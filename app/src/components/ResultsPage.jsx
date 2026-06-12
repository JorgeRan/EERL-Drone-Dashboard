import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { color } from "../constants/tailwind";
import {
  calculateDistanceMeters,
  filterCoordinateOutliers,
  extractTelemetryMetrics,
  getTelemetryPeakValue,
  inferFlowSensorMode,
  SENSOR_MODE_AERIS,
  SENSOR_MODE_DUAL,
  SENSOR_MODE_MIXED,
  toFiniteNumber,
} from "../constants/telemetryMetrics";
import { MethanePanel } from "./MethanePanel";
import { OpacityAdjuster } from "./OpacitySlider";
import {
  deleteAllData,
  deleteMission,
  listMissions,
  listTelemetryHistory,
  listTelemetryHistoryAggregated,
  runAerisAnalysis,
} from "../services/api";
import {
  SquarePen,
  Trash,
  RotateCcw,
  Play,
  Pause,
  Square,
  Download,
  Paperclip,
} from "lucide-react";
import { AerisPanel } from "./AerisPanel";
import { MissionModal } from "./MissionModal";
import { CSVImportModal } from "./CSVModal";
import { DeckMap } from "./DeckMap";
import { Map } from "./Map";
import { buildDeckTracePointsFromFlowData } from "../shared/deckTraceData";
import { getScaledMethaneColor } from "../constants/methaneScale";
import JSZip from "jszip";
import { fromBlob as geotiffFromBlob } from "geotiff";

const ALL_DRONES_OPTION = "ALL";
const ALL_DATA_MISSION_ID = "ALL_DATA_MISSION";
const REPLAY_STEP_MS = 180;
const METHANE_MOLAR_MASS_KG_PER_MOL = 0.01604;
const UNIVERSAL_GAS_CONSTANT = 8.314462618;
const DEFAULT_BACKGROUND_PPM = 1.9;
const DEFAULT_TEMPERATURE_K = 293.15;
const DEFAULT_PRESSURE_PA = 101325.0;
const DEFAULT_TRANSECT_WIDTH_M = 80.0;
const DEFAULT_MIXING_HEIGHT_M = 25.0;
const DELETE_ALL_HOLD_MS = 2000;
const METHANE_VALID_VALID = 1;
const METHANE_VALID_INVALID = 2;
const START_POINT_FILTER_DEFAULT_RADIUS_METERS = 25;
const VIEWPORT_TELEMETRY_LIMIT = 12000;
const VIEWPORT_TILE_CACHE_TTL_MS = 15000;
const VIEWPORT_TILE_CACHE_MAX_ENTRIES = 120;
const VIEWPORT_ZOOM_BUCKET_STEP = 0.5;
const ORTHOPHOTO_ACCEPT_ATTR =
  ".tif,.tiff,.kmz,application/vnd.google-earth.kmz,image/tiff";

const MAX_ORTHOPHOTO_DIMENSION = 2048;

const canvasToBlob = (canvas, mimeType = "image/png") =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas toBlob failed."));
      }
    }, mimeType);
  });

const normalizeOrthophotoCoordinates = (west, south, east, north) => [
  [west, north],
  [east, north],
  [east, south],
  [west, south],
];

const isLatLonBounds = ([west, south, east, north]) =>
  [west, east].every(
    (value) => Number.isFinite(value) && Math.abs(value) <= 180,
  ) &&
  [south, north].every(
    (value) => Number.isFinite(value) && Math.abs(value) <= 90,
  ) &&
  south < north &&
  west < east;

const buildOrthophotoOverlayFromGeoTiff = async (file) => {
  const tiff = await geotiffFromBlob(file);
  const image = await tiff.getImage();
  const width = Number(image.getWidth?.() ?? image.width ?? 0);
  const height = Number(image.getHeight?.() ?? image.height ?? 0);

  if (!width || !height) {
    throw new Error("GeoTIFF image dimensions are missing.");
  }

  const boundingBox = image.getBoundingBox?.();
  if (
    !Array.isArray(boundingBox) ||
    boundingBox.length !== 4 ||
    !isLatLonBounds(boundingBox)
  ) {
    throw new Error(
      "GeoTIFF must be georeferenced in latitude/longitude (EPSG:4326).",
    );
  }

  const coordinates = normalizeOrthophotoCoordinates(...boundingBox);
  const rgb = await image.readRGB({ interleave: true });

  // Decode into a full-resolution canvas first.
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) {
    throw new Error("Unable to create image canvas.");
  }
  const imageData = srcCtx.createImageData(width, height);
  for (
    let sourceIndex = 0, targetIndex = 0;
    targetIndex < imageData.data.length;
    sourceIndex += 3, targetIndex += 4
  ) {
    imageData.data[targetIndex] = rgb[sourceIndex] ?? 0;
    imageData.data[targetIndex + 1] = rgb[sourceIndex + 1] ?? rgb[sourceIndex] ?? 0;
    imageData.data[targetIndex + 2] = rgb[sourceIndex + 2] ?? rgb[sourceIndex] ?? 0;
    imageData.data[targetIndex + 3] = 255;
  }
  srcCtx.putImageData(imageData, 0, 0);

  // Downsample to MAX_ORTHOPHOTO_DIMENSION to stay within Mapbox texture limits.
  const scale = Math.min(1, MAX_ORTHOPHOTO_DIMENSION / Math.max(width, height));
  const outWidth = Math.round(width * scale);
  const outHeight = Math.round(height * scale);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outWidth;
  outCanvas.height = outHeight;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) {
    throw new Error("Unable to create output canvas.");
  }
  outCtx.drawImage(srcCanvas, 0, 0, width, height, 0, 0, outWidth, outHeight);

  // Use a blob URL — much cheaper than a base64 data URL for large rasters.
  const blob = await canvasToBlob(outCanvas, "image/png");
  const imageUrl = URL.createObjectURL(blob);

  return {
    type: "geotiff",
    fileName: file.name,
    imageUrl,
    coordinates,
    width: outWidth,
    height: outHeight,
  };
};

const resolveKmzAssetPath = (kmlEntryName, href) => {
  const trimmedHref = String(href || "").trim();
  if (!trimmedHref) {
    return "";
  }

  if (!trimmedHref.includes("../")) {
    const baseParts = kmlEntryName.split("/");
    baseParts.pop();
    return [...baseParts, trimmedHref].filter(Boolean).join("/");
  }

  const resolved = kmlEntryName.split("/");
  resolved.pop();

  trimmedHref.split("/").forEach((part) => {
    if (!part || part === ".") {
      return;
    }
    if (part === "..") {
      resolved.pop();
      return;
    }
    resolved.push(part);
  });

  return resolved.join("/");
};

const buildOrthophotoOverlayFromKmz = async (file) => {
  const zip = await JSZip.loadAsync(file);
  const kmlEntry = Object.values(zip.files).find(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith(".kml"),
  );
  console.log("[buildOrthophotoOverlayFromKmz] KMZ entries:", Object.keys(zip.files));
  if (!kmlEntry) {
    throw new Error("KMZ file does not contain a KML document.");
  }

  const kmlText = await kmlEntry.async("string");
  console.log("[buildOrthophotoOverlayFromKmz] KML content:", kmlText);
  const xml = new DOMParser().parseFromString(kmlText, "application/xml");
  const groundOverlay = xml.querySelector("GroundOverlay");

  if (!groundOverlay) {
    throw new Error("KMZ must contain a GroundOverlay.");
  }
  console.log("[buildOrthophotoOverlayFromKmz] GroundOverlay element found:", groundOverlay);

  const href = groundOverlay.querySelector("Icon > href")?.textContent?.trim();
  const latLonBox = groundOverlay.querySelector("LatLonBox");
  console.log("[buildOrthophotoOverlayFromKmz] href:", href);
  const north = Number(latLonBox?.querySelector("north")?.textContent);
  const south = Number(latLonBox?.querySelector("south")?.textContent);
  const east = Number(latLonBox?.querySelector("east")?.textContent);
  const west = Number(latLonBox?.querySelector("west")?.textContent);

  if (!href || !isLatLonBounds([west, south, east, north])) {
    throw new Error(
      "KMZ GroundOverlay must include a valid LatLonBox and image reference.",
    );
  }

  const assetPath = resolveKmzAssetPath(kmlEntry.name, href);
  const imageEntry = zip.file(assetPath) || zip.file(href);

  if (!imageEntry) {
    throw new Error("KMZ overlay image was not found in the archive.");
  }

  const imageBlob = await imageEntry.async("blob");

  return {
    type: "kmz",
    fileName: file.name,
    imageUrl: URL.createObjectURL(imageBlob),
    coordinates: normalizeOrthophotoCoordinates(west, south, east, north),
  };
};

const getGridDegreesForZoom = (zoomLevel) => {
  const zoom = Number(zoomLevel);

  if (zoom >= 16) {
    return 0.0001;
  }

  if (zoom >= 14) {
    return 0.0002;
  }

  if (zoom >= 12) {
    return 0.0003;
  }

  if (zoom >= 10) {
    return 0.0005;
  }

  return 0.00075;
};

const toTileBucket = (value, tileSpan) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isFinite(tileSpan) || tileSpan <= 0) {
    return "na";
  }

  return String(Math.floor(numeric / tileSpan));
};

const buildViewportTileCacheKey = ({ viewport, range, gridDegrees }) => {
  const zoom = Number(viewport?.zoom);
  const zoomBucket = Number.isFinite(zoom)
    ? Math.floor(zoom / VIEWPORT_ZOOM_BUCKET_STEP) * VIEWPORT_ZOOM_BUCKET_STEP
    : 0;
  const minLatitude = Number(viewport?.minLatitude);
  const maxLatitude = Number(viewport?.maxLatitude);
  const minLongitude = Number(viewport?.minLongitude);
  const maxLongitude = Number(viewport?.maxLongitude);
  const tileSpan = Math.max(Number(gridDegrees || 0), 0.00005) * 60;
  const from = typeof range?.from === "string" ? range.from.trim() : "";
  const to = typeof range?.to === "string" ? range.to.trim() : "";

  return [
    `z:${zoomBucket.toFixed(1)}`,
    `g:${Number(gridDegrees || 0).toFixed(6)}`,
    `lat:${toTileBucket(minLatitude, tileSpan)}:${toTileBucket(maxLatitude, tileSpan)}`,
    `lon:${toTileBucket(minLongitude, tileSpan)}:${toTileBucket(maxLongitude, tileSpan)}`,
    `from:${from || "-"}`,
    `to:${to || "-"}`,
  ].join("|");
};

const pruneViewportTileCache = (cache) => {
  if (!(cache instanceof globalThis.Map)) {
    return;
  }

  const now = Date.now();

  for (const [cacheKey, entry] of cache.entries()) {
    if (now - Number(entry?.cachedAt || 0) > VIEWPORT_TILE_CACHE_TTL_MS) {
      cache.delete(cacheKey);
    }
  }

  if (cache.size <= VIEWPORT_TILE_CACHE_MAX_ENTRIES) {
    return;
  }

  const sortedEntries = [...cache.entries()].sort(
    (left, right) => Number(left[1]?.cachedAt || 0) - Number(right[1]?.cachedAt || 0),
  );

  const deleteCount = cache.size - VIEWPORT_TILE_CACHE_MAX_ENTRIES;
  for (let index = 0; index < deleteCount; index += 1) {
    const cacheKey = sortedEntries[index]?.[0];
    if (cacheKey) {
      cache.delete(cacheKey);
    }
  }
};

const filterFlowPointsOutsideStartRadius = (
  flowPoints,
  { enabled, startPoint, radiusMeters },
) => {
  const points = Array.isArray(flowPoints) ? flowPoints : [];

  if (
    !enabled ||
    !startPoint ||
    !Number.isFinite(startPoint.latitude) ||
    !Number.isFinite(startPoint.longitude) ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0
  ) {
    return points;
  }

  return points.filter((point) => {
    const latitude = Number(point?.latitude);
    const longitude = Number(point?.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return true;
    }

    const distanceMeters = calculateDistanceMeters(
      startPoint.latitude,
      startPoint.longitude,
      latitude,
      longitude,
    );

    if (!Number.isFinite(distanceMeters)) {
      return true;
    }

    return distanceMeters > radiusMeters;
  });
};

const resolveRawMethaneValidity = (source) => {
  const candidates = [
    source?.methane_valid,
    source?.methaneValid,
    source?.payload?.methane_valid,
    source?.payload?.methaneValid,
  ];

  const firstDefined = candidates.find(
    (candidate) => candidate !== undefined && candidate !== null,
  );

  return firstDefined;
};

const getTelemetryMethaneValidity = (source) => {
  const rawMethaneValidity = resolveRawMethaneValidity(source);

  if (rawMethaneValidity === undefined || rawMethaneValidity === null) {
    return null;
  }

  const methaneValidity = toFiniteNumber(rawMethaneValidity);

  if (
    methaneValidity === METHANE_VALID_VALID ||
    methaneValidity === METHANE_VALID_INVALID
  ) {
    return methaneValidity;
  }

  return 0;
};

const shouldIncludeMethaneValidity = (source, visibility) => {
  // Aeris traces do not use methane_valid in the same way as dual-sensor telemetry.
  if (source?.sensorMode === SENSOR_MODE_AERIS) {
    return true;
  }

  const methaneValidity = getTelemetryMethaneValidity(source);

  // Only filter rows that actually carry methane_valid.
  if (methaneValidity === null) {
    return true;
  }

  if (methaneValidity === METHANE_VALID_VALID) {
    return visibility.valid;
  }

  if (methaneValidity === METHANE_VALID_INVALID) {
    return visibility.invalid;
  }

  return visibility.noData;
};

const sensorModePresentation = (sensorMode) => {
  if (sensorMode === SENSOR_MODE_AERIS) {
    return {
      label: "Aeris",
      foreground: color.green,
      background: color.greenSoft,
    };
  }

  if (sensorMode === SENSOR_MODE_MIXED) {
    return {
      label: "Mixed",
      foreground: color.warning,
      background: "rgba(240, 193, 93, 0.18)",
    };
  }

  return {
    label: "Dual",
    foreground: color.textMuted,
    background: color.surface,
  };
};

const formatCompactValue = (value, digits = 2) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "-";
  }

  return parsed.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
};

// const formatDateTimeLocalValue = (value) => {
//   if (!value) {
//     return "";
//   }

//   const date = new Date(value);
//   if (Number.isNaN(date.getTime())) {
//     return "";
//   }

//   const offsetMs = date.getTimezoneOffset() * 60 * 1000;
//   return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
// };

const ppmToKgM3 = (
  methanePpm,
  temperatureK = DEFAULT_TEMPERATURE_K,
  pressurePa = DEFAULT_PRESSURE_PA,
) => {
  if (!Number.isFinite(methanePpm) || methanePpm <= 0) {
    return 0;
  }

  const moleFraction = methanePpm * 1e-6;
  const methaneMolesPerM3 =
    moleFraction * (pressurePa / (UNIVERSAL_GAS_CONSTANT * temperatureK));

  return methaneMolesPerM3 * METHANE_MOLAR_MASS_KG_PER_MOL;
};

const quantile = (values, ratio) => {
  if (!values.length) {
    return null;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const boundedRatio = Math.min(1, Math.max(0, ratio));
  const index = Math.floor((sortedValues.length - 1) * boundedRatio);
  return sortedValues[index];
};

const estimateTransectWidthMeters = (flowData) => {
  const geoPoints = flowData.filter(
    (point) =>
      Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
  );

  if (geoPoints.length < 2) {
    return DEFAULT_TRANSECT_WIDTH_M;
  }

  const firstPoint = geoPoints[0];
  const lastPoint = geoPoints[geoPoints.length - 1];
  const latitudes = geoPoints.map((point) => point.latitude);
  const longitudes = geoPoints.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);

  const endpointSpan = calculateDistanceMeters(
    firstPoint.latitude,
    firstPoint.longitude,
    lastPoint.latitude,
    lastPoint.longitude,
  );
  const boundingSpan = calculateDistanceMeters(
    minLatitude,
    minLongitude,
    maxLatitude,
    maxLongitude,
  );

  return Math.max(DEFAULT_TRANSECT_WIDTH_M, endpointSpan, boundingSpan);
};

