"""
services/catalog.py — Fuente ÚNICA de verdad de precios y recompensas.

En v1 había TRES catálogos divergentes (payments.py dict, tabla Package usada
por telegram.py y ALPHA_REWARDS en logic.py), además de que el front enviaba
price_ton/alpha_total al backend. Ahora el cliente solo envía un slug.

⚠️ Decisiones de negocio a confirmar (marcadas con TODO-NEGOCIO):
  - duration_days: 30 días para todos; None = vitalicio.
  - Si un tier superior debe dar acceso también a los canales inferiores.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

REFERRAL_DISCOUNT_PCT = 10
REFERRAL_REWARD_ALPHA = 100


@dataclass(frozen=True)
class Package:
    slug: str
    name: str
    level: int
    price_stars: int
    price_ton_nano: int
    price_usd: float
    alpha_total: int
    duration_days: Optional[int]
    description: str

    def stars_price(self, with_referral_discount: bool) -> int:
        if not with_referral_discount:
            return self.price_stars
        return max(1, (self.price_stars * (100 - REFERRAL_DISCOUNT_PCT)) // 100)

    def ton_price_nano(self, with_referral_discount: bool) -> int:
        if not with_referral_discount:
            return self.price_ton_nano
        return (self.price_ton_nano * (100 - REFERRAL_DISCOUNT_PCT)) // 100


_TON = 1_000_000_000

PACKAGES: dict[str, Package] = {
    p.slug: p
    for p in (
        Package("soldier", "Soldier 🎖️", 1, 150, int(1.5 * _TON), 2.99, 150, 30,
                "Herramientas de Creador."),
        Package("veteran", "Veteran ⚔️", 2, 300, 3 * _TON, 5.99, 330, 30,
                "Contenido avanzado."),
        Package("legend", "Legend 👑", 3, 1250, int(12.5 * _TON), 25.00, 650, 30,
                "Acceso total VIP y funciones máximas."),
        Package("icon-legend", "Icon Legend 💎", 4, 2650, int(26.5 * _TON), 53.00, 1500, 30,  # TODO-NEGOCIO: ¿vitalicio?
                "Acceso total + Cámaras en videollamadas."),
    )
}

# Alias heredados del front v1 → slug canónico.
ALIASES = {"starter": "soldier", "advanced": "veteran", "elite": "legend", "lifetime": "icon-legend"}

CREATOR_ROLE_MIN_LEVEL = 3  # v1: Legend/Icon Legend otorgan rol creator


def get_package(slug: str) -> Package:
    key = ALIASES.get(slug.strip().lower(), slug.strip().lower())
    pkg = PACKAGES.get(key)
    if not pkg:
        raise KeyError(slug)
    return pkg


def public_catalog() -> list[dict]:
    return [
        {
            "slug": p.slug, "name": p.name, "level": p.level,
            "price_stars": p.price_stars, "price_ton": p.price_ton_nano / _TON,
            "price_usd": p.price_usd, "alpha_total": p.alpha_total,
            "duration_days": p.duration_days, "description": p.description,
        }
        for p in PACKAGES.values()
    ]
