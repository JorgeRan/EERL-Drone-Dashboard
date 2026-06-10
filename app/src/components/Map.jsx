import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
// import { Map, NavigationControl, Popup, useControl } from "react-map-gl/mapbox";
import { GeoJsonLayer, ArcLayer } from "deck.gl";
import satelliteImage from "../assets/satellite.png";
import { tw, color } from "../constants/tailwind";
import {
  buildOfflineImageCoordinates,
  buildOfflineSatelliteStyle,
  shouldUseOnlineMap,
} from "../constants/offlineMap";
import {
  buildHeatmapColorExpression,
  buildHeatmapWeightExpression,
  buildHotspotHaloRadiusExpression,
  buildHotspotRadiusExpression,
  buildMethaneColorExpression,
  buildMethaneGradient,
  buildMethaneScale,
  formatLegendValue,
  minimumLegendSpan,
} from "../constants/methaneScale";
import {
  backendHttpUrl,
  createTelemetryWebSocket,
  waitForBackendReady,
} from "../services/api";
import { normalizeTelemetryPacket } from "../shared/telemetryContract";
import {
  extractTelemetryMetrics,
  SENSOR_MODE_AERIS,
} from "../constants/telemetryMetrics";
import { traceOrigin } from "../data/methaneTraceData";
import { buildMethanePlumeDataset } from "../data/methaneTraceData";

const latitude = traceOrigin.latitude;
const longitude = traceOrigin.longitude;
const altitude = traceOrigin.altitude;
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
const DRONE_COLOR_BY_ID = {
  M350: "#f97316",
  "M400-1": "#22c55e",
  "M400-2": "#3b82f6",
};
const DRONE_COLOR_FALLBACK_PALETTE = [
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#eab308",
  "#14b8a6",
];
const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };
const DASHBOARD_TRACE_SOURCE_UPDATE_DEBOUNCE_MS = 150;
const ORTHOPHOTO_SOURCE_ID = "mission-orthophoto";
const ORTHOPHOTO_LAYER_ID = "mission-orthophoto-layer";

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getDroneColor = (droneId) => {
  const normalizedDroneId = String(droneId || "").trim();
  if (!normalizedDroneId) {
    return color.fligthpathOrange;
  }

  const knownColor = DRONE_COLOR_BY_ID[normalizedDroneId];
  if (knownColor) {
    return knownColor;
  }

  const hash = [...normalizedDroneId].reduce(
    (total, char) => total + char.charCodeAt(0),
    0,
  );
  return DRONE_COLOR_FALLBACK_PALETTE[
    hash % DRONE_COLOR_FALLBACK_PALETTE.length
  ];
};

const normalizeDroneState = (entry) => ({
  ...extractTelemetryMetrics(entry),
  drone_id: entry.drone_id,
  topic: entry.topic,
  ts: entry.ts,
  latitude: toFiniteNumber(entry.latitude),
  longitude: toFiniteNumber(entry.longitude),
  altitude: toFiniteNumber(entry.altitude),
  target_latitude: toFiniteNumber(
    entry.target_latitude ?? entry.payload?.target_position?.latitude,
  ),
  target_longitude: toFiniteNumber(
    entry.target_longitude ?? entry.payload?.target_position?.longitude,
  ),
  battery: toFiniteNumber(entry.battery),
  speed: toFiniteNumber(entry.speed),
  payload: entry.payload || {},
});

const buildVisibleDroneIdSet = (visibleDroneIds) =>
  new Set(
    (Array.isArray(visibleDroneIds) ? visibleDroneIds : [])
      .map((droneId) => String(droneId || "").trim())
      .filter(Boolean),
  );

const isDroneVisible = (droneId, visibleDroneIdSet, hasVisibilityFilter) => {
  if (!hasVisibilityFilter) {
    return true;
  }

  return visibleDroneIdSet.has(String(droneId || "").trim());
};

const buildDroneFeatureCollection = (
  drones,
  visibleDroneIdSet,
  hasVisibilityFilter,
) => ({
  type: "FeatureCollection",
  features: drones
    .filter((drone) =>
      isDroneVisible(drone.drone_id, visibleDroneIdSet, hasVisibilityFilter),
    )
    .filter(
      (drone) =>
        Number.isFinite(drone.longitude) && Number.isFinite(drone.latitude),
    )
    .map((drone) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [drone.longitude, drone.latitude],
      },
      properties: {
        droneId: drone.drone_id,
        markerColor: getDroneColor(drone.drone_id),
        topic: drone.topic,
        altitude: drone.altitude,
        battery: drone.battery,
        speed: drone.speed,
        sniffer: drone.sniffer,
        purway: drone.purway,
        acetylene: drone.acetylene,
        nitrousOxide: drone.nitrousOxide,
        sensorMode: drone.sensorMode,
        methane: drone.methane,
        ts: drone.ts,
      },
    })),
});

const buildTraceDatasetFromTracePoints = (tracePoints) => {
  const points = Array.isArray(tracePoints) ? tracePoints : [];

  return {
    type: "FeatureCollection",
    features: points
      .filter(
        (point) =>
          Number.isFinite(Number(point?.longitude)) &&
          Number.isFinite(Number(point?.latitude)),
      )
      .map((point, index) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [Number(point.longitude), Number(point.latitude)],
        },
        properties: {
          id:
            point.id ??
            `trace-${point.droneId || "drone"}-${point.timestampMs || point.sampleOrder || index}`,
          droneId: point.droneId || null,
          sampleOrder: point.sampleOrder ?? index,
          sampleIndex: point.sampleIndex ?? index + 1,
          timestampMs: point.timestampMs,
          timestampIso: point.timestampIso,
          timeLabel: point.timeLabel,
          altitude: point.altitude,
          sniffer: point.sniffer,
          purway: point.purway,
          acetylene: point.acetylene,
          nitrousOxide: point.nitrousOxide,
          sensorMode: point.sensorMode,
          methane: point.methane,
          methaneValid: point.methaneValid ?? point.methane_valid,
          displayMetricLabel: point.displayMetricLabel,
          displayMetricUnits: point.displayMetricUnits,
          sourceLatitude: Number(point.sourceLatitude ?? point.latitude),
          sourceLongitude: Number(point.sourceLongitude ?? point.longitude),
          targetLatitude: Number(
            point.targetLatitude ?? point.target_latitude ?? point.latitude,
          ),
          targetLongitude: Number(
            point.targetLongitude ?? point.target_longitude ?? point.longitude,
          ),
          mapCoordinates:
            point.mapCoordinates ?? point.payload?.map_coordinates ?? "drone",
          detected: Boolean(point.detected),
          pointColor: point.pointColor,
        },
      })),
  };
};

const isAllDroneSelection = (selectedDroneId) => {
  if (selectedDroneId == null) {
    return true;
  }

  const normalizedValue = String(selectedDroneId).trim().toLowerCase();
  return (
    !normalizedValue ||
    normalizedValue === "all" ||
    normalizedValue === "all-data"
  );
};

const buildTraceFlightPathFeatureCollection = (traceDataset) => {
  const coordinates = [...(traceDataset?.features || [])]
    .sort(
      (left, right) =>
        Number(left?.properties?.sampleOrder ?? 0) -
        Number(right?.properties?.sampleOrder ?? 0),
    )
    .map((feature) => {
      const sourceLongitude = toFiniteNumber(
        feature?.properties?.sourceLongitude,
      );
      const sourceLatitude = toFiniteNumber(
        feature?.properties?.sourceLatitude,
      );

      if (Number.isFinite(sourceLongitude) && Number.isFinite(sourceLatitude)) {
        return [sourceLongitude, sourceLatitude];
      }

      return feature?.geometry?.coordinates;
    })
    .filter(
      (coordinates) =>
        Number.isFinite(Number(coordinates?.[0])) &&
        Number.isFinite(Number(coordinates?.[1])),
    );

  if (coordinates.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates,
        },
        properties: {
          id: "trace-flight-path",
        },
      },
    ],
  };
};

const buildLiveFlightPathFeatureCollection = (
  droneTrackHistory,
  selectedDroneId,
  visibleDroneIdSet,
  hasVisibilityFilter,
) => {
  const showAllDrones = isAllDroneSelection(selectedDroneId);
  const features = Object.entries(droneTrackHistory || {})
    .filter(([droneId, coordinates]) => {
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        return false;
      }

      if (!isDroneVisible(droneId, visibleDroneIdSet, hasVisibilityFilter)) {
        return false;
      }

      return hasVisibilityFilter
        ? true
        : showAllDrones || droneId === selectedDroneId;
    })
    .map(([droneId, coordinates]) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates,
      },
      properties: {
        id: `flight-path-${droneId}`,
        droneId,
        pathColor: getDroneColor(droneId),
      },
    }));

  return {
    type: "FeatureCollection",
    features,
  };
};

