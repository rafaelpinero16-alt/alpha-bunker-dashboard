"""
routers/kyc_v2.py — Verificación de edad/identidad sin binarios en Postgres.

Flujo:
  1. POST /v2/kyc/upload-urls   → 2 URLs firmadas (POST presignado S3/R2, 10 min,
                                   content-type y tamaño máximo forzados por la política)
  2. El cliente sube documento y selfie DIRECTO al bucket privado.
  3. POST /v2/kyc/submit        → guarda solo las claves de objeto; estado "pending".
  4. Admin: GET /v2/kyc/pending, GET /v2/kyc/{id}/view (URLs GET de 5 min),
            POST /v2/kyc/{id}/review

v1: kyc.py recibía document_base64/selfie_base64 y los DESCARTABA (solo
guardaba legal_name), marcando "pending" sin prueba alguna. En una plataforma
+18 eso es un riesgo legal directo, no un detalle técnico.

Bucket: privado, cifrado en reposo (SSE), sin listado público, con regla de
ciclo de vida acorde a tu política de retención.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.dependencies import Principal, StrictBody, get_current_principal, require_admin
from core.settings import get_settings
from database.db import get_db
from database.models import User
from database.models_v2 import KycSubmission

router = APIRouter(prefix="/v2/kyc", tags=["KYC v2"])
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _s3():
    import boto3

    s = get_settings()
    if not s.kyc_s3_bucket:
        raise HTTPException(status_code=503, detail="Almacenamiento KYC no configurado.")
    return boto3.client("s3", region_name=s.kyc_s3_region or None,
                        endpoint_url=s.kyc_s3_endpoint_url or None), s.kyc_s3_bucket


class UploadUrlsBody(StrictBody):
    document_content_type: str
    selfie_content_type: str


class SubmitBody(StrictBody):
    legal_name: str = Field(min_length=3, max_length=200)
    document_key: str = Field(max_length=512)
    selfie_key: str = Field(max_length=512)


class ReviewBody(StrictBody):
    decision: Literal["verified", "rejected"]
    note: Optional[str] = Field(default=None, max_length=1000)


def _prefix(user_id: int) -> str:
    return f"kyc/{user_id}/"


@router.post("/upload-urls")
def upload_urls(body: UploadUrlsBody, principal: Principal = Depends(get_current_principal)):
    for ct in (body.document_content_type, body.selfie_content_type):
        if ct not in ALLOWED_TYPES:
            raise HTTPException(status_code=415, detail="Formato no permitido (JPEG/PNG/WEBP).")
    client, bucket = _s3()
    max_bytes = get_settings().kyc_max_upload_bytes
    out = {}
    for kind, ct in (("document", body.document_content_type), ("selfie", body.selfie_content_type)):
        key = f"{_prefix(principal.user_id)}{kind}-{uuid.uuid4().hex}"
        out[kind] = {"key": key, **client.generate_presigned_post(
            Bucket=bucket, Key=key,
            Fields={"Content-Type": ct},
            Conditions=[{"Content-Type": ct}, ["content-length-range", 1024, max_bytes]],
            ExpiresIn=600,
        )}
    return out


@router.post("/submit")
def submit(body: SubmitBody, principal: Principal = Depends(get_current_principal),
           db: Session = Depends(get_db)):
    prefix = _prefix(principal.user_id)
    if not (body.document_key.startswith(prefix) and body.selfie_key.startswith(prefix)):
        raise HTTPException(status_code=400, detail="Claves de archivo inválidas.")
    client, bucket = _s3()
    for key in (body.document_key, body.selfie_key):
        try:
            client.head_object(Bucket=bucket, Key=key)
        except Exception:
            raise HTTPException(status_code=400, detail="Archivo no subido o caducado.")

    user = db.execute(select(User).where(User.user_id == principal.user_id).with_for_update()).scalar_one()
    if getattr(user, "kyc_status", None) == "verified":
        raise HTTPException(status_code=409, detail="Ya estás verificado.")
    db.add(KycSubmission(user_id=user.user_id, legal_name=body.legal_name,
                         document_key=body.document_key, selfie_key=body.selfie_key))
    user.legal_name = body.legal_name
    user.kyc_status = "pending"
    db.commit()
    return {"status": "pending"}


@router.get("/status")
def status(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    return {"kyc_status": getattr(user, "kyc_status", None) or "unverified",
            "role": principal.role, "access_level": principal.access_level, "name": user.name}


@router.get("/pending")
def pending(_: Principal = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.execute(select(KycSubmission).where(KycSubmission.status == "pending")
                      .order_by(KycSubmission.submitted_at).limit(100)).scalars().all()
    return {"items": [{"id": r.id, "user_id": r.user_id, "legal_name": r.legal_name,
                       "submitted_at": r.submitted_at.isoformat()} for r in rows]}


@router.get("/{submission_id}/view")
def view(submission_id: int, _: Principal = Depends(require_admin), db: Session = Depends(get_db)):
    sub = db.get(KycSubmission, submission_id)
    if not sub:
        raise HTTPException(status_code=404)
    client, bucket = _s3()
    sign = lambda k: client.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": k},
                                                   ExpiresIn=300)
    return {"document_url": sign(sub.document_key), "selfie_url": sign(sub.selfie_key)}


@router.post("/{submission_id}/review")
def review(submission_id: int, body: ReviewBody, admin: Principal = Depends(require_admin),
           db: Session = Depends(get_db)):
    sub = db.execute(select(KycSubmission).where(KycSubmission.id == submission_id)
                     .with_for_update()).scalar_one_or_none()
    if not sub or sub.status != "pending":
        raise HTTPException(status_code=404, detail="Solicitud no encontrada o ya revisada.")
    sub.status = body.decision
    sub.reviewer_id = admin.user_id
    sub.review_note = body.note
    sub.reviewed_at = datetime.now(timezone.utc)
    user = db.execute(select(User).where(User.user_id == sub.user_id).with_for_update()).scalar_one()
    user.kyc_status = body.decision
    db.commit()
    return {"status": sub.status}
