import os
import sqlite3
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

DB_NAME = "database.db"
# Preparado para integrarse automáticamente con PostgreSQL en Railway
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///./{DB_NAME}")

def get_connection():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

# Adaptador automático para URLs de Postgres de Railway
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_recycle=300 if not DATABASE_URL.startswith("sqlite") else -1
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    from database.models import Package
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # Sincronizamos y actualizamos los paquetes oficiales con el orden estricto solicitado
        db.query(Package).delete()
        db.add_all([
            Package(
                slug="spy", 
                name="Spy 🕵️", 
                description="Reconocimiento y acceso inicial al Búnker.", 
                alpha_base=50, bonus_percentage=0, alpha_total=50, 
                price_stars=250, price_ton=0.5, badge="🕵️ SPY"
            ),
            Package(
                slug="soldier", 
                name="Soldier 🎖️", 
                description="Infantería táctica con contenido esencial.", 
                alpha_base=150, bonus_percentage=0, alpha_total=150, 
                price_stars=750, price_ton=1.0, badge="🎖️ SOLDIER"
            ),
            Package(
                slug="veteran", 
                name="Veteran ⚔️", 
                description="Acceso avanzado a operaciones especiales.", 
                alpha_base=300, bonus_percentage=10, alpha_total=330, 
                price_stars=1500, price_ton=2.0, badge="⚔️ VETERAN"
            ),
            Package(
                slug="legend", 
                name="Legend 👑", 
                description="Rango de Comandante con privilegios VIP totales.", 
                alpha_base=550, bonus_percentage=18, alpha_total=650, 
                price_stars=2750, price_ton=5.0, badge="👑 LEGEND"
            ),
            Package(
                slug="icon-legend", 
                name="Icon Legend 💎", 
                description="General Supremo con acceso ilimitado y cámaras.", 
                alpha_base=1200, bonus_percentage=25, alpha_total=1500, 
                price_stars=6000, price_ton=12.0, badge="💎 ICON"
            )
        ])
        db.commit()
        print("[DB SEED]: 5 Paquetes oficiales (Spy a Icon Legend) registrados exitosamente.")
    except Exception as e:
        db.rollback()
        print(f"[DB SEED ERROR]: {e}")
    finally:
        db.close()