const estimateMixingHeightMeters = (flowData) => {
  const altitudes = flowData
    .map((point) => toFiniteNumber(point.altitude))
    .filter((value) => value !== null);

  if (altitudes.length < 2) {
    return DEFAULT_MIXING_HEIGHT_M;
  }

  return Math.max(
    DEFAULT_MIXING_HEIGHT_M,
    Math.max(...altitudes) - Math.min(...altitudes),
  );
};

const getWindNormalSpeed = (point) => {
  const windU = toFiniteNumber(point.wind_u);
  const windV = toFiniteNumber(point.wind_v);

  if (windU !== null || windV !== null) {
    return Math.hypot(windU ?? 0, windV ?? 0);
  }

  return Math.max(
    0,
    toFiniteNumber(point.speed) ??
    toFiniteNumber(point.payload?.speed) ??
    toFiniteNumber(point.payload?.spd) ??
    0,
  );
};

const getPurwayPathLengthMeters = (point) => {
  const directDistance =
    toFiniteNumber(point.distance) ?? toFiniteNumber(point.payload?.distance);
  if (directDistance !== null && directDistance > 0) {
    return directDistance;
  }

  const latitude = toFiniteNumber(point.latitude);
  const longitude = toFiniteNumber(point.longitude);
  const targetLatitude =
    toFiniteNumber(point.target_latitude) ??
    toFiniteNumber(point.payload?.target_latitude) ??
    toFiniteNumber(point.payload?.target_position?.latitude);
  const targetLongitude =
    toFiniteNumber(point.target_longitude) ??
    toFiniteNumber(point.payload?.target_longitude) ??
    toFiniteNumber(point.payload?.target_position?.longitude);

  if (
    latitude === null ||
    longitude === null ||
    targetLatitude === null ||
    targetLongitude === null
  ) {
    return null;
  }

  const horizontalDistance = calculateDistanceMeters(
    latitude,
    longitude,
    targetLatitude,
    targetLongitude,
  );
  if (!Number.isFinite(horizontalDistance) || horizontalDistance <= 0) {
    return null;
  }

  const altitude = toFiniteNumber(point.altitude) ?? 0;
  const targetAltitude =
    toFiniteNumber(point.target_altitude) ??
    toFiniteNumber(point.payload?.target_altitude) ??
    altitude;
  const verticalDistance = targetAltitude - altitude;

  return Math.hypot(horizontalDistance, verticalDistance);
};

const getAnalysisMethanePpm = (point) => {
  if (point?.sensorMode === SENSOR_MODE_AERIS) {
    return Math.max(0, Number(point.methane ?? 0));
  }

  const purway = toFiniteNumber(point.purway);
  const pathLengthMeters = getPurwayPathLengthMeters(point);
  if (purway !== null && pathLengthMeters !== null && pathLengthMeters > 0) {
    return Math.max(0, purway / pathLengthMeters);
  }

  if (purway !== null) {
    return null;
  }

  const sniffer = toFiniteNumber(point.sniffer);
  if (sniffer !== null) {
    return Math.max(0, sniffer);
  }

  return Math.max(0, Number(point.methane ?? 0));
};

const estimateMassFlux = ({
  flowData,
  backgroundPpm,
  transectWidthM,
  mixingHeightM,
}) => {
  const count = flowData.length;

  if (!count || transectWidthM <= 0 || mixingHeightM <= 0) {
    return {
      massFluxKgS: 0,
      massFluxKgH: 0,
      sampleCount: count,
      surfaceAreaM2: Math.max(0, transectWidthM * mixingHeightM),
    };
  }

  const areaTotal = transectWidthM * mixingHeightM;
  const areaPerSample = areaTotal / count;
  const massFluxKgS = flowData.reduce((sum, point) => {
    const methane = getAnalysisMethanePpm(point);
    const enhancementPpm = Math.max(0, methane - backgroundPpm);
    const enhancementKgM3 = ppmToKgM3(enhancementPpm);
    const windNormal = Math.max(0, getWindNormalSpeed(point));
    return sum + enhancementKgM3 * windNormal * areaPerSample;
  }, 0);

  return {
    massFluxKgS,
    massFluxKgH: massFluxKgS * 3600,
    sampleCount: count,
    surfaceAreaM2: areaTotal,
  };
};

const estimateEmissionRate = ({
  flowData,
  backgroundPpm,
  transectWidthM,
  mixingHeightM,
}) => {
  const count = flowData.length;

  if (!count || transectWidthM <= 0 || mixingHeightM <= 0) {
    return {
      emissionRateKgS: 0,
      emissionRateKgH: 0,
      sampleCount: count,
      surfaceAreaM2: Math.max(0, transectWidthM * mixingHeightM),
    };
  }

  const enhancementsKgM3 = flowData.map((point) => {
    const methane = getAnalysisMethanePpm(point);
    return ppmToKgM3(Math.max(0, methane - backgroundPpm));
  });
  const windNormals = flowData.map((point) => Math.max(0, getWindNormalSpeed(point)));
  const meanEnhancementKgM3 =
    enhancementsKgM3.reduce((sum, value) => sum + value, 0) / count;
  const meanWindNormal =
    windNormals.reduce((sum, value) => sum + value, 0) / count;
  const surfaceAreaM2 = transectWidthM * mixingHeightM;
  const emissionRateKgS =
    meanEnhancementKgM3 * meanWindNormal * surfaceAreaM2;

  return {
    emissionRateKgS,
    emissionRateKgH: emissionRateKgS * 3600,
    sampleCount: count,
    surfaceAreaM2,
  };
};

const EMPTY_ANALYSIS_DERIVED = {
  notebookAnalysisSamples: [],
  aerisTracerAvailability: {
    acetylene: false,
    nitrousOxide: false,
  },
  averageMethane: 0,
  thresholdSamples: 0,
  confidenceScore: 0,
  dualPurwayPathStats: {
    purwaySampleCount: 0,
    pathLengthSampleCount: 0,
  },
  fluxEstimates: {
    backgroundPpm: DEFAULT_BACKGROUND_PPM,
    transectWidthM: DEFAULT_TRANSECT_WIDTH_M,
    mixingHeightM: DEFAULT_MIXING_HEIGHT_M,
    meanWindNormalMps: 0,
    windCoverage: 0,
    massFlux: {
      massFluxKgS: 0,
      massFluxKgH: 0,
      sampleCount: 0,
      surfaceAreaM2: 0,
    },
    emissionRate: {
      emissionRateKgS: 0,
      emissionRateKgH: 0,
      sampleCount: 0,
      surfaceAreaM2: 0,
    },
  },
};

const computeAnalysisDerivatives = (selectedFlowData, selectedWindow) => {
  if (!selectedFlowData.length) {
    return EMPTY_ANALYSIS_DERIVED;
  }

  const safeStart = Math.max(
    0,
    Math.min(selectedWindow.startIndex, selectedFlowData.length - 1),
  );
  const safeEnd = Math.max(
    safeStart,
    Math.min(selectedWindow.endIndex, selectedFlowData.length - 1),
  );

  const selectedWindowFlowData = selectedFlowData.slice(safeStart, safeEnd + 1);
  const notebookAnalysisSamples = selectedWindowFlowData
    .filter((point) => {
      const methane = Number(point?.methane ?? 0);
      return methane >= selectedWindow.ppmMin && methane <= selectedWindow.ppmMax;
    })
    .map((point) => ({
      ts: point.timestampIso || point.ts || null,
      timestampMs: point.timestampMs ?? null,
      droneId: point.droneId || null,
      topic: point.topic || null,
      latitude: point.latitude ?? null,
      longitude: point.longitude ?? null,
      altitude: point.altitude ?? null,
      methane: Number(point?.methane ?? 0),
      acetylene: Number(point?.acetylene ?? 0),
      nitrousOxide: Number(point?.nitrousOxide ?? 0),
    }));

  const aerisTracerAvailability = {
    acetylene: notebookAnalysisSamples.some(
      (point) => Number.isFinite(point?.acetylene) && Number(point.acetylene) > 0,
    ),
    nitrousOxide: notebookAnalysisSamples.some(
      (point) =>
        Number.isFinite(point?.nitrousOxide) && Number(point.nitrousOxide) > 0,
    ),
  };

  const selectedAnalysisFlowData = filterCoordinateOutliers(selectedWindowFlowData);
  const averageMethane = selectedAnalysisFlowData.length
    ? selectedAnalysisFlowData.reduce(
      (sum, point) => sum + Number(point.methane || 0),
      0,
    ) / selectedAnalysisFlowData.length
    : 0;

  const thresholdSamples = selectedAnalysisFlowData.filter(
    (point) => Number(point.methane || 0) >= 2,
  ).length;

  const sampleCoverage = Math.min(1, selectedAnalysisFlowData.length / 220);
  const plumeCoverage = Math.min(1, thresholdSamples / 55);
  const score = Math.round((sampleCoverage * 0.65 + plumeCoverage * 0.35) * 100);
  const confidenceScore = Number.isFinite(score)
    ? Math.max(0, Math.min(100, score))
    : 0;

  const purwaySamples = selectedAnalysisFlowData.filter(
    (point) => toFiniteNumber(point.purway) !== null,
  );
  const samplesWithPathLength = purwaySamples.filter(
    (point) => (getPurwayPathLengthMeters(point) ?? 0) > 0,
  );
  const dualPurwayPathStats = {
    purwaySampleCount: purwaySamples.length,
    pathLengthSampleCount: samplesWithPathLength.length,
  };

  const methaneValues = selectedAnalysisFlowData
    .map((point) => getAnalysisMethanePpm(point))
    .filter((value) => Number.isFinite(value));
  const backgroundPpm =
    methaneValues.length >= 5
      ? quantile(methaneValues, 0.1) ?? DEFAULT_BACKGROUND_PPM
      : DEFAULT_BACKGROUND_PPM;
  const transectWidthM = estimateTransectWidthMeters(selectedAnalysisFlowData);
  const mixingHeightM = estimateMixingHeightMeters(selectedAnalysisFlowData);
  const windSamples = selectedAnalysisFlowData
    .map((point) => getWindNormalSpeed(point))
    .filter((value) => Number.isFinite(value) && value > 0);
  const meanWindNormalMps = windSamples.length
    ? windSamples.reduce((sum, value) => sum + value, 0) / windSamples.length
    : 0;

  const fluxEstimates = {
    backgroundPpm,
    transectWidthM,
    mixingHeightM,
    meanWindNormalMps,
    windCoverage:
      selectedAnalysisFlowData.length > 0
        ? windSamples.length / selectedAnalysisFlowData.length
        : 0,
    massFlux: estimateMassFlux({
      flowData: selectedAnalysisFlowData,
      backgroundPpm,
      transectWidthM,
      mixingHeightM,
    }),
    emissionRate: estimateEmissionRate({
      flowData: selectedAnalysisFlowData,
      backgroundPpm,
      transectWidthM,
      mixingHeightM,
    }),
  };

  return {
    notebookAnalysisSamples,
    aerisTracerAvailability,
    averageMethane,
    thresholdSamples,
    confidenceScore,
    dualPurwayPathStats,
    fluxEstimates,
  };
};

const normalizeMissionPoint = (point, index, droneId) => {
  if (index === 0) {
    console.log("[normalizeMissionPoint] raw point[0] keys:", Object.keys(point));
    console.log("[normalizeMissionPoint] raw point[0] methane_valid:", point.methane_valid, "| methaneValid:", point.methaneValid, "| payload keys:", point.payload ? Object.keys(point.payload) : point.payload);
  }
  const metrics = extractTelemetryMetrics(point);
  const methaneValidity = getTelemetryMethaneValidity(point);
  const timestampIso =
    point.timestampIso ||
    point.ts ||
    point.timestamp ||
    new Date().toISOString();
  const rawTimestampMs = Number(point.timestampMs);
  const derivedTimestampMs = new Date(timestampIso).getTime();
  const timestampMs = Number.isFinite(rawTimestampMs)
    ? rawTimestampMs
    : Number.isFinite(derivedTimestampMs)
      ? derivedTimestampMs
      : Date.now();

  return {
    sampleOrder: index,
    sampleIndex: index + 1,
    timestampMs,
    timestampIso,
    time: new Date(timestampMs).toLocaleTimeString(),
    altitude: toFiniteNumber(point.altitude) ?? 0,
    latitude: toFiniteNumber(point.latitude),
    longitude: toFiniteNumber(point.longitude),
    speed:
      toFiniteNumber(point.speed) ?? toFiniteNumber(point.payload?.speed) ?? null,
    wind_u:
      toFiniteNumber(point.wind_u) ?? toFiniteNumber(point.payload?.wind_u) ?? null,
    wind_v:
      toFiniteNumber(point.wind_v) ?? toFiniteNumber(point.payload?.wind_v) ?? null,
    wind_w:
      toFiniteNumber(point.wind_w) ?? toFiniteNumber(point.payload?.wind_w) ?? null,
    distance:
      toFiniteNumber(point.distance) ?? toFiniteNumber(point.payload?.distance) ?? null,
    target_latitude:
      toFiniteNumber(point.target_latitude) ??
      toFiniteNumber(point.payload?.target_latitude) ??
      toFiniteNumber(point.payload?.target_position?.latitude) ??
      null,
    target_longitude:
      toFiniteNumber(point.target_longitude) ??
      toFiniteNumber(point.payload?.target_longitude) ??
      toFiniteNumber(point.payload?.target_position?.longitude) ??
      null,
    target_altitude:
      toFiniteNumber(point.target_altitude) ??
      toFiniteNumber(point.payload?.target_altitude) ??
      null,
    sensorMode: metrics.sensorMode,
    sniffer: metrics.sniffer,
    purway: metrics.purway,
    methane: metrics.methane,
    methane_valid: methaneValidity,
    methaneValid: methaneValidity,
    acetylene: metrics.acetylene,
    nitrousOxide: metrics.nitrousOxide,
    droneId,
    payload: point.payload || {},
  };
};

const flattenMissionFlowData = (results) =>
  (Array.isArray(results) ? results : [])
    .flatMap((entry) => {
      const droneId = entry?.drone || "unknown-drone";
      const data = Array.isArray(entry?.data) ? entry.data : [];
      return data.map((point, index) =>
        normalizeMissionPoint(point, index, droneId),
      );
    })
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((point, index) => ({
      ...point,
      sampleOrder: index,
      sampleIndex: index + 1,
    }));

const normalizeTelemetryHistory = (rows) =>
  (Array.isArray(rows) ? rows : [])
    .map((point, index) =>
      normalizeMissionPoint(
        point,
        index,
        point?.drone_id || point?.droneId || "unknown-drone",
      ),
    )
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((point, index) => ({
      ...point,
      sampleOrder: index,
      sampleIndex: index + 1,
    }));

