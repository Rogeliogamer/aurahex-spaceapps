import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.background import BackgroundScheduler
from core_etl import process_fire_data, generate_burning_calendar
from download_data import download_and_merge_firms

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("\n⏰ Arrancando Motor de Automatización (Cron)...")
    csv_path = os.path.join(BASE_DIR, "real_fires.csv")

    # Solo descarga al arrancar si el archivo no existe o tiene más de 12 horas de antigüedad
    if not os.path.exists(csv_path) or (time.time() - os.path.getmtime(csv_path)) > 43200:
        download_and_merge_firms()
    else:
        print("✅ 'real_fires.csv' ya está actualizado localmente. Saltando descarga inicial.")

    # Pre-calentar la resolución inicial (Nivel 5) y su calendario en memoria
    process_fire_data("real_fires.csv", resolution=5)
    generate_burning_calendar("real_fires.csv", resolution=5)
    
    # Programar actualización automática cada 24 horas
    scheduler = BackgroundScheduler()
    scheduler.add_job(download_and_merge_firms, 'interval', hours=24)
    scheduler.start()
    print("✅ Cron activado: Descargas satelitales programadas cada 24 horas.\n")
    
    yield
    
    scheduler.shutdown()
    print("🛑 Motor de automatización detenido.")

app = FastAPI(
    title="AuraHex API",
    description="Motor de datos espaciales y calendario armonizado para NASA Space Apps",
    lifespan=lifespan
)

# 🌐 Permitimos conexiones desde CUALQUIER origen (CORS) para evitar bloqueos en Vercel
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"mensaje": "🔥 API de AuraHex funcionando correctamente. Lista para el hackathon."}

@app.get("/api/fires/harmonized")
def get_harmonized_fires(resolution: int = 6):
    return process_fire_data("real_fires.csv", resolution)

@app.get("/api/fires/calendar")
def get_burning_calendar(resolution: int = 5):
    return generate_burning_calendar("real_fires.csv", resolution)