const buildDisplayedTraceDataset = (
  traceDataset,
  showTargetMarkers,
  visibleDroneIdSet,
  hasVisibilityFilter,
) => ({
  type: "FeatureCollection",
  features: (traceDataset?.features || [])
    .filter((feature) =>
      isDroneVisible(
        feature?.properties?.droneId,
        visibleDroneIdSet,
        hasVisibilityFilter,
      ),
    )
    .map((feature) => {
      const properties = feature?.properties || {};
      let longitude, latitude, mapCoordinates;
      if (showTargetMarkers) {
        const tLon = toFiniteNumber(properties.targetLongitude);
        const tLat = toFiniteNumber(properties.targetLatitude);
        const isValidTarget =
          tLon !== 0 &&
          tLat !== 0 &&
          Number.isFinite(tLon) &&
          Number.isFinite(tLat);
        if (isValidTarget) {
          longitude = tLon;
          latitude = tLat;
          mapCoordinates = "target";
        } else {
          longitude = toFiniteNumber(properties.sourceLongitude) ?? tLon;
          latitude = toFiniteNumber(properties.sourceLatitude) ?? tLat;
          mapCoordinates = "drone";
        }
      } else {
        longitude =
          toFiniteNumber(properties.sourceLongitude) ??
          toFiniteNumber(properties.targetLongitude);
        latitude =
          toFiniteNumber(properties.sourceLatitude) ??
          toFiniteNumber(properties.targetLatitude);
        mapCoordinates = "drone";
      }

      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return null;
      }

      return {
        ...feature,
        geometry: {
          ...feature.geometry,
          coordinates: [longitude, latitude],
        },
        properties: {
          ...properties,
          mapCoordinates,
        },
      };
    })
    .filter(Boolean),
});

const getTraceMaxMethane = (dataset) => {
  if (!dataset?.features?.length) {
    return 5;
  }

  let max = 5;
  for (const feature of dataset.features) {
    const value = Number(feature?.properties?.methane);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }

  return max;
};

const fitMapToTraceDataset = (
  map,
  dataset,
  { padding = 20, duration = 650, maxZoom = 17 } = {},
) => {
  if (!map || !dataset?.features?.length) {
    return;
  }

  const bounds = new mapboxgl.LngLatBounds();
  let hasValidPoints = false;

  dataset.features.forEach((feature) => {
    const coordinates = feature?.geometry?.coordinates;
    const lng = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);

    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      bounds.extend([lng, lat]);
      hasValidPoints = true;
    }
  });

  if (!hasValidPoints) {
    return;
  }

  map.fitBounds(bounds, {
    padding,
    duration,
    maxZoom,
    essential: true,
  });
};

const getTraceDatasetCenter = (dataset, fallback = {}) => {
  const features = Array.isArray(dataset?.features) ? dataset.features : [];

  if (!features.length) {
    return {
      latitude: fallback.latitude ?? latitude,
      longitude: fallback.longitude ?? longitude,
    };
  }

  const bounds = new mapboxgl.LngLatBounds();
  let hasValidPoints = false;

  features.forEach((feature) => {
    const coordinates = feature?.geometry?.coordinates;
    const lng = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);

    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      bounds.extend([lng, lat]);
      hasValidPoints = true;
    }
  });

  if (!hasValidPoints) {
    return {
      latitude: fallback.latitude ?? latitude,
      longitude: fallback.longitude ?? longitude,
    };
  }

  const center = bounds.getCenter();
  return {
    latitude: center.lat,
    longitude: center.lng,
  };
};

const fitMapToDroneStates = (
  map,
  drones,
  { padding = 60, duration = 700, maxZoom = 17 } = {},
) => {
  if (!map || !Array.isArray(drones) || drones.length === 0) {
    return false;
  }

  const bounds = new mapboxgl.LngLatBounds();
  let hasValidPoints = false;

  drones.forEach((drone) => {
    const lng = Number(drone?.longitude);
    const lat = Number(drone?.latitude);

    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      bounds.extend([lng, lat]);
      hasValidPoints = true;
    }
  });

  if (!hasValidPoints) {
    return false;
  }

  map.fitBounds(bounds, {
    padding,
    duration,
    maxZoom,
    essential: true,
  });

  return true;
};

