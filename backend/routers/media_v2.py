"""
routers/media_v2.py — Subida de medios (chat, posts, avatares) a almacenamiento de objetos.

v1 enviaba imágenes/vídeos/audios como data:base64 dentro del JSON del chat y de
posts.image_url (columna TEXT): filas de varios MB, feed lentísimo, backups
enormes y WebSockets saturados. Ahora:
  1. POST /v2/media/upload-url {content_type, size}  → POST presignado (5 min)
  2. el cliente sube directo al bucket (S3 / Cloudflare R2)
  3. envía la URL pública resultante como media_url (validada por MEDIA_ALLOWED_HOSTS)

Contenido PPV: usa un bucket/prefijo PRIVADO y sirve con URLs GET firmadas de
corta duración tras comprobar el desbloqueo (no implementado aquí).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from auth.dependencies import Principal, StrictBody, get_current_principal
from core.settings import get_settings

router = APIRouter(prefix="/v2/media", tags=["Media v2"])

LIMITS = {
    "image/jpeg": 10 * 1024 * 1024, "image/png": 10 * 1024 * 1024, "image/webp": 10 * 1024 * 1024,
    "video/mp4": 100 * 1024 * 1024, "video/webm": 100 * 1024 * 1024,
    "audio/webm": 15 * 1024 * 1024, "audio/mpeg": 15 * 1024 * 1024, "audio/ogg": 15 * 1024 * 1024,
}
EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4",
       "video/webm": "webm", "audio/webm": "weba", "audio/mpeg": "mp3", "audio/ogg": "ogg"}


class UploadBody(StrictBody):
    content_type: str
    size: int = Field(gt=0)


@router.post("/upload-url")
def upload_url(body: UploadBody, principal: Principal = Depends(get_current_principal)):
    s = get_settings()
    if not (s.media_s3_bucket and s.media_public_base_url):
        raise HTTPException(status_code=503, detail="Almacenamiento de medios no configurado.")
    limit = LIMITS.get(body.content_type)
    if not limit:
        raise HTTPException(status_code=415, detail="Tipo de archivo no permitido.")
    if body.size > limit:
        raise HTTPException(status_code=413, detail="Archivo demasiado grande.")

    import boto3
    client = boto3.client("s3", region_name=s.kyc_s3_region or None,
                          endpoint_url=s.kyc_s3_endpoint_url or None)
    key = f"u/{principal.user_id}/{uuid.uuid4().hex}.{EXT[body.content_type]}"
    post = client.generate_presigned_post(
        Bucket=s.media_s3_bucket, Key=key,
        Fields={"Content-Type": body.content_type},
        Conditions=[{"Content-Type": body.content_type}, ["content-length-range", 1, limit]],
        ExpiresIn=300,
    )
    return {"upload": post, "public_url": f"{s.media_public_base_url}/{key}"}
