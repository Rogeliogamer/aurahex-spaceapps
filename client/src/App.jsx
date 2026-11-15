import MapLoading from "./MapLoading.jsx";
import { downloadFireCsv } from "./fireCsv.js";
import React, { useState, useEffect, useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { H3HexagonLayer, TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PolygonLayer } from "@deck.gl/layers";
import { cellToLatLng, cellToBoundary } from "h3-js";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ComposedChart,
  Line,
} from "recharts";

// Servidores de mapas de Esri (Raster Tiles directos, inmunes a fallos de WebGL secundario)
const BASEMAPS = {
  DARK: {
    name: "Oscuro Táctico",
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labels:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  },
  SATELLITE: {
    name: "Satélite Real",
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    labels:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  },
};

// Rampas de color (Estándar Térmico vs Accesible para Daltonismo - requisito NASA)
const COLOR_RAMPS = {
  THERMAL: {
    name: "Térmica",
    extremo: { hex: "#ef4444", rgb: [239, 68, 68, 235] },
    alto: { hex: "#f97316", rgb: [249, 115, 22, 225] },
    moderado: { hex: "#eab308", rgb: [234, 179, 8, 200] },
    heatScale: ["#1e293b", "#854d0e", "#ea580c", "#dc2626", "#f87171"],
  },
  ACCESSIBLE: {
    name: "Accesible (Viridis)",
    extremo: { hex: "#fde047", rgb: [253, 224, 71, 240] },
    alto: { hex: "#2dd4bf", rgb: [45, 212, 191, 225] },
    moderado: { hex: "#6366f1", rgb: [99, 102, 241, 210] },
    heatScale: ["#1e1b4b", "#4338ca", "#0d9488", "#84cc16", "#fde047"],
  },
};

// Escalas reales aproximadas por nivel H3
const H3_SCALE_INFO = {
  4: "~1,770 km² (Macro)",
  5: "~252 km² (Regional)",
  6: "~36.1 km² (Estatal)",
  7: "~5.16 km² (Municipal)",
  8: "~0.74 km² (Local)",
};

function resolutionForZoom(zoom) {
  if (zoom < 4) return 4;
  if (zoom < 5.8) return 5;
  if (zoom < 7.5) return 6;
  if (zoom < 9.2) return 7;
  return 8;
}

const INITIAL_VIEW_STATE = {
  longitude: -101.0,
  latitude: 25.5,
  zoom: 4.5,
  pitch: 45,
  bearing: 0,
};

// Regiones rápidas de exploración. Son cajas geográficas aproximadas, no límites administrativos oficiales.
const QUICK_REGIONS = [
  { id: "northwest-mx", label: "Noroeste de México", north: 32.8, south: 22.0, west: -117.2, east: -105.0 },
  { id: "northeast-mx", label: "Noreste de México", north: 30.5, south: 22.0, west: -105.0, east: -97.0 },
  { id: "west-bajio-mx", label: "Occidente y Bajío", north: 24.5, south: 18.0, west: -106.0, east: -99.0 },
  { id: "south-southeast-mx", label: "Centro-sur y sureste", north: 21.0, south: 14.5, west: -102.0, east: -92.0 },
  { id: "yucatan-mx", label: "Península de Yucatán", north: 22.8, south: 17.5, west: -92.0, east: -86.5 },
  { id: "california-us", label: "California", north: 42.1, south: 32.5, west: -124.5, east: -114.1 },
];