export function Map({
  traceDataset,
  tracePoints,
  orthophotoOverlay = null,
  onScaleChange,
  selectedDroneId,
  visibleDroneIds,
  devices = [],
  showAllPlottedData = true,
  onToggleAllPlottedData,
  droneVisibilityById = {},
  onToggleDroneVisibility,
  methaneValidityVisibility = { valid: true, invalid: true, noData: false },
  onToggleMethaneValidity,
  resultsPageMode,
  heatmapOnlyMode = false,
  heatmapEnabled = true,
  plumeViewEnabled = false,
  traceOpacity = 1,
  onToggleHeatmap,
  onTogglePlumeView,
  onPlumeViewAutoChange,
  onViewportChange,
  onTraceRenderComplete,
  startPointFilterEnabled = false,
  onToggleStartPointFilter,
  startPointFilterRadiusMeters = 25,
  onStartPointFilterRadiusChange,
  startPointPickModeEnabled = false,
  onStartPointPickModeChange,
  startPointCoordinates = null,
  onSetStartPointCoordinates,
  onClearStartPointCoordinates,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const primaryMarkerRef = useRef(null);
  const startPointMarkerRef = useRef(null);
  const plumeTransitionFrameRef = useRef(null);
  const traceSourceUpdateTimeoutRef = useRef(null);
  const plumeModeFromTiltRef = useRef(plumeViewEnabled);
  const onPlumeViewAutoChangeRef = useRef(onPlumeViewAutoChange);
  const onViewportChangeRef = useRef(onViewportChange);
  const resolvedTraceDataset = useMemo(
    () =>
      Array.isArray(tracePoints) && tracePoints.length > 0
        ? buildTraceDatasetFromTracePoints(tracePoints)
        : traceDataset,
    [traceDataset, tracePoints],
  );
  const initialTraceDatasetRef = useRef(resolvedTraceDataset);
  const initialPlumeDatasetRef = useRef(
    resultsPageMode
      ? buildMethanePlumeDataset(resolvedTraceDataset)
      : EMPTY_FEATURE_COLLECTION,
  );
  const datasetMaxMethane = getTraceMaxMethane(resolvedTraceDataset);
  const initialUpperLimitRef = useRef(datasetMaxMethane);
  const initialLowerLimitRef = useRef(0);
  const [upperLimit, setUpperLimit] = useState(datasetMaxMethane);
  const [lowerLimit, setLowerLimit] = useState(0);
  const [upperLimitInput, setUpperLimitInput] = useState(
    String(datasetMaxMethane),
  );
  const [lowerLimitInput, setLowerLimitInput] = useState("0");
  const [showFlightPath, setShowFlightPath] = useState(false);
  const [showTargetMarkers, setShowTargetMarkers] = useState(false);
  const [isAutoCenterEnabled, setIsAutoCenterEnabled] = useState(true);
  const [isStyleReady, setIsStyleReady] = useState(false);
  const [droneStates, setDroneStates] = useState([]);
  const [droneTrackHistory, setDroneTrackHistory] = useState({});
  const [isTelemetryConnected, setIsTelemetryConnected] = useState(false);
  const [lastTraceRenderMs, setLastTraceRenderMs] = useState(null);
  const mapMode = shouldUseOnlineMap(mapboxToken) ? "online" : "offline";
  const methaneScale = buildMethaneScale(lowerLimit, upperLimit);
  const methaneGradient = buildMethaneGradient(lowerLimit, upperLimit);
  const safeTraceOpacity = Math.min(
    1,
    Math.max(
      0,
      Number.isFinite(Number(traceOpacity)) ? Number(traceOpacity) : 1,
    ),
  );
  const isHeatmapOnlyActive = !resultsPageMode && heatmapOnlyMode;
  const methanePlumeDataset = useMemo(
    () =>
      resultsPageMode
        ? buildMethanePlumeDataset(resolvedTraceDataset)
        : EMPTY_FEATURE_COLLECTION,
    [resultsPageMode, resolvedTraceDataset],
  );
  const visibleDroneIdSet = useMemo(
    () => buildVisibleDroneIdSet(visibleDroneIds),
    [visibleDroneIds],
  );
  const hasVisibilityFilter = Array.isArray(visibleDroneIds);
  const displayedTraceDataset = useMemo(
    () =>
      buildDisplayedTraceDataset(
        resolvedTraceDataset,
        showTargetMarkers,
        visibleDroneIdSet,
        hasVisibilityFilter,
      ),
    [
      hasVisibilityFilter,
      showTargetMarkers,
      resolvedTraceDataset,
      visibleDroneIdSet,
    ],
  );
  const rawTracePointCount = resolvedTraceDataset?.features?.length || 0;
  const renderedTracePointCount = displayedTraceDataset?.features?.length || 0;
  const traceReductionPercent = rawTracePointCount
    ? Math.max(
        0,
        Math.round((1 - renderedTracePointCount / rawTracePointCount) * 100),
      )
    : 0;
  const flightPathDataset = useMemo(
    () =>
      resultsPageMode
        ? buildTraceFlightPathFeatureCollection(resolvedTraceDataset)
        : buildLiveFlightPathFeatureCollection(
            droneTrackHistory,
            selectedDroneId,
            visibleDroneIdSet,
            hasVisibilityFilter,
          ),
    [
      droneTrackHistory,
      hasVisibilityFilter,
      resultsPageMode,
      selectedDroneId,
      resolvedTraceDataset,
      visibleDroneIdSet,
    ],
  );
  const focusedDrone =
    droneStates.find(
      (drone) =>
        drone.drone_id === selectedDroneId &&
        isDroneVisible(drone.drone_id, visibleDroneIdSet, hasVisibilityFilter),
    ) ||
    droneStates.find((drone) =>
      isDroneVisible(drone.drone_id, visibleDroneIdSet, hasVisibilityFilter),
    ) ||
    droneStates[0] ||
    null;
  const visibleDroneStates = useMemo(
    () =>
      droneStates.filter((drone) =>
        isDroneVisible(drone.drone_id, visibleDroneIdSet, hasVisibilityFilter),
      ),
    [droneStates, hasVisibilityFilter, visibleDroneIdSet],
  );
  const displayLatitude = Number.isFinite(focusedDrone?.latitude)
    ? focusedDrone.latitude
    : latitude;
  const displayLongitude = Number.isFinite(focusedDrone?.longitude)
    ? focusedDrone.longitude
    : longitude;
  const displayAltitude = Number.isFinite(focusedDrone?.altitude)
    ? focusedDrone.altitude
    : altitude;

  const displayTargetLatitude = Number.isFinite(focusedDrone?.target_latitude)
    ? focusedDrone.target_latitude
    : latitude;
  const displayTargetLongitude = Number.isFinite(focusedDrone?.target_longitude)
    ? focusedDrone.target_longitude
    : longitude;
  const initialTraceCenter = useMemo(
    () =>
      getTraceDatasetCenter(resolvedTraceDataset, {
        latitude: displayLatitude,
        longitude: displayLongitude,
      }),
    [displayLatitude, displayLongitude, resolvedTraceDataset],
  );
  const initialMapCenterRef = useRef({
    latitude: initialTraceCenter.latitude,
    longitude: initialTraceCenter.longitude,
  });
  const initialPlumeViewEnabledRef = useRef(plumeViewEnabled);
  const initialHeatmapOnlyModeRef = useRef(heatmapOnlyMode);

  useEffect(() => {
    onPlumeViewAutoChangeRef.current = onPlumeViewAutoChange;
  }, [onPlumeViewAutoChange]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  const handleLimitChange = (limitType, rawValue) => {
    const nextValue = rawValue.replace(",", ".");

    if (limitType === "upper") {
      setUpperLimitInput(nextValue);
    } else {
      setLowerLimitInput(nextValue);
    }

    const parsedValue = Number(nextValue);

    if (!Number.isFinite(parsedValue)) {
      return;
    }

    if (limitType === "upper" && parsedValue > lowerLimit) {
      setUpperLimit(parsedValue);
    }

    if (limitType === "lower" && parsedValue < upperLimit) {
      setLowerLimit(parsedValue);
    }
  };

  const commitLimit = (limitType) => {
    if (limitType === "upper") {
      const parsedValue = Number(upperLimitInput);
      const safeValue = Number.isFinite(parsedValue)
        ? Math.max(parsedValue, lowerLimit + minimumLegendSpan)
        : upperLimit;

      setUpperLimit(safeValue);
      setUpperLimitInput(formatLegendValue(safeValue));
      return;
    }

    const parsedValue = Number(lowerLimitInput);
    const safeValue = Number.isFinite(parsedValue)
      ? Math.min(parsedValue, upperLimit - minimumLegendSpan)
      : lowerLimit;

    setLowerLimit(safeValue);
    setLowerLimitInput(formatLegendValue(safeValue));
  };

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return undefined;
    }

    const isOnlineMode = shouldUseOnlineMap(mapboxToken);
    const initialCenterLatitude = initialMapCenterRef.current.latitude;
    const initialCenterLongitude = initialMapCenterRef.current.longitude;
    const offlineCoordinates = buildOfflineImageCoordinates({
      centerLat: initialCenterLatitude,
      centerLon: initialCenterLongitude,
    });

    if (isOnlineMode) {
      mapboxgl.accessToken = mapboxToken;
    }

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: isOnlineMode
        ? "mapbox://styles/mapbox/satellite-streets-v12"
        : buildOfflineSatelliteStyle({
            imageUrl: satelliteImage,
            coordinates: offlineCoordinates,
          }),
      center: [initialCenterLongitude, initialCenterLatitude],
      zoom: 18,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = map;
    popupRef.current = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: "methane-trace-popup",
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    const emitViewport = () => {
      const bounds = map.getBounds();
      if (!bounds) {
        return;
      }

      onViewportChangeRef.current?.({
        zoom: map.getZoom(),
        minLatitude: bounds.getSouth(),
        maxLatitude: bounds.getNorth(),
        minLongitude: bounds.getWest(),
        maxLongitude: bounds.getEast(),
      });
    };

    map.on("moveend", emitViewport);

    map.on("load", () => {
      setIsStyleReady(true);
      emitViewport();
      if (!isOnlineMode && !resultsPageMode) {
        map.fitBounds([offlineCoordinates[3], offlineCoordinates[1]], {
          duration: 0,
          padding: 20,
        });
      }

      if (isOnlineMode) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });

        if (initialPlumeViewEnabledRef.current) {
          map.setTerrain({ source: "mapbox-dem", exaggeration: 1.35 });
          map.setFog({
            color: "rgba(255, 255, 255, 0.06)",
            "high-color": "rgba(20, 31, 52, 0.14)",
            "space-color": "#0f172a",
            "horizon-blend": 0.08,
          });
        }
      }

      const initialLowerLimit = initialLowerLimitRef.current;
      const initialUpperLimit = initialUpperLimitRef.current;
      const initialSpan = Math.max(
        initialUpperLimit - initialLowerLimit,
        minimumLegendSpan,
      );
      const initialHeatmapThreshold = initialLowerLimit + initialSpan * 0.04;

      map.addSource("methane-traces", {
        type: "geojson",
        data: initialTraceDatasetRef.current,
      });

      map.addLayer({
        id: "methane-trace-heatmap",
        type: "heatmap",
        source: "methane-traces",
        filter: [">=", ["get", "methane"], initialHeatmapThreshold],
        paint: {
          "heatmap-weight": buildHeatmapWeightExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            0.85,
            18,
            1.65,
          ],
          "heatmap-color": buildHeatmapColorExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "heatmap-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            12,
            18,
            28,
          ],
          "heatmap-opacity": resultsPageMode
            ? heatmapEnabled
              ? 0.78 * safeTraceOpacity
              : 0
            : initialHeatmapOnlyModeRef.current
              ? 0.9 * safeTraceOpacity
            : plumeViewEnabled
              ? heatmapEnabled
                ? 0.2 * safeTraceOpacity
                : 0
              : 0,
        },
      });

      map.addLayer({
        id: "methane-trace-zero-points",
        type: "circle",
        source: "methane-traces",
        filter: ["==", ["get", "methane"], 0],
        layout: {
          "circle-sort-key": ["get", "methane"],
        },
        paint: {
          "circle-color": ["get", "pointColor"],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            2.4,
            18,
            4.4,
          ],
          "circle-stroke-width": 0.9,
          "circle-stroke-color": "rgba(255,255,255,0.72)",
          "circle-stroke-opacity": initialHeatmapOnlyModeRef.current
            ? 0
            : 0.72 * safeTraceOpacity,
          "circle-opacity": resultsPageMode
            ? 0.18 * safeTraceOpacity
            : initialHeatmapOnlyModeRef.current
              ? 0
            : plumeViewEnabled
              ? 0.15 * safeTraceOpacity
              : 0.88 * safeTraceOpacity,
        },
      });

      map.addLayer({
        id: "methane-trace-hotspots",
        type: "circle",
        source: "methane-traces",
        filter: [">", ["get", "methane"], 0],
        layout: {
          "circle-sort-key": ["get", "methane"],
        },
        paint: {
          "circle-color": buildMethaneColorExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "circle-radius": buildHotspotRadiusExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "circle-stroke-width": 1,
          "circle-stroke-color": "rgba(255,255,255,0.9)",
          "circle-stroke-opacity": initialHeatmapOnlyModeRef.current
            ? 0
            : 0.9 * safeTraceOpacity,
          "circle-opacity": resultsPageMode
            ? 0.95 * safeTraceOpacity
            : initialHeatmapOnlyModeRef.current
              ? 0
            : plumeViewEnabled
              ? 0.15 * safeTraceOpacity
              : 0.8 * safeTraceOpacity,
        },
      });

      map.addLayer({
        id: "methane-trace-halo",
        type: "circle",
        source: "methane-traces",
        filter: [">", ["get", "methane"], 0],
        layout: {
          "circle-sort-key": ["get", "methane"],
        },
        paint: {
          "circle-color": buildMethaneColorExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "circle-radius": buildHotspotHaloRadiusExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "circle-blur": 0.72,
          "circle-opacity": resultsPageMode
            ? heatmapEnabled
              ? 0.46 * safeTraceOpacity
              : 0
            : initialHeatmapOnlyModeRef.current
              ? 0
            : plumeViewEnabled
              ? heatmapEnabled
                ? 0.1 * safeTraceOpacity
                : 0
              : heatmapEnabled
                ? 0.36 * safeTraceOpacity
                : 0,
        },
      });

      map.addSource("methane-plume", {
        type: "geojson",
        data: initialPlumeDatasetRef.current,
      });

      map.addLayer({
        id: "methane-plume-columns",
        type: "fill-extrusion",
        source: "methane-plume",
        paint: {
          "fill-extrusion-color": buildMethaneColorExpression(
            initialLowerLimit,
            initialUpperLimit,
          ),
          "fill-extrusion-base": ["get", "baseHeight"],
          "fill-extrusion-height": ["get", "plumeHeight"],
          "fill-extrusion-opacity": plumeViewEnabled
            ? 0.82 * safeTraceOpacity
            : 0,
          "fill-extrusion-vertical-gradient": true,
        },
      });

      map.addLayer({
        id: "methane-plume-caps",
        type: "line",
        source: "methane-plume",
        paint: {
          "line-color": "rgba(255,255,255,0.88)",
          "line-width": 1.1,
          "line-opacity": plumeViewEnabled ? 0.45 * safeTraceOpacity : 0,
        },
      });

      map.addSource("live-drones", {
        type: "geojson",
        data: buildDroneFeatureCollection([]),
      });

      map.addSource("flight-path", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "flight-path-line",
        type: "line",
        source: "flight-path",
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": [
            "coalesce",
            ["get", "pathColor"],
            color.fligthpathOrange,
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 18, 4],
          "line-opacity": 0,
          "line-blur": 0.15,
        },
      });

      map.addLayer({
        id: "live-drones-points",
        type: "circle",
        source: "live-drones",
        paint: {
          "circle-color": ["coalesce", ["get", "markerColor"], color.orange],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 18, 9],
          "circle-stroke-width": 1.4,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.94,
        },
      });

      map.addLayer({
        id: "live-drones-labels",
        type: "symbol",
        source: "live-drones",
        layout: {
          "text-field": ["get", "droneId"],
          "text-size": 11,
          "text-offset": [0, 1.3],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "rgba(0,0,0,0.82)",
          "text-halo-width": 1.1,
        },
      });

      const attachTraceTooltip = (layerId) => {
        map.on("mousemove", layerId, (event) => {
          const hoveredFeature = event.features?.[0];

          if (!hoveredFeature || !popupRef.current) {
            return;
          }

          const {
            methane,
            ch4,
            sniffer,
            purway,
            acetylene,
            nitrousOxide,
            displayMetricLabel,
            displayMetricUnits,
            sensorMode,
            altitude: pointAltitude,
            sampleIndex,
            timeLabel,
          } = hoveredFeature.properties;
          const isAerisTrace = sensorMode === SENSOR_MODE_AERIS;
          map.getCanvas().style.cursor = "pointer";
          popupRef.current
            .setLngLat(event.lngLat)
            .setHTML(
              `
                            <div style="min-width: 148px; color: #e5eef8;">
                                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: #9fb0c2;">Sample ${sampleIndex}</div>
                                <div style="margin-top: 4px; font-size: 13px; font-weight: 700; color: #ffffff;">${displayMetricLabel || (isAerisTrace ? "CH4" : "Purway")} ${Number(methane ?? 0).toFixed(2)} ${displayMetricUnits || (isAerisTrace ? "ppm" : "ppm-m")}</div>
                                ${
                                  isAerisTrace
                                    ? `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">CH4 ${Number(ch4 ?? 0).toFixed(2)} ppm</div>`
                                    : `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">CH4 ${Number(ch4 ?? 0).toFixed(2)} ppm</div>`
                                }
                                ${
                                  isAerisTrace
                                    ? `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Acetylene ${Number(acetylene ?? 0).toFixed(2)} ppm</div>
                                <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Nitrous Oxide ${Number(nitrousOxide ?? 0).toFixed(2)} ppm</div>`
                                    : `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Sniffer ${Number(sniffer ?? 0).toFixed(2)} ppm</div>
                                  <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Purway ${Number(purway ?? 0).toFixed(2)} ppm-m</div>`
                                }
                                <div style="margin-top: 4px; font-size: 12px; color: #d2dce8;">Altitude ${Number(pointAltitude).toFixed(0)} m</div>
                                <div style="margin-top: 2px; font-size: 11px; color: #9fb0c2;">Flight mark ${timeLabel}</div>
                            </div>
                        `,
            )
            .addTo(map);
        });

        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
          popupRef.current?.remove();
        });
      };

      attachTraceTooltip("methane-trace-zero-points");
      attachTraceTooltip("methane-trace-hotspots");

      map.on("mousemove", "live-drones-points", (event) => {
        const feature = event.features?.[0];

        if (!feature || !popupRef.current) {
          return;
        }

        const {
          droneId,
          altitude: liveAltitude,
          battery,
          speed,
          methane,
          sniffer,
          purway,
          acetylene,
          nitrousOxide,
          sensorMode,
          ts,
        } = feature.properties;
        const isAerisDrone = sensorMode === SENSOR_MODE_AERIS;
        map.getCanvas().style.cursor = "pointer";

        popupRef.current
          .setLngLat(event.lngLat)
          .setHTML(
            `
                        <div style="min-width: 160px; color: #e5eef8;">
                            <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: #9fb0c2;">${droneId}</div>
                            <div style="margin-top: 4px; font-size: 12px; color: #ffffff;">Alt ${Number(liveAltitude || 0).toFixed(1)} m</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Battery ${battery ?? "-"}%</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Speed ${speed ?? "-"} m/s</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">CH4 ${methane ?? "-"} ppm</div>
                            ${
                              isAerisDrone
                                ? `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Acetylene ${acetylene ?? "-"} ppm</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Nitrous Oxide ${nitrousOxide ?? "-"} ppm</div>`
                                : `<div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Purway ${purway ?? "-"} ppm-m</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Sniffer ${sniffer ?? "-"} ppm</div>`
                            }
                            <div style="margin-top: 2px; font-size: 11px; color: #9fb0c2;">${ts ? new Date(ts).toLocaleString() : ""}</div>
                        </div>
                    `,
          )
          .addTo(map);
      });

      map.on("mouseleave", "live-drones-points", () => {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      });

      // Show the target markers switch only if at least one feature has valid, non-zero target coordinates
      if (resultsPageMode && isAutoCenterEnabled) {
        fitMapToTraceDataset(map, initialTraceDatasetRef.current, {
          padding: 20,
          duration: 0,
          maxZoom: 18,
        });

        if (plumeViewEnabled) {
          map.easeTo({
            pitch: 72,
            bearing: 34,
            duration: 0,
            essential: true,
          });
        }

        const syncPlumeModeFromTilt = () => {
          const pitch = map.getPitch();

          if (!plumeModeFromTiltRef.current && pitch >= 45) {
            plumeModeFromTiltRef.current = true;
            onPlumeViewAutoChangeRef.current?.(true);
            return;
          }

          if (plumeModeFromTiltRef.current && pitch <= 25) {
            plumeModeFromTiltRef.current = false;
            onPlumeViewAutoChangeRef.current?.(false);
          }
        };

        map.on("move", syncPlumeModeFromTilt);
      }

      map.resize();
    });

    return () => {
      if (plumeTransitionFrameRef.current) {
        cancelAnimationFrame(plumeTransitionFrameRef.current);
        plumeTransitionFrameRef.current = null;
      }
      popupRef.current?.remove();
      popupRef.current = null;
      primaryMarkerRef.current?.remove();
      primaryMarkerRef.current = null;
      startPointMarkerRef.current?.remove();
      startPointMarkerRef.current = null;
      map.off("moveend", emitViewport);
      setIsStyleReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap || !isStyleReady) {
      return;
    }

    // Always do a full remove → add cycle to avoid stale source/layer state.
    if (currentMap.getLayer(ORTHOPHOTO_LAYER_ID)) {
      currentMap.removeLayer(ORTHOPHOTO_LAYER_ID);
    }
    if (currentMap.getSource(ORTHOPHOTO_SOURCE_ID)) {
      currentMap.removeSource(ORTHOPHOTO_SOURCE_ID);
    }

    const hasOverlay =
      orthophotoOverlay?.imageUrl &&
      Array.isArray(orthophotoOverlay.coordinates) &&
      orthophotoOverlay.coordinates.length === 4;

    if (!hasOverlay) {
      return;
    }

    currentMap.addSource(ORTHOPHOTO_SOURCE_ID, {
      type: "image",
      url: orthophotoOverlay.imageUrl,
      coordinates: orthophotoOverlay.coordinates,
    });

    // Insert BEFORE the heatmap so trace points render on top.
    const beforeLayer = currentMap.getLayer("methane-trace-heatmap")
      ? "methane-trace-heatmap"
      : undefined;

    currentMap.addLayer(
      {
        id: ORTHOPHOTO_LAYER_ID,
        type: "raster",
        source: ORTHOPHOTO_SOURCE_ID,
        paint: {
          "raster-opacity": 0.88,
          "raster-fade-duration": 0,
        },
      },
      beforeLayer,
    );
  }, [isStyleReady, orthophotoOverlay]);

  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap) {
      return;
    }

    const handleMapClick = (event) => {
      if (!startPointPickModeEnabled) {
        return;
      }

      const latitude = Number(event?.lngLat?.lat);
      const longitude = Number(event?.lngLat?.lng);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
      }

      onSetStartPointCoordinates?.({ latitude, longitude });
      onStartPointPickModeChange?.(false);
    };

    currentMap.on("click", handleMapClick);

    return () => {
      currentMap.off("click", handleMapClick);
    };
  }, [
    onSetStartPointCoordinates,
    onStartPointPickModeChange,
    startPointPickModeEnabled,
  ]);

  useEffect(() => {
    const currentMap = mapRef.current;
    const canvas = currentMap?.getCanvas?.();

    if (!canvas) {
      return;
    }

    if (startPointPickModeEnabled) {
      canvas.style.cursor = "crosshair";
      return () => {
        canvas.style.cursor = "";
      };
    }

    return undefined;
  }, [startPointPickModeEnabled]);

  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap) {
      return;
    }

    if (
      !startPointCoordinates ||
      !Number.isFinite(startPointCoordinates.latitude) ||
      !Number.isFinite(startPointCoordinates.longitude)
    ) {
      startPointMarkerRef.current?.remove();
      startPointMarkerRef.current = null;
      return;
    }

    const nextLongitude = Number(startPointCoordinates.longitude);
    const nextLatitude = Number(startPointCoordinates.latitude);

    if (!startPointMarkerRef.current) {
      startPointMarkerRef.current = new mapboxgl.Marker({
        color: "#06b6d4",
        scale: 0.9,
      })
        .setLngLat([nextLongitude, nextLatitude])
        .setPopup(
          new mapboxgl.Popup({ offset: 14 }).setHTML(
            '<div style="font-size:12px;color:#0f172a;font-weight:600;">Start Point Filter</div>',
          ),
        )
        .addTo(currentMap);
      return;
    }

    startPointMarkerRef.current.setLngLat([nextLongitude, nextLatitude]);
  }, [startPointCoordinates]);

  useEffect(() => {
    if (resultsPageMode) {
      return;
    }

    const currentMap = mapRef.current;
    if (!currentMap) {
      return;
    }

    primaryMarkerRef.current?.setLngLat([
      displayTargetLongitude,
      displayTargetLatitude,
    ]);

    if (!isAutoCenterEnabled) {
      return;
    }

    if (visibleDroneStates.length > 1) {
      fitMapToDroneStates(currentMap, visibleDroneStates, {
        padding: 80,
        duration: 900,
        maxZoom: 17,
      });
      return;
    }

    if (
      !focusedDrone ||
      !Number.isFinite(displayLatitude) ||
      !Number.isFinite(displayLongitude)
    ) {
      return;
    }

    currentMap.easeTo({
      center: [displayLongitude, displayLatitude],
      duration: 900,
      essential: true,
    });
  }, [
    displayLatitude,
    displayLongitude,
    displayTargetLatitude,
    displayTargetLongitude,
    focusedDrone,
    isAutoCenterEnabled,
    resultsPageMode,
    visibleDroneStates,
  ]);

  useEffect(() => {
    if (traceSourceUpdateTimeoutRef.current) {
      window.clearTimeout(traceSourceUpdateTimeoutRef.current);
      traceSourceUpdateTimeoutRef.current = null;
    }

    plumeModeFromTiltRef.current = plumeViewEnabled;

    const currentMap = mapRef.current;
    const applySourceUpdate = () => {
      const activeMap = mapRef.current;
      const methaneSource = activeMap?.getSource("methane-traces");
      const notifyTraceRenderComplete = (startedAtMs) => {
        if (!resultsPageMode || typeof onTraceRenderComplete !== "function") {
          return;
        }

        if (!activeMap) {
          onTraceRenderComplete();
          return;
        }

        let callbackInvoked = false;
        const invokeOnce = () => {
          if (callbackInvoked) {
            return;
          }

          callbackInvoked = true;
          if (Number.isFinite(startedAtMs)) {
            setLastTraceRenderMs(
              Math.max(0, Math.round(performance.now() - startedAtMs)),
            );
          }
          onTraceRenderComplete();
        };

        activeMap.resize();
        activeMap.triggerRepaint?.();
        window.requestAnimationFrame(() => {
          activeMap.resize();
          activeMap.triggerRepaint?.();
        });

        activeMap.once("idle", invokeOnce);
      };

      const startedAtMs = performance.now();

      if (methaneSource) {
        methaneSource.setData(displayedTraceDataset);

        if (resultsPageMode && isAutoCenterEnabled) {
          fitMapToTraceDataset(activeMap, displayedTraceDataset, {
            padding: plumeViewEnabled ? 120 : 20,
            duration: 500,
            maxZoom: 18,
          });
        }

        notifyTraceRenderComplete(startedAtMs);
      } else {
        notifyTraceRenderComplete(startedAtMs);
      }

      const plumeSource = activeMap?.getSource("methane-plume");
      if (plumeSource) {
        plumeSource.setData(methanePlumeDataset);
      }
    };

    if (!currentMap) {
      return;
    }

    if (resultsPageMode) {
      applySourceUpdate();
    } else {
      traceSourceUpdateTimeoutRef.current = window.setTimeout(
        applySourceUpdate,
        DASHBOARD_TRACE_SOURCE_UPDATE_DEBOUNCE_MS,
      );
    }

    return () => {
      if (traceSourceUpdateTimeoutRef.current) {
        window.clearTimeout(traceSourceUpdateTimeoutRef.current);
        traceSourceUpdateTimeoutRef.current = null;
      }
    };
  }, [
    displayedTraceDataset,
    methanePlumeDataset,
    isAutoCenterEnabled,
    onTraceRenderComplete,
    resultsPageMode,
    plumeViewEnabled,
  ]);

  useEffect(() => {
    const currentMap = mapRef.current;
    if (
      !currentMap ||
      !currentMap.getLayer("methane-trace-heatmap") ||
      !currentMap.getLayer("methane-trace-zero-points") ||
      !currentMap.getLayer("methane-trace-hotspots") ||
      !currentMap.getLayer("methane-trace-halo") ||
      !currentMap.getLayer("methane-plume-columns") ||
      !currentMap.getLayer("methane-plume-caps")
    ) {
      return;
    }

    if (plumeTransitionFrameRef.current) {
      cancelAnimationFrame(plumeTransitionFrameRef.current);
      plumeTransitionFrameRef.current = null;
    }

    const startHeatmapOpacity = Number(
      currentMap.getPaintProperty("methane-trace-heatmap", "heatmap-opacity") ??
        0,
    );
    const startZeroOpacity = Number(
      currentMap.getPaintProperty(
        "methane-trace-zero-points",
        "circle-opacity",
      ) ?? 0.88,
    );
    const startZeroStrokeOpacity = Number(
      currentMap.getPaintProperty(
        "methane-trace-zero-points",
        "circle-stroke-opacity",
      ) ?? 0.72,
    );
    const startHotspotOpacity = Number(
      currentMap.getPaintProperty("methane-trace-hotspots", "circle-opacity") ??
        0.8,
    );
    const startHotspotStrokeOpacity = Number(
      currentMap.getPaintProperty(
        "methane-trace-hotspots",
        "circle-stroke-opacity",
      ) ?? 0.9,
    );
    const startHaloOpacity = Number(
      currentMap.getPaintProperty("methane-trace-halo", "circle-opacity") ??
        0.36,
    );

    const targetHeatmapOpacity = resultsPageMode
      ? heatmapEnabled
        ? 0.78 * safeTraceOpacity
        : 0
      : isHeatmapOnlyActive
        ? 0.9 * safeTraceOpacity
      : plumeViewEnabled
        ? heatmapEnabled
          ? 0.2 * safeTraceOpacity
          : 0
        : 0;
    const targetZeroOpacity = resultsPageMode
      ? 0.18 * safeTraceOpacity
      : isHeatmapOnlyActive
        ? 0
      : plumeViewEnabled
        ? 0.15 * safeTraceOpacity
        : 0.88 * safeTraceOpacity;
    const targetZeroStrokeOpacity = isHeatmapOnlyActive
      ? 0
      : 0.72 * safeTraceOpacity;
    const targetHotspotOpacity = resultsPageMode
      ? 0.95 * safeTraceOpacity
      : isHeatmapOnlyActive
        ? 0
      : plumeViewEnabled
        ? 0.15 * safeTraceOpacity
        : 0.8 * safeTraceOpacity;
    const targetHotspotStrokeOpacity = isHeatmapOnlyActive
      ? 0
      : 0.9 * safeTraceOpacity;
    const targetHaloOpacity = resultsPageMode
      ? heatmapEnabled
        ? 0.46 * safeTraceOpacity
        : 0
      : isHeatmapOnlyActive
        ? 0
      : plumeViewEnabled
        ? heatmapEnabled
          ? 0.1 * safeTraceOpacity
          : 0
        : heatmapEnabled
          ? 0.36 * safeTraceOpacity
          : 0;
    const startPlumeOpacity = Number(
      currentMap.getPaintProperty(
        "methane-plume-columns",
        "fill-extrusion-opacity",
      ) ?? 0,
    );
    const startPlumeCapsOpacity = Number(
      currentMap.getPaintProperty("methane-plume-caps", "line-opacity") ?? 0,
    );
    const targetPlumeOpacity = plumeViewEnabled ? 0.82 * safeTraceOpacity : 0;
    const targetPlumeCapsOpacity = plumeViewEnabled
      ? 0.45 * safeTraceOpacity
      : 0;
    const durationMs = 420;
    const startAt = performance.now();

    const animate = (now) => {
      const progress = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);

      currentMap.setPaintProperty(
        "methane-trace-heatmap",
        "heatmap-opacity",
        startHeatmapOpacity +
          (targetHeatmapOpacity - startHeatmapOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-trace-zero-points",
        "circle-opacity",
        startZeroOpacity + (targetZeroOpacity - startZeroOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-trace-zero-points",
        "circle-stroke-opacity",
        startZeroStrokeOpacity +
          (targetZeroStrokeOpacity - startZeroStrokeOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-trace-hotspots",
        "circle-opacity",
        startHotspotOpacity +
          (targetHotspotOpacity - startHotspotOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-trace-hotspots",
        "circle-stroke-opacity",
        startHotspotStrokeOpacity +
          (targetHotspotStrokeOpacity - startHotspotStrokeOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-trace-halo",
        "circle-opacity",
        startHaloOpacity + (targetHaloOpacity - startHaloOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-plume-columns",
        "fill-extrusion-opacity",
        startPlumeOpacity + (targetPlumeOpacity - startPlumeOpacity) * eased,
      );
      currentMap.setPaintProperty(
        "methane-plume-caps",
        "line-opacity",
        startPlumeCapsOpacity +
          (targetPlumeCapsOpacity - startPlumeCapsOpacity) * eased,
      );

      if (progress < 1) {
        plumeTransitionFrameRef.current = requestAnimationFrame(animate);
      } else {
        plumeTransitionFrameRef.current = null;
      }
    };

    plumeTransitionFrameRef.current = requestAnimationFrame(animate);

    if (resultsPageMode) {
      currentMap.easeTo({
        pitch: plumeViewEnabled ? 72 : 0,
        bearing: plumeViewEnabled ? 34 : 0,
        duration: 500,
        essential: true,
      });
    }

    if (mapMode === "online") {
      currentMap.setTerrain(
        plumeViewEnabled ? { source: "mapbox-dem", exaggeration: 1.35 } : null,
      );
    }

    return () => {
      if (plumeTransitionFrameRef.current) {
        cancelAnimationFrame(plumeTransitionFrameRef.current);
        plumeTransitionFrameRef.current = null;
      }
    };
  }, [
    heatmapEnabled,
    isHeatmapOnlyActive,
    mapMode,
    plumeViewEnabled,
    resultsPageMode,
    safeTraceOpacity,
  ]);

  useEffect(() => {
    const currentMap = mapRef.current;
    const liveDroneSource = currentMap?.getSource("live-drones");
    const flightPathSource = currentMap?.getSource("flight-path");

    if (liveDroneSource) {
      liveDroneSource.setData(
        buildDroneFeatureCollection(
          droneStates,
          visibleDroneIdSet,
          hasVisibilityFilter,
        ),
      );
    }

    if (flightPathSource) {
      flightPathSource.setData(flightPathDataset);
    }
  }, [droneStates, flightPathDataset, hasVisibilityFilter, visibleDroneIdSet]);

  useEffect(() => {
    const currentMap = mapRef.current;

    if (!currentMap?.getLayer("flight-path-line")) {
      return;
    }

    currentMap.setPaintProperty(
      "flight-path-line",
      "line-opacity",
      showFlightPath ? (resultsPageMode ? 0.72 : 0.88) : 0,
    );
  }, [resultsPageMode, showFlightPath]);

  useEffect(() => {
    let isCancelled = false;
    let socket;
    let reconnectTimer;

    const upsertDroneState = (incomingEntry) => {
      const normalizedEntry = normalizeDroneState(incomingEntry);
      const nextLatitude = normalizedEntry.latitude;
      const nextLongitude = normalizedEntry.longitude;

      if (Number.isFinite(nextLatitude) && Number.isFinite(nextLongitude)) {
        setDroneTrackHistory((previousHistory) => {
          const existingCoordinates =
            previousHistory[normalizedEntry.drone_id] || [];
          const lastCoordinate =
            existingCoordinates[existingCoordinates.length - 1];

          if (
            lastCoordinate &&
            lastCoordinate[0] === nextLongitude &&
            lastCoordinate[1] === nextLatitude
          ) {
            return previousHistory;
          }

          return {
            ...previousHistory,
            [normalizedEntry.drone_id]: [
              ...existingCoordinates,
              [nextLongitude, nextLatitude],
            ].slice(-500),
          };
        });
      }

      setDroneStates((previousState) => {
        const dedupedState = previousState.filter(
          (item) => item.drone_id !== normalizedEntry.drone_id,
        );
        const nextState = [normalizedEntry, ...dedupedState];
        nextState.sort(
          (a, b) =>
            new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime(),
        );
        return nextState;
      });
    };

    const loadLatestState = async () => {
      try {
        const response = await fetch(`${backendHttpUrl}/api/drones/latest`);
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        if (isCancelled || !Array.isArray(payload?.data)) {
          return;
        }

        const normalizedRows = payload.data.map(normalizeDroneState);
        normalizedRows.sort(
          (a, b) =>
            new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime(),
        );
        setDroneStates(normalizedRows);
        setDroneTrackHistory(
          normalizedRows.reduce((history, row) => {
            if (
              Number.isFinite(row.longitude) &&
              Number.isFinite(row.latitude)
            ) {
              history[row.drone_id] = [[row.longitude, row.latitude]];
            }

            return history;
          }, {}),
        );
      } catch {
        /* empty */
      }
    };

    const connectTelemetrySocket = () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }

      try {
        socket = createTelemetryWebSocket();
        socket.onopen = () => {
          if (!isCancelled) {
            setIsTelemetryConnected(true);
          }
        };

        socket.onclose = () => {
          if (!isCancelled) {
            setIsTelemetryConnected(false);
            reconnectTimer = window.setTimeout(connectTelemetrySocket, 1000);
          }
        };

        socket.onerror = () => {
          if (!isCancelled) {
            setIsTelemetryConnected(false);
          }

          socket?.close();
        };

        socket.onmessage = (event) => {
          try {
            const packet = normalizeTelemetryPacket(JSON.parse(event.data));
            if (!packet?.telemetry) {
              return;
            }

            upsertDroneState(packet.telemetry);
          } catch (error) {
            console.error("Failed to process websocket telemetry:", error);
          }
        };
      } catch {
        setIsTelemetryConnected(false);
        reconnectTimer = window.setTimeout(connectTelemetrySocket, 1000);
      }
    };

    void waitForBackendReady().then((isBackendReady) => {
      if (!isBackendReady || isCancelled) {
        return;
      }

      loadLatestState();
      connectTelemetrySocket();
    });

    return () => {
      isCancelled = true;
      setIsTelemetryConnected(false);
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  useEffect(() => {
    const currentMap = mapRef.current;

    if (
      !currentMap ||
      !currentMap.getLayer("methane-trace-heatmap") ||
      !currentMap.getLayer("methane-trace-hotspots") ||
      !currentMap.getLayer("methane-trace-halo") ||
      !currentMap.getLayer("methane-plume-columns")
    ) {
      return;
    }

    currentMap.setPaintProperty(
      "methane-trace-heatmap",
      "heatmap-weight",
      buildHeatmapWeightExpression(lowerLimit, upperLimit),
    );
    currentMap.setPaintProperty(
      "methane-trace-heatmap",
      "heatmap-color",
      buildHeatmapColorExpression(lowerLimit, upperLimit),
    );
    currentMap.setPaintProperty(
      "methane-trace-hotspots",
      "circle-color",
      buildMethaneColorExpression(lowerLimit, upperLimit),
    );
    currentMap.setPaintProperty(
      "methane-trace-halo",
      "circle-color",
      buildMethaneColorExpression(lowerLimit, upperLimit),
    );
    currentMap.setPaintProperty(
      "methane-trace-hotspots",
      "circle-radius",
      buildHotspotRadiusExpression(lowerLimit, upperLimit),
    );
    currentMap.setPaintProperty(
      "methane-trace-halo",
      "circle-radius",
      buildHotspotHaloRadiusExpression(lowerLimit, upperLimit),
    );

    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan);
    const heatmapThreshold = lowerLimit + span * 0.04;
    currentMap.setFilter("methane-trace-heatmap", [
      ">=",
      ["get", "methane"],
      heatmapThreshold,
    ]);
    currentMap.setPaintProperty(
      "methane-plume-columns",
      "fill-extrusion-color",
      buildMethaneColorExpression(lowerLimit, upperLimit),
    );
  }, [lowerLimit, upperLimit]);

  useEffect(() => {
    onScaleChange?.({ lowerLimit, upperLimit });
  }, [lowerLimit, onScaleChange, upperLimit]);

  return (
    <div
      className={tw.panel}
      style={{ backgroundColor: color.card, padding: "0.5rem" }}
    >
      <div className="flex h-full w-full flex-col gap-3">
        <div
          className={`grid grid-cols-1 gap-3 xl:items-start ${
            resultsPageMode
              ? "xl:grid-cols-1"
              : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
          }`}
        >
          {!resultsPageMode ? (
            <div className="flex flex-col gap-3 rounded-lg px-3 py-2">
              <div className="flex flex-col justify-start items-start">
                <p
                  className="text-xs uppercase tracking-[0.18em]"
                  style={{ color: color.green }}
                >
                  Position
                </p>
                <h3
                  className="text-xl font-bold tracking-tight"
                  style={{ color: color.text }}
                >
                  Drone satellite view
                </h3>

                <div className="mt-1 flex flex-wrap justify-start items-center gap-3">
                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setIsAutoCenterEnabled((previous) => !previous)
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${isAutoCenterEnabled ? "bg-cyan-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${isAutoCenterEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Center on Drone
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => setShowFlightPath((previous) => !previous)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showFlightPath ? "bg-orange-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showFlightPath ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Flight Path
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setShowTargetMarkers((previous) => !previous)
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showTargetMarkers ? "bg-yellow-400" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showTargetMarkers ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Target Markers
                    </span>
                  </div>
                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => onTogglePlumeView?.()}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${plumeViewEnabled ? "bg-green-600" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${plumeViewEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Plume View
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          <div
            className="flex flex-col gap-2 rounded-lg border px-3 py-2 mt-5 "
            style={{
              backgroundColor: color.surface,
              borderColor: color.border,
            }}
          >
            {!resultsPageMode ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onToggleAllPlottedData?.()}
                    className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none"
                    style={{
                      backgroundColor: showAllPlottedData
                        ? color.green
                        : color.borderStrong,
                    }}
                    aria-label="Toggle all map plotted data"
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showAllPlottedData ? "translate-x-5" : "translate-x-0"}`}
                    />
                  </button>
                  <span
                    className="text-sm font-semibold"
                    style={{ color: color.text }}
                  >
                    Map Data
                  </span>

                  <div className="flex flex-wrap gap-1.5">
                    {devices.map((device) => {
                      const isVisible =
                        showAllPlottedData &&
                        droneVisibilityById[device.id] !== false;
                      const deviceColor = getDroneColor(device.id);

                      return (
                        <button
                          key={device.id}
                          type="button"
                          onClick={() => onToggleDroneVisibility?.(device.id)}
                          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                          style={{
                            backgroundColor: isVisible
                              ? `${deviceColor}22`
                              : color.card,
                            borderColor: isVisible ? deviceColor : color.border,
                            color: isVisible ? color.text : color.textMuted,
                          }}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: deviceColor }}
                          />
                          {device.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="text-xs font-semibold uppercase tracking-[0.12em]"
                    style={{ color: color.textMuted }}
                  >
                    Methane Valid
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleMethaneValidity?.("valid")}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                    style={{
                      backgroundColor: methaneValidityVisibility.valid
                        ? `${color.green}22`
                        : color.card,
                      borderColor: methaneValidityVisibility.valid
                        ? color.green
                        : color.border,
                      color: methaneValidityVisibility.valid
                        ? color.text
                        : color.textMuted,
                    }}
                  >
                    Valid (1)
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleMethaneValidity?.("invalid")}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                    style={{
                      backgroundColor: methaneValidityVisibility.invalid
                        ? `${color.orange}22`
                        : color.card,
                      borderColor: methaneValidityVisibility.invalid
                        ? color.orange
                        : color.border,
                      color: methaneValidityVisibility.invalid
                        ? color.text
                        : color.textMuted,
                    }}
                  >
                    Invalid (2)
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleMethaneValidity?.("noData")}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                    style={{
                      backgroundColor: methaneValidityVisibility.noData
                        ? `${color.textMuted}22`
                        : color.card,
                      borderColor: methaneValidityVisibility.noData
                        ? color.textMuted
                        : color.border,
                      color: methaneValidityVisibility.noData
                        ? color.text
                        : color.textMuted,
                    }}
                  >
                    No Data (0)
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleStartPointFilter?.()}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${startPointFilterEnabled ? "bg-cyan-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${startPointFilterEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Start Radius Filter
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onStartPointPickModeChange?.(!startPointPickModeEnabled)
                    }
                    className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                    style={{
                      backgroundColor: startPointPickModeEnabled
                        ? `${color.orange}22`
                        : color.card,
                      borderColor: startPointPickModeEnabled
                        ? color.orange
                        : color.border,
                      color: startPointPickModeEnabled
                        ? color.text
                        : color.textMuted,
                    }}
                  >
                    {startPointPickModeEnabled
                      ? "Click on Map..."
                      : "Set Start"}
                  </button>

                  <button
                    type="button"
                    onClick={() => onClearStartPointCoordinates?.()}
                    disabled={!startPointCoordinates}
                    className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55"
                    style={{
                      backgroundColor: color.card,
                      borderColor: color.border,
                      color: color.textMuted,
                    }}
                  >
                    Clear Start
                  </button>

                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs"
                      style={{ color: color.textMuted }}
                    >
                      Radius {Math.round(startPointFilterRadiusMeters)} m
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      step={1}
                      value={startPointFilterRadiusMeters}
                      onChange={(event) =>
                        onStartPointFilterRadiusChange?.(
                          Number(event.target.value) || 25,
                        )
                      }
                      className="w-28"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex w-full flex-col gap-2 pt-1 ">
              {resultsPageMode ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleHeatmap?.()}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${heatmapEnabled ? "bg-sky-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${heatmapEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Heatmap
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => onTogglePlumeView?.()}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${plumeViewEnabled ? "bg-green-600" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${plumeViewEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Plume View
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <span
                      className="text-xs"
                      style={{ color: color.textMuted }}
                    >
                      Methane Valid
                    </span>
                    <button
                      type="button"
                      onClick={() => onToggleMethaneValidity?.("valid")}
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                      style={{
                        backgroundColor: methaneValidityVisibility.valid
                          ? `${color.green}22`
                          : color.card,
                        borderColor: methaneValidityVisibility.valid
                          ? color.green
                          : color.border,
                        color: methaneValidityVisibility.valid
                          ? color.text
                          : color.textMuted,
                      }}
                    >
                      1
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleMethaneValidity?.("invalid")}
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                      style={{
                        backgroundColor: methaneValidityVisibility.invalid
                          ? `${color.orange}22`
                          : color.card,
                        borderColor: methaneValidityVisibility.invalid
                          ? color.orange
                          : color.border,
                        color: methaneValidityVisibility.invalid
                          ? color.text
                          : color.textMuted,
                      }}
                    >
                      2
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleMethaneValidity?.("noData")}
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                      style={{
                        backgroundColor: methaneValidityVisibility.noData
                          ? `${color.textMuted}22`
                          : color.card,
                        borderColor: methaneValidityVisibility.noData
                          ? color.textMuted
                          : color.border,
                        color: methaneValidityVisibility.noData
                          ? color.text
                          : color.textMuted,
                      }}
                    >
                      0
                    </button>
                  </div>
                  <div className="flex w-full flex-row gap-3">
                    <div
                      className="flex items-center gap-2 rounded-full border px-2 py-1"
                      style={{ borderColor: color.border }}
                    >
                      <button
                        type="button"
                        onClick={() => onToggleStartPointFilter?.()}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${startPointFilterEnabled ? "bg-cyan-500" : "bg-gray-300"}`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${startPointFilterEnabled ? "translate-x-5" : "translate-x-0"}`}
                        />
                      </button>
                      <span
                        className="text-sm"
                        style={{ color: color.textMuted }}
                      >
                        Start Radius
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        onStartPointPickModeChange?.(!startPointPickModeEnabled)
                      }
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors"
                      style={{
                        backgroundColor: startPointPickModeEnabled
                          ? `${color.orange}22`
                          : color.card,
                        borderColor: startPointPickModeEnabled
                          ? color.orange
                          : color.border,
                        color: startPointPickModeEnabled
                          ? color.text
                          : color.textMuted,
                      }}
                    >
                      {startPointPickModeEnabled
                        ? "Click on Map..."
                        : "Set Start"}
                    </button>

                    <button
                      type="button"
                      onClick={() => onClearStartPointCoordinates?.()}
                      disabled={!startPointCoordinates}
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55"
                      style={{
                        backgroundColor: color.card,
                        borderColor: color.border,
                        color: color.textMuted,
                      }}
                    >
                      Clear Start
                    </button>

                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs"
                        style={{ color: color.textMuted }}
                      >
                        Radius {Math.round(startPointFilterRadiusMeters)} m
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        step={1}
                        value={startPointFilterRadiusMeters}
                        onChange={(event) =>
                          onStartPointFilterRadiusChange?.(
                            Number(event.target.value) || 25,
                          )
                        }
                        className="w-28"
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {resultsPageMode ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setIsAutoCenterEnabled((previous) => !previous)
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${isAutoCenterEnabled ? "bg-cyan-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${isAutoCenterEnabled ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Auto Center
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() => setShowFlightPath((previous) => !previous)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showFlightPath ? "bg-orange-500" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showFlightPath ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Flight Path
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2 rounded-full border px-2 py-1"
                    style={{ borderColor: color.border }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setShowTargetMarkers((previous) => !previous)
                      }
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showTargetMarkers ? "bg-yellow-400" : "bg-gray-300"}`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showTargetMarkers ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                    <span
                      className="text-sm"
                      style={{ color: color.textMuted }}
                    >
                      Target Markers
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-row justify-between items-center">
          <div
            className="my-1 flex flex-wrap gap-x-4 gap-y-2 text-sm"
            style={{ color: color.textMuted }}
          >
            <span>lat: {displayLatitude.toFixed(4)} deg N</span>
            <span>lon: {Math.abs(displayLongitude).toFixed(4)} deg W</span>
            <span>alt: {displayAltitude.toFixed(1)} m</span>
            <span>drones: {droneStates.length}</span>
          </div>
          <div
            className="rounded-full px-3 py-1 text-xs font-medium flex items-center"
            style={{
              backgroundColor: isTelemetryConnected
                ? color.orangeSoft
                : color.surface,
              color: isTelemetryConnected ? color.orange : color.textMuted,
            }}
          >
            {isTelemetryConnected ? "Live telemetry" : "Waiting telemetry"} •{" "}
            {mapMode}
          </div>
        </div>
        {resultsPageMode ? (
          <div
            className="my-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
            style={{ color: color.textMuted }}
          >
            <span>raw: {rawTracePointCount.toLocaleString()}</span>
            <span>rendered: {renderedTracePointCount.toLocaleString()}</span>
            <span>reduction: {traceReductionPercent}%</span>
            <span>
              last render: {Number.isFinite(lastTraceRenderMs) ? `${lastTraceRenderMs} ms` : "-"}
            </span>
          </div>
        ) : null}
        <div className="flex items-stretch gap-2">
          <div
            ref={mapContainerRef}
            className={` w-full rounded-lg ${resultsPageMode ? "min-h-[590px]" : "border min-h-[590px]"}`}
            style={resultsPageMode ? undefined : { borderColor: color.border }}
          />

          <div className="flex h-full min-w-[100px] items-center gap-3">
            <div className="flex h-[292px] items-stretch gap-2">
              <div
                className="w-5 rounded-[4px] border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                style={{
                  background: methaneGradient,
                  borderColor: color.border,
                }}
              />
              <div className="flex h-full flex-col justify-between py-[2px]">
                {methaneScale.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-1.5">
                    <span
                      className="block h-px w-2"
                      style={{ backgroundColor: color.textMuted }}
                    />

                    {entry.kind === "upper" ? (
                      <input
                        type="number"
                        step="0.1"
                        value={upperLimitInput}
                        onChange={(event) =>
                          handleLimitChange("upper", event.target.value)
                        }
                        onBlur={() => commitLimit("upper")}
                        className="w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none"
                        style={{ borderColor: color.border, color: color.text }}
                        aria-label="Upper methane scale limit"
                      />
                    ) : null}

                    {entry.kind === "range" ? (
                      <span
                        className="text-[10px] font-semibold leading-none"
                        style={{ color: color.text }}
                      >
                        {entry.label}
                      </span>
                    ) : null}

                    {entry.kind === "lower" ? (
                      <input
                        type="number"
                        step="0.1"
                        value={lowerLimitInput}
                        onChange={(event) =>
                          handleLimitChange("lower", event.target.value)
                        }
                        onBlur={() => commitLimit("lower")}
                        className="w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none"
                        style={{ borderColor: color.border, color: color.text }}
                        aria-label="Lower methane scale limit"
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
