import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import m350Marker from "../assets/M350.png";
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

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

const buildDroneFeatureCollection = (drones) => ({
  type: "FeatureCollection",
  features: drones
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

const isAllDroneSelection = (selectedDroneId) => {
  if (selectedDroneId == null) {
    return true;
  }

  const normalizedValue = String(selectedDroneId).trim().toLowerCase();
  return !normalizedValue || normalizedValue === "all" || normalizedValue === "all-data";
};

const buildTraceFlightPathFeatureCollection = (traceDataset) => {
  const coordinates = [...(traceDataset?.features || [])]
    .sort(
      (left, right) =>
        Number(left?.properties?.sampleOrder ?? 0) -
        Number(right?.properties?.sampleOrder ?? 0),
    )
    .map((feature) => feature?.geometry?.coordinates)
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
) => {
  const showAllDrones = isAllDroneSelection(selectedDroneId);
  const features = Object.entries(droneTrackHistory || {})
    .filter(([droneId, coordinates]) => {
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        return false;
      }

      return showAllDrones || droneId === selectedDroneId;
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
      },
    }));

  return {
    type: "FeatureCollection",
    features,
  };
};

const buildDisplayedTraceDataset = (traceDataset, showTargetMarkers) => ({
  type: "FeatureCollection",
  features: (traceDataset?.features || [])
    .map((feature) => {
      const properties = feature?.properties || {};
      const sourceLongitude = toFiniteNumber(properties.sourceLongitude);
      const sourceLatitude = toFiniteNumber(properties.sourceLatitude);
      const targetLongitude = toFiniteNumber(properties.targetLongitude);
      const targetLatitude = toFiniteNumber(properties.targetLatitude);
      const longitude = showTargetMarkers
        ? targetLongitude ?? sourceLongitude
        : sourceLongitude ?? targetLongitude;
      const latitude = showTargetMarkers
        ? targetLatitude ?? sourceLatitude
        : sourceLatitude ?? targetLatitude;

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
          mapCoordinates: showTargetMarkers ? "target" : "drone",
        },
      };
    })
    .filter(Boolean),
});