export function ResultsPage({
  devices = [],
  sensorsMode = [],
  selectedDeviceId,
  onSelectDevice,
  onContinueMission,
  continuingMissionId = null,
  measurementStatus = "idle",
  onDataRefresh,
}) {
  const [selectedMissionId, setSelectedMissionId] = useState(null);
  const [isMissionLoading, setIsMissionLoading] = useState(false);
  const [isMissionMapReady, setIsMissionMapReady] = useState(false);
  const [isMissionChartReady, setIsMissionChartReady] = useState(false);

  const [selectedResultDroneId, setSelectedResultDroneId] =
    useState(ALL_DRONES_OPTION);
  const [missionsSample, setMissionsSample] = useState([]);
  const [telemetryHistorySample, setTelemetryHistorySample] = useState([]);
  const [telemetryHistoryRange, setTelemetryHistoryRange] = useState({
    from: "",
    to: "",
  });
  const [isTelemetryHistoryLoading, setIsTelemetryHistoryLoading] =
    useState(false);
  const [mapViewportTelemetrySample, setMapViewportTelemetrySample] = useState([]);
  const [mapViewportTelemetrySummary, setMapViewportTelemetrySummary] =
    useState({
      source: "full-history",
      inputPointCount: 0,
      renderedPointCount: 0,
      zoom: null,
      cacheHit: false,
    });
  const [isMapViewportTelemetryLoading, setIsMapViewportTelemetryLoading] =
    useState(false);
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [deletingMissionId, setDeletingMissionId] = useState(null);
  const [isDeletingAllData, setIsDeletingAllData] = useState(false);
  const [isDeleteAllHolding, setIsDeleteAllHolding] = useState(false);
  const [deleteAllHoldProgress, setDeleteAllHoldProgress] = useState(0);
  const [legendScale, setLegendScale] = useState({
    lowerLimit: 0,
    upperLimit: 200,
  });
  const [plumeViewByMission, setPlumeViewByMission] = useState({});
  const isPlumeViewEnabled = plumeViewByMission[selectedMissionId] ?? false;
  const [heatmapViewByMission, setHeatmapViewByMission] = useState({});
  const isHeatmapEnabled = heatmapViewByMission[selectedMissionId] ?? true;
  const [traceOpacity, setTraceOpacity] = useState(1);
  const [methaneValidityVisibility, setMethaneValidityVisibility] = useState({
    valid: true,
    invalid: true,
    noData: false,
  });
  const [startPointFilterEnabled, setStartPointFilterEnabled] = useState(false);
  const [startPointFilterRadiusMeters, setStartPointFilterRadiusMeters] =
    useState(START_POINT_FILTER_DEFAULT_RADIUS_METERS);
  const [startPointPickModeEnabled, setStartPointPickModeEnabled] =
    useState(false);
  const [startPointCoordinates, setStartPointCoordinates] = useState(null);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [isAnalyzeModalOpen, setIsAnalyzeModalOpen] = useState(false);
  const [isNotebookRunning, setIsNotebookRunning] = useState(false);
  const [analysisOutputText, setAnalysisOutputText] = useState("");
  const [analysisImageDataUris, setAnalysisImageDataUris] = useState([]);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisExecutedAt, setAnalysisExecutedAt] = useState("");
  const [missionOrthophotosById, setMissionOrthophotosById] = useState({});
  const [orthophotoMessage, setOrthophotoMessage] = useState("");
  const [isOrthophotoUploading, setIsOrthophotoUploading] = useState(false);
  const [analysisTracerRates, setAnalysisTracerRates] = useState({
    acetylene: "0.0",
    nitrousOxide: "0.0",
  });
  const MISSION_RENDER_GUARD_TIMEOUT_MS = 9000;
  const replayTimerRef = useRef(null);
  const missionSelectionTimeoutRef = useRef(null);
  const missionRenderGuardTimeoutRef = useRef(null);
  const replayEndIndexRef = useRef(0);
  const analysisWorkerRef = useRef(null);
  const analysisRequestIdRef = useRef(0);
  const mapViewportDebounceRef = useRef(null);
  const mapViewportRequestIdRef = useRef(0);
  const latestMapViewportRef = useRef(null);
  const mapViewportTileCacheRef = useRef(new globalThis.Map());
  const analysisInputRef = useRef({
    selectedFlowData: [],
    selectedWindow: {
      startIndex: 0,
      endIndex: 0,
      ppmMin: 0,
      ppmMax: 1,
    },
  });
  const deleteAllHoldTimeoutRef = useRef(null);
  const deleteAllHoldIntervalRef = useRef(null);
  const [csvModalFile, setCsvModalFile] = useState(null);
  const [importMessage, setImportMessage] = useState(null);
  const [analysisDerived, setAnalysisDerived] = useState(
    EMPTY_ANALYSIS_DERIVED,
  );

  const openCsvPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = (event) => {
      const file = event.target.files?.[0] || null;
      if (file) setCsvModalFile(file);
    };
    input.click();
  };

  const clearMissionSelectionTransitions = useCallback(() => {
    if (missionSelectionTimeoutRef.current) {
      window.clearTimeout(missionSelectionTimeoutRef.current);
      missionSelectionTimeoutRef.current = null;
    }

    if (missionRenderGuardTimeoutRef.current) {
      window.clearTimeout(missionRenderGuardTimeoutRef.current);
      missionRenderGuardTimeoutRef.current = null;
    }
  }, []);

  const handleMapTraceRenderComplete = useCallback(() => {
    setIsMissionMapReady(true);
  }, [clearMissionSelectionTransitions]);

  const handleChartRenderComplete = useCallback(() => {
    setIsMissionChartReady(true);
  }, []);

  const handleSelectMission = useCallback(
    (mission) => {
      if (!mission?.id) {
        return;
      }

      const shouldSkipTransition =
        selectedMissionId === mission.id && !isMissionLoading;
      if (shouldSkipTransition) {
        setSelectedResultDroneId(ALL_DRONES_OPTION);
        onSelectDevice?.(mission.primaryDroneId || selectedDeviceId);
        return;
      }

      clearMissionSelectionTransitions();
      flushSync(() => {
        setIsMissionLoading(true);
        setIsMissionMapReady(false);
        setIsMissionChartReady(false);
      });

      missionSelectionTimeoutRef.current = window.setTimeout(() => {
        setSelectedResultDroneId(ALL_DRONES_OPTION);
        onSelectDevice?.(mission.primaryDroneId || selectedDeviceId);
        setSelectedMissionId(mission.id);
        missionSelectionTimeoutRef.current = null;

        missionRenderGuardTimeoutRef.current = window.setTimeout(() => {
          setIsMissionLoading(false);
          missionRenderGuardTimeoutRef.current = null;
        }, MISSION_RENDER_GUARD_TIMEOUT_MS);
      }, 0);
    },
    [
      clearMissionSelectionTransitions,
      isMissionLoading,
      onSelectDevice,
      selectedDeviceId,
      selectedMissionId,
    ],
  );

  const actualMissions = useMemo(() => {
    return missionsSample
      .map((mission) => {
        const flowData = flattenMissionFlowData(mission.results);
        const droneIds = (Array.isArray(mission.results) ? mission.results : [])
          .map((entry) => entry?.drone)
          .filter(Boolean);
        const startTs = flowData[0]?.timestampIso || mission.createdAt || null;
        const endTs =
          flowData[flowData.length - 1]?.timestampIso ||
          mission.createdAt ||
          null;
        const peakMethane = flowData.reduce(
          (maxValue, point) => Math.max(maxValue, Number(point.methane || 0)),
          0,
        );
        const droneSensorModeById = droneIds.reduce((accumulator, droneId) => {
          const droneFlowData = flowData.filter(
            (point) => point.droneId === droneId,
          );
          accumulator[droneId] = inferFlowSensorMode(droneFlowData);
          return accumulator;
        }, {});

        return {
          id: mission.id,
          name: mission.name || "Untitled Mission",
          sampleCount: flowData.length,
          droneIds,
          primaryDroneId: droneIds[0] || null,
          startTs,
          endTs,
          createdAt: mission.createdAt || null,
          elapsedSeconds: Number(mission.elapsedSeconds || 0),
          peakMethane,
          status: flowData.length > 0 ? "Ready" : "No Data",
          droneSensorModeById,
          flowData,
        };
      })
      .sort((a, b) => {
        const aTs = new Date(a.endTs || 0).getTime();
        const bTs = new Date(b.endTs || 0).getTime();
        return bTs - aTs;
      });
  }, [missionsSample]);

  const telemetryHistoryFlowData = useMemo(
    () => normalizeTelemetryHistory(telemetryHistorySample),
    [telemetryHistorySample],
  );

  const shouldUseViewportTelemetry =
    selectedMissionId === ALL_DATA_MISSION_ID &&
    selectedResultDroneId === ALL_DRONES_OPTION;

  const loadTelemetryHistory = useCallback(async (range = {}) => {
    setIsTelemetryHistoryLoading(true);
    const loadedTelemetryHistory = await listTelemetryHistory({
      limit: 100000,
      from: range.from || undefined,
      to: range.to || undefined,
    });
    setTelemetryHistorySample(loadedTelemetryHistory);
    setIsTelemetryHistoryLoading(false);
  }, []);

  const handleMapViewportChange = useCallback(
    (viewport) => {
      latestMapViewportRef.current = viewport;

      if (!shouldUseViewportTelemetry) {
        return;
      }

      if (mapViewportDebounceRef.current) {
        window.clearTimeout(mapViewportDebounceRef.current);
      }

      mapViewportDebounceRef.current = window.setTimeout(async () => {
        const activeViewport = latestMapViewportRef.current;
        if (!activeViewport) {
          return;
        }

        const gridDegrees = getGridDegreesForZoom(activeViewport.zoom);
        const cacheKey = buildViewportTileCacheKey({
          viewport: activeViewport,
          range: telemetryHistoryRange,
          gridDegrees,
        });
        const now = Date.now();
        pruneViewportTileCache(mapViewportTileCacheRef.current);

        const cachedEntry = mapViewportTileCacheRef.current.get(cacheKey);
        if (
          cachedEntry &&
          now - Number(cachedEntry.cachedAt || 0) <= VIEWPORT_TILE_CACHE_TTL_MS
        ) {
          setMapViewportTelemetrySample(cachedEntry.data);
          setMapViewportTelemetrySummary({
            ...cachedEntry.summary,
            source: "viewport-cache",
            cacheHit: true,
          });
          setIsMapViewportTelemetryLoading(false);
          return;
        }

        const requestId = mapViewportRequestIdRef.current + 1;
        mapViewportRequestIdRef.current = requestId;
        setIsMapViewportTelemetryLoading(true);

        const aggregatedPayload = await listTelemetryHistoryAggregated({
          limit: VIEWPORT_TELEMETRY_LIMIT,
          from: telemetryHistoryRange.from || undefined,
          to: telemetryHistoryRange.to || undefined,
          minLatitude: activeViewport.minLatitude,
          maxLatitude: activeViewport.maxLatitude,
          minLongitude: activeViewport.minLongitude,
          maxLongitude: activeViewport.maxLongitude,
          gridDegrees,
        });

        if (requestId !== mapViewportRequestIdRef.current) {
          return;
        }

        const normalizedWindowedData = normalizeTelemetryHistory(
          aggregatedPayload?.data || [],
        );

        const summary = {
          source: "viewport-aggregate",
          inputPointCount: Number(
            aggregatedPayload?.aggregation?.inputPointCount || 0,
          ),
          renderedPointCount: normalizedWindowedData.length,
          zoom: Number.isFinite(Number(activeViewport.zoom))
            ? Number(activeViewport.zoom)
            : null,
          cacheHit: false,
        };

        setMapViewportTelemetrySample(normalizedWindowedData);
        setMapViewportTelemetrySummary(summary);
        mapViewportTileCacheRef.current.set(cacheKey, {
          cachedAt: now,
          data: normalizedWindowedData,
          summary,
        });
        pruneViewportTileCache(mapViewportTileCacheRef.current);
        setIsMapViewportTelemetryLoading(false);
      }, 220);
    },
    [
      shouldUseViewportTelemetry,
      telemetryHistoryRange.from,
      telemetryHistoryRange.to,
    ],
  );

  const missions = useMemo(() => {
    const aggregateFlowData = telemetryHistoryFlowData;
    const aggregateDroneIds = Array.from(
      new Set(aggregateFlowData.map((point) => point.droneId).filter(Boolean)),
    );
    const aggregateStartTs = aggregateFlowData[0]?.timestampIso || null;
    const aggregateEndTs =
      aggregateFlowData[aggregateFlowData.length - 1]?.timestampIso || null;
    const aggregatePeakMethane = aggregateFlowData.reduce(
      (maxValue, point) => Math.max(maxValue, Number(point.methane || 0)),
      0,
    );
    const aggregateSensorModes = aggregateDroneIds.reduce(
      (accumulator, droneId) => {
        const droneFlowData = aggregateFlowData.filter(
          (point) => point.droneId === droneId,
        );
        accumulator[droneId] = inferFlowSensorMode(droneFlowData);
        return accumulator;
      },
      {},
    );

    return [
      {
        id: ALL_DATA_MISSION_ID,
        name: "All Data",
        sampleCount: aggregateFlowData.length,
        droneIds: aggregateDroneIds,
        primaryDroneId: aggregateDroneIds[0] || null,
        startTs: aggregateStartTs,
        endTs: aggregateEndTs,
        createdAt: null,
        elapsedSeconds: 0,
        peakMethane: aggregatePeakMethane,
        status: aggregateFlowData.length ? "Recorded" : "No Data",
        droneSensorModeById: aggregateSensorModes,
        flowData: aggregateFlowData,
        isSynthetic: true,
      },
      ...actualMissions.map((mission) => ({
        ...mission,
        isSynthetic: false,
      })),
    ];
  }, [actualMissions, telemetryHistoryFlowData]);

  useEffect(() => {
    const loadData = async () => {
      const [loadedMissions] = await Promise.all([listMissions()]);
      setMissionsSample(loadedMissions);
      await loadTelemetryHistory({ from: "", to: "" });
    };
    void loadData();
  }, [loadTelemetryHistory]);

  useEffect(() => {
    const selectedMissionStillExists = missions.some(
      (mission) => mission.id === selectedMissionId,
    );

    if (selectedMissionId && !selectedMissionStillExists) {
      setSelectedMissionId(null);
      setIsMissionLoading(false);
    }

    if (!selectedMissionId) {
      setIsMissionLoading(false);
    }
  }, [missions, selectedMissionId]);

  useEffect(
    () => () => {
      clearMissionSelectionTransitions();
    },
    [clearMissionSelectionTransitions],
  );

  useEffect(
    () => () => {
      if (mapViewportDebounceRef.current) {
        window.clearTimeout(mapViewportDebounceRef.current);
        mapViewportDebounceRef.current = null;
      }
      mapViewportRequestIdRef.current += 1;
      mapViewportTileCacheRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (shouldUseViewportTelemetry) {
      return;
    }

    if (mapViewportDebounceRef.current) {
      window.clearTimeout(mapViewportDebounceRef.current);
      mapViewportDebounceRef.current = null;
    }

    mapViewportRequestIdRef.current += 1;
    mapViewportTileCacheRef.current.clear();
    setIsMapViewportTelemetryLoading(false);
    setMapViewportTelemetrySample([]);
    setMapViewportTelemetrySummary((previous) => ({
      ...previous,
      source: "full-history",
      inputPointCount: 0,
      renderedPointCount: 0,
      zoom: null,
      cacheHit: false,
    }));
  }, [shouldUseViewportTelemetry]);

  const aggregateMission = useMemo(
    () => missions.find((mission) => mission.id === ALL_DATA_MISSION_ID) || null,
    [missions],
  );

  const savedMissions = useMemo(
    () => missions.filter((mission) => !mission.isSynthetic),
    [missions],
  );

  const selectedMission = useMemo(
    () => missions.find((mission) => mission.id === selectedMissionId) || null,
    [missions, selectedMissionId],
  );

  const selectedMissionOrthophoto = useMemo(() => {
    if (!selectedMission?.id) {
      return null;
    }

    return missionOrthophotosById[selectedMission.id] || null;
  }, [missionOrthophotosById, selectedMission]);

  const handleOrthophotoFileSelected = useCallback(
    async (file) => {
      if (!selectedMission?.id || selectedMission.isSynthetic || !file) {
        return;
      }

      setIsOrthophotoUploading(true);
      setOrthophotoMessage("");

      try {
        const lowerName = file.name.toLowerCase();
        const overlay = lowerName.endsWith(".kmz")
          ? await buildOrthophotoOverlayFromKmz(file)
          : await buildOrthophotoOverlayFromGeoTiff(file);

        setMissionOrthophotosById((previous) => {
          const old = previous[selectedMission.id];
          if (old?.imageUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(old.imageUrl);
          }
          console.log(`[handleOrthophotoFileSelected] Attached orthophoto for mission ${selectedMission.id}:`, overlay);
          return {
            ...previous,
            [selectedMission.id]: {
              ...overlay,
              attachedAt: new Date().toISOString(),
            },
          };
        });
        setOrthophotoMessage(
          `${file.name} attached to ${selectedMission.name}.`,
        );
      } catch (error) {
        setOrthophotoMessage(
          error instanceof Error
            ? error.message
            : "Failed to attach orthophoto.",
        );
      } finally {
        setIsOrthophotoUploading(false);
      }
    },
    [selectedMission],
  );

  const openOrthophotoPicker = useCallback(() => {
    if (!selectedMission?.id || selectedMission.isSynthetic) {
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ORTHOPHOTO_ACCEPT_ATTR;
    input.onchange = (event) => {
      const file = event.target.files?.[0] || null;
      if (file) {
        void handleOrthophotoFileSelected(file);
      }
    };
    input.click();
  }, [handleOrthophotoFileSelected, selectedMission]);

  const handleRemoveOrthophoto = useCallback(() => {
    if (!selectedMission?.id || selectedMission.isSynthetic) {
      return;
    }

    setMissionOrthophotosById((previous) => {
      const next = { ...previous };
      const old = next[selectedMission.id];
      if (old?.imageUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(old.imageUrl);
      }
      delete next[selectedMission.id];
      return next;
    });
    setOrthophotoMessage(`Removed orthophoto from ${selectedMission.name}.`);
  }, [selectedMission]);

  useEffect(() => {
    if (!selectedMission) {
      setSelectedResultDroneId(ALL_DRONES_OPTION);
      return;
    }

    if (
      selectedResultDroneId !== ALL_DRONES_OPTION &&
      !selectedMission.droneIds.includes(selectedResultDroneId)
    ) {
      setSelectedResultDroneId(ALL_DRONES_OPTION);
    }
  }, [selectedMission, selectedResultDroneId]);

  useEffect(() => {
    setStartPointCoordinates(null);
    setStartPointPickModeEnabled(false);
    setStartPointFilterEnabled(false);
  }, [selectedMissionId, selectedResultDroneId]);

  const selectedFlowData = useMemo(() => {
    if (!selectedMission?.flowData) {
      return [];
    }

    if (selectedResultDroneId === ALL_DRONES_OPTION) {
      return selectedMission.flowData;
    }

    return selectedMission.flowData.filter(
      (point) => point.droneId === selectedResultDroneId,
    );
  }, [selectedMission, selectedResultDroneId]);

  const selectedFlowDataForMap = useMemo(() => {
    const filtered = selectedFlowData.filter((point) =>
      shouldIncludeMethaneValidity(point, methaneValidityVisibility),
    );
    const counts = { valid: 0, invalid: 0, noData: 0, null: 0 };
    for (const p of selectedFlowData) {
      const v = p.methane_valid;
      if (v === 1) counts.valid++;
      else if (v === 2) counts.invalid++;
      else if (v === 0) counts.noData++;
      else counts.null++;
    }
    if (selectedFlowData.length > 0) {
      const sample = selectedFlowData[0];
      console.log("[methane_valid filter] sample point keys:", Object.keys(sample));
      console.log("[methane_valid filter] sample point.methane_valid:", sample.methane_valid, "| typeof payload:", typeof sample.payload, "| payload.methane_valid:", sample.payload?.methane_valid);
    }
    console.log(
      `[methane_valid filter] visibility=${JSON.stringify(methaneValidityVisibility)} | total=${selectedFlowData.length} (valid=1: ${counts.valid}, invalid=2: ${counts.invalid}, no-data=0: ${counts.noData}, null: ${counts.null}) → kept=${filtered.length}, removed=${selectedFlowData.length - filtered.length}`,
    );
    return filtered;
  }, [selectedFlowData, methaneValidityVisibility]);

  const selectedFlowDataForMapWithStartFilter = useMemo(
    () =>
      filterFlowPointsOutsideStartRadius(selectedFlowDataForMap, {
        enabled: startPointFilterEnabled,
        startPoint: startPointCoordinates,
        radiusMeters: startPointFilterRadiusMeters,
      }),
    [
      selectedFlowDataForMap,
      startPointCoordinates,
      startPointFilterEnabled,
      startPointFilterRadiusMeters,
    ],
  );

  const droneFilterOptions = useMemo(() => {
    const missionDroneIds = selectedMission?.droneIds || [];
    return [
      { id: ALL_DRONES_OPTION, name: "All Drones" },
      ...missionDroneIds.map((droneId) => ({ id: droneId, name: droneId })),
    ];
  }, [selectedMission]);

  const selectedSensorMode = useMemo(
    () => inferFlowSensorMode(selectedFlowData),
    [selectedFlowData],
  );
  const isDualSensorAnalysis = selectedSensorMode === SENSOR_MODE_DUAL;
  const isAerisAnalysis = selectedSensorMode === SENSOR_MODE_AERIS;
  const hasAerisTraceData = useMemo(
    () =>
      selectedFlowData.some(
        (point) =>
          point.sensorMode === SENSOR_MODE_AERIS ||
          Number.isFinite(Number(point.acetylene)) ||
          Number.isFinite(Number(point.nitrousOxide)),
      ),
    [selectedFlowData],
  );
  const hasDualTraceData = useMemo(
    () =>
      selectedFlowData.some(
        (point) =>
          point.sensorMode !== SENSOR_MODE_AERIS ||
          Number.isFinite(Number(point.sniffer)) ||
          Number.isFinite(Number(point.purway)),
      ),
    [selectedFlowData],
  );

  const requiresChartReady = useMemo(() => {
    if (!selectedMission || selectedFlowData.length === 0) {
      return false;
    }

    if (selectedSensorMode === SENSOR_MODE_AERIS) {
      return hasAerisTraceData;
    }

    if (selectedSensorMode === SENSOR_MODE_MIXED) {
      return hasDualTraceData || hasAerisTraceData;
    }

    return true;
  }, [
    hasAerisTraceData,
    hasDualTraceData,
    selectedFlowData.length,
    selectedMission,
    selectedSensorMode,
  ]);

  useEffect(() => {
    if (!isMissionLoading || !selectedMission) {
      return;
    }

    if (!isMissionMapReady) {
      return;
    }

    if (requiresChartReady && !isMissionChartReady) {
      return;
    }

    clearMissionSelectionTransitions();
    setIsMissionLoading(false);
  }, [
    clearMissionSelectionTransitions,
    isMissionChartReady,
    isMissionLoading,
    isMissionMapReady,
    requiresChartReady,
    selectedMission,
  ]);

  const maxSelectablePpm = Math.max(1, getTelemetryPeakValue(selectedFlowData));
  const [selectedWindow, setSelectedWindow] = useState({
    startIndex: 0,
    endIndex: Math.max(0, selectedFlowData.length - 1),
    ppmMin: 0,
    ppmMax: maxSelectablePpm,
  });

  useEffect(() => {
    if (typeof Worker === "undefined") {
      return undefined;
    }

    const worker = new Worker(
      new URL("../workers/resultsAnalysisWorker.js", import.meta.url),
      { type: "module" },
    );
    analysisWorkerRef.current = worker;

    worker.onmessage = (event) => {
      const payload = event.data || {};
      if (payload.requestId !== analysisRequestIdRef.current) {
        return;
      }

      if (!payload.ok || !payload.result) {
        const fallback = computeAnalysisDerivatives(
          analysisInputRef.current.selectedFlowData,
          analysisInputRef.current.selectedWindow,
        );
        setAnalysisDerived(fallback);
        return;
      }

      setAnalysisDerived(payload.result);
    };

    worker.onerror = () => {
      const fallback = computeAnalysisDerivatives(
        analysisInputRef.current.selectedFlowData,
        analysisInputRef.current.selectedWindow,
      );
      setAnalysisDerived(fallback);
    };

    return () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      analysisWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    analysisInputRef.current = { selectedFlowData, selectedWindow };

    const worker = analysisWorkerRef.current;
    if (!worker) {
      const fallback = computeAnalysisDerivatives(selectedFlowData, selectedWindow);
      setAnalysisDerived(fallback);
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    analysisRequestIdRef.current = requestId;
    worker.postMessage({ requestId, selectedFlowData, selectedWindow });
  }, [selectedFlowData, selectedWindow]);

  const clearReplayTimer = useCallback(() => {
    if (replayTimerRef.current) {
      window.clearInterval(replayTimerRef.current);
      replayTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setSelectedWindow({
      startIndex: 0,
      endIndex: Math.max(0, selectedFlowData.length - 1),
      ppmMin: 0,
      ppmMax: maxSelectablePpm,
    });
    replayEndIndexRef.current = Math.max(0, selectedFlowData.length - 1);
    clearReplayTimer();
    setIsReplayPlaying(false);
  }, [
    clearReplayTimer,
    selectedMissionId,
    selectedFlowData.length,
    maxSelectablePpm,
    selectedResultDroneId,
  ]);

  useEffect(() => {
    replayEndIndexRef.current = selectedWindow.endIndex;
  }, [selectedWindow.endIndex]);

  useEffect(() => () => clearReplayTimer(), [clearReplayTimer]);

  const tracePointsForMap = useMemo(
    () => buildDeckTracePointsFromFlowData(selectedFlowDataForMapWithStartFilter),
    [selectedFlowDataForMapWithStartFilter],
  );
  const isViewportTelemetryActive =
    shouldUseViewportTelemetry &&
    mapViewportTelemetrySummary.source === "viewport-aggregate";
  const activeTracePointsForMap = isViewportTelemetryActive
    ? mapViewportTelemetrySample
    : tracePointsForMap;

  const notebookAnalysisSamples = analysisDerived.notebookAnalysisSamples;
  const aerisTracerAvailability = analysisDerived.aerisTracerAvailability;
  const averageMethane = analysisDerived.averageMethane;
  const thresholdSamples = analysisDerived.thresholdSamples;

  const analysisReadiness = useMemo(() => {
    if (!selectedMission || selectedFlowData.length === 0) {
      return {
        label: "No Data",
        tone: color.red,
        background: "rgba(239, 68, 68, 0.12)",
      };
    }

    if (selectedFlowData.length < 30) {
      return {
        label: "Partial Data",
        tone: color.warning,
        background: "rgba(240, 193, 93, 0.16)",
      };
    }

    return {
      label: "Ready",
      tone: color.green,
      background: color.greenSoft,
    };
  }, [selectedMission, selectedFlowData.length]);

  const confidenceScore = analysisDerived.confidenceScore;
  const dualPurwayPathStats = analysisDerived.dualPurwayPathStats;

  const isDualEstimateBlocked =
    isDualSensorAnalysis &&
    dualPurwayPathStats.purwaySampleCount > 0 &&
    dualPurwayPathStats.pathLengthSampleCount === 0;
  const isDualEstimatePartial =
    isDualSensorAnalysis &&
    dualPurwayPathStats.pathLengthSampleCount > 0 &&
    dualPurwayPathStats.pathLengthSampleCount <
    dualPurwayPathStats.purwaySampleCount;

  const fluxEstimates = analysisDerived.fluxEstimates;

  const analysisMethods = useMemo(
    () => [
      {
        name: "Mass Flux Estimation",
        estimate: `${formatCompactValue(fluxEstimates.massFlux.massFluxKgH, 3)} kg/h`,
        uncertainty:
          fluxEstimates.windCoverage >= 0.75 ? "±12%" : "±20%",
        assumptions: `Background ${formatCompactValue(fluxEstimates.backgroundPpm, 2)} ppm, transect ${formatCompactValue(fluxEstimates.transectWidthM, 0)} m, mixing ${formatCompactValue(fluxEstimates.mixingHeightM, 0)} m`,
        quality:
          confidenceScore >= 70 && fluxEstimates.windCoverage >= 0.75
            ? "High"
            : confidenceScore >= 40
              ? "Medium"
              : "Low",
      },
      // {
      //   name: "Control Surface Flux",
      //   estimate: `${formatCompactValue(unifiedEmissionRate * 0.97, 3)} kg/h`,
      //   uncertainty: "±15%",
      //   assumptions: "Control plane intersects plume",
      //   quality: confidenceScore >= 65 ? "High" : "Medium",
      // },
      // {
      //   name: "Gaussian Plume Model",
      //   estimate: `${formatCompactValue(unifiedEmissionRate * 1.21, 3)} kg/h`,
      //   uncertainty: "±22%",
      //   assumptions: "Steady-state wind and source",
      //   quality: confidenceScore >= 75 ? "Medium" : "Low",
      // },
      // {
      //   name: "Numerical Integration (Riemann)",
      //   estimate: `${formatCompactValue(unifiedEmissionRate * 0.91, 3)} kg/h`,
      //   uncertainty: "±10%",
      //   assumptions: "Uniform sampling density",
      //   quality: confidenceScore >= 60 ? "High" : "Medium",
      // },
      // {
      //   name: "Spatial Interpolation (IDW)",
      //   estimate: `${formatCompactValue(unifiedEmissionRate * 1.03, 3)} kg/h`,
      //   uncertainty: "±16%",
      //   assumptions: "Neighborhood radius representative",
      //   quality: confidenceScore >= 70 ? "High" : "Medium",
      // },
      {
        name: "Emission Rate Estimation",
        estimate: `${formatCompactValue(fluxEstimates.emissionRate.emissionRateKgH, 3)} kg/h`,
        uncertainty:
          fluxEstimates.windCoverage >= 0.75 ? "±14%" : "±22%",
        assumptions: `Mean normal wind ${formatCompactValue(fluxEstimates.meanWindNormalMps, 2)} m/s across ${fluxEstimates.emissionRate.sampleCount} samples`,
        quality:
          confidenceScore >= 65 && fluxEstimates.windCoverage >= 0.75
            ? "High"
            : confidenceScore >= 40
              ? "Medium"
              : "Low",
      },
      // {
      //   name: "Mass Balance Method",
      //   estimate: `${formatCompactValue(unifiedEmissionRate * 1.14, 3)} kg/h`,
      //   uncertainty: "±20%",
      //   assumptions: "Upwind/downwind split resolved",
      //   quality: confidenceScore >= 78 ? "Medium" : "Low",
      // },
    ],
    [confidenceScore, fluxEstimates],
  );

  const missionDurationText = useMemo(() => {
    if (!selectedMission?.startTs || !selectedMission?.endTs) {
      return "-";
    }

    const start = new Date(selectedMission.startTs).getTime();
    const end = new Date(selectedMission.endTs).getTime();
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return `${minutes}m ${remainderSeconds}s`;
  }, [selectedMission]);

  const formatTimestamp = (value) => {
    if (!value) {
      return "-";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return date.toLocaleString();
  };

  const playFlight = () => {
    if (!selectedFlowData.length) {
      return;
    }

    const lastIndex = Math.max(0, selectedFlowData.length - 1);
    const shouldRestart = replayEndIndexRef.current >= lastIndex;

    clearReplayTimer();
    setIsReplayPlaying(true);

    if (shouldRestart) {
      replayEndIndexRef.current = 0;
      setSelectedWindow((prev) => ({
        ...prev,
        startIndex: 0,
        endIndex: 0,
        ppmMin: 0,
        ppmMax: maxSelectablePpm,
      }));
    }

    replayTimerRef.current = window.setInterval(() => {
      if (replayEndIndexRef.current >= lastIndex) {
        clearReplayTimer();
        setIsReplayPlaying(false);
        return;
      }

      const nextEndIndex = replayEndIndexRef.current + 1;
      replayEndIndexRef.current = nextEndIndex;
      setSelectedWindow((prev) => ({
        ...prev,
        startIndex: 0,
        endIndex: nextEndIndex,
        ppmMin: 0,
        ppmMax: maxSelectablePpm,
      }));
    }, REPLAY_STEP_MS);
  };

  const pauseFlight = () => {
    clearReplayTimer();
    setIsReplayPlaying(false);
  };

  const resetFlight = () => {
    clearReplayTimer();
    setIsReplayPlaying(false);
    const lastIndex = Math.max(0, selectedFlowData.length - 1);
    replayEndIndexRef.current = lastIndex;
    setSelectedWindow({
      startIndex: 0,
      endIndex: lastIndex,
      ppmMin: 0,
      ppmMax: maxSelectablePpm,
    });
  };

  const handleToggleMethaneValidityVisibility = useCallback((key) => {
    setMethaneValidityVisibility((previous) => {
      if (key !== "valid" && key !== "invalid" && key !== "noData") {
        return previous;
      }

      const next = {
        ...previous,
        [key]: !previous[key],
      };

      if (!next.valid && !next.invalid && !next.noData) {
        next[key] = true;
      }

      return next;
    });
  }, []);

  const handleDeleteMission = async (missionId) => {
    if (!missionId || deletingMissionId) {
      return;
    }

    setDeletingMissionId(missionId);
    const deleted = await deleteMission(missionId);

    if (deleted) {
      setMissionsSample((previous) =>
        previous.filter((mission) => mission.id !== missionId),
      );
    }

    setDeletingMissionId(null);
  };

  const clearDeleteAllHold = useCallback(() => {
    if (deleteAllHoldTimeoutRef.current) {
      window.clearTimeout(deleteAllHoldTimeoutRef.current);
      deleteAllHoldTimeoutRef.current = null;
    }

    if (deleteAllHoldIntervalRef.current) {
      window.clearInterval(deleteAllHoldIntervalRef.current);
      deleteAllHoldIntervalRef.current = null;
    }
  }, []);

  const cancelDeleteAllHold = useCallback(() => {
    clearDeleteAllHold();
    setIsDeleteAllHolding(false);
    setDeleteAllHoldProgress(0);
  }, [clearDeleteAllHold]);

  const handleDeleteAllRecordedData = useCallback(async () => {
    if (isDeletingAllData) {
      return;
    }

    setIsDeletingAllData(true);
    const deleted = await deleteAllData();

    if (deleted) {
      setMissionsSample([]);
      setTelemetryHistorySample([]);
      setTelemetryHistoryRange({ from: "", to: "" });
      setSelectedMissionId(null);
      setIsMissionLoading(false);
      setSelectedResultDroneId(ALL_DRONES_OPTION);
      setImportMessage("All recorded data deleted.");
      if (typeof onDataRefresh === "function") {
        await onDataRefresh();
      }
    }

    setIsDeletingAllData(false);
    setIsDeleteAllHolding(false);
    setDeleteAllHoldProgress(0);
  }, [isDeletingAllData, onDataRefresh]);

  const beginDeleteAllHold = useCallback(() => {
    if (isDeletingAllData || isTelemetryHistoryLoading) {
      return;
    }

    clearDeleteAllHold();
    setImportMessage(null);
    setIsDeleteAllHolding(true);
    setDeleteAllHoldProgress(0);
    const startedAt = Date.now();

    deleteAllHoldIntervalRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setDeleteAllHoldProgress(
        Math.min(100, (elapsedMs / DELETE_ALL_HOLD_MS) * 100),
      );
    }, 50);

    deleteAllHoldTimeoutRef.current = window.setTimeout(() => {
      clearDeleteAllHold();
      setDeleteAllHoldProgress(100);
      void handleDeleteAllRecordedData();
    }, DELETE_ALL_HOLD_MS);
  }, [
    clearDeleteAllHold,
    handleDeleteAllRecordedData,
    isDeletingAllData,
    isTelemetryHistoryLoading,
  ]);

  useEffect(() => () => clearDeleteAllHold(), [clearDeleteAllHold]);

  const handleRunNotebookAnalysis = useCallback(async (tracerRates = {}) => {
    setIsAnalyzeModalOpen(true);
    setIsNotebookRunning(true);
    setAnalysisError("");
    setAnalysisOutputText("");
    setAnalysisImageDataUris([]);

    const nextTracerRates = {
      acetylene:
        tracerRates?.acetyleneTracerRate ?? analysisTracerRates.acetylene ?? "",
      nitrousOxide:
        tracerRates?.nitrousOxideTracerRate ?? analysisTracerRates.nitrousOxide ?? "",
    };
    const acetyleneTracerRate = Number.parseFloat(nextTracerRates.acetylene);
    const nitrousOxideTracerRate = Number.parseFloat(nextTracerRates.nitrousOxide);
    const tracerReleaseRates = {
      acetylene:
        aerisTracerAvailability.acetylene &&
          Number.isFinite(acetyleneTracerRate) &&
          acetyleneTracerRate > 0
          ? acetyleneTracerRate
          : null,
      nitrousOxide:
        aerisTracerAvailability.nitrousOxide &&
          Number.isFinite(nitrousOxideTracerRate) &&
          nitrousOxideTracerRate > 0
          ? nitrousOxideTracerRate
          : null,
    };

    setAnalysisTracerRates(nextTracerRates);

    if (!tracerReleaseRates.acetylene && !tracerReleaseRates.nitrousOxide) {
      setAnalysisError(
        "Enter a positive release rate for at least one tracer present in the selected Aeris window.",
      );
      setIsNotebookRunning(false);
      return;
    }

    const result = await runAerisAnalysis({
      samples: notebookAnalysisSamples,
      tracerReleaseRates,
      selection: {
        ...selectedWindow,
        sampleCount: notebookAnalysisSamples.length,
      },
      mission: {
        id: selectedMission?.id || null,
        name: selectedMission?.name || null,
        droneId:
          selectedResultDroneId === ALL_DRONES_OPTION ? null : selectedResultDroneId,
      },
    });

    if (!result?.ok) {
      setAnalysisError(result?.error || "Aeris analysis failed");
      setIsNotebookRunning(false);
      return;
    }

    setAnalysisExecutedAt(result.executedAt || new Date().toISOString());
    setAnalysisImageDataUris(
      Array.isArray(result.imageDataUris) && result.imageDataUris.length
        ? result.imageDataUris
        : result.imageDataUri
          ? [result.imageDataUri]
          : [],
    );
    setAnalysisOutputText(
      result.outputText ||
      "Notebook ran successfully, but returned no output text.",
    );
    setIsNotebookRunning(false);
  }, [
    analysisTracerRates.acetylene,
    analysisTracerRates.nitrousOxide,
    aerisTracerAvailability.acetylene,
    aerisTracerAvailability.nitrousOxide,
    notebookAnalysisSamples,
    selectedMission?.id,
    selectedMission?.name,
    selectedResultDroneId,
    selectedWindow,
  ]);

  const handleExportGeoJSON = useCallback(() => {
    if (!tracePointsForMap.length) {
      return;
    }

    const buildExportTracePoints = (tracePoints) =>
      tracePoints
        .map((point, index) => {
          const sourcePoint = selectedFlowDataForMapWithStartFilter[index] || null;
          const targetLatitude =
            toFiniteNumber(sourcePoint?.target_latitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_latitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_position?.latitude);
          const targetLongitude =
            toFiniteNumber(sourcePoint?.target_longitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_longitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_position?.longitude);
          const measuredLatitude = toFiniteNumber(point?.latitude);
          const measuredLongitude = toFiniteNumber(point?.longitude);
          const hasTargetCoordinates =
            targetLatitude !== null && targetLongitude !== null;

          return {
            ...point,
            latitude: hasTargetCoordinates ? targetLatitude : measuredLatitude,
            longitude: hasTargetCoordinates ? targetLongitude : measuredLongitude,
            coordinateSource: hasTargetCoordinates ? "target" : "measured",
          };
        })
        .filter(
          (point) =>
            Number.isFinite(Number(point?.latitude)) &&
            Number.isFinite(Number(point?.longitude)),
        );

    const { lowerLimit, upperLimit } = legendScale;
    const span = Math.max(upperLimit - lowerLimit, 0.1);
    const heatmapThreshold = lowerLimit + span * 0.04;
    const clamp = (value, minimum, maximum) =>
      Math.min(Math.max(value, minimum), maximum);
    const metersToLatitudeDegrees = (meters) => meters / 111320;
    const metersToLongitudeDegrees = (meters, latitude) =>
      meters / (111320 * Math.cos((latitude * Math.PI) / 180));
    const buildCirclePolygon = (longitude, latitude, radiusMeters) => {
      const segments = 24;
      const coordinates = [];

      for (let index = 0; index <= segments; index += 1) {
        const angle = (index / segments) * Math.PI * 2;
        const latOffset = metersToLatitudeDegrees(radiusMeters * Math.sin(angle));
        const lonOffset = metersToLongitudeDegrees(
          radiusMeters * Math.cos(angle),
          latitude,
        );
        coordinates.push([longitude + lonOffset, latitude + latOffset]);
      }

      return {
        type: "Polygon",
        coordinates: [coordinates],
      };
    };

    const exportedTracePoints = buildExportTracePoints(tracePointsForMap);

    const pointFeatures = exportedTracePoints.map((point) => {
      const traceValue = Number(point?.methane ?? 0);
      const markerColor = getScaledMethaneColor(traceValue, lowerLimit, upperLimit);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates:
            point.altitude != null
              ? [point.longitude, point.latitude, point.altitude]
              : [point.longitude, point.latitude],
        },
        properties: {
          exportLayer: "trace-point",
          "marker-color": markerColor,
          "marker-size": "small",
          stroke: markerColor,
          "stroke-width": 2,
          fill: markerColor,
          "fill-opacity": 0.8,
          timestamp: point.timestampIso ?? null,
          droneId: point.droneId ?? null,
          altitude: point.altitude ?? null,
          methane: traceValue,
          ch4: point.ch4 ?? null,
          sniffer: point.sniffer ?? null,
          purway: point.purway ?? null,
          acetylene: point.acetylene ?? null,
          nitrousOxide: point.nitrousOxide ?? null,
          methaneValid: point.methaneValid ?? null,
          sensorMode: point.sensorMode ?? null,
          displayMetricLabel: point.displayMetricLabel ?? null,
          displayMetricUnits: point.displayMetricUnits ?? null,
          sampleIndex: point.sampleIndex ?? null,
          sampleOrder: point.sampleOrder ?? null,
          coordinateSource: point.coordinateSource ?? "measured",
        },
      };
    });

    const heatmapFeatures = exportedTracePoints
      .filter((point) => Number(point?.methane ?? 0) >= heatmapThreshold)
      .map((point) => {
        const traceValue = Number(point?.methane ?? 0);
        const normalizedWeight = clamp((traceValue - lowerLimit) / span, 0, 1);
        const heatmapColor = getScaledMethaneColor(traceValue, lowerLimit, upperLimit);
        const radiusMeters = 7 + normalizedWeight * 15;

        return {
          type: "Feature",
          geometry: buildCirclePolygon(point.longitude, point.latitude, radiusMeters),
          properties: {
            exportLayer: "heatmap",
            stroke: heatmapColor,
            "stroke-width": 1,
            "stroke-opacity": 0.2 + normalizedWeight * 0.4,
            fill: heatmapColor,
            "fill-opacity": 0.12 + normalizedWeight * 0.5,
            methane: traceValue,
            heatmapWeight: normalizedWeight,
            heatmapRadiusMeters: radiusMeters,
            heatmapThreshold,
            droneId: point.droneId ?? null,
            timestamp: point.timestampIso ?? null,
            displayMetricLabel: point.displayMetricLabel ?? null,
            displayMetricUnits: point.displayMetricUnits ?? null,
          },
        };
      });

    const geojson = {
      type: "FeatureCollection",
      colorScale: { lowerLimit, upperLimit },
      heatmap: {
        threshold: heatmapThreshold,
        pointCount: heatmapFeatures.length,
      },
      features: [...heatmapFeatures, ...pointFeatures],
    };
    const missionLabel = selectedMission?.name
      ? selectedMission.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      : "mission";
    const droneLabel =
      selectedResultDroneId !== ALL_DRONES_OPTION
        ? `_${selectedResultDroneId}`
        : "";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${missionLabel}${droneLabel}_${timestamp}.geojson`;

    const blob = new Blob([JSON.stringify(geojson, null, 2)], {
      type: "application/geo+json",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }, [
    tracePointsForMap,
    legendScale,
    selectedMission,
    selectedResultDroneId,
    selectedFlowDataForMapWithStartFilter,
  ]);

  const handleExportKMZ = useCallback(async () => {
    if (!tracePointsForMap.length) {
      return;
    }

    const buildExportTracePoints = (tracePoints) =>
      tracePoints
        .map((point, index) => {
          const sourcePoint = selectedFlowDataForMapWithStartFilter[index] || null;
          const targetLatitude =
            toFiniteNumber(sourcePoint?.target_latitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_latitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_position?.latitude);
          const targetLongitude =
            toFiniteNumber(sourcePoint?.target_longitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_longitude) ??
            toFiniteNumber(sourcePoint?.payload?.target_position?.longitude);
          const measuredLatitude = toFiniteNumber(point?.latitude);
          const measuredLongitude = toFiniteNumber(point?.longitude);
          const hasTargetCoordinates =
            targetLatitude !== null && targetLongitude !== null;

          return {
            ...point,
            latitude: hasTargetCoordinates ? targetLatitude : measuredLatitude,
            longitude: hasTargetCoordinates ? targetLongitude : measuredLongitude,
            coordinateSource: hasTargetCoordinates ? "target" : "measured",
          };
        })
        .filter(
          (point) =>
            Number.isFinite(Number(point?.latitude)) &&
            Number.isFinite(Number(point?.longitude)),
        );

    const { lowerLimit, upperLimit } = legendScale;
    const span = Math.max(upperLimit - lowerLimit, 0.1);
    const heatmapThreshold = lowerLimit + span * 0.04;

    const xmlEscape = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const clamp = (value, minimum, maximum) =>
      Math.min(Math.max(value, minimum), maximum);

    const toKmlColor = (hexColor, alphaHex = "ff") => {
      const safe = String(hexColor || "").replace("#", "");
      if (safe.length !== 6) {
        return `${alphaHex}b8bd38`;
      }

      const red = safe.slice(0, 2);
      const green = safe.slice(2, 4);
      const blue = safe.slice(4, 6);
      return `${alphaHex}${blue}${green}${red}`;
    };

    const hexToRgb = (hexColor) => {
      const safe = String(hexColor || "").replace("#", "");
      if (safe.length !== 6) {
        return { r: 56, g: 189, b: 248 };
      }

      return {
        r: Number.parseInt(safe.slice(0, 2), 16),
        g: Number.parseInt(safe.slice(2, 4), 16),
        b: Number.parseInt(safe.slice(4, 6), 16),
      };
    };

    const sanitizeKmzAssetName = (value, fallbackName) =>
      String(value || fallbackName)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || fallbackName;

    const mimeTypeToExtension = (mimeType) => {
      const normalized = String(mimeType || "").toLowerCase();

      if (normalized.includes("png")) {
        return "png";
      }

      if (normalized.includes("jpeg") || normalized.includes("jpg")) {
        return "jpg";
      }

      if (normalized.includes("webp")) {
        return "webp";
      }

      return "png";
    };

    const zip = new JSZip();

    const exportedTracePoints = buildExportTracePoints(tracePointsForMap);

    if (!exportedTracePoints.length) {
      return;
    }

    const missionLabelRaw = selectedMission?.name || "Mission";
    const missionLabel = xmlEscape(missionLabelRaw);

    const pointStyleMap = new globalThis.Map();
    const pointStyleDefs = [];
    const pointPlacemarks = exportedTracePoints.map((point, index) => {
      const traceValue = Number(point?.methane ?? 0);
      const markerColor = getScaledMethaneColor(traceValue, lowerLimit, upperLimit);
      const styleKey = `${markerColor.toLowerCase()}-pt`;

      if (!pointStyleMap.has(styleKey)) {
        const styleId = `pt-${pointStyleMap.size}`;
        pointStyleMap.set(styleKey, styleId);
        pointStyleDefs.push(
          `<Style id="${styleId}"><IconStyle><color>${toKmlColor(markerColor, "70")}</color><scale>0.55</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle><LabelStyle><scale>0</scale></LabelStyle></Style>`,
        );
      }

      const styleId = pointStyleMap.get(styleKey);
      const altitude = Number(point?.altitude ?? 0);
      const displayMetricLabel = xmlEscape(point?.displayMetricLabel || "Value");
      const displayMetricUnits = xmlEscape(point?.displayMetricUnits || "");
      const description = xmlEscape(
        `${displayMetricLabel}: ${traceValue.toFixed(3)} ${displayMetricUnits}\nDrone: ${point?.droneId || "unknown"}\nTime: ${point?.timestampIso || "n/a"}`,
      );

      return `<Placemark><name>Sample ${index + 1}</name><styleUrl>#${styleId}</styleUrl><description>${description}</description><Point><coordinates>${point.longitude},${point.latitude},${altitude}</coordinates></Point></Placemark>`;
    });

    const pathCoordinates = exportedTracePoints
      .map((point) => `${point.longitude},${point.latitude},${Number(point?.altitude ?? 0)}`)
      .join(" ");
    const pathPlacemark = `<Placemark><name>Mission Path</name><Style><LineStyle><color>ff4ade80</color><width>3</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${pathCoordinates}</coordinates></LineString></Placemark>`;

    const orthophotoOverlay =
      selectedMissionOrthophoto?.imageUrl &&
      Array.isArray(selectedMissionOrthophoto.coordinates) &&
      selectedMissionOrthophoto.coordinates.length === 4
        ? selectedMissionOrthophoto
        : null;

    const heatmapPoints = exportedTracePoints.filter(
      (point) => Number(point?.methane ?? 0) >= heatmapThreshold,
    );

    const determineHeatBounds = () => {
      if (orthophotoOverlay) {
        return {
          west: Number(orthophotoOverlay.coordinates[0]?.[0] ?? -180),
          north: Number(orthophotoOverlay.coordinates[0]?.[1] ?? 90),
          east: Number(orthophotoOverlay.coordinates[1]?.[0] ?? 180),
          south: Number(orthophotoOverlay.coordinates[2]?.[1] ?? -90),
        };
      }

      const latitudes = exportedTracePoints.map((point) => Number(point.latitude));
      const longitudes = exportedTracePoints.map((point) => Number(point.longitude));
      const minLat = Math.min(...latitudes);
      const maxLat = Math.max(...latitudes);
      const minLon = Math.min(...longitudes);
      const maxLon = Math.max(...longitudes);
      const latPadding = Math.max((maxLat - minLat) * 0.035, 0.00006);
      const lonPadding = Math.max((maxLon - minLon) * 0.035, 0.00006);

      return {
        west: minLon - lonPadding,
        north: maxLat + latPadding,
        east: maxLon + lonPadding,
        south: minLat - latPadding,
      };
    };

    const createHeatmapOverlayBlob = async (bounds) => {
      const lonSpan = Math.max(bounds.east - bounds.west, 1e-9);
      const latSpan = Math.max(bounds.north - bounds.south, 1e-9);
      const aspect = clamp(lonSpan / latSpan, 0.45, 2.3);
      const width = 1400;
      const height = Math.max(720, Math.min(1800, Math.round(width / aspect)));

      // Keep two accumulators so color reflects methane values, not point density.
      const pixelCount = width * height;
      const weightSums = new Float32Array(pixelCount);
      const methaneSums = new Float32Array(pixelCount);

      for (const point of heatmapPoints) {
        const traceValue = Number(point?.methane ?? 0);
        const methaneWeight = clamp((traceValue - lowerLimit) / span, 0, 1);
        const centerX = ((Number(point.longitude) - bounds.west) / lonSpan) * width;
        const centerY =
          (1 - (Number(point.latitude) - bounds.south) / latSpan) *
          height;
        const radius = 8 + methaneWeight * 24;
        const radiusSquared = radius * radius;
        const baseWeight = 0.35 + methaneWeight * 0.65;

        const minX = Math.max(0, Math.floor(centerX - radius));
        const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
        const minY = Math.max(0, Math.floor(centerY - radius));
        const maxY = Math.min(height - 1, Math.ceil(centerY + radius));

        for (let y = minY; y <= maxY; y += 1) {
          const dy = y - centerY;

          for (let x = minX; x <= maxX; x += 1) {
            const dx = x - centerX;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > radiusSquared) {
              continue;
            }

            const normalizedDistance = 1 - distanceSquared / radiusSquared;
            const kernel =
              normalizedDistance * normalizedDistance * normalizedDistance;
            const weight = kernel * baseWeight;
            const pixelIndex = y * width + x;

            weightSums[pixelIndex] += weight;
            methaneSums[pixelIndex] += weight * traceValue;
          }
        }
      }

      const colorCanvas = document.createElement("canvas");
      colorCanvas.width = width;
      colorCanvas.height = height;
      const colorCtx = colorCanvas.getContext("2d");

      if (!colorCtx) {
        throw new Error("Unable to create heatmap color canvas.");
      }

      const densityValues = [];
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const density = weightSums[pixelIndex];
        if (density > 1e-6) {
          densityValues.push(density);
        }
      }

      densityValues.sort((a, b) => a - b);
      const percentileValue = (p) => {
        if (!densityValues.length) {
          return 0;
        }

        const index = Math.floor((densityValues.length - 1) * p);
        return densityValues[index];
      };

      const p15 = percentileValue(0.15);
      const p97 = percentileValue(0.97);
      const densityRange = Math.max(p97 - p15, 1e-5);

      const outputImage = colorCtx.createImageData(width, height);
      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const density = weightSums[pixelIndex];
        if (density <= 1e-6) {
          continue;
        }

        const rgbaIndex = pixelIndex * 4;
        const methaneAtPixel = methaneSums[pixelIndex] / density;
        const normalizedDensity = clamp((density - p15) / densityRange, 0, 1);

        const pixelHex = getScaledMethaneColor(
          methaneAtPixel,
          lowerLimit,
          upperLimit,
        );
        const pixelRgb = hexToRgb(pixelHex);
        const alpha = clamp(
          0.72 + Math.pow(normalizedDensity, 0.8) * 0.28,
          0,
          1,
        );

        outputImage.data[rgbaIndex] = pixelRgb.r;
        outputImage.data[rgbaIndex + 1] = pixelRgb.g;
        outputImage.data[rgbaIndex + 2] = pixelRgb.b;
        outputImage.data[rgbaIndex + 3] = Math.round(alpha * 255);
      }

      colorCtx.putImageData(outputImage, 0, 0);

      const softenedCanvas = document.createElement("canvas");
      softenedCanvas.width = width;
      softenedCanvas.height = height;
      const softenedCtx = softenedCanvas.getContext("2d");

      if (!softenedCtx) {
        throw new Error("Unable to create softened heatmap canvas.");
      }

      softenedCtx.filter = "blur(0.6px)";
      softenedCtx.drawImage(colorCanvas, 0, 0);
      softenedCtx.filter = "none";

      return canvasToBlob(softenedCanvas, "image/png");
    };

    let orthophotoAssetName = null;
    if (orthophotoOverlay) {
      const imageResponse = await fetch(orthophotoOverlay.imageUrl);
      if (!imageResponse.ok) {
        throw new Error(
          "Failed to read the attached mission image for KMZ export.",
        );
      }

      const imageBlob = await imageResponse.blob();
      const assetBaseName = sanitizeKmzAssetName(
        orthophotoOverlay.fileName?.replace(/\.[^.]+$/, "") ||
          "mission_orthophoto",
        "mission_orthophoto",
      );
      orthophotoAssetName = `images/${assetBaseName}.${mimeTypeToExtension(imageBlob.type)}`;
      zip.file(orthophotoAssetName, imageBlob);
    }

    const heatBounds = determineHeatBounds();
    let heatmapAssetName = null;
    if (heatmapPoints.length) {
      const heatmapBlob = await createHeatmapOverlayBlob(heatBounds);
      const heatAssetBaseName = sanitizeKmzAssetName(
        `${missionLabelRaw}_smooth_heatmap`,
        "smooth_heatmap",
      );
      heatmapAssetName = `images/${heatAssetBaseName}.png`;
      zip.file(heatmapAssetName, heatmapBlob);
    }

    const orthophotoFolder = orthophotoOverlay
      ? `<Folder>
      <name>Orthophoto Overlay</name>
      <GroundOverlay>
        <name>${xmlEscape(orthophotoOverlay.fileName || "Orthophoto")}</name>
        <Icon>
          <href>${xmlEscape(orthophotoAssetName)}</href>
        </Icon>
        <drawOrder>0</drawOrder>
        <LatLonBox>
          <north>${orthophotoOverlay.coordinates[0]?.[1] ?? 90}</north>
          <south>${orthophotoOverlay.coordinates[2]?.[1] ?? -90}</south>
          <east>${orthophotoOverlay.coordinates[1]?.[0] ?? 180}</east>
          <west>${orthophotoOverlay.coordinates[0]?.[0] ?? -180}</west>
        </LatLonBox>
      </GroundOverlay>
    </Folder>`
      : "";

    const heatmapOverlayFolder = heatmapAssetName
      ? `<Folder>
      <name>Smooth Heatmap</name>
      <GroundOverlay>
        <name>Telemetry Heatmap</name>
        <color>f2ffffff</color>
        <Icon>
          <href>${xmlEscape(heatmapAssetName)}</href>
        </Icon>
        <drawOrder>2</drawOrder>
        <LatLonBox>
          <north>${heatBounds.north}</north>
          <south>${heatBounds.south}</south>
          <east>${heatBounds.east}</east>
          <west>${heatBounds.west}</west>
        </LatLonBox>
      </GroundOverlay>
    </Folder>`
      : "";

