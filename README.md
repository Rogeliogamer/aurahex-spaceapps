# 🔥 AuraHex — Calendario Armonizado de Actividad de Quema y Monitoreo Satelital H3

**Proyecto desarrollado para el 2026 NASA Space Apps Challenge.**

Plataforma web bilingüe (`ES`/`EN`) de inteligencia geoespacial que armoniza los registros térmicos de múltiples constelaciones satelitales (**MODIS y VIIRS**) en una malla hexagonal discreta (**Uber H3**), permitiendo a brigadistas, científicos y gestores territoriales analizar patrones históricos de incendios, anomalías térmicas y periodos críticos en un entorno 3D interactivo.

# 🌍 El Problema Científico y Nuestra Solución

Los satélites de observación terrestre llevan más de dos décadas rastreando focos de calor, pero sus registros están divididos entre sensores cuyas mediciones no pueden compararse directamente (Schema Drift y discrepancia espacial):

- **MODIS (Terra & Aqua):** Más de 20 años de historial, pero con píxeles de menor resolución ($1\text{ km} \times 1\text{ km}$) y confianza reportada en porcentaje ($0\text{–}100\%$).

- **VIIRS (NOAA-20 & NOAA-21):** Mayor sensibilidad y continuidad moderna con píxeles de alta resolución ($375\text{ m} \times 375\text{ m}$) y confianza categórica (`low`, `nominal`, `high`).

**AuraHex resuelve esta incompatibilidad mediante una arquitectura ETL de Armonización Geoespacial:**

1. **Ingesta Multi-Constelación (30+ Días):** Descarga y consolida datos de **MODIS, VIIRS NOAA-20** y **VIIRS NOAA-21** conectándose a la API de Área de **NASA FIRMS** (con soporte de acumulación histórica local y actualización programada cada $24\text{ h}$).

2. **Normalización Física:** Homologa las escalas de confianza, convierte lecturas infrarrojas de Kelvin a ${}^\circ\text{C}$ y unifica la Potencia Radiativa del Fuego (**FRP en $\text{MW}$**).

3. **Indexación Hexagonal Universal (Uber H3):** Sustituye los puntos dispares por celdas hexagonales matemáticas uniformes. Una vez indexados, el sensor de origen deja de ser una barrera y los patrones, tendencias y anomalías térmicas se convierten en el enfoque principal.

# ✨ Características Implementadas

- **🌐 Experiencia Inmersiva 3D Bilingüe (`Landing.jsx` + `Three.js`):** Portada interactiva con globo terráqueo orbital (`Three.js` + `GSAP`) y visor analítico completo con conmutador instantáneo **Espalol / Inglés (`ES · EN`)**.

- **📅 Calendario Armonizado de Actividad de Quema:** Mapa de calor diario, comparativa de anomalías contra la mediana histórica y matriz de régimen multi-anual (`2019–2026`).

- **📍 Exploración por Área de Interés (AOI) y Coordenadas:** Filtros por regiones rápidas, caja delimitadora `Lat/Lon`, selección de hexágonos individuales en el mapa y rango de fechas (`Inicio - Fin`) con recálculo estadístico en tiempo real.

- **⬇️ Exportación de Datos Armonizados a CSV:** Descarga directa en formato CSV tanto del día activo como del historial completo del Área de Interés (AOI) seleccionada.

- **🔍 Zoom Semántico H3 en Tiempo Real (Niveles 4 a 8):** Recálculo dinámico desde escala continental ($\approx 1,770\text{ km}^2$) hasta escala local ($\approx 0.74\text{ km}^2$), respaldado por un motor de caché en memoria que responde en milisegundos.

- **👁️ Rampas de Color Accesibles:** Alternancia en vivo entre paleta **Térmica** y paleta científica **Viridis** (accesible para daltonismo).

# 🏗️ Estructura del Repositorio

```
aurahex-spaceapps/
├── server/                     # Backend API y Motor ETL Geoespacial
│   ├── download_data.py        # Conector NASA FIRMS (API 30 días + Fallback 7 días + Acumulación)
│   ├── core_etl.py             # Limpieza Pandas, caché en memoria, H3 y Calendario de Quema
│   ├── main.py                 # API REST con FastAPI, Pre-Caché y Cron Job cada 24h
│   ├── .env                    # Clave privada FIRMS_MAP_KEY (ignorado en Git)
│   └── requirements.txt        # Dependencias de Python
├── client/                     # Frontend Interactivo 3D (React + Vite)
│   ├── public/                 # Texturas espaciales (Blue Marble, México) y logotipos
│   ├── src/
│   │   ├── Landing.jsx         # Portada interactiva bilingüe con narrativa espacial y GSAP
│   │   ├── OrbitCanvas.jsx     # Contenedor WebGL del globo terráqueo 3D
│   │   ├── orbitScene.js       # Escena Three.js con demostración de celdas H3 en globo
│   │   ├── spaceEffects.js     # Shaders de atmósfera, estrellas y órbitas satelitales
│   │   ├── App.jsx             # Visor 3D Deck.gl, Calendario, AOI, Filtros y Time-Lapse (ES/EN)
│   │   ├── fireCsv.js          # Utilidad de exportación de celdas H3 a formato CSV
│   │   ├── MapLoading.jsx      # Pantalla de carga sincronizada
│   │   └── main.jsx            # Enrutamiento entre Landing (/) y Mapa (/map)
│   └── package.json            # Dependencias de Node (Deck.gl, Three.js, GSAP, Recharts, H3-js)
├── docs/                       # Documentación técnica, análisis del reto y guías del equipo
│   ├── analisis_reto_nasa.md   # Diagnóstico de cumplimiento frente al reto oficial
│   ├── ampliar_rango_historico.md
│   ├── satelites_monitoreo_incendios.md
│   ├── escalas_hexagonales_h3.md
│   └── instalacion_desde_cero.md
└── .gitignore
```

# 🚀 Guía de Inicio Rápido (Para el Equipo)

**Requisitos Previos**

- **Python $3.10+$** (py o python)

- **Node.js $18+$** (npm)

- **Git**

1. Clonar o actualizar el repositorio

```
git clone https://github.com/Rogeliogamer/aurahex-spaceapps.git
cd aurahex-spaceapps
```

2. Configurar y encender el Backend (`server/`)

Abre una terminal en la carpeta `server`:

```
cd server

# Crear y activar entorno virtual (Windows PowerShell)
py -m venv venv
.\venv\Scripts\activate

# Instalar dependencias
python -m pip install -r requirements.txt
```

(Opcional Recomendado) Activar descarga de 30 días con **NASA FIRMS API**:

Crea un archivo `server/.env` con tu clave gratuita de [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/):

```
FIRMS_MAP_KEY=tu_clave_de_32_caracteres
FIRMS_DAYS=30
```

(Si no creas el archivo `.env`, el sistema funcionará automáticamente en modo público descargando los últimos 7 días).

Ejecuta la descarga inicial y levanta el servidor:

```
python download_data.py
python -m uvicorn main:app --reload
```

La API quedará activa en `http://localhost:8000` (Documentación Swagger en `http://localhost:8000/docs`).

3. Encender el Frontend (`client/`)

Abre una **segunda terminal** en la carpeta `client`:

```
cd client

# Instalar librerías (incluyendo Three.js, GSAP y Deck.gl)
npm install

# Iniciar servidor de desarrollo
npm run dev
```

Abre `http://localhost:5173` para ver la Landing Page 3D o entra directo a `http://localhost:5173/map` para abrir el visor geoespacial.