const getTraceMaxMethane = (dataset) => {
  if (!dataset?.features?.length) {
    return 5;
  }

  const values = dataset.features
    .map((feature) => Number(feature?.properties?.methane))
    .filter((value) => Number.isFinite(value));

  if (!values.length) {
    return 5;
  }

  return Math.max(5, ...values);
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

export function Map({
  traceDataset,
  onScaleChange,
  selectedDroneId,
  resultsPageMode,
  heatmapEnabled = true,
  plumeViewEnabled = false,
  traceOpacity = 1,
  onPlumeViewAutoChange,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const primaryMarkerRef = useRef(null);
  const plumeTransitionFrameRef = useRef(null);
  const plumeModeFromTiltRef = useRef(plumeViewEnabled);
  const initialTraceDatasetRef = useRef(traceDataset);
  const initialPlumeDatasetRef = useRef(buildMethanePlumeDataset(traceDataset));
  const datasetMaxMethane = getTraceMaxMethane(traceDataset);
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
  const [droneStates, setDroneStates] = useState([]);
  const [droneTrackHistory, setDroneTrackHistory] = useState({});
  const [isTelemetryConnected, setIsTelemetryConnected] = useState(false);
  const [mapMode, setMapMode] = useState(() =>
    shouldUseOnlineMap(mapboxToken) ? "online" : "offline",
  );
  const methaneScale = buildMethaneScale(lowerLimit, upperLimit);
  const methaneGradient = buildMethaneGradient(lowerLimit, upperLimit);
  const safeTraceOpacity = Math.min(
    1,
    Math.max(
      0,
      Number.isFinite(Number(traceOpacity)) ? Number(traceOpacity) : 1,
    ),
  );
  const methanePlumeDataset = useMemo(
    () => buildMethanePlumeDataset(traceDataset),
    [traceDataset],
  );
  const displayedTraceDataset = useMemo(
    () => buildDisplayedTraceDataset(traceDataset, showTargetMarkers),
    [showTargetMarkers, traceDataset],
  );
  const flightPathDataset = useMemo(
    () =>
      resultsPageMode
        ? buildTraceFlightPathFeatureCollection(traceDataset)
        : buildLiveFlightPathFeatureCollection(droneTrackHistory, selectedDroneId),
    [droneTrackHistory, resultsPageMode, selectedDroneId, traceDataset],
  );
  const focusedDrone =
    droneStates.find((drone) => drone.drone_id === selectedDroneId) ||
    droneStates[0] ||
    null;
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
    const offlineCoordinates = buildOfflineImageCoordinates({
      centerLat: latitude,
      centerLon: longitude,
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
      center: [displayLongitude, displayLatitude],
      zoom: 18,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });

    setMapMode(isOnlineMode ? "online" : "offline");
    mapRef.current = map;
    popupRef.current = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      className: "methane-trace-popup",
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    if (!resultsPageMode) {
      const markerElement = document.createElement("div");
      markerElement.style.width = "52px";
      markerElement.style.height = "52px";
      markerElement.style.display = "flex";
      markerElement.style.alignItems = "center";
      markerElement.style.justifyContent = "center";
      markerElement.style.borderRadius = "999px";
      markerElement.style.background = "rgba(255, 255, 255, 0.92)";
      markerElement.style.border = `3px solid ${color.orange}`;
      markerElement.style.boxShadow = `0 0 0 8px rgba(253, 148, 86, 0.28), 0 10px 22px rgba(0, 0, 0, 0.42)`;

      const markerImage = document.createElement("img");
      markerImage.src = m350Marker;
      markerImage.alt = "Drone";
      markerImage.draggable = false;
      markerImage.style.width = "40px";
      markerImage.style.height = "40px";
      markerImage.style.objectFit = "contain";
      markerImage.style.filter = "drop-shadow(0 3px 6px rgba(0, 0, 0, 0.24))";

      markerImage.onerror = () => {
        markerImage.style.display = "none";
      };

      markerElement.appendChild(markerImage);

      primaryMarkerRef.current = new mapboxgl.Marker({
        element: markerElement,
        anchor: "center",
      })
        .setLngLat([longitude, latitude])
        .addTo(map);
    }

    map.on("load", () => {
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

        if (plumeViewEnabled) {
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
          "circle-stroke-opacity": 0.72 * safeTraceOpacity,
          "circle-opacity": resultsPageMode
            ? 0.18 * safeTraceOpacity
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
          "circle-stroke-opacity": 0.9 * safeTraceOpacity,
          "circle-opacity": resultsPageMode
            ? 0.95 * safeTraceOpacity
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
          "line-color": color.blue,
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
          "circle-color": color.orange,
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
            averageMethane,
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

      if (resultsPageMode) {
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
            onPlumeViewAutoChange?.(true);
            return;
          }

          if (plumeModeFromTiltRef.current && pitch <= 25) {
            plumeModeFromTiltRef.current = false;
            onPlumeViewAutoChange?.(false);
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
      map.remove();
      mapRef.current = null;
    };
  }, [resultsPageMode]);

  useEffect(() => {
    if (resultsPageMode) {
      return;
    }

    if (
      !focusedDrone ||
      !Number.isFinite(displayLatitude) ||
      !Number.isFinite(displayLongitude)
    ) {
      return;
    }

    const currentMap = mapRef.current;
    if (currentMap) {
      currentMap.easeTo({
        center: [displayLongitude, displayLatitude],
        duration: 900,
        essential: true,
      });
    }

    primaryMarkerRef.current?.setLngLat([
      displayTargetLongitude,
      displayTargetLatitude,
    ]);
  }, [displayLatitude, displayLongitude, focusedDrone, resultsPageMode]);

  useEffect(() => {
    const nextUpperLimit = Math.max(
      datasetMaxMethane,
      lowerLimit + minimumLegendSpan,
    );

    setUpperLimit(nextUpperLimit);
    setUpperLimitInput(formatLegendValue(nextUpperLimit));
    initialUpperLimitRef.current = nextUpperLimit;
  }, [datasetMaxMethane, lowerLimit]);

  useEffect(() => {
    plumeModeFromTiltRef.current = plumeViewEnabled;

    const currentMap = mapRef.current;
    const methaneSource = currentMap?.getSource("methane-traces");

    if (methaneSource) {
      methaneSource.setData(displayedTraceDataset);

      if (resultsPageMode) {
        fitMapToTraceDataset(currentMap, displayedTraceDataset, {
          padding: plumeViewEnabled ? 120 : 20,
          duration: 500,
          maxZoom: 18,
        });
      }
    }

    const plumeSource = currentMap?.getSource("methane-plume");
    if (plumeSource) {
      plumeSource.setData(methanePlumeDataset);
    }
  }, [
    displayedTraceDataset,
    methanePlumeDataset,
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
      : plumeViewEnabled
        ? heatmapEnabled
          ? 0.2 * safeTraceOpacity
          : 0
        : 0;
    const targetZeroOpacity = resultsPageMode
      ? 0.18 * safeTraceOpacity
      : plumeViewEnabled
        ? 0.15 * safeTraceOpacity
        : 0.88 * safeTraceOpacity;
    const targetZeroStrokeOpacity = 0.72 * safeTraceOpacity;
    const targetHotspotOpacity = resultsPageMode
      ? 0.95 * safeTraceOpacity
      : plumeViewEnabled
        ? 0.15 * safeTraceOpacity
        : 0.8 * safeTraceOpacity;
    const targetHotspotStrokeOpacity = 0.9 * safeTraceOpacity;
    const targetHaloOpacity = resultsPageMode
      ? heatmapEnabled
        ? 0.46 * safeTraceOpacity
        : 0
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
      liveDroneSource.setData(buildDroneFeatureCollection(droneStates));
    }

    if (flightPathSource) {
      flightPathSource.setData(flightPathDataset);
    }
  }, [droneStates, flightPathDataset]);

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
          const existingCoordinates = previousHistory[normalizedEntry.drone_id] || [];
          const lastCoordinate = existingCoordinates[existingCoordinates.length - 1];

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
      } catch {}
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
            const packet = JSON.parse(event.data);
            if (packet?.type !== "telemetry" || !packet.data) {
              return;
            }

            upsertDroneState(packet.data);
          } catch {}
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
        <div className="grid grid-cols-2 justify-between">
          {!resultsPageMode ? (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p
                  className="text-xs uppercase tracking-[0.18em]"
                  style={{ color: color.green }}
                >
                  Position
                </p>
                <p
                  className="text-xl font-bold tracking-tight"
                  style={{ color: color.text }}
                >
                  Drone satellite view
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-row gap-7">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowFlightPath((previous) => !previous)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showFlightPath ? "bg-green-600" : "bg-gray-300"}`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showFlightPath ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
            <span className="">Flight Path</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowTargetMarkers((previous) => !previous)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showTargetMarkers ? "bg-green-600" : "bg-gray-300"}`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showTargetMarkers ? "translate-x-5" : "translate-x-0"}`}
              />
            </button>
            <span className="">Target Markers</span>
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
        <div className="flex items-stretch gap-2">
          <div
            ref={mapContainerRef}
            className={` w-full rounded-lg ${resultsPageMode ? "min-h-[590px]" : "border min-h-[460px]"}`}
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