//     const kml = `<?xml version="1.0" encoding="UTF-8"?>
// <kml xmlns="http://www.opengis.net/kml/2.2">
//   <Document>
//     <name>${missionLabel}</name>
//     <description>${xmlEscape(
//       `Generated by EERL Dashboard. Scale ${lowerLimit.toFixed(2)} to ${upperLimit.toFixed(2)}.`,
//     )}</description>
//     ${pointStyleDefs.join("\n    ")}
//     <Folder>
//       <name>Mission Path</name>
//       ${pathPlacemark}
//     </Folder>
//     <Folder>
//       <name>Sample Points</name>
//       ${pointPlacemarks.join("\n      ")}
//       </Folder>
//     ${orthophotoFolder}
//     ${heatmapOverlayFolder}
//   </Document>
// </kml>`;
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${missionLabel}</name>
    <description>${xmlEscape(
      `Generated by EERL Dashboard. Scale ${lowerLimit.toFixed(2)} to ${upperLimit.toFixed(2)}.`,
    )}</description>
    ${pointStyleDefs.join("\n    ")}
    ${orthophotoFolder}
    ${heatmapOverlayFolder}
  </Document>
</kml>`;

    const missionFileLabel = selectedMission?.name
      ? selectedMission.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      : "mission";
    const droneLabel =
      selectedResultDroneId !== ALL_DRONES_OPTION
        ? `_${selectedResultDroneId}`
        : "";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${missionFileLabel}${droneLabel}_${timestamp}.kmz`;

    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      mimeType: "application/vnd.google-earth.kmz",
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }, [
    tracePointsForMap,
    legendScale,
    selectedMission,
    selectedResultDroneId,
    selectedFlowDataForMapWithStartFilter,
  ]);

  const handleDownloadAnalysis = useCallback(() => {
    if (!analysisImageDataUris.length && !analysisOutputText) {
      return;
    }

    const timestamp = analysisExecutedAt
      ? new Date(analysisExecutedAt).toISOString().replace(/[:.]/g, "-")
      : new Date().toISOString().replace(/[:.]/g, "-");

    if (analysisImageDataUris.length) {
      analysisImageDataUris.forEach((imageDataUri, index) => {
        const link = document.createElement("a");
        link.href = imageDataUri;
        link.download = `aeris-analysis-${timestamp}-${index + 1}.png`;
        link.click();
      });
      return;
    }

    const link = document.createElement("a");
    const blob = new Blob([analysisOutputText], {
      type: "text/plain;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `aeris-analysis-${timestamp}.txt`;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }, [analysisExecutedAt, analysisImageDataUris, analysisOutputText]);

  return (
    <div className="grid h-full w-full gap-4 p-3 lg:grid-cols-[250px_minmax(0,1fr)]">
      {isAnalyzeModalOpen ? (
        <MissionModal size="wide" onClose={() => setIsAnalyzeModalOpen(false)}>
          <div className="flex h-full min-h-[78vh] flex-col gap-4 overflow-y-auto pr-2">
            <div className="flex flex-wrap items-start justify-between gap-3 pr-10">
              <div>
                <p
                  className="text-[11px] uppercase tracking-[0.2em]"
                  style={{ color: color.textDim }}
                >
                  Aeris Notebook
                </p>
                <h2
                  className="text-2xl font-semibold"
                  style={{ color: color.text }}
                >
                  Analysis Result
                </h2>
                <p className="text-sm" style={{ color: color.textMuted }}>
                  {isNotebookRunning
                    ? "Running all notebook cells..."
                    : analysisExecutedAt
                      ? `Completed at ${new Date(analysisExecutedAt).toLocaleString()}`
                      : "Awaiting notebook output"}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
                  style={{
                    backgroundColor: color.surface,
                    borderColor: color.borderStrong,
                    color: color.text,
                  }}
                  onClick={handleDownloadAnalysis}
                  disabled={!analysisImageDataUris.length && !analysisOutputText}
                >
                  <Download size={16} />
                  Download
                </button>
                <button
                  type="button"
                  className="rounded-md px-4 py-2 text-white"
                  style={{ backgroundColor: color.orange }}
                  onClick={() => setIsAnalyzeModalOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
              <div
                className="min-h-[420px] overflow-auto rounded-xl border p-4"
                style={{
                  backgroundColor: color.surface,
                  borderColor: color.border,
                }}
              >
                {isNotebookRunning ? (
                  <p className="text-sm" style={{ color: color.textMuted }}>
                    Executing notebook. This can take a little while...
                  </p>
                ) : analysisError ? (
                  <p
                    className="text-sm whitespace-pre-wrap"
                    style={{ color: color.red }}
                  >
                    {analysisError}
                  </p>
                ) : analysisImageDataUris.length ? (
                  <div className="flex flex-col gap-4">
                    {analysisImageDataUris.map((imageDataUri, index) => (
                      <div key={`${imageDataUri.slice(0, 64)}-${index}`} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <h3
                            className="text-sm font-semibold uppercase tracking-[0.12em]"
                            style={{ color: color.textDim }}
                          >
                            {analysisImageDataUris.length > 1
                              ? `Figure ${index + 1}`
                              : "Figure"}
                          </h3>
                        </div>
                        <img
                          src={imageDataUri}
                          alt={`Notebook analysis plot ${index + 1}`}
                          className="w-full rounded-lg border"
                          style={{
                            borderColor: color.borderStrong,
                            backgroundColor: color.card,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: color.textMuted }}>
                    No figure was returned by the notebook.
                  </p>
                )}
              </div>

              <div
                className="min-h-[420px] overflow-auto rounded-xl border p-4"
                style={{
                  backgroundColor: color.surface,
                  borderColor: color.border,
                }}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3
                    className="text-sm font-semibold uppercase tracking-[0.12em]"
                    style={{ color: color.textDim }}
                  >
                    Console Output
                  </h3>
                  {analysisImageDataUris.length ? (
                    <span
                      className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]"
                      style={{
                        backgroundColor: color.greenSoft,
                        color: color.green,
                      }}
                    >
                      {analysisImageDataUris.length > 1
                        ? `${analysisImageDataUris.length} Figures Ready`
                        : "Figure Ready"}
                    </span>
                  ) : null}
                </div>
                {isNotebookRunning ? (
                  <p className="text-sm" style={{ color: color.textMuted }}>
                    Waiting for analysis logs...
                  </p>
                ) : analysisError ? (
                  <p
                    className="text-sm whitespace-pre-wrap"
                    style={{ color: color.red }}
                  >
                    {analysisError}
                  </p>
                ) : analysisOutputText ? (
                  <pre
                    className="text-xs whitespace-pre-wrap"
                    style={{ color: color.text, margin: 0 }}
                  >
                    {analysisOutputText}
                  </pre>
                ) : (
                  <p className="text-sm" style={{ color: color.textMuted }}>
                    No text output was returned by the notebook.
                  </p>
                )}
              </div>
            </div>
          </div>
        </MissionModal>
      ) : null}
      <div className="flex items-center flex-col gap-3">
        <button
          type="button"
          onClick={openCsvPicker}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-lg font-medium transition-colors w-full justify-center"
          style={{
            backgroundColor: color.surface,
            borderColor: color.borderStrong,
            color: color.green,
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 13 13"
            fill="none"
            transform="rotate(180)"
          >
            <path
              d="M6.5 1v7M3.5 5l3 3 3-3M2 10h9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Upload CSV
        </button>

        {importMessage && (
          <p className="text-xs text-center" style={{ color: color.green }}>
            {importMessage}
          </p>
        )}

        <aside
          className="rounded-lg border p-3 w-full"
          style={{ backgroundColor: color.card, borderColor: color.border }}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex flex-row gap-3">
              <h2
                className="text-sm font-semibold"
                style={{ color: color.text }}
              >
                Saved Missions
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-xs"
                style={{
                  backgroundColor: color.surface,
                  color: color.textMuted,
                }}
              >
                {actualMissions.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsDeleteMode((previous) => !previous);
              }}
              style={{
                color: isDeleteMode ? color.orange : color.textMuted,
              }}
            >
              <SquarePen size={17} />
            </button>
          </div>

          <div className="space-y-2">
            {aggregateMission ? (() => {
              const mission = aggregateMission;
              const isActive = mission.id === selectedMissionId;
              return (
                <div
                  key={mission.id}
                  className="relative w-full overflow-hidden rounded-md"
                  style={{ backgroundColor: color.surface }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      handleSelectMission(mission);
                    }}
                    className="relative z-10 flex w-full flex-row rounded-md border px-3 py-2 text-left"
                    style={{
                      borderColor: isActive ? color.orange : color.border,
                      backgroundColor: isActive
                        ? color.orangeSoft
                        : color.surface,
                    }}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className="text-sm font-semibold"
                          style={{ color: color.text }}
                        >
                          {mission.name}
                        </p>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                          style={{
                            backgroundColor: color.orangeSoft,
                            color: color.orange,
                          }}
                        >
                          Permanent
                        </span>
                      </div>
                      <p
                        className="mt-1 text-xs"
                        style={{ color: color.textMuted }}
                      >
                        {mission.sampleCount} samples across {mission.droneIds.length} drone(s)
                      </p>
                      <p
                        className="mt-1 text-[11px]"
                        style={{ color: color.textDim }}
                      >
                        Combined view across recorded telemetry history
                      </p>
                      {aggregateMission?.startTs || aggregateMission?.endTs ? (
                        <p
                          className="mt-1 text-[11px]"
                          style={{ color: color.textDim }}
                        >
                          {aggregateMission?.startTs
                            ? `${formatTimestamp(aggregateMission.startTs)} to ${formatTimestamp(aggregateMission.endTs)}`
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  </button>
                </div>
              );
            })() : null}

            <div
              className="rounded-md border p-3"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p
                  className="text-[10px] font-semibold uppercase tracking-[0.16em]"
                  style={{ color: color.textDim }}
                >
                  All Data Range
                </p>
                <span
                  className="text-[11px]"
                  style={{ color: color.textMuted }}
                >
                  {isTelemetryHistoryLoading
                    ? "Loading..."
                    : shouldUseViewportTelemetry
                      ? isMapViewportTelemetryLoading
                        ? "Viewport loading..."
                        : mapViewportTelemetrySummary.cacheHit
                          ? "Viewport cache hit"
                          : "Viewport aggregate mode"
                      : "Latest 100,000 rows max"}
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs" style={{ color: color.textMuted }}>
                  From
                  <input
                    type="datetime-local"
                    value={telemetryHistoryRange.from}
                    onChange={(event) => {
                      const nextFrom = event.target.value;
                      setTelemetryHistoryRange((previous) => ({
                        ...previous,
                        from: nextFrom,
                      }));
                    }}
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    style={{
                      backgroundColor: color.card,
                      borderColor: color.borderStrong,
                      color: color.text,
                    }}
                  />
                </label>
                <label className="text-xs" style={{ color: color.textMuted }}>
                  To
                  <input
                    type="datetime-local"
                    value={telemetryHistoryRange.to}
                    onChange={(event) => {
                      const nextTo = event.target.value;
                      setTelemetryHistoryRange((previous) => ({
                        ...previous,
                        to: nextTo,
                      }));
                    }}
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    style={{
                      backgroundColor: color.card,
                      borderColor: color.borderStrong,
                      color: color.text,
                    }}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-row gap-2">
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-xs text-nowrap font-semibold"
                  style={{
                    backgroundColor: color.orange,
                    color: "#ffffff",
                    opacity: isTelemetryHistoryLoading ? 0.6 : 1,
                  }}
                  disabled={isTelemetryHistoryLoading}
                  onClick={() => {
                    void loadTelemetryHistory(telemetryHistoryRange);
                  }}
                >
                  Apply Range
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-xs text-nowrap font-semibold"
                  style={{
                    backgroundColor: color.card,
                    borderColor: color.borderStrong,
                    color: color.text,
                    opacity: isTelemetryHistoryLoading ? 0.6 : 1,
                  }}
                  disabled={isTelemetryHistoryLoading}
                  onClick={() => {
                    const emptyRange = { from: "", to: "" };
                    setTelemetryHistoryRange(emptyRange);
                    void loadTelemetryHistory(emptyRange);
                  }}
                >
                  Clear Range
                </button>
              </div>
              {shouldUseViewportTelemetry ? (
                <p className="mt-2 text-[11px]" style={{ color: color.textMuted }}>
                  Windowed map points: {mapViewportTelemetrySummary.renderedPointCount.toLocaleString()} / {mapViewportTelemetrySummary.inputPointCount.toLocaleString()} in view
                  {Number.isFinite(mapViewportTelemetrySummary.zoom)
                    ? ` (z${mapViewportTelemetrySummary.zoom.toFixed(1)})`
                    : ""}
                </p>
              ) : null}
              <div className="mt-4 flex items-center justify-end">
                <button
                  type="button"
                  onPointerDown={beginDeleteAllHold}
                  onPointerUp={cancelDeleteAllHold}
                  onPointerLeave={cancelDeleteAllHold}
                  onPointerCancel={cancelDeleteAllHold}
                  disabled={isDeletingAllData || isTelemetryHistoryLoading}
                  className="relative overflow-hidden rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                  style={{
                    backgroundColor: color.surface,
                    border: `1px solid ${color.border}`,
                    color: isDeleteAllHolding ? color.red : color.textDim,
                    opacity: isDeleteAllHolding || isDeletingAllData ? 0.95 : 0.28,
                    transition: "opacity 160ms ease, color 160ms ease",
                  }}
                  aria-label="Hold for 2 seconds to delete all recorded data"
                  title="Hold for 2 seconds to delete all recorded data"
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${deleteAllHoldProgress}%`,
                      backgroundColor: "rgba(239, 68, 68, 0.18)",
                      transition: isDeleteAllHolding
                        ? "none"
                        : "width 160ms ease",
                    }}
                  />
                  <span className="relative z-10">
                    {isDeletingAllData
                      ? "Deleting All Data"
                      : isDeleteAllHolding
                        ? `Hold ${Math.max(0, (DELETE_ALL_HOLD_MS - (deleteAllHoldProgress / 100) * DELETE_ALL_HOLD_MS) / 1000).toFixed(1)}s`
                        : "Delete All Data"}
                  </span>
                </button>
              </div>
            </div>

            {savedMissions.length ? (
              <div className="pt-2">
                <div className="mb-2 flex items-center gap-2">
                  <div
                    className="h-px flex-1"
                    style={{ backgroundColor: color.border }}
                  />
                  <span
                    className="text-[10px] font-semibold uppercase tracking-[0.16em]"
                    style={{ color: color.textDim }}
                  >
                    Saved Missions
                  </span>
                  <div
                    className="h-px flex-1"
                    style={{ backgroundColor: color.border }}
                  />
                </div>
              </div>
            ) : null}

            {savedMissions.map((mission) => {
              const isActive = mission.id === selectedMissionId;
              const isDeleting = deletingMissionId === mission.id;
              const isContinuing = continuingMissionId === mission.id;
              return (
                <div
                  key={mission.id}
                  className="relative w-full overflow-hidden rounded-md"
                  style={{ backgroundColor: color.surface }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      handleSelectMission(mission);
                    }}
                    onKeyPress={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        handleSelectMission(mission);
                      }
                    }}
                    className="relative z-10 flex w-full flex-row rounded-md border px-3 py-2 text-left cursor-pointer"
                    style={{
                      borderColor: isActive ? color.orange : color.border,
                      backgroundColor: isActive ? color.orangeSoft : color.surface,
                    }}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold" style={{ color: color.text }}>
                          {mission.name}
                        </p>
                        <span className="text-[11px]" style={{ color: isActive ? color.orange : color.textDim }}>
                          {mission.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: color.textMuted }}>
                        {mission.sampleCount} samples across {mission.droneIds.length} drone(s)
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {mission.droneIds.map((droneId) => {
                          const presentation = sensorModePresentation(mission.droneSensorModeById?.[droneId]);
                          return (
                            <span
                              key={`${mission.id}-${droneId}`}
                              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{
                                color: presentation.foreground,
                                backgroundColor: presentation.background,
                              }}
                            >
                              {droneId} • {presentation.label}
                            </span>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-[11px]" style={{ color: color.textDim }}>
                        {formatTimestamp(mission.endTs)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 px-3 pb-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onContinueMission?.(mission);
                      }}
                      disabled={measurementStatus !== "idle" && !isContinuing}
                      className="rounded-md px-2.5 py-1 text-[11px] font-semibold"
                      style={{
                        backgroundColor: isContinuing ? color.greenSoft : color.orangeSoft,
                        color: isContinuing ? color.green : color.orange,
                        opacity: measurementStatus !== "idle" && !isContinuing ? 0.55 : 1,
                      }}
                    >
                      {isContinuing ? "Continuing" : "Continue"}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDeleteMission(mission.id);
                    }}
                    disabled={!isDeleteMode || isDeleting || mission.isSynthetic}
                    className="absolute right-0 top-0 z-20 flex h-full w-1/3 items-center justify-center transition-transform duration-300 ease-out"
                    style={{
                      backgroundColor: mission.isSynthetic ? color.surface : color.red,
                      color: mission.isSynthetic ? color.textDim : "#ffffff",
                      transform: isDeleteMode ? "translateX(0)" : "translateX(100%)",
                      opacity: isDeleteMode ? 1 : 0,
                      pointerEvents: isDeleteMode && !mission.isSynthetic ? "auto" : "none",
                    }}
                    aria-label={
                      mission.isSynthetic
                        ? `${mission.name} cannot be deleted`
                        : `Delete mission ${mission.name}`
                    }
                  >
                    {mission.isSynthetic ? "Permanent" : <Trash size={18} />}
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <section className="grid gap-3 h-full">
        <div
          className="rounded-lg border p-4"
          style={{
            backgroundColor: color.card,
            borderColor: color.border,
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p
                className="text-xs uppercase tracking-[0.12em]"
                style={{ color: color.textDim }}
              >
                Analysis Control
              </p>
              <h3
                className="text-xl font-semibold"
                style={{ color: color.text }}
              >
                {selectedMission?.name || "No mission selected"}
              </h3>
              <p className="text-xs" style={{ color: color.textMuted }}>
                {selectedMission?.sampleCount || 0} samples across{" "}
                {selectedMission?.droneIds.length || 0} drone(s){" "}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="rounded-full px-3 py-1 font-semibold"
                style={{
                  backgroundColor: analysisReadiness.background,
                  color: analysisReadiness.tone,
                }}
              >
                {analysisReadiness.label}
              </span>
              <span
                className="rounded-full px-3 py-1"
                style={{
                  backgroundColor: color.surface,
                  color: color.textMuted,
                }}
              >
                Samples {selectedMission?.sampleCount || 0}
              </span>
              <span
                className="rounded-full px-3 py-1"
                style={{
                  backgroundColor: color.orangeSoft,
                  color: color.orange,
                }}
              >
                Peak CH4 {Number(selectedMission?.peakMethane || 0).toFixed(2)}{" "}
                ppm
              </span>
              <span
                className="rounded-full px-3 py-1"
                style={{ backgroundColor: color.greenSoft, color: color.green }}
              >
                Duration {missionDurationText}
              </span>
              {isAerisAnalysis ? (
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 font-semibold"
                  style={{
                    backgroundColor: color.orange,
                    color: "#ffffff",
                  }}
                  onClick={() => {
                    void handleRunNotebookAnalysis();
                  }}
                  disabled={isNotebookRunning}
                >
                  {isNotebookRunning ? "Running..." : "Run Analysis"}
                </button>
              ) : isDualSensorAnalysis ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span
                    className="rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em]"
                    style={{
                      backgroundColor: color.orangeSoft,
                      color: color.orange,
                    }}
                  >
                    Estimates follow graph timeframe
                  </span>
                  {isDualEstimateBlocked ? (
                    <span
                      className="rounded-md px-3 py-1.5 text-xs font-semibold"
                      style={{
                        backgroundColor: "rgba(239, 68, 68, 0.12)",
                        color: color.red,
                      }}
                    >
                      Upload CSV with distance to calculate Purway-derived estimates
                    </span>
                  ) : isDualEstimatePartial ? (
                    <span
                      className="rounded-md px-3 py-1.5 text-xs font-semibold"
                      style={{
                        backgroundColor: "rgba(240, 193, 93, 0.16)",
                        color: color.warning,
                      }}
                    >
                      Some samples are missing distance; estimates use only rows with path length
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {isDualSensorAnalysis ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div
              className="rounded-lg border px-3 py-3"
              style={{ backgroundColor: color.card, borderColor: color.border }}
            >
              <p
                className="text-[11px] uppercase tracking-[0.12em]"
                style={{ color: color.textDim }}
              >
                Unified Emission
              </p>
              <p
                className="mt-1 text-xl font-semibold"
                style={{ color: color.text }}
              >
                {isDualEstimateBlocked
                  ? "CSV required"
                  : `${formatCompactValue(
                    fluxEstimates.emissionRate.emissionRateKgH,
                    3,
                  )} kg/h`}
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-3"
              style={{ backgroundColor: color.card, borderColor: color.border }}
            >
              <p
                className="text-[11px] uppercase tracking-[0.12em]"
                style={{ color: color.textDim }}
              >
                Confidence
              </p>
              <p
                className="mt-1 text-xl font-semibold"
                style={{ color: color.text }}
              >
                {confidenceScore}%
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-3"
              style={{ backgroundColor: color.card, borderColor: color.border }}
            >
              <p
                className="text-[11px] uppercase tracking-[0.12em]"
                style={{ color: color.textDim }}
              >
                Avg Methane
              </p>
              <p
                className="mt-1 text-xl font-semibold"
                style={{ color: color.text }}
              >
                {averageMethane.toFixed(2)} ppm
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-3"
              style={{ backgroundColor: color.card, borderColor: color.border }}
            >
              <p
                className="text-[11px] uppercase tracking-[0.12em]"
                style={{ color: color.textDim }}
              >
                Threshold Samples
              </p>
              <p
                className="mt-1 text-xl font-semibold"
                style={{ color: color.text }}
              >
                {thresholdSamples}
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 xl:grid-cols-[1.35fr_0.65fr] h-full">
          <div
            className="min-h-[320px] rounded-lg border p-4"
            style={{ backgroundColor: color.card, borderColor: color.border }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h4
                className="text-sm font-semibold"
                style={{ color: color.text }}
              >
                Flight Replay + Analysis Map
              </h4>
              <div className="relative">
                <select
                  value={selectedResultDroneId}
                  disabled={isMissionLoading || !selectedMission}
                  onChange={(e) => {
                    const nextDroneId = e.target.value;
                    setSelectedResultDroneId(nextDroneId);
                    if (nextDroneId !== ALL_DRONES_OPTION) {
                      onSelectDevice?.(nextDroneId);
                    }
                  }}
                  className="appearance-none rounded-lg border py-2 pl-3 pr-8 text-sm font-medium focus:outline-none"
                  style={{
                    backgroundColor: color.card,
                    borderColor: color.borderStrong,
                    color: color.text,
                  }}
                >
                  {droneFilterOptions.map((d) => (
                    <option
                      key={d.id}
                      value={d.id}
                      style={{ backgroundColor: color.card }}
                    >
                      {d.name}
                    </option>
                  ))}
                </select>
                <svg
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <path
                    d="M2 4l4 4 4-4"
                    stroke={color.textMuted}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div
                className="flex items-center gap-2 text-xs"
                style={{ color: color.textMuted }}
              >
                <button
                  onClick={playFlight}
                  type="button"
                  className="rounded px-2 py-1"
                  disabled={
                    isMissionLoading ||
                    !selectedFlowData.length ||
                    isReplayPlaying
                  }
                  style={{
                    opacity:
                      isMissionLoading ||
                        !selectedFlowData.length ||
                        isReplayPlaying
                        ? 0.55
                        : 1,
                  }}
                >
                  {replayEndIndexRef.current >=
                    Math.max(0, selectedFlowData.length - 1) ? (
                    <RotateCcw size={20} />
                  ) : (
                    <Play size={20} />
                  )}
                </button>
                <button
                  onClick={pauseFlight}
                  type="button"
                  className="rounded px-2 py-1"
                  disabled={isMissionLoading || !isReplayPlaying}
                  style={{
                    opacity: isMissionLoading ? 0.55 : isReplayPlaying ? 1 : 0.55,
                  }}
                >
                  <Pause size={20} />
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1"
                  disabled={isMissionLoading || !selectedFlowData.length}
                  style={{
                    opacity:
                      isMissionLoading || !selectedFlowData.length ? 0.55 : 1,
                  }}
                  onClick={resetFlight}
                >
                  <Square size={20} />
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-md">
              {selectedMission ? (
                <div className="relative">
                  <Map
                    traceDataset={{ type: "FeatureCollection", features: [] }}
                    tracePoints={activeTracePointsForMap}
                    orthophotoOverlay={selectedMissionOrthophoto}
                    onScaleChange={setLegendScale}
                    selectedDroneId={
                      selectedResultDroneId === ALL_DRONES_OPTION
                        ? selectedMission?.primaryDroneId || selectedDeviceId
                        : selectedResultDroneId
                    }
                    resultsPageMode={true}
                    heatmapEnabled={isHeatmapEnabled}
                    plumeViewEnabled={isPlumeViewEnabled}
                    traceOpacity={traceOpacity}
                    showMethaneValidityControls={!isAerisAnalysis}
                    methaneValidityVisibility={methaneValidityVisibility}
                    onToggleMethaneValidity={
                      handleToggleMethaneValidityVisibility
                    }
                    onToggleHeatmap={() => {
                      if (!selectedMissionId) {
                        return;
                      }

                      setHeatmapViewByMission((previous) => ({
                        ...previous,
                        [selectedMissionId]: !(previous[selectedMissionId] ?? true),
                      }));
                    }}
                    onTogglePlumeView={() => {
                      if (!selectedMissionId) {
                        return;
                      }

                      setPlumeViewByMission((previous) => ({
                        ...previous,
                        [selectedMissionId]: !(previous[selectedMissionId] ?? false),
                      }));
                    }}
                    onPlumeViewAutoChange={(enabled) => {
                      if (!selectedMissionId) {
                        return;
                      }

                      setPlumeViewByMission((previous) => {
                        if ((previous[selectedMissionId] ?? false) === enabled) {
                          return previous;
                        }

                        return {
                          ...previous,
                          [selectedMissionId]: enabled,
                        };
                      });
                    }}
                    startPointFilterEnabled={startPointFilterEnabled}
                    onToggleStartPointFilter={() =>
                      setStartPointFilterEnabled((previous) => !previous)
                    }
                    startPointFilterRadiusMeters={startPointFilterRadiusMeters}
                    onStartPointFilterRadiusChange={setStartPointFilterRadiusMeters}
                    startPointPickModeEnabled={startPointPickModeEnabled}
                    onStartPointPickModeChange={setStartPointPickModeEnabled}
                    startPointCoordinates={startPointCoordinates}
                    onSetStartPointCoordinates={setStartPointCoordinates}
                    onClearStartPointCoordinates={() => {
                      setStartPointCoordinates(null);
                      setStartPointPickModeEnabled(false);
                      setStartPointFilterEnabled(false);
                    }}
                    onTraceRenderComplete={handleMapTraceRenderComplete}
                    onViewportChange={handleMapViewportChange}
                    missionConfiguration={sensorsMode}
                  />

                  {isMissionLoading ? (
                    <div
                      className="absolute inset-0 z-20 flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-md border px-4 text-center"
                      style={{
                        backgroundColor: "rgba(14, 18, 26, 0.78)",
                        borderColor: color.border,
                        color: color.textMuted,
                      }}
                    >
                      <div
                        className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
                        style={{
                          borderColor: color.orange,
                          borderTopColor: "transparent",
                        }}
                      />
                      <div>
                        <p className="text-sm font-semibold" style={{ color: color.text }}>
                          Loading mission data...
                        </p>
                        <p className="text-xs" style={{ color: color.textMuted }}>
                          Rendering map colors and values.
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div
                  className="flex min-h-[320px] items-center justify-center rounded-md border px-4 text-center"
                  style={{
                    backgroundColor: color.surface,
                    borderColor: color.border,
                    color: color.textMuted,
                  }}
                >
                  Please select a mission to analyse
                </div>
              )}
            </div>
            {isMissionLoading ? null : (
              <div className="flex flex-row items-center justify-between gap-2">
                <OpacityAdjuster value={traceOpacity} onChange={setTraceOpacity} />
                <div >
                  <button
                    type="button"
                    disabled={
                      !selectedMission ||
                      selectedMission.isSynthetic ||
                      isOrthophotoUploading
                    }
                    onClick={openOrthophotoPicker}
                    className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-lg font-medium transition-colors w-full justify-center"
                    style={{
                      backgroundColor: color.surface,
                      borderColor: color.borderStrong,
                      color: color.orange,
                    }}
                  >
                    <Paperclip size={18} />
                    {isOrthophotoUploading ? "Attaching..." : "Attach Orthophoto"}
                  </button>
                  {selectedMissionOrthophoto ? (
                    <div
                      className="mt-2 flex items-center gap-2 text-xs"
                      style={{ color: color.textMuted }}
                    >
                      <span>{selectedMissionOrthophoto.fileName}</span>
                      <button
                        type="button"
                        onClick={handleRemoveOrthophoto}
                        className="rounded-md px-2 py-1 font-semibold"
                        style={{
                          backgroundColor: color.surface,
                          border: `1px solid ${color.borderStrong}`,
                          color: color.orange,
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                  {orthophotoMessage ? (
                    <p className="mt-2 text-xs" style={{ color: color.textMuted }}>
                      {orthophotoMessage}
                    </p>
                  ) : null}
                </div>
              </div>
            )}

            <div
              className="mt-3 grid grid-cols-3 gap-2 text-xs"
              style={{ color: color.textMuted }}
            >
              <div
                className="rounded-md px-3 py-2"
                style={{ backgroundColor: color.surface }}
              >
                Start: {formatTimestamp(selectedMission?.startTs)}
              </div>
              <div
                className="rounded-md px-3 py-2"
                style={{ backgroundColor: color.surface }}
              >
                End: {formatTimestamp(selectedMission?.endTs)}
              </div>
              <div
                className="rounded-md px-3 py-2"
                style={{ backgroundColor: color.surface }}
              >
                Trace points: {selectedFlowData.length}
              </div>
            </div>

            <div
              className="mt-2 grid grid-cols-2 gap-2 text-xs"
              style={{ color: color.textMuted }}
            >
              <div
                className="rounded-md px-3 py-2"
                style={{ backgroundColor: color.surface }}
              >
                Legend Min: {legendScale.lowerLimit.toFixed(2)}
              </div>
              <div
                className="rounded-md px-3 py-2"
                style={{ backgroundColor: color.surface }}
              >
                Legend Max: {legendScale.upperLimit.toFixed(2)}
              </div>
            </div>

            <div
              className="mt-2 rounded-md px-3 py-2 text-xs"
              style={{ backgroundColor: color.surface, color: color.textMuted }}
            >
              Drones: {selectedMission?.droneIds?.join(", ") || "-"} • View:{" "}
              {selectedResultDroneId}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {(selectedMission?.droneIds || []).map((droneId) => {
                const presentation = sensorModePresentation(
                  selectedMission?.droneSensorModeById?.[droneId],
                );

                return (
                  <span
                    key={`selected-${selectedMission?.id || "none"}-${droneId}`}
                    className="rounded-full px-2.5 py-1 font-semibold"
                    style={{
                      color: presentation.foreground,
                      backgroundColor: presentation.background,
                    }}
                  >
                    {droneId} • {presentation.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 h-full">
            {isMissionLoading ? (
              <div
                className="min-h-[200px] rounded-lg border p-4"
                style={{ backgroundColor: color.card, borderColor: color.border }}
              >
                <div className="flex h-full min-h-[200px] items-center justify-center">
                  <div className="flex items-center gap-3" style={{ color: color.textMuted }}>
                    <div
                      className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent"
                      style={{
                        borderColor: color.orange,
                        borderTopColor: "transparent",
                      }}
                    />
                    <span className="text-sm">Loading analysis panels...</span>
                  </div>
                </div>
              </div>
            ) : isDualSensorAnalysis ? (
              <div
                className="min-h-[150px] rounded-lg border p-3"
                style={{ backgroundColor: color.card, borderColor: color.border }}
              >
                <div className="mt-2 space-y-2">
                  {analysisMethods.slice(0, 4).map((method) => (
                    <div
                      key={method.name}
                      className="rounded-md border px-2.5 py-2"
                      style={{
                        backgroundColor: color.surface,
                        borderColor: color.border,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className="text-xs font-semibold"
                          style={{ color: color.text }}
                        >
                          {method.name}
                        </p>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px]"
                          style={{
                            backgroundColor:
                              method.quality === "High"
                                ? color.greenSoft
                                : method.quality === "Medium"
                                  ? "rgba(240, 193, 93, 0.16)"
                                  : "rgba(239, 68, 68, 0.12)",
                            color:
                              method.quality === "High"
                                ? color.green
                                : method.quality === "Medium"
                                  ? color.warning
                                  : color.red,
                          }}
                        >
                          {method.quality}
                        </span>
                      </div>
                      <p
                        className="mt-1 text-[11px]"
                        style={{ color: color.textMuted }}
                      >
                        {method.estimate} • {method.uncertainty}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div
              className="relative min-h-[280px] rounded-lg border p-3"
              style={{ backgroundColor: color.card, borderColor: color.border }}
            >
              <h4
                className="text-sm font-semibold"
                style={{ color: color.text }}
              >
                Trace Graphs
              </h4>
              <div className="mt-2 h-full">
                {selectedSensorMode ===
                SENSOR_MODE_AERIS ? null : selectedSensorMode ===
                  SENSOR_MODE_MIXED ? (
                  <div className="space-y-3">
                    {hasDualTraceData ? (
                      <MethanePanel
                        flowData={selectedFlowData}
                        selection={selectedWindow}
                        onSelectionChange={setSelectedWindow}
                        resultsPageMode={true}
                        onRenderComplete={handleChartRenderComplete}
                      />
                    ) : null}
                  </div>
                ) : (
                  <MethanePanel
                    flowData={selectedFlowData}
                    selection={selectedWindow}
                    onSelectionChange={setSelectedWindow}
                    resultsPageMode={true}
                    onRenderComplete={handleChartRenderComplete}
                  />
                )}
              </div>
              {isMissionLoading && requiresChartReady ? (
                <div
                  className="absolute inset-0 z-20 flex items-center justify-center rounded-lg"
                  style={{ backgroundColor: "rgba(14, 18, 26, 0.72)" }}
                >
                  <div className="flex items-center gap-3" style={{ color: color.textMuted }}>
                    <div
                      className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent"
                      style={{
                        borderColor: color.orange,
                        borderTopColor: "transparent",
                      }}
                    />
                    <span className="text-sm">Waiting for chart layout...</span>
                  </div>
                </div>
              ) : null}
            </div> 

            {isMissionLoading ? null : (
              <div
                className="min-h-[120px]  rounded-lg border p-3"
                style={{
                  backgroundColor: color.card,
                  borderColor: color.border,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4
                      className="text-sm font-semibold"
                      style={{ color: color.text }}
                    >
                      Analysis Outputs
                    </h4>
                    <p
                      className="mt-0.5 text-[11px]"
                      style={{ color: color.textDim }}
                    >
                      Export mission artifacts with one tap.
                    </p>
                  </div>
                  <span
                    className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                    style={{
                      color: color.text,
                      backgroundColor: color.surface,
                      border: `1px solid ${color.borderStrong}`,
                    }}
                  >
                    Ready
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    className="flex justify-center items-center group relative overflow-hidden rounded-xl border p-3 text-left transition-transform duration-200 hover:-translate-y-[1px]"
                    style={{
                      borderColor: "rgba(106, 214, 194, 0.45)",
                      background:
                        "linear-gradient(150deg, rgba(106, 214, 194, 0.24) 0%, rgba(106, 214, 194, 0.08) 45%, rgba(8, 15, 17, 0.6) 100%)",
                    }}
                  >
                    <div className="absolute top-0 right-0 rounded-bl-lg px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: color.teal}}>
                      .csv
                    </div>
                    <p
                      className="mt-1 text-sm font-semibold"
                      style={{ color: "#ffffff" }}
                    >
                      Spreadsheet
                    </p>
                  </button>

                  <button
                    type="button"
                    className="flex justify-center items-center group relative overflow-hidden rounded-xl border p-3 text-left transition-transform duration-200 hover:-translate-y-[1px]"
                    style={{
                      borderColor: "rgba(86, 142, 255, 0.45)",
                      background:
                        "linear-gradient(150deg, rgba(86, 142, 255, 0.25) 0%, rgba(86, 142, 255, 0.08) 45%, rgba(8, 13, 26, 0.58) 100%)",
                    }}
                    onClick={handleExportGeoJSON}
                  >
                    <div className="absolute top-0 right-0 rounded-bl-lg px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: color.blue }}>
                      .geojson
                    </div>
                    <p
                      className="mt-1 text-sm font-semibold"
                      style={{ color: "#ffffff" }}
                    >
                      GeoJSON
                    </p>
                  </button>

                  <button
                    type="button"
                    className="flex justify-center items-center group relative overflow-hidden rounded-xl border p-3 text-left transition-transform duration-200 hover:-translate-y-[1px]"
                    style={{
                      borderColor: "rgba(253, 148, 86, 0.45)",
                      background:
                        "linear-gradient(150deg, rgba(253, 148, 86, 0.28) 0%, rgba(253, 148, 86, 0.08) 50%, rgba(10, 14, 20, 0.55) 100%)",
                    }}
                    onClick={() => {
                      void handleExportKMZ();
                    }}
                  >
                    <div className="absolute top-0 right-0 rounded-bl-lg px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: color.orange }}>
                      .kmz
                    </div>
                    <p
                      className="mt-1 text-sm font-semibold"
                      style={{ color: "#ffffff" }}
                    >
                      Google Earth
                    </p>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 h-full">
          {selectedSensorMode === SENSOR_MODE_AERIS ? (
            <AerisPanel
              flowData={selectedFlowData}
              selection={selectedWindow}
              onSelectionChange={setSelectedWindow}
              resultsPageMode={true}
              onRenderComplete={handleChartRenderComplete}
              initialTracerRates={analysisTracerRates}
              tracerAvailability={aerisTracerAvailability}
              onAnalyze={(tracerRates) => {
                void handleRunNotebookAnalysis(tracerRates);
              }}
              analyzeBusy={isNotebookRunning}
            />
          ) : selectedSensorMode === SENSOR_MODE_MIXED ? (
            <div className="space-y-3">
              {hasAerisTraceData ? (
                <AerisPanel
                  flowData={selectedFlowData}
                  selection={selectedWindow}
                  onSelectionChange={setSelectedWindow}
                  resultsPageMode={true}
                  onRenderComplete={handleChartRenderComplete}
                  initialTracerRates={analysisTracerRates}
                  tracerAvailability={aerisTracerAvailability}
                  onAnalyze={(tracerRates) => {
                    void handleRunNotebookAnalysis(tracerRates);
                  }}
                  analyzeBusy={isNotebookRunning}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* <div
          className="rounded-lg border p-3"
          style={{ backgroundColor: color.card, borderColor: color.border }}
        >
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold" style={{ color: color.text }}>
              Method Comparison
            </h4>
            <span className="text-xs" style={{ color: color.textMuted }}>
              {analysisMethods.length} methods
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs" style={{ color: color.textMuted }}>
              <thead>
                <tr>
                  <th className="px-2 py-2">Method</th>
                  <th className="px-2 py-2">Estimate</th>
                  <th className="px-2 py-2">Uncertainty</th>
                  <th className="px-2 py-2">Quality</th>
                  <th className="px-2 py-2">Assumptions</th>
                </tr>
              </thead>
              <tbody>
                {analysisMethods.map((method) => (
                  <tr key={method.name} style={{ borderTop: `1px solid ${color.border}` }}>
                    <td className="px-2 py-2" style={{ color: color.text }}>
                      {method.name}
                    </td>
                    <td className="px-2 py-2">{method.estimate}</td>
                    <td className="px-2 py-2">{method.uncertainty}</td>
                    <td className="px-2 py-2">{method.quality}</td>
                    <td className="px-2 py-2">{method.assumptions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div> */}
      </section>

      {csvModalFile && (
        <CSVImportModal
          file={csvModalFile}
          devices={devices}
          sensorsMode={sensorsMode}
          preferredDroneId={selectedDeviceId}
          onClose={() => setCsvModalFile(null)}
          onComplete={(msg) => {
            setImportMessage(msg);
            window.setTimeout(() => setImportMessage(null), 4000);
            listMissions().then(setMissionsSample);
          }}
        />
      )}
    </div>
  );
}
