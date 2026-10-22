import os
from sqlalchemy import create_engine, text

# Pega aquí tu URL PÚBLICA de Railway (la que tiene el dominio externo y puerto proxy)
DATABASE_URL = "postgresql://postgres:jzfFIqGuaIRvsZtwVRNRGIRNwERaOoge@postgres.railway.internal:5432/railway"

print("Conectando a la base de datos pública en Railway...")
engine = create_engine(DATABASE_URL)

def run_sql_file(filepath):
    print(f"Ejecutando: {filepath}...")
    with open(filepath, "r", encoding="utf-8") as f:
        sql_script = f.read()
    
    with engine.connect() as conn:
        conn.execute(text(sql_script))
        conn.commit()
    print(f"✅ Ejecutado con éxito: {filepath}")

if __name__ == "__main__":
    migrations_dir = os.path.join(os.path.dirname(__file__), "migrations")
    run_sql_file(os.path.join(migrations_dir, "001_v2.sql"))
    run_sql_file(os.path.join(migrations_dir, "002_app_support.sql"))
    print("🚀 ¡Todas las migraciones de la v2 se aplicaron con éxito en PostgreSQL!")