function isLongitudeInside(longitude, west, east) {
  // También permite cajas que cruzan el meridiano 180°.
  return west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
}

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isCellInsideAOI(record, aoi) {
  if (!aoi) return true;
  try {
    const [latitude, longitude] = cellToLatLng(record.h3_index);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

    if (aoi.type === "hexagon") {
      return pointInPolygon([longitude, latitude], aoi.boundary);
    }

    return (
      latitude >= aoi.south &&
      latitude <= aoi.north &&
      isLongitudeInside(longitude, aoi.west, aoi.east)
    );
  } catch (error) {
    console.warn("No se pudo evaluar la celda H3:", record.h3_index, error);
    return false;
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildAOICalendar(records, dates) {
  const grouped = new Map();
  for (const record of records) {
    const current = grouped.get(record.acq_date) || {
      harmonized_cells: 0,
      raw_hotspots: 0,
      total_frp: 0,
      extreme_cells: 0,
      high_cells: 0,
      multi_sensor_cells: 0,
    };
    current.harmonized_cells += 1;
    current.raw_hotspots += Number(record.point_count) || 0;
    current.total_frp += Number(record.total_frp) || 0;
    if (record.total_frp > 150) current.extreme_cells += 1;
    else if (record.total_frp > 50) current.high_cells += 1;
    if (String(record.instruments || "").includes(",")) current.multi_sensor_cells += 1;
    grouped.set(record.acq_date, current);
  }

  // Incluye también los días sin detecciones dentro del rango para no ocultar días en cero.
  const baseDays = dates.map((date) => ({
    date,
    ...(grouped.get(date) || {
      harmonized_cells: 0,
      raw_hotspots: 0,
      total_frp: 0,
      extreme_cells: 0,
      high_cells: 0,
      multi_sensor_cells: 0,
    }),
  }));
  const medianCells = median(baseDays.map((day) => day.harmonized_cells));
  const medianFrp = median(baseDays.map((day) => day.total_frp));
  const daily = baseDays.map((day) => {
    const anomaly = ((day.harmonized_cells - medianCells) / Math.max(1, medianCells)) * 100;
    return {
      ...day,
      total_frp: Number(day.total_frp.toFixed(1)),
      anomaly_pct: Number(anomaly.toFixed(1)),
      status: anomaly >= 35 ? "CRITICO" : anomaly >= 10 ? "ELEVADO" : anomaly <= -25 ? "BAJO" : "NORMAL",
    };
  });

  const peak = daily.reduce((best, day) =>
    !best || day.harmonized_cells > best.harmonized_cells ? day : best, null);
  const totalRaw = daily.reduce((sum, day) => sum + day.raw_hotspots, 0);
  const totalHarmonized = daily.reduce((sum, day) => sum + day.harmonized_cells, 0);
  const minCells = daily.length ? Math.min(...daily.map((day) => day.harmonized_cells)) : 0;
  const maxCells = daily.length ? Math.max(...daily.map((day) => day.harmonized_cells)) : 0;

  return {
    daily,
    summary: {
      median_daily_cells: Number(medianCells.toFixed(1)),
      median_daily_frp: Number(medianFrp.toFixed(1)),
      min_daily_cells: minCells,
      max_daily_cells: maxCells,
      total_raw_detections: totalRaw,
      total_harmonized_cell_days: totalHarmonized,
      harmonization_efficiency_pct: Number(((1 - totalHarmonized / Math.max(1, totalRaw)) * 100).toFixed(1)),
      peak_date: peak?.date || "-",
      peak_cells: peak?.harmonized_cells || 0,
      peak_anomaly_pct: peak?.anomaly_pct || 0,
    },
  };
}

function getAOIPolygon(aoi) {
  if (!aoi) return null;
  if (aoi.type === "hexagon") return aoi.boundary;
  return [
    [aoi.west, aoi.south],
    [aoi.east, aoi.south],
    [aoi.east, aoi.north],
    [aoi.west, aoi.north],
  ];
}

function downloadAOIRangeCSV(records, resolution, startDate, endDate, aoiLabel) {
  const headers = [
    "aoi", "h3_index", "acq_date", "total_frp_mw",
    "avg_confidence", "avg_brightness", "point_count", "instruments",
  ];
  const escapeCSV = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = records.map((record) => [
    aoiLabel || "Vista global", record.h3_index, record.acq_date,
    record.total_frp, record.avg_confidence, record.avg_brightness,
    record.point_count, record.instruments,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCSV).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeLabel = String(aoiLabel || "global")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  link.href = url;
  link.download = `aurahex-${safeLabel || "global"}-h3-${resolution}-${startDate || "inicio"}-${endDate || "fin"}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [initialLoading, setInitialLoading] = useState(true);
  const [dataError, setDataError] = useState(false);
  const [{ cells: fireData, resolution: loadedResolution }, setFireData] =
    useState({ cells: [], resolution: null });
  const [uniqueDates, setUniqueDates] = useState([]);
  const [currentDate, setCurrentDate] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [hoverInfo, setHoverInfo] = useState(null);

  // Estado del Sprint 3: Área de Interés (AOI) y cámara controlada.
  const [selectedAOI, setSelectedAOI] = useState(null);
  const [boundsDraft, setBoundsDraft] = useState({ north: "", south: "", west: "", east: "" });
  const [aoiError, setAoiError] = useState("");
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

  // Estado del Mapa Base, Rampa de Color y Zoom Semántico
  const [mapTheme, setMapTheme] = useState("DARK");
  const [colorRamp, setColorRamp] = useState("THERMAL");
  const [h3Resolution, setH3Resolution] = useState(5);
  const [targetResolution, setTargetResolution] = useState(5);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(4.5);

  // Estado del Sprint 2: Calendario Armonizado de Actividad de Quema
  const [calendarData, setCalendarData] = useState(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [calendarTab, setCalendarTab] = useState("HEATMAP"); // 'HEATMAP' | 'ANOMALIES' | 'MULTIYEAR'

  // Filtros interactivos
  const [activeSats, setActiveSats] = useState({
    MODIS: true,
    NOAA20: true,
    NOAA21: true,
  });
  const [activeThreats, setActiveThreats] = useState({
    EXTREMO: true,
    ALTO: true,
    MODERADO: true,
  });

  const activePalette = COLOR_RAMPS[colorRamp];

  // 1. Escucha del zoom de la cámara
  const onViewStateChange = ({ viewState: nextViewState }) => {
    setViewState(nextViewState);
    const roundedZoom = Math.round(nextViewState.zoom * 10) / 10;
    if (roundedZoom !== cameraZoom) {
      setCameraZoom(roundedZoom);
    }

    const newRes = resolutionForZoom(nextViewState.zoom);
    if (newRes !== targetResolution) {
      setTargetResolution(newRes);
    }
  };

  // 2. Debounce de 250ms para pedir la nueva malla H3 solo al estabilizar el zoom
  useEffect(() => {
    const timer = setTimeout(() => {
      if (targetResolution !== h3Resolution) {
        setH3Resolution(targetResolution);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [targetResolution, h3Resolution]);

  // 3. Descarga dinámica desde FastAPI (Malla H3 + Calendario Armonizado)
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let active = true;
    setIsRecalculating(true);
    setDataError(false);

    Promise.all([
      fetch(
        `http://localhost:8000/api/fires/harmonized?resolution=${h3Resolution}`,
        {
          signal: controller.signal,
        },
      ).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      fetch(
        `http://localhost:8000/api/fires/calendar?resolution=${h3Resolution}`,
        {
          signal: controller.signal,
        },
      ).then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([data, calData]) => {
        if (!active) return;
        if (!Array.isArray(data))
          throw new Error("Respuesta inválida de la API");

        setFireData({ cells: data, resolution: h3Resolution });
        if (calData) setCalendarData(calData);

        const dates = [...new Set(data.map((d) => d.acq_date).filter(Boolean))].sort();
        setUniqueDates(dates);
        setDateStart((previous) => previous || dates[0] || "");
        setDateEnd((previous) => previous || dates.at(-1) || "");
        setCurrentDate((previous) =>
          dates.includes(previous) ? previous : dates.at(-1) || "",
        );
      })
      .catch((error) => {
        if (!active) return;
        console.error("Error al conectar con la API:", error);
        setDataError(true);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!active) return;
        setIsRecalculating(false);
        setInitialLoading(false);
      });

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [h3Resolution]);

  // 4. Fechas disponibles dentro del rango seleccionado.
  const rangeDates = useMemo(
    () => uniqueDates.filter((date) => (!dateStart || date >= dateStart) && (!dateEnd || date <= dateEnd)),
    [uniqueDates, dateStart, dateEnd],
  );

  // 5. Filtrado espacial: el centro de cada celda H3 determina si pertenece al AOI.
  const spatiallyFilteredData = useMemo(
    () => fireData.filter((record) => isCellInsideAOI(record, selectedAOI)),
    [fireData, selectedAOI],
  );

  const rangeFilteredData = useMemo(
    () => spatiallyFilteredData.filter((record) =>
      (!dateStart || record.acq_date >= dateStart) &&
      (!dateEnd || record.acq_date <= dateEnd),
    ),
    [spatiallyFilteredData, dateStart, dateEnd],
  );

  // Mantiene una fecha válida al cambiar AOI o rango. Los días sin focos permanecen en el time-lapse.
  useEffect(() => {
    if (rangeDates.length === 0) {
      setCurrentDate("");
      setIsPlaying(false);
      return;
    }
    if (!rangeDates.includes(currentDate)) {
      setCurrentDate(rangeDates.at(-1));
    }
  }, [rangeDates, currentDate]);

  // 6. Reloj del reproductor, limitado al rango temporal seleccionado.
  useEffect(() => {
    if (!isPlaying || rangeDates.length < 2) return undefined;
    const interval = setInterval(() => {
      setCurrentDate((previous) => {
        const currentIndex = rangeDates.indexOf(previous);
        return rangeDates[(currentIndex + 1 + rangeDates.length) % rangeDates.length];
      });
    }, 1800);
    return () => clearInterval(interval);
  }, [isPlaying, rangeDates]);

  // Calendario recalculado exclusivamente con los registros del AOI y del rango elegido.
  const aoiCalendar = useMemo(
    () => buildAOICalendar(rangeFilteredData, rangeDates),
    [rangeFilteredData, rangeDates],
  );
  const aoiSummary = aoiCalendar.summary;

  // 7. Filtros de sensor, amenaza y día aplicados a las celdas visibles del mapa.
  const filteredData = useMemo(() => {
    return rangeFilteredData.filter((d) => {
      const instrumentsStr = String(d.instruments).toUpperCase();
      const hasModis =
        instrumentsStr.includes("MODIS") ||
        instrumentsStr === "T" ||
        instrumentsStr === "A" ||
        instrumentsStr.includes("TERRA") ||
        instrumentsStr.includes("AQUA");
      const hasNoaa20 =
        instrumentsStr.includes("NOAA-20") ||
        instrumentsStr.includes("N20") ||
        instrumentsStr.split(",").map((value) => value.trim()).includes("1");
      const hasNoaa21 =
        instrumentsStr.includes("NOAA-21") ||
        instrumentsStr.includes("N21") ||
        instrumentsStr.split(",").map((value) => value.trim()).includes("2");

      const satMatch =
        (activeSats.MODIS && hasModis) ||
        (activeSats.NOAA20 && hasNoaa20) ||
        (activeSats.NOAA21 && hasNoaa21);

      const isExtremo = d.total_frp > 150;
      const isAlto = d.total_frp > 50 && d.total_frp <= 150;
      const isModerado = d.total_frp <= 50;
      const threatMatch =
        (activeThreats.EXTREMO && isExtremo) ||
        (activeThreats.ALTO && isAlto) ||
        (activeThreats.MODERADO && isModerado);
      const dateMatch = currentDate ? d.acq_date === currentDate : false;
      return satMatch && threatMatch && dateMatch;
    });
  }, [rangeFilteredData, activeSats, activeThreats, currentDate]);

  const exportPending =
    isRecalculating ||
    loadedResolution !== h3Resolution ||
    targetResolution !== h3Resolution;
  const canExportCsv =
    !dataError &&
    !exportPending &&
    Boolean(currentDate) &&
    filteredData.length > 0;
  const canExportRangeCsv =
    !dataError &&
    !exportPending &&
    rangeFilteredData.length > 0;

  const currentDayStats = useMemo(
    () => aoiCalendar.daily.find((day) => day.date === currentDate) || null,
    [aoiCalendar, currentDate],
  );

  // Acciones del AOI.
  const focusBounds = (bounds) => {
    const adjustedEast = bounds.west <= bounds.east ? bounds.east : bounds.east + 360;
    let longitude = (bounds.west + adjustedEast) / 2;
    if (longitude > 180) longitude -= 360;
    const latitude = (bounds.north + bounds.south) / 2;
    const span = Math.max(bounds.north - bounds.south, adjustedEast - bounds.west);
    const zoom = Math.max(5.8, Math.min(10, Math.log2(360 / Math.max(span, 0.01)) - 1.5));
    setViewState((previous) => ({ ...previous, longitude, latitude, zoom }));
    setCameraZoom(Math.round(zoom * 10) / 10);
    setTargetResolution(resolutionForZoom(zoom));
  };

  const applyQuickRegion = (regionId) => {
    const region = QUICK_REGIONS.find((item) => item.id === regionId);
    if (!region) return;
    setSelectedAOI({ type: "bounds", regionId: region.id, ...region });
    setBoundsDraft({
      north: String(region.north),
      south: String(region.south),
      west: String(region.west),
      east: String(region.east),
    });
    setAoiError("");
    setIsPlaying(false);
    focusBounds(region);
  };

  const applyCustomBounds = (event) => {
    event.preventDefault();
    const bounds = {
      north: Number(boundsDraft.north),
      south: Number(boundsDraft.south),
      west: Number(boundsDraft.west),
      east: Number(boundsDraft.east),
    };
    const valid = Object.values(bounds).every(Number.isFinite) &&
      bounds.north <= 90 && bounds.north >= -90 &&
      bounds.south <= 90 && bounds.south >= -90 &&
      bounds.north > bounds.south &&
      bounds.west <= 180 && bounds.west >= -180 &&
      bounds.east <= 180 && bounds.east >= -180 &&
      bounds.west !== bounds.east;
    if (!valid) {
      setAoiError("Revisa los límites: latitudes entre -90 y 90, longitudes entre -180 y 180 y Norte mayor que Sur.");
      return;
    }
    setSelectedAOI({ type: "bounds", label: "Caja de coordenadas", ...bounds });
    setAoiError("");
    setIsPlaying(false);
    focusBounds(bounds);
  };

  const selectHexagon = (record) => {
    try {
      const [latitude, longitude] = cellToLatLng(record.h3_index);
      const boundary = cellToBoundary(record.h3_index).map(([lat, lon]) => [lon, lat]);
      setSelectedAOI({
        type: "hexagon",
        label: `Hexágono ${record.h3_index}`,
        h3Index: record.h3_index,
        boundary,
      });
      setIsPlaying(false);
      setHoverInfo(null);
      const zoom = Math.max(viewState.zoom, 8);
      setViewState((previous) => ({ ...previous, longitude, latitude, zoom }));
      setCameraZoom(Math.round(zoom * 10) / 10);
      setTargetResolution(resolutionForZoom(zoom));
    } catch (error) {
      console.error("No se pudo seleccionar el hexágono:", error);
    }
  };

  const clearAOI = () => {
    setSelectedAOI(null);
    setAoiError("");
  };

  // 6. Estadísticas para la gráfica de anillo
  const chartData = useMemo(() => {
    let extremo = 0,
      alto = 0,
      moderado = 0;
    filteredData.forEach((d) => {
      if (d.total_frp > 150) extremo++;
      else if (d.total_frp > 50) alto++;
      else moderado++;
    });
    return [
      { name: "Extremo", value: extremo, color: activePalette.extremo.hex },
      { name: "Alto", value: alto, color: activePalette.alto.hex },
      { name: "Moderado", value: moderado, color: activePalette.moderado.hex },
    ];
  }, [filteredData, activePalette]);

  // Función auxiliar para colorear celdas del calendario según intensidad
  const getHeatColor = (ratio) => {
    const scale = activePalette.heatScale;
    if (ratio >= 0.8) return scale[4];
    if (ratio >= 0.6) return scale[3];
    if (ratio >= 0.4) return scale[2];
    if (ratio >= 0.2) return scale[1];
    return scale[0];
  };

  // 7. Capas WebGL (Mapa Base Esri + Etiquetas + Hexágonos H3 en el mismo lienzo)
  const layers = [
    new TileLayer({
      id: `esri-base-${mapTheme}`,
      data: BASEMAPS[mapTheme].base,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      renderSubLayers: (props) => {
        const {
          bbox: { west, south, east, north },
        } = props.tile;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [west, south, east, north],
        });
      },
    }),
    new TileLayer({
      id: `esri-labels-${mapTheme}`,
      data: BASEMAPS[mapTheme].labels,
      minZoom: 0,
      maxZoom: 16,
      tileSize: 256,
      renderSubLayers: (props) => {
        const {
          bbox: { west, south, east, north },
        } = props.tile;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [west, south, east, north],
        });
      },
    }),
    new H3HexagonLayer({
      id: "h3-hexagon-layer",
      data: filteredData,
      pickable: true,
      wireframe: false,
      filled: true,
      extruded: true,
      elevationScale: h3Resolution >= 7 ? 5 : 20,
      getHexagon: (d) => d.h3_index,
      getFillColor: (d) => {
        if (d.total_frp > 150) return activePalette.extremo.rgb;
        if (d.total_frp > 50) return activePalette.alto.rgb;
        return activePalette.moderado.rgb;
      },
      getElevation: (d) => d.total_frp,
      onHover: (info) => setHoverInfo(info),
      onClick: (info) => {
        if (info.object) selectHexagon(info.object);
      },
      updateTriggers: {
        getFillColor: [filteredData, colorRamp],
        getElevation: [filteredData, h3Resolution],
      },
    }),
  ];

  const selectedAOIPolygon = getAOIPolygon(selectedAOI);
  if (selectedAOIPolygon) {
    layers.push(
      new PolygonLayer({
        id: "aoi-selection-boundary",
        data: [{ polygon: selectedAOIPolygon }],
        getPolygon: (item) => item.polygon,
        stroked: true,
        filled: true,
        getFillColor: [249, 115, 22, 22],
        getLineColor: [251, 146, 60, 245],
        getLineWidth: 3,
        lineWidthMinPixels: 2,
        pickable: false,
      }),
    );
  }

  if (initialLoading) return <MapLoading />;

  return (
    <div className="flex h-screen w-full bg-gray-950 text-white overflow-hidden font-sans">
      {/* PANEL LATERAL DE CONTROL */}
      <div className="w-96 bg-gray-900/95 p-5 flex flex-col gap-3.5 z-10 shadow-2xl overflow-y-auto border-r border-gray-800">
        {/* Encabezado */}
        <div>
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-red-600">
              AuraHex
            </h1>
            <a
              href="/"
              className="text-[11px] text-gray-400 hover:text-white bg-gray-800 px-2.5 py-1 rounded-md border border-gray-700 transition-colors"
            >
              ← Portada
            </a>
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            Calendario Armonizado & Motor H3
          </p>

          <div className="mt-2.5 flex items-center justify-between bg-gray-800/70 px-3 py-2 rounded-lg border border-gray-700/60">
            {dataError ? (
              <span
                role="status"
                className="text-xs font-semibold text-orange-300"
              >
                Datos no disponibles
              </span>
            ) : (
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                </span>
                <span className="text-green-400">API SINCRONIZADA</span>
              </div>
            )}
            <span className="text-xs font-mono text-gray-300">
              {filteredData.length} celdas
            </span>
          </div>

          {/* BOTÓN SPRINT 1: EXPORTACIÓN CSV */}
          <button
            type="button"
            disabled={!canExportCsv}
            onClick={() =>
              downloadFireCsv(filteredData, loadedResolution, currentDate)
            }
            className="mt-2 w-full rounded-lg border border-orange-500/50 bg-orange-600/20 px-3 py-2 text-xs font-bold text-orange-200 transition-colors enabled:cursor-pointer enabled:hover:bg-orange-600/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden="true">⬇️ </span>Exportar CSV del día activo
          </button>
          <button
            type="button"
            disabled={!canExportRangeCsv}
            onClick={() => downloadAOIRangeCSV(rangeFilteredData, loadedResolution, dateStart, dateEnd, selectedAOI?.label)}
            className="mt-1 w-full rounded-lg border border-cyan-500/50 bg-cyan-600/15 px-3 py-2 text-xs font-bold text-cyan-100 transition-colors enabled:cursor-pointer enabled:hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden="true">⬇️ </span>Exportar CSV del AOI y periodo
          </button>
          {!dataError && !canExportCsv && (
            <p className="mt-1 text-[11px] text-gray-400">
              {exportPending
                ? "Actualizando resolución H3…"
                : "No hay celdas para exportar con estos filtros."}
            </p>
          )}
          {!dataError && !canExportRangeCsv && !exportPending && (
            <p className="mt-1 text-[10px] text-gray-500">No hay registros dentro del AOI y rango de fechas para exportar.</p>
          )}
        </div>

        {/* BOTÓN DESTACADO SPRINT 2: CALENDARIO DE ACTIVIDAD DE QUEMA */}
        <div className="bg-gradient-to-br from-orange-950/60 via-gray-900 to-gray-900 p-3.5 rounded-xl border border-orange-500/40 shadow-lg">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-orange-300">
              🔥 Calendario de Actividad
            </span>
            {currentDayStats && (
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                  currentDayStats.anomaly_pct >= 10
                    ? "bg-red-500/20 text-red-300 border border-red-500/40"
                    : currentDayStats.anomaly_pct <= -15
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                      : "bg-gray-800 text-gray-300 border border-gray-700"
                }`}
              >
                {currentDayStats.anomaly_pct > 0
                  ? `+${currentDayStats.anomaly_pct}%`
                  : `${currentDayStats.anomaly_pct}%`}{" "}
                vs Mediana
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-300 leading-relaxed mb-2.5">
            Compara la serie armonizada MODIS/VIIRS contra la mediana histórica
            e identifica anomalías.
          </p>
          <button
            onClick={() => setIsCalendarOpen(!isCalendarOpen)}
            className="w-full py-2 px-3 rounded-lg text-xs font-bold bg-orange-600 hover:bg-orange-500 text-white transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>
              📅{" "}
              {isCalendarOpen
                ? "Ocultar Calendario Histórico"
                : "Abrir Calendario de Quema"}
            </span>
          </button>
        </div>

        {/* SPRINT 3: SELECTOR DE ÁREA DE INTERÉS Y RANGO TEMPORAL */}
        <section className="rounded-xl border border-cyan-500/30 bg-gray-800/80 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">
              📍 Exploración por Área (AOI)
            </h3>
            {selectedAOI && (
              <button type="button" onClick={clearAOI} className="text-[10px] font-semibold text-orange-300 hover:text-white">
                Limpiar
              </button>
            )}
          </div>

          <div>
            <label htmlFor="quick-region" className="mb-1 block text-[10px] font-semibold text-gray-400">
              Regiones rápidas de exploración
            </label>
            <select
              id="quick-region"
              value={selectedAOI?.regionId || ""}
              onChange={(event) => applyQuickRegion(event.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-2.5 py-2 text-xs text-white outline-none focus:border-cyan-400"
            >
              <option value="">Seleccionar región…</option>
              {QUICK_REGIONS.map((region) => (
                <option key={region.id} value={region.id}>{region.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] leading-relaxed text-gray-500">
              Áreas rectangulares aproximadas para exploración; no representan límites administrativos oficiales ni zonas críticas detectadas automáticamente.
            </p>
          </div>

          <form onSubmit={applyCustomBounds} className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Caja de coordenadas (Lat/Lon)
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: "north", label: "Norte / Lat. máx.", min: -90, max: 90 },
                { key: "south", label: "Sur / Lat. mín.", min: -90, max: 90 },
                { key: "west", label: "Oeste / Lon. mín.", min: -180, max: 180 },
                { key: "east", label: "Este / Lon. máx.", min: -180, max: 180 },
              ].map((field) => (
                <label key={field.key} className="text-[10px] text-gray-400">
                  {field.label}
                  <input
                    type="number"
                    step="any"
                    min={field.min}
                    max={field.max}
                    required
                    value={boundsDraft[field.key]}
                    onChange={(event) => setBoundsDraft((previous) => ({ ...previous, [field.key]: event.target.value }))}
                    placeholder={field.key === "north" ? "32.7" : field.key === "south" ? "14.5" : field.key === "west" ? "-118.4" : "-86.5"}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 font-mono text-xs text-white outline-none focus:border-cyan-400"
                  />
                </label>
              ))}
            </div>
            <button type="submit" className="w-full rounded-lg border border-cyan-500/50 bg-cyan-600/20 px-3 py-2 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-600/35">
              Aplicar caja Lat/Lon
            </button>
            <p className="text-[10px] leading-relaxed text-gray-500">
              El filtrado usa el centro geográfico de cada celda H3; las celdas que cruzan el borde pueden quedar incluidas o excluidas según su centro.
            </p>
          </form>

          {aoiError && <p role="alert" className="text-[10px] leading-relaxed text-red-300">{aoiError}</p>}
          <div className="rounded-lg border border-gray-700 bg-gray-900/70 p-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Área activa</div>
            <div className="mt-0.5 break-words text-xs font-semibold text-gray-200">
              {selectedAOI?.label || "Vista global"}
            </div>
            <div className="mt-1 text-[10px] text-gray-400">
              {selectedAOI ? `${rangeFilteredData.length.toLocaleString()} registros armonizados en el AOI` : `${fireData.length.toLocaleString()} registros en la cobertura actual`}
            </div>
            <p className="mt-1 text-[10px] text-gray-500">
              También puedes hacer clic directamente en un hexágono del mapa para inspeccionar su historial.
            </p>
          </div>

          <div className="border-t border-gray-700 pt-2">
            <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300">Periodo de análisis</h4>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] text-gray-400">
                Inicio
                <input
                  type="date"
                  min={uniqueDates[0] || undefined}
                  max={dateEnd || uniqueDates.at(-1) || undefined}
                  value={dateStart}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDateStart(value);
                    if (dateEnd && value > dateEnd) setDateEnd(value);
                    setIsPlaying(false);
                  }}
                  className="mt-1 w-full min-w-0 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-white outline-none focus:border-cyan-400"
                />
              </label>
              <label className="text-[10px] text-gray-400">
                Fin
                <input
                  type="date"
                  min={dateStart || uniqueDates[0] || undefined}
                  max={uniqueDates.at(-1) || undefined}
                  value={dateEnd}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDateEnd(value);
                    if (dateStart && value < dateStart) setDateStart(value);
                    setIsPlaying(false);
                  }}
                  className="mt-1 w-full min-w-0 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-white outline-none focus:border-cyan-400"
                />
              </label>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-500">
              {rangeDates.length} días disponibles en el periodo seleccionado.
            </p>
          </div>
        </section>

        {/* Selector de Mapa Base y Rampa de Color Accesible */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <h3 className="text-[11px] text-gray-400 uppercase font-bold tracking-wider mb-1.5">
              Mapa Base
            </h3>
            <div className="grid grid-cols-2 gap-1">
              {Object.entries(BASEMAPS).map(([key]) => (
                <button
                  key={key}
                  onClick={() => setMapTheme(key)}
                  className={`py-1.5 px-2 rounded-lg text-[11px] font-bold transition-all border ${
                    mapTheme === key
                      ? "bg-orange-600/20 border-orange-500 text-orange-300"
                      : "bg-gray-800 border-gray-700 text-gray-400"
                  }`}
                >
                  {key === "DARK" ? "🌑 Oscuro" : "🛰️ Satélite"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-[11px] text-gray-400 uppercase font-bold tracking-wider mb-1.5">
              Paleta Color
            </h3>
            <div className="grid grid-cols-2 gap-1">
              {Object.entries(COLOR_RAMPS).map(([key]) => (
                <button
                  key={key}
                  onClick={() => setColorRamp(key)}
                  className={`py-1.5 px-2 rounded-lg text-[11px] font-bold transition-all border ${
                    colorRamp === key
                      ? "bg-indigo-600/30 border-indigo-400 text-indigo-200"
                      : "bg-gray-800 border-gray-700 text-gray-400"
                  }`}
                >
                  {key === "THERMAL" ? "🔥 Térmica" : "👁️ Viridis"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Motor de Zoom Semántico H3 */}
        <div className="bg-gray-800/90 p-3 rounded-xl border border-gray-700">
          <div className="flex justify-between items-center mb-1">
            <h3 className="text-xs text-gray-400 uppercase font-bold tracking-wider">
              Zoom Semántico H3
            </h3>
            {isRecalculating && (
              <span className="text-[11px] text-orange-400 animate-pulse font-bold">
                🔄 Recalculando...
              </span>
            )}
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-gray-300">Zoom / Resolución:</span>
            <span className="font-mono font-bold text-orange-400">
              {cameraZoom.toFixed(1)}x • Nivel {h3Resolution}
            </span>
          </div>
          <div className="mt-1 pt-1 border-t border-gray-700/70 flex justify-between text-[11px] text-gray-400">
            <span>Área por celda:</span>
            <span className="font-mono text-gray-200">
              {H3_SCALE_INFO[h3Resolution]}
            </span>
          </div>
        </div>

        {/* Línea de Tiempo (Time-Lapse 30 días) */}
        <div className="bg-gray-800/90 p-3 rounded-xl border border-gray-700">
          <h3 className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-2">
            Evolución Temporal ({rangeDates.length} Días)
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              disabled={rangeDates.length < 2}
              className="bg-orange-600 hover:bg-orange-500 text-white rounded-full w-9 h-9 flex items-center justify-center transition-colors shrink-0 shadow-lg cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPlaying ? "⏸" : "▶"}
            </button>
            <div className="flex-1">
              <div className="text-sm font-bold text-orange-300 font-mono">
                {currentDate || "Cargando..."}
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(0, rangeDates.length - 1)}
                value={Math.max(0, rangeDates.indexOf(currentDate))}
                disabled={rangeDates.length === 0}
                onChange={(e) => {
                  setIsPlaying(false);
                  setCurrentDate(rangeDates[Number(e.target.value)] || "");
                }}
                className="w-full accent-orange-500 mt-1 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Filtro Satelital */}
        <div>
          <h3 className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-1.5">
            Constelación Satelital (3 Fuentes)
          </h3>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() =>
                setActiveSats({ ...activeSats, MODIS: !activeSats.MODIS })
              }
              className={`px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                activeSats.MODIS
                  ? "bg-blue-600 text-white shadow-md"
                  : "bg-gray-800 text-gray-500 border border-gray-700"
              }`}
            >
              MODIS
              <span className="block text-[9px] font-normal opacity-80">
                Terra / Aqua
              </span>
            </button>
            <button
              onClick={() =>
                setActiveSats({ ...activeSats, NOAA20: !activeSats.NOAA20 })
              }
              className={`px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                activeSats.NOAA20
                  ? "bg-purple-600 text-white shadow-md"
                  : "bg-gray-800 text-gray-500 border border-gray-700"
              }`}
            >
              VIIRS N20
              <span className="block text-[9px] font-normal opacity-80">
                NOAA-20
              </span>
            </button>
            <button
              onClick={() =>
                setActiveSats({ ...activeSats, NOAA21: !activeSats.NOAA21 })
              }
              className={`px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                activeSats.NOAA21
                  ? "bg-fuchsia-600 text-white shadow-md"
                  : "bg-gray-800 text-gray-500 border border-gray-700"
              }`}
            >
              VIIRS N21
              <span className="block text-[9px] font-normal opacity-80">
                NOAA-21
              </span>
            </button>
          </div>
        </div>

        {/* Nivel de Amenaza */}
        <div>
          <h3 className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-1.5">
            Nivel de Amenaza (FRP)
          </h3>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() =>
                setActiveThreats({
                  ...activeThreats,
                  EXTREMO: !activeThreats.EXTREMO,
                })
              }
              className={`flex justify-between items-center px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                activeThreats.EXTREMO
                  ? "border-red-500/80 bg-gray-800 text-white"
                  : "border-gray-800 bg-gray-800/40 text-gray-500"
              }`}
            >
              <span className="font-bold">Extremo ({">"}150 MW)</span>
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: activePalette.extremo.hex }}
              ></span>
            </button>
            <button
              onClick={() =>
                setActiveThreats({
                  ...activeThreats,
                  ALTO: !activeThreats.ALTO,
                })
              }
              className={`flex justify-between items-center px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                activeThreats.ALTO
                  ? "border-orange-500/80 bg-gray-800 text-white"
                  : "border-gray-800 bg-gray-800/40 text-gray-500"
              }`}
            >
              <span className="font-bold">Alto (50–150 MW)</span>
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: activePalette.alto.hex }}
              ></span>
            </button>
            <button
              onClick={() =>
                setActiveThreats({
                  ...activeThreats,
                  MODERADO: !activeThreats.MODERADO,
                })
              }
              className={`flex justify-between items-center px-3 py-1.5 rounded-lg text-xs transition-colors border ${
                activeThreats.MODERADO
                  ? "border-yellow-500/80 bg-gray-800 text-white"
                  : "border-gray-800 bg-gray-800/40 text-gray-500"
              }`}
            >
              <span className="font-bold">Moderado ({"<"}50 MW)</span>
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: activePalette.moderado.hex }}
              ></span>
            </button>
          </div>
        </div>

        {/* Gráfica de Distribución */}
        <div className="bg-gray-800/90 p-3 rounded-xl border border-gray-700">
          <h3 className="text-xs text-gray-400 uppercase font-bold tracking-wider mb-1">
            Distribución de Severidad
          </h3>
          <div className="h-28 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={24}
                  outerRadius={42}
                  paddingAngle={3}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "#111827",
                    border: "1px solid #374151",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  itemStyle={{ color: "#fff" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="mt-auto pt-1">
          <p className="text-[11px] text-gray-500 text-center">
            NASA Space Apps Challenge • AuraHex
          </p>
        </div>
      </div>

      {/* LIENZO 3D PRINCIPAL */}
      <div className="flex-1 relative bg-gray-950">
        <DeckGL
          viewState={viewState}
          controller={true}
          layers={layers}
          onViewStateChange={onViewStateChange}
        />

        {selectedAOI && (
          <div className="absolute top-4 left-4 z-20 max-w-[min(22rem,55%)] rounded-xl border border-orange-500/50 bg-gray-900/90 px-3 py-2 shadow-xl backdrop-blur-md">
            <div className="text-[9px] font-bold uppercase tracking-wider text-orange-300">Área de interés activa</div>
            <div className="truncate text-xs font-semibold text-white">{selectedAOI.label}</div>
            <div className="text-[10px] text-gray-400">{rangeFilteredData.length.toLocaleString()} registros · {dateStart || "inicio"} a {dateEnd || "fin"}</div>
          </div>
        )}

        {/* Botón flotante superior derecho para acceso rápido al Calendario */}
        <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
          <button
            onClick={() => setIsCalendarOpen(!isCalendarOpen)}
            className="bg-gray-900/90 hover:bg-gray-800 text-white px-4 py-2 rounded-xl border border-orange-500/50 shadow-2xl text-xs font-bold flex items-center gap-2 backdrop-blur-md cursor-pointer transition-all"
          >
            <span>📅 Calendario Armonizado</span>
            {rangeDates.length > 0 && (
              <span className="bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded-md font-mono">
                Mediana AOI: {aoiSummary.median_daily_cells} celdas/día
              </span>
            )}
          </button>
        </div>

        {/* PANEL / MODAL INTERACTIVO DEL CALENDARIO DE ACTIVIDAD DE QUEMA (SPRINT 2) */}
        {isCalendarOpen && fireData.length > 0 && (
          <div className="absolute inset-x-6 bottom-8 z-30 bg-gray-900/95 backdrop-blur-xl border border-gray-700 rounded-2xl shadow-2xl p-5 max-h-[78vh] flex flex-col overflow-hidden">
            {/* Cabecera del Calendario */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-gray-800">
              <div>
                <h2 className="text-lg font-extrabold text-white flex items-center gap-2">
                  <span>
                    📅 Calendario de Actividad de Quema — {selectedAOI?.label || "Vista global"}
                  </span>
                  <span className="text-xs font-mono bg-orange-500/20 text-orange-300 px-2.5 py-0.5 rounded-full border border-orange-500/30">
                    H3 Nivel {h3Resolution}
                  </span>
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  Actividad calculada con los registros armonizados del área y del periodo seleccionados.
                  La anomalía se compara contra la mediana diaria de este mismo periodo.
                </p>
              </div>

              {/* Pestañas del Calendario */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCalendarTab("HEATMAP")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    calendarTab === "HEATMAP"
                      ? "bg-orange-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  🗓️ Mapa de Calor (30 Días)
                </button>
                <button
                  onClick={() => setCalendarTab("ANOMALIES")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    calendarTab === "ANOMALIES"
                      ? "bg-orange-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  📈 Anomalías vs. Mediana
                </button>
                <button
                  onClick={() => setCalendarTab("MULTIYEAR")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    calendarTab === "MULTIYEAR"
                      ? "bg-orange-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  🏛️ Régimen Multi-Anual (2019–2026)
                </button>
                <button
                  onClick={() => setIsCalendarOpen(false)}
                  className="ml-2 bg-gray-800 hover:bg-red-900/60 text-gray-300 hover:text-white w-8 h-8 rounded-lg flex items-center justify-center font-bold border border-gray-700 cursor-pointer"
                  title="Cerrar calendario"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Tarjetas KPI de Armonización */}
            <div className="grid grid-cols-4 gap-3 my-3">
              <div className="bg-gray-800/70 p-3 rounded-xl border border-gray-700/70">
                <div className="text-[11px] text-gray-400 uppercase font-semibold">
                  Mediana del Periodo
                </div>
                <div className="text-xl font-extrabold text-white font-mono mt-0.5">
                  {aoiSummary.median_daily_cells}{" "}
                  <span className="text-xs font-normal text-gray-400">
                    celdas H3/día
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  Energía mediana: {aoiSummary.median_daily_frp} MW
                </div>
              </div>

              <div className="bg-gray-800/70 p-3 rounded-xl border border-gray-700/70">
                <div className="text-[11px] text-gray-400 uppercase font-semibold">
                  Día Crítico (Pico)
                </div>
                <div className="text-xl font-extrabold text-orange-400 font-mono mt-0.5">
                  {aoiSummary.peak_date}
                </div>
                <div className="text-[11px] text-red-300 mt-0.5">
                  {aoiSummary.peak_cells} celdas (
                  {aoiSummary.peak_anomaly_pct > 0
                    ? `+${aoiSummary.peak_anomaly_pct}%`
                    : `${aoiSummary.peak_anomaly_pct}%`}{" "}
                  sobre mediana)
                </div>
              </div>

              <div className="bg-gray-800/70 p-3 rounded-xl border border-gray-700/70">
                <div className="text-[11px] text-gray-400 uppercase font-semibold">
                  Reducción de Duplicados
                </div>
                <div className="text-xl font-extrabold text-emerald-400 font-mono mt-0.5">
                  {aoiSummary.harmonization_efficiency_pct}%
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  {aoiSummary.total_raw_detections.toLocaleString()}{" "}
                  focos →{" "}
                  {aoiSummary.total_harmonized_cell_days.toLocaleString()}{" "}
                  celdas
                </div>
              </div>

              <div className="bg-gray-800/70 p-3 rounded-xl border border-gray-700/70">
                <div className="text-[11px] text-gray-400 uppercase font-semibold">
                  Fecha Activa en Mapa
                </div>
                <div className="text-xl font-extrabold text-blue-400 font-mono mt-0.5">
                  {currentDate || "-"}
                </div>
                <div className="text-[11px] text-gray-300 mt-0.5">
                  {currentDayStats
                    ? `${currentDayStats.harmonized_cells} celdas (${currentDayStats.anomaly_pct > 0 ? "+" : ""}${currentDayStats.anomaly_pct}% vs mediana)`
                    : "Selecciona un día"}
                </div>
              </div>
            </div>

            {/* CONTENIDO DE PESTAÑA 1: HEATMAP CALENDARIO DIARIO INTERACTIVO */}
            {calendarTab === "HEATMAP" && (
              <div className="overflow-y-auto pr-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-300 font-semibold">
                    Haz clic en cualquier día del calendario para sincronizar el
                    Mapa 3D:
                  </span>
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                    <span>Menor actividad</span>
                    {activePalette.heatScale.map((c, idx) => (
                      <span
                        key={idx}
                        className="w-4 h-3 rounded-sm inline-block border border-gray-700"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <span>Periodo crítico</span>
                  </div>
                </div>

                <div className="grid grid-cols-6 sm:grid-cols-10 gap-2">
                  {aoiCalendar.daily.map((dayItem) => {
                    const dailyRange = aoiSummary.max_daily_cells - aoiSummary.min_daily_cells;
                    const ratio = dailyRange === 0
                      ? (dayItem.harmonized_cells > 0 ? 1 : 0)
                      : (dayItem.harmonized_cells - aoiSummary.min_daily_cells) / dailyRange;
                    const bg = getHeatColor(ratio);
                    const isSelected = currentDate === dayItem.date;

                    return (
                      <button
                        key={dayItem.date}
                        onClick={() => {
                          if (rangeDates.includes(dayItem.date)) {
                            setIsPlaying(false);
                            setCurrentDate(dayItem.date);
                          }
                        }}
                        style={{ backgroundColor: bg }}
                        className={`p-2.5 rounded-xl text-left transition-all cursor-pointer border ${
                          isSelected
                            ? "ring-2 ring-white border-white scale-[1.03]"
                            : "border-gray-700/80 hover:border-gray-400"
                        }`}
                      >
                        <div className="text-[11px] font-mono font-bold text-white drop-shadow">
                          {dayItem.date.slice(5)}
                        </div>
                        <div className="text-sm font-extrabold text-white mt-0.5 drop-shadow">
                          {dayItem.harmonized_cells}
                        </div>
                        <div className="text-[10px] font-mono text-gray-100 opacity-90">
                          {dayItem.anomaly_pct > 0
                            ? `+${dayItem.anomaly_pct}%`
                            : `${dayItem.anomaly_pct}%`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* CONTENIDO DE PESTAÑA 2: GRÁFICA DE ANOMALÍAS DIARIAS Y ESTACIONALES VS MEDIANA */}
            {calendarTab === "ANOMALIES" && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-64">
                <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-800 flex flex-col">
                  <h4 className="text-xs font-bold text-gray-300 uppercase mb-2">
                    Serie Diaria Armonizada vs. Mediana del Periodo
                  </h4>
                  <div className="flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={aoiCalendar.daily}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(v) => v.slice(5)}
                          stroke="#9ca3af"
                          fontSize={10}
                        />
                        <YAxis stroke="#9ca3af" fontSize={10} />
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: "#111827",
                            border: "1px solid #374151",
                            borderRadius: "8px",
                            fontSize: "12px",
                          }}
                        />
                        <ReferenceLine
                          y={aoiSummary.median_daily_cells}
                          stroke="#38bdf8"
                          strokeDasharray="4 4"
                          label={{
                            value: "Mediana",
                            fill: "#38bdf8",
                            fontSize: 10,
                          }}
                        />
                        <Bar
                          dataKey="harmonized_cells"
                          name="Celdas H3 Activas"
                          fill={activePalette.alto.hex}
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-800 flex flex-col">
                  {selectedAOI ? (
                    <>
                      <h4 className="text-xs font-bold text-gray-300 uppercase mb-2">Comparativa histórica regional</h4>
                      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-gray-700 p-5 text-center">
                        <div>
                          <div className="text-2xl">🧭</div>
                          <p className="mt-2 text-sm font-semibold text-gray-200">Referencia histórica regional no disponible</p>
                          <p className="mt-1 text-xs leading-relaxed text-gray-400">
                            La API entrega 31 días de celdas armonizadas y un calendario histórico global. No contiene una serie multi-anual geolocalizada para calcular una mediana histórica exclusiva de este AOI.
                          </p>
                        </div>
                      </div>
                    </>
                  ) : calendarData?.monthly_climatology ? (
                    <>
                      <h4 className="text-xs font-bold text-gray-300 uppercase mb-2">
                        Comparativa mensual global: actividad y referencia climatológica
                      </h4>
                      <div className="flex-1">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={calendarData.monthly_climatology}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <XAxis dataKey="month" stroke="#9ca3af" fontSize={10} />
                            <YAxis stroke="#9ca3af" fontSize={10} />
                            <RechartsTooltip contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: "8px", fontSize: "12px" }} />
                            <Bar dataKey="current_year" name="Actividad estimada/observada (celdas H3)" fill={activePalette.extremo.hex} radius={[4, 4, 0, 0]} />
                            <Line type="monotone" dataKey="historical_median" name="Referencia mediana" stroke="#38bdf8" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="critical_threshold" name="Umbral de referencia" stroke="#facc15" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                      <p className="mt-1 text-[10px] text-gray-500">Referencia global del backend; no está filtrada por el rango ni representa una climatología regional observada.</p>
                    </>
                  ) : (
                    <p className="m-auto text-xs text-gray-400">No hay datos de referencia mensual disponibles.</p>
                  )}
                </div>
              </div>
            )}

            {/* CONTENIDO DE PESTAÑA 3: MATRIZ MULTI-ANUAL (AÑOS X MESES) */}
            {calendarTab === "MULTIYEAR" && selectedAOI && (
              <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-gray-700 p-6 text-center">
                <div className="max-w-xl">
                  <div className="text-2xl">🗺️</div>
                  <h3 className="mt-2 text-sm font-bold text-white">Matriz multi-anual no disponible para este AOI</h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-400">La matriz actual del backend es global y no conserva la ubicación de cada año/mes. Para no atribuir cifras globales a una región, esta vista se habilitará cuando exista un histórico multi-anual geolocalizado.</p>
                </div>
              </div>
            )}

            {calendarTab === "MULTIYEAR" && !selectedAOI && calendarData?.multiyear_matrix && (
              <div className="overflow-x-auto overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-800">
                      <th className="py-2 px-2 text-left font-bold">Año</th>
                      {[
                        "Ene",
                        "Feb",
                        "Mar",
                        "Abr",
                        "May",
                        "Jun",
                        "Jul",
                        "Ago",
                        "Sep",
                        "Oct",
                        "Nov",
                        "Dic",
                      ].map((m) => (
                        <th key={m} className="py-2 px-2 text-center font-bold">
                          {m}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {calendarData.multiyear_matrix.map((row) => (
                      <tr
                        key={row.year}
                        className="border-b border-gray-800/60"
                      >
                        <td className="py-1.5 px-2 font-mono font-bold text-gray-200">
                          {row.year}
                        </td>
                        {row.months.map((mCell) => (
                          <td key={mCell.month} className="p-1">
                            <div
                              style={{
                                backgroundColor: getHeatColor(
                                  mCell.ratio_to_peak,
                                ),
                              }}
                              className="rounded-md py-1.5 px-1 text-center font-mono text-[11px] text-white font-semibold border border-black/20"
                              title={`${row.year} - ${mCell.month}: ${mCell.cells.toLocaleString()} celdas H3 armonizadas`}
                            >
                              {mCell.cells.toLocaleString()}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Atribución inferior derecha */}
        <div className="absolute bottom-2 right-3 z-20 bg-gray-900/80 px-2.5 py-1 rounded text-[11px] text-gray-400 border border-gray-800 pointer-events-none">
          Tiles © Esri, HERE, Garmin, USGS • Motor H3 Deck.gl
        </div>

        {/* Tooltip 3D al pasar el cursor */}
        {hoverInfo && hoverInfo.object && (
          <div
            className="absolute z-50 bg-gray-900/95 backdrop-blur-md border border-gray-700 text-white p-3.5 rounded-xl shadow-2xl pointer-events-none transform -translate-x-1/2 -translate-y-full -mt-3 min-w-56"
            style={{ left: hoverInfo.x, top: hoverInfo.y }}
          >
            <div className="text-[11px] font-mono text-gray-400 mb-0.5">
              H3 (Res {h3Resolution}): {hoverInfo.object.h3_index}
            </div>
            <div className="text-xl font-extrabold text-orange-400 mb-2">
              {hoverInfo.object.total_frp.toFixed(1)} MW (FRP)
            </div>
            <div className="flex flex-col gap-1 text-xs border-t border-gray-800 pt-2">
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Temp. Brillo Est.:</span>
                <span className="font-bold text-red-300">
                  {Math.max(
                    0,
                    hoverInfo.object.avg_brightness - 273.15,
                  ).toFixed(1)}{" "}
                  °C
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Confianza Promedio:</span>
                <span className="font-bold text-green-400">
                  {hoverInfo.object.avg_confidence.toFixed(0)}%
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Satélites:</span>
                <span className="font-bold text-right text-blue-300">
                  {hoverInfo.object.instruments}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Focos fusionados:</span>
                <span className="font-bold">
                  {hoverInfo.object.point_count}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
