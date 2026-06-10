import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ColumnLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
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
import { buildDeckTracePointsFromFlowData } from "../shared/deckTraceData";

const latitude = traceOrigin.latitude;
const longitude = traceOrigin.longitude;
const altitude = traceOrigin.altitude;
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
const TRACE_HIGH_ZOOM_THRESHOLD = 14;
const TRACE_MEDIUM_ZOOM_THRESHOLD = 11;
const TRACE_LOW_ZOOM_THRESHOLD = 8;

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

const toFiniteNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const hexToRgba = (hex, alpha = 255) => {
    const normalized = String(hex || "").replace("#", "");
    const expanded = normalized.length === 3
        ? normalized.split("").map((character) => character + character).join("")
        : normalized.padEnd(6, "0").slice(0, 6);

    return [
        Number.parseInt(expanded.slice(0, 2), 16) || 0,
        Number.parseInt(expanded.slice(2, 4), 16) || 0,
        Number.parseInt(expanded.slice(4, 6), 16) || 0,
        alpha,
    ];
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
        (total, character) => total + character.charCodeAt(0),
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

const buildDisplayedTracePoints = (
    tracePoints,
    showTargetMarkers,
    visibleDroneIdSet,
    hasVisibilityFilter,

) => (Array.isArray(tracePoints) ? tracePoints : [])
    .filter((point) =>
        isDroneVisible(point?.droneId, visibleDroneIdSet, hasVisibilityFilter),
    )
    .map((point) => {
        let nextLongitude;
        let nextLatitude;
        let mapCoordinates;

        if (showTargetMarkers) {
            const targetLongitude = toFiniteNumber(point.targetLongitude ?? point.target_longitude);
            const targetLatitude = toFiniteNumber(point.targetLatitude ?? point.target_latitude);
            const isValidTarget =
                targetLongitude !== 0 &&
                targetLatitude !== 0 &&
                Number.isFinite(targetLongitude) &&
                Number.isFinite(targetLatitude);

            if (isValidTarget) {
                nextLongitude = targetLongitude;
                nextLatitude = targetLatitude;
                mapCoordinates = "target";
            } else {
                nextLongitude = toFiniteNumber(point.sourceLongitude ?? point.longitude ?? point.targetLongitude) ?? targetLongitude;
                nextLatitude = toFiniteNumber(point.sourceLatitude ?? point.latitude ?? point.targetLatitude) ?? targetLatitude;
                mapCoordinates = "drone";
            }
        } else {
            nextLongitude = toFiniteNumber(point.sourceLongitude ?? point.longitude ?? point.targetLongitude);
            nextLatitude = toFiniteNumber(point.sourceLatitude ?? point.latitude ?? point.targetLatitude);
            mapCoordinates = "drone";
        }

        if (!Number.isFinite(nextLongitude) || !Number.isFinite(nextLatitude)) {
            return null;
        }

        return {
            ...point,
            longitude: nextLongitude,
            latitude: nextLatitude,
            mapCoordinates,
        };
    })
    .filter(Boolean);

const fitMapToTracePoints = (map, points, { padding = 20, duration = 650, maxZoom = 17 } = {}) => {
    if (!map || !Array.isArray(points) || points.length === 0) {
        return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasValidPoints = false;

    points.forEach((point) => {
        const lng = Number(point?.longitude);
        const lat = Number(point?.latitude);

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

const buildPlumeColumnData = (tracePoints) => (Array.isArray(tracePoints) ? tracePoints : [])
    .filter((point) => Number(point?.methane ?? 0) > 0)
    .filter((point) => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude))
    .map((point, index) => ({
        id: `plume-${index}`,
        longitude: Number(point.longitude),
        latitude: Number(point.latitude),
        methane: Number(point.methane ?? 0),
        plumeHeight: Math.max(0, Number(point.methane ?? 0) * 0.01),
        radiusMeters: 1,
    }));

const getTracePointBudgetForZoom = (zoomLevel) => {
    if (zoomLevel >= 16) {
        return 120000;
    }

    if (zoomLevel >= TRACE_HIGH_ZOOM_THRESHOLD) {
        return 90000;
    }

    if (zoomLevel >= TRACE_MEDIUM_ZOOM_THRESHOLD) {
        return 50000;
    }

    if (zoomLevel >= TRACE_LOW_ZOOM_THRESHOLD) {
        return 22000;
    }

    return 12000;
};

const getGridCellSizeForZoom = (zoomLevel) => {
    if (zoomLevel >= TRACE_HIGH_ZOOM_THRESHOLD) {
        return 0;
    }

    if (zoomLevel >= TRACE_MEDIUM_ZOOM_THRESHOLD) {
        return 0.00015;
    }

    if (zoomLevel >= TRACE_LOW_ZOOM_THRESHOLD) {
        return 0.00035;
    }

    return 0.00075;
};

const decimateTracePoints = (points, maxPoints) => {
    if (!Array.isArray(points) || points.length <= maxPoints) {
        return Array.isArray(points) ? points : [];
    }

    const stride = Math.max(1, Math.ceil(points.length / maxPoints));
    const reduced = [];

    for (let index = 0; index < points.length; index += stride) {
        reduced.push(points[index]);
    }

    if (reduced[reduced.length - 1] !== points[points.length - 1]) {
        reduced.push(points[points.length - 1]);
    }

    return reduced.slice(0, maxPoints);
};

const aggregateTracePointsByGrid = (points, cellSize) => {
    if (!Array.isArray(points) || points.length === 0 || cellSize <= 0) {
        return Array.isArray(points) ? points : [];
    }

    const buckets = new globalThis.Map();

    points.forEach((point) => {
        const longitude = Number(point?.longitude);
        const latitude = Number(point?.latitude);

        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
            return;
        }

        const lngKey = Math.floor(longitude / cellSize);
        const latKey = Math.floor(latitude / cellSize);
        const bucketKey = `${lngKey}:${latKey}`;
        const methane = Number(point?.methane ?? 0);
        const existing = buckets.get(bucketKey);

        if (!existing) {
            buckets.set(bucketKey, {
                representative: point,
                methaneMax: methane,
                methaneSum: methane,
                pointCount: 1,
            });
            return;
        }

        existing.pointCount += 1;
        existing.methaneSum += methane;

        if (methane > existing.methaneMax) {
            existing.methaneMax = methane;
            existing.representative = point;
        }
    });

    return [...buckets.values()].map((entry) => ({
        ...entry.representative,
        methane: entry.methaneMax,
        methaneAvg: entry.methaneSum / entry.pointCount,
        aggregatedCount: entry.pointCount,
    }));
};

const buildAdaptiveTracePointData = (points, zoomLevel) => {
    const rows = Array.isArray(points) ? points : [];
    if (!rows.length) {
        return [];
    }

    const maxPoints = getTracePointBudgetForZoom(zoomLevel);
    const cellSize = getGridCellSizeForZoom(zoomLevel);
    const clustered = cellSize > 0 ? aggregateTracePointsByGrid(rows, cellSize) : rows;
    return decimateTracePoints(clustered, maxPoints);
};

const fitMapToDroneStates = (map, drones, { padding = 60, duration = 700, maxZoom = 17 } = {}) => {
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

export function DeckMap({
    traceDataset,
    tracePoints,
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
    heatmapEnabled = true,
    plumeViewEnabled = false,
    traceOpacity = 1,
    onToggleHeatmap,
    onTogglePlumeView,
    onPlumeViewAutoChange,
    onTraceRenderComplete,
}) {
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const deckOverlayRef = useRef(null);
    const popupRef = useRef(null);
    const plumeTransitionFrameRef = useRef(null);
    const traceSourceUpdateTimeoutRef = useRef(null);
    const plumeModeFromTiltRef = useRef(plumeViewEnabled);
    const mapMode = shouldUseOnlineMap(mapboxToken) ? "online" : "offline";
    const datasetMaxMethane = getTraceMaxMethane(
        tracePoints && tracePoints.length
            ? { features: tracePoints.map((point) => ({ properties: { methane: point.methane } })) }
            : traceDataset,
    );
    const initialMapSetupRef = useRef(null);
    const [upperLimit, setUpperLimit] = useState(datasetMaxMethane);
    const [lowerLimit, setLowerLimit] = useState(0);
    const [upperLimitInput, setUpperLimitInput] = useState(String(datasetMaxMethane));
    const [lowerLimitInput, setLowerLimitInput] = useState("0");
    const [showFlightPath, setShowFlightPath] = useState(false);
    const [showTargetMarkers, setShowTargetMarkers] = useState(false);
    const [isAutoCenterEnabled, setIsAutoCenterEnabled] = useState(true);
    const [droneStates, setDroneStates] = useState([]);
    const [, setDroneTrackHistory] = useState({});
    const [isTelemetryConnected, setIsTelemetryConnected] = useState(false);
    const [mapZoom, setMapZoom] = useState(18);

    const safeTraceOpacity = Math.min(
        1,
        Math.max(0, Number.isFinite(Number(traceOpacity)) ? Number(traceOpacity) : 1),
    );

    const methaneScale = useMemo(() => buildMethaneScale(lowerLimit, upperLimit), [lowerLimit, upperLimit]);
    const methaneGradient = useMemo(() => buildMethaneGradient(lowerLimit, upperLimit), [lowerLimit, upperLimit]);
    const visibleDroneIdSet = useMemo(() => buildVisibleDroneIdSet(visibleDroneIds), [visibleDroneIds]);
    const hasVisibilityFilter = Array.isArray(visibleDroneIds);
    const tracePointData = useMemo(
        () => buildDisplayedTracePoints(
            tracePoints ?? buildDeckTracePointsFromFlowData((traceDataset?.features || []).map((feature) => ({
                ...(feature?.properties || {}),
                longitude: feature?.properties?.sourceLongitude ?? feature?.geometry?.coordinates?.[0],
                latitude: feature?.properties?.sourceLatitude ?? feature?.geometry?.coordinates?.[1],
            }))),
            showTargetMarkers,
            visibleDroneIdSet,
            hasVisibilityFilter,
        ),
        [hasVisibilityFilter, showTargetMarkers, traceDataset, tracePoints, visibleDroneIdSet],
    );
    const adaptiveTracePointData = useMemo(
        () => buildAdaptiveTracePointData(tracePointData, mapZoom),
        [mapZoom, tracePointData],
    );
    const methanePlumeDataset = useMemo(
        () => (resultsPageMode ? buildPlumeColumnData(adaptiveTracePointData) : []),
        [adaptiveTracePointData, resultsPageMode],
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

    const displayLatitude = Number.isFinite(focusedDrone?.latitude) ? focusedDrone.latitude : latitude;
    const displayLongitude = Number.isFinite(focusedDrone?.longitude) ? focusedDrone.longitude : longitude;
    const displayAltitude = Number.isFinite(focusedDrone?.altitude) ? focusedDrone.altitude : altitude;

    const initialTraceCenter = useMemo(
        () => {
            const points = tracePointData || [];
            if (!points.length) {
                return { latitude: displayLatitude, longitude: displayLongitude };
            }

            const bounds = new mapboxgl.LngLatBounds();
            let hasValidPoints = false;

            points.forEach((point) => {
                const lng = Number(point?.longitude);
                const lat = Number(point?.latitude);
                if (Number.isFinite(lng) && Number.isFinite(lat)) {
                    bounds.extend([lng, lat]);
                    hasValidPoints = true;
                }
            });

            if (!hasValidPoints) {
                return { latitude: displayLatitude, longitude: displayLongitude };
            }

            const center = bounds.getCenter();
            return { latitude: center.lat, longitude: center.lng };
        },
        [displayLatitude, displayLongitude, tracePointData],
    );

    if (initialMapSetupRef.current === null) {
        initialMapSetupRef.current = {
            isOnlineMode: shouldUseOnlineMap(mapboxToken),
            initialCenterLatitude: resultsPageMode
                ? initialTraceCenter.latitude
                : displayLatitude,
            initialCenterLongitude: resultsPageMode
                ? initialTraceCenter.longitude
                : displayLongitude,
            initialDisplayedTracePoints: tracePointData,
            initialIsAutoCenterEnabled: isAutoCenterEnabled,
            initialPlumeViewEnabled: plumeViewEnabled,
            initialResultsPageMode: resultsPageMode,
        };
    }

    const getScaleColor = useCallback((value) => {
        const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan);
        const ratio = Math.min(Math.max((Number(value ?? 0) - lowerLimit) / span, 0), 1);
        const index = Math.min(
            methaneScale.length - 1,
            Math.max(0, Math.round(ratio * (methaneScale.length - 1))),
        );
        return methaneScale[index]?.swatch || color.text;
    }, [lowerLimit, methaneScale, upperLimit]);
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

    const deckLayers = useMemo(() => {
        const traceFeatures = adaptiveTracePointData || [];
        const traceZeroFeatures = [];
        const traceHotspotFeatures = [];

        traceFeatures.forEach((point) => {
            if (Number(point?.methane ?? 0) > 0) {
                traceHotspotFeatures.push(point);
                return;
            }

            traceZeroFeatures.push(point);
        });

        const plumeFeatures = methanePlumeDataset || [];
        const liveDroneFeatures = buildDroneFeatureCollection(
            visibleDroneStates,
            visibleDroneIdSet,
            hasVisibilityFilter,
        ).features;
        const zeroOpacity = resultsPageMode
            ? 0.18 * safeTraceOpacity
            : plumeViewEnabled
                ? 0.15 * safeTraceOpacity
                : 0.88 * safeTraceOpacity;
        const hotspotOpacity = resultsPageMode
            ? 0.95 * safeTraceOpacity
            : plumeViewEnabled
                ? 0.15 * safeTraceOpacity
                : 0.8 * safeTraceOpacity;
        const haloOpacity = resultsPageMode
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
        const plumeOpacity = plumeViewEnabled ? 0.82 * safeTraceOpacity : 0;
        const plumeCapsOpacity = plumeViewEnabled ? 0.45 * safeTraceOpacity : 0;

        return [
            // new HeatmapLayer({
            //     id: "methane-trace-heatmap",
            //     data: traceFeatures,
            //     aggregation: 'SUM',
            //     pickable: false,
            //     visible: traceHeatmapOpacity > 0,
            //     getPosition: (feature) => feature.geometry.coordinates,
            //     getWeight: (feature) => Number(feature?.properties?.methane ?? 0),
            //     // radiusPixels: resultsPageMode ? 20 : 15,
            //     // intensity: resultsPageMode ? 1.65 : 1.1,
            //     radiusPixels: 25,
            //     intensity: 1,
            //     threshold: 0.02,
            //     colorRange: buildMethaneScale(lowerLimit, upperLimit)
            //         .slice()
            //         .reverse()
            //         .map((entry) => hexToRgba(entry.swatch, 210)),
            //     opacity: traceHeatmapOpacity,
            // }),
            new ScatterplotLayer({
                id: "methane-trace-zero-points",
                data: traceZeroFeatures,
                pickable: traceFeatures.length <= 25000,
                visible: zeroOpacity > 0,
                getPosition: (point) => [point.longitude, point.latitude],
                getFillColor: (point) => hexToRgba(point?.pointColor || color.textMuted, 210),
                getRadius: 3,
                radiusMinPixels: 2,
                radiusMaxPixels: 6,
                stroked: true,
                lineWidthMinPixels: 1,
                getLineColor: [255, 255, 255, 184],
                opacity: zeroOpacity,
            }),
            new ScatterplotLayer({
                id: "methane-trace-hotspots",
                data: traceHotspotFeatures,
                pickable: traceFeatures.length <= 25000,
                visible: hotspotOpacity > 0,
                getPosition: (point) => [point.longitude, point.latitude],
                getFillColor: (point) => hexToRgba(getScaleColor(point?.methane), 220),
                getRadius: (point) => {
                    const methane = Number(point?.methane ?? 0);
                    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan);
                    const ratio = Math.min(Math.max((methane - lowerLimit) / span, 0), 1);
                    return 2.5 + ratio * 4;
                },
                radiusMinPixels: 2.5,
                radiusMaxPixels: 6.5,
                stroked: true,
                lineWidthMinPixels: 1,
                getLineColor: [255, 255, 255, 230],
                opacity: hotspotOpacity,
            }),
            new ScatterplotLayer({
                id: "methane-trace-halo",
                data: traceHotspotFeatures,
                pickable: false,
                visible: haloOpacity > 0,
                getPosition: (point) => [point.longitude, point.latitude],
                getFillColor: (point) => hexToRgba(getScaleColor(point?.methane), 90),
                getRadius: (point) => {
                    const methane = Number(point?.methane ?? 0);
                    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan);
                    const ratio = Math.min(Math.max((methane - lowerLimit) / span, 0), 1);
                    return 7 + ratio * 9;
                },
                radiusMinPixels: 6,
                radiusMaxPixels: 16,
                stroked: false,
                opacity: haloOpacity,
            }),
            new ColumnLayer({
                id: "methane-plume-columns",
                data: plumeFeatures,
                pickable: false,
                diskResolution: 8,
                stroked: false,
                extruded: true,
                getPosition: (feature) => [feature.longitude, feature.latitude],
                getRadius: (feature) => Number(feature?.radiusMeters ?? 1),
                radiusUnits: "meters",
                getFillColor: (feature) => hexToRgba(getScaleColor(feature?.methane), 210),
                getElevation: (feature) => Number(feature?.plumeHeight ?? 0),
                elevationScale: 14,
                opacity: plumeOpacity,
            }),
            new ScatterplotLayer({
                id: "methane-plume-caps",
                data: plumeFeatures,
                pickable: false,
                filled: false,
                stroked: true,
                getPosition: (feature) => [feature.longitude, feature.latitude],
                getRadius: (feature) => Number(feature?.radiusMeters ?? 1),
                radiusUnits: "meters",
                lineWidthMinPixels: 1.1,
                getLineColor: [255, 255, 255, 220],
                opacity: plumeCapsOpacity,
            }),
            // new PathLayer({
            //     id: "flight-path-line",
            //     data: flightPathDataset.features,
            //     pickable: false,
            //     visible: showFlightPath,
            //     getPath: (feature) => feature.geometry.coordinates,
            //     getColor: (feature) => hexToRgba(feature?.properties?.pathColor || color.fligthpathOrange, 220),
            //     getWidth: resultsPageMode ? 3 : 2,
            //     widthMinPixels: 2,
            //     widthScale: 1,
            //     rounded: true,
            // }),
            new ScatterplotLayer({
                id: "live-drones-points",
                data: liveDroneFeatures,
                pickable: true,
                visible: true,
                getPosition: (feature) => feature.geometry.coordinates,
                getFillColor: (feature) => hexToRgba(getDroneColor(feature?.properties?.drone_id), 230),
                getRadius: 8,
                radiusMinPixels: 5,
                radiusMaxPixels: 10,
                stroked: true,
                lineWidthMinPixels: 1.4,
                getLineColor: [255, 255, 255, 255],
                opacity: 0.94,
            }),
            new TextLayer({
                id: "live-drones-labels",
                data: liveDroneFeatures,
                pickable: false,
                getPosition: (feature) => feature.geometry.coordinates,
                getText: (feature) => feature?.properties?.drone_id || "",
                getSize: 11,
                getColor: [255, 255, 255, 255],
                getTextAnchor: "middle",
                getAlignmentBaseline: "center",
                getPixelOffset: [0, 14],
                background: true,
                backgroundColor: [0, 0, 0, 180],
            }),
        ];
    }, [
        getScaleColor,
        hasVisibilityFilter,
        heatmapEnabled,
        lowerLimit,
        methanePlumeDataset,
        plumeViewEnabled,
        resultsPageMode,
        safeTraceOpacity,
        adaptiveTracePointData,
        upperLimit,
        visibleDroneIdSet,
        visibleDroneStates,
    ]);

    const initialDeckLayersRef = useRef(null);
    if (initialDeckLayersRef.current === null) {
        initialDeckLayersRef.current = deckLayers;
    }

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

        const {
            isOnlineMode,
            initialCenterLatitude,
            initialCenterLongitude,
            initialDisplayedTracePoints,
            initialIsAutoCenterEnabled,
            initialPlumeViewEnabled,
            initialResultsPageMode,
        } = initialMapSetupRef.current || {};
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

        const overlay = new MapboxOverlay({
            interleaved: true,
            layers: initialDeckLayersRef.current,
        });
        mapRef.current = map;
        deckOverlayRef.current = overlay;
        popupRef.current = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 14,
            className: "methane-trace-popup",
        });
        map.addControl(new mapboxgl.NavigationControl(), "top-right");
        map.addControl(overlay);

        map.on("load", () => {
            if (!isOnlineMode && !initialResultsPageMode) {
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
            }

            if (initialResultsPageMode && initialIsAutoCenterEnabled) {
                fitMapToTracePoints(map, initialDisplayedTracePoints, {
                    padding: initialPlumeViewEnabled ? 120 : 20,
                    duration: 0,
                    maxZoom: 18,
                });

                if (initialPlumeViewEnabled) {
                    map.easeTo({
                        pitch: 72,
                        bearing: 34,
                        duration: 0,
                        essential: true,
                    });
                }
            }
            map.resize();
        });

        return () => {
            if (plumeTransitionFrameRef.current) {
                cancelAnimationFrame(plumeTransitionFrameRef.current);
                plumeTransitionFrameRef.current = null;
            }
            if (traceSourceUpdateTimeoutRef.current) {
                window.clearTimeout(traceSourceUpdateTimeoutRef.current);
                traceSourceUpdateTimeoutRef.current = null;
            }
            popupRef.current?.remove();
            popupRef.current = null;
            deckOverlayRef.current = null;
            map.remove();
            mapRef.current = null;
        };
    }, []);

    useEffect(() => {
        deckOverlayRef.current?.setProps({ layers: deckLayers });
    }, [deckLayers]);

    useEffect(() => {
        const currentMap = mapRef.current;
        if (!currentMap) {
            return undefined;
        }

        const syncZoom = () => {
            const nextZoom = Number(currentMap.getZoom());
            if (Number.isFinite(nextZoom)) {
                setMapZoom(nextZoom);
            }
        };

        syncZoom();
        currentMap.on("zoomend", syncZoom);
        return () => {
            currentMap.off("zoomend", syncZoom);
        };
    }, []);

    useEffect(() => {
        const currentMap = mapRef.current;
        if (!currentMap) {
            return;
        }

        if (resultsPageMode) {
            currentMap.easeTo({
                pitch: plumeViewEnabled ? 72 : 0,
                bearing: plumeViewEnabled ? 34 : 0,
                duration: 500,
                essential: true,
            });
        }

        if (mapMode !== "online") {
            return;
        }

        const applyTerrainIfReady = () => {
            const activeMap = mapRef.current;
            if (!activeMap) {
                return true;
            }

            const hasLoadedStyle = activeMap.isStyleLoaded();
            const hasDemSource = Boolean(activeMap.getSource("mapbox-dem"));

            if (!hasLoadedStyle || !hasDemSource) {
                return false;
            }

            activeMap.setTerrain(
                plumeViewEnabled ? { source: "mapbox-dem", exaggeration: 1.35 } : null,
            );
            return true;
        };

        if (applyTerrainIfReady()) {
            return;
        }

        const handleIdle = () => {
            applyTerrainIfReady();
        };

        currentMap.once("idle", handleIdle);
        return () => {
            currentMap.off("idle", handleIdle);
        };
    }, [mapMode, plumeViewEnabled, resultsPageMode]);

    useEffect(() => {
        if (resultsPageMode) {
            return;
        }

        const currentMap = mapRef.current;
        if (!currentMap || !isAutoCenterEnabled) {
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
        focusedDrone,
        isAutoCenterEnabled,
        resultsPageMode,
        visibleDroneStates,
    ]);

    useEffect(() => {
        const currentMap = mapRef.current;
        if (!currentMap || !resultsPageMode) {
            return undefined;
        }

        const syncPlumeModeFromTilt = () => {
            const pitch = currentMap.getPitch();

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

        currentMap.on("move", syncPlumeModeFromTilt);
        return () => {
            currentMap.off("move", syncPlumeModeFromTilt);
        };
    }, [onPlumeViewAutoChange, resultsPageMode]);

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
                    (a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime(),
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
                    (a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime(),
                );
                setDroneStates(normalizedRows);
                setDroneTrackHistory(
                    normalizedRows.reduce((history, row) => {
                        if (Number.isFinite(row.longitude) && Number.isFinite(row.latitude)) {
                            history[row.drone_id] = [[row.longitude, row.latitude]];
                        }

                        return history;
                    }, {}),
                );
            } catch {
                // Ignore transient backend failures; websocket reconnect handles recovery.
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
                    } catch {
                        // Ignore malformed packets.
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
        onScaleChange?.({ lowerLimit, upperLimit });
    }, [lowerLimit, onScaleChange, upperLimit]);

    useEffect(() => {
        onTraceRenderComplete?.();
    }, [adaptiveTracePointData, deckLayers, onTraceRenderComplete]);

    //   return (
    //     <div className={tw.panel} style={{ backgroundColor: color.card, padding: "0.5rem" }}>
    //       <div className="flex h-full w-full flex-col gap-3">
    //         <div className="flex flex-wrap items-center justify-between gap-3">
    //           <div>
    //             <p className="text-xs uppercase tracking-[0.18em]" style={{ color: color.green }}>
    //               Position
    //             </p>
    //             <h3 className="text-xl font-bold tracking-tight" style={{ color: color.text }}>
    //               Drone satellite view
    //             </h3>
    //           </div>
    //           <div
    //             className="rounded-full px-3 py-1 text-xs font-medium"
    //             style={{
    //               backgroundColor: isTelemetryConnected ? color.orangeSoft : color.surface,
    //               color: isTelemetryConnected ? color.orange : color.textMuted,
    //             }}
    //           >
    //             {isTelemetryConnected ? "Live telemetry" : "Waiting telemetry"} • {mapMode}
    //           </div>
    //         </div>

    //         <div className="flex flex-wrap gap-2 rounded-lg border px-3 py-2" style={{ backgroundColor: color.surface, borderColor: color.border }}>
    //           {!resultsPageMode ? (
    //             <>
    //               <button
    //                 type="button"
    //                 onClick={() => setIsAutoCenterEnabled((previous) => !previous)}
    //                 className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                 style={{
    //                   backgroundColor: isAutoCenterEnabled ? `${color.green}22` : color.card,
    //                   borderColor: isAutoCenterEnabled ? color.green : color.border,
    //                   color: isAutoCenterEnabled ? color.text : color.textMuted,
    //                 }}
    //               >
    //                 Auto Center
    //               </button>
    //               <button
    //                 type="button"
    //                 onClick={() => setShowFlightPath((previous) => !previous)}
    //                 className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                 style={{
    //                   backgroundColor: showFlightPath ? `${color.orange}22` : color.card,
    //                   borderColor: showFlightPath ? color.orange : color.border,
    //                   color: showFlightPath ? color.text : color.textMuted,
    //                 }}
    //               >
    //                 Flight Path
    //               </button>
    //               {showTargetSwitch ? (
    //                 <button
    //                   type="button"
    //                   onClick={() => setShowTargetMarkers((previous) => !previous)}
    //                   className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                   style={{
    //                     backgroundColor: showTargetMarkers ? `${(color.yellow || "#facc15")}22` : color.card,
    //                     borderColor: showTargetMarkers ? color.yellow || "#facc15" : color.border,
    //                     color: showTargetMarkers ? color.text : color.textMuted,
    //                   }}
    //                 >
    //                   Target Markers
    //                 </button>
    //               ) : null}
    //             </>
    //           ) : null}

    //           <button
    //             type="button"
    //             onClick={() => onToggleAllPlottedData?.()}
    //             className="rounded-full border px-3 py-1 text-xs font-semibold"
    //             style={{
    //               backgroundColor: showAllPlottedData ? `${color.green}22` : color.card,
    //               borderColor: showAllPlottedData ? color.green : color.border,
    //               color: showAllPlottedData ? color.text : color.textMuted,
    //             }}
    //           >
    //             All Data
    //           </button>

    //           {devices.map((device) => {
    //             const isVisible = showAllPlottedData && droneVisibilityById[device.id] !== false;
    //             const deviceColor = getDroneColor(device.id);
    //             return (
    //               <button
    //                 key={device.id}
    //                 type="button"
    //                 onClick={() => onToggleDroneVisibility?.(device.id)}
    //                 className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                 style={{
    //                   backgroundColor: isVisible ? `${deviceColor}22` : color.card,
    //                   borderColor: isVisible ? deviceColor : color.border,
    //                   color: isVisible ? color.text : color.textMuted,
    //                 }}
    //               >
    //                 {device.name}
    //               </button>
    //             );
    //           })}

    //           <button
    //             type="button"
    //             onClick={() => onToggleMethaneValidity?.("valid")}
    //             className="rounded-full border px-3 py-1 text-xs font-semibold"
    //             style={{
    //               backgroundColor: methaneValidityVisibility.valid ? `${color.green}22` : color.card,
    //               borderColor: methaneValidityVisibility.valid ? color.green : color.border,
    //               color: methaneValidityVisibility.valid ? color.text : color.textMuted,
    //             }}
    //           >
    //             Valid (1)
    //           </button>
    //           <button
    //             type="button"
    //             onClick={() => onToggleMethaneValidity?.("invalid")}
    //             className="rounded-full border px-3 py-1 text-xs font-semibold"
    //             style={{
    //               backgroundColor: methaneValidityVisibility.invalid ? `${color.orange}22` : color.card,
    //               borderColor: methaneValidityVisibility.invalid ? color.orange : color.border,
    //               color: methaneValidityVisibility.invalid ? color.text : color.textMuted,
    //             }}
    //           >
    //             Invalid (2)
    //           </button>
    //           <button
    //             type="button"
    //             onClick={() => onToggleMethaneValidity?.("noData")}
    //             className="rounded-full border px-3 py-1 text-xs font-semibold"
    //             style={{
    //               backgroundColor: methaneValidityVisibility.noData ? `${color.textMuted}22` : color.card,
    //               borderColor: methaneValidityVisibility.noData ? color.textMuted : color.border,
    //               color: methaneValidityVisibility.noData ? color.text : color.textMuted,
    //             }}
    //           >
    //             No Data (0)
    //           </button>

    //           {resultsPageMode ? (
    //             <>
    //               <button
    //                 type="button"
    //                 onClick={() => onToggleHeatmap?.()}
    //                 className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                 style={{
    //                   backgroundColor: heatmapEnabled ? `${color.green}22` : color.card,
    //                   borderColor: heatmapEnabled ? color.green : color.border,
    //                   color: heatmapEnabled ? color.text : color.textMuted,
    //                 }}
    //               >
    //                 Heatmap
    //               </button>
    //               <button
    //                 type="button"
    //                 onClick={() => onTogglePlumeView?.()}
    //                 className="rounded-full border px-3 py-1 text-xs font-semibold"
    //                 style={{
    //                   backgroundColor: plumeViewEnabled ? `${color.orange}22` : color.card,
    //                   borderColor: plumeViewEnabled ? color.orange : color.border,
    //                   color: plumeViewEnabled ? color.text : color.textMuted,
    //                 }}
    //               >
    //                 Plume View
    //               </button>
    //             </>
    //           ) : null}
    //         </div>

    //         <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px]">
    //           <div
    //             ref={mapContainerRef}
    //             className={`w-full rounded-lg ${resultsPageMode ? "min-h-[590px]" : "border min-h-[460px]"}`}
    //             style={resultsPageMode ? undefined : { borderColor: color.border }}
    //           />

    //           <div className="flex flex-col gap-3">
    //             <div className="rounded-lg border p-3" style={{ backgroundColor: color.surface, borderColor: color.border }}>
    //               <div className="text-xs uppercase tracking-[0.12em]" style={{ color: color.textMuted }}>
    //                 Telemetry
    //               </div>
    //               <div className="mt-2 space-y-1 text-sm" style={{ color: color.text }}>
    //                 <div>lat: {displayLatitude.toFixed(4)} deg N</div>
    //                 <div>lon: {Math.abs(displayLongitude).toFixed(4)} deg W</div>
    //                 <div>alt: {displayAltitude.toFixed(1)} m</div>
    //                 <div>drones: {droneStates.length}</div>
    //                 <div>trace points: {tracePointCount}</div>
    //               </div>
    //             </div>

    //             <div className="flex h-full min-w-[100px] items-center gap-3">
    //             <div className="flex h-[292px] items-stretch gap-2">
    //               <div
    //                 className="w-5 rounded-[4px] border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
    //                 style={{
    //                   background: methaneGradient,
    //                   borderColor: color.border,
    //                 }}
    //               />
    //               <div className="flex h-full flex-col justify-between py-[2px]">
    //                 {methaneScale.map((entry) => (
    //                   <div key={entry.id} className="flex items-center gap-1.5">
    //                     <span
    //                       className="block h-px w-2"
    //                       style={{ backgroundColor: color.textMuted }}
    //                     />

    //                     {entry.kind === "upper" ? (
    //                       <input
    //                         type="number"
    //                         step="0.1"
    //                         value={upperLimitInput}
    //                         onChange={(event) =>
    //                           handleLimitChange("upper", event.target.value)
    //                         }
    //                         onBlur={() => commitLimit("upper")}
    //                         className="w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none"
    //                         style={{ borderColor: color.border, color: color.text }}
    //                         aria-label="Upper methane scale limit"
    //                       />
    //                     ) : null}

    //                     {entry.kind === "range" ? (
    //                       <span
    //                         className="text-[10px] font-semibold leading-none"
    //                         style={{ color: color.text }}
    //                       >
    //                         {entry.label}
    //                       </span>
    //                     ) : null}

    //                     {entry.kind === "lower" ? (
    //                       <input
    //                         type="number"
    //                         step="0.1"
    //                         value={lowerLimitInput}
    //                         onChange={(event) =>
    //                           handleLimitChange("lower", event.target.value)
    //                         }
    //                         onBlur={() => commitLimit("lower")}
    //                         className="w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none"
    //                         style={{ borderColor: color.border, color: color.text }}
    //                         aria-label="Lower methane scale limit"
    //                       />
    //                     ) : null}
    //                   </div>
    //                 ))}
    //               </div>
    //             </div>
    //           </div>
    //           </div>
    //         </div>

    //         <div className="flex items-center justify-between text-sm" style={{ color: color.textMuted }}>
    //           <span>Upper/Lower limits update the deck.gl heatmap and point colors.</span>
    //           <span>{methaneScale.map((entry) => entry.label).join(" | ")}</span>
    //         </div>
    //       </div>
    //     </div>
    //   );
    return (
        <div
            className={tw.panel}
            style={{ backgroundColor: color.card, padding: "0.5rem" }}
        >
            <div className="flex h-full w-full flex-col gap-3">
                <div
                    className={`grid grid-cols-1 gap-3 xl:items-start ${resultsPageMode
                        ? "xl:grid-cols-1"
                        : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
                        }`}
                >
                    {!resultsPageMode ? (
                        <div className="flex flex-col gap-3 rounded-lg px-3 py-2"
                        >
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
                                            Flight Path
                                        </span>
                                    </div>

                                    <div
                                        className="flex items-center gap-2 rounded-full border px-2 py-1"
                                        style={{ borderColor: color.border }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => setShowTargetMarkers((previous) => !previous)}
                                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showTargetMarkers ? "bg-yellow-400" : "bg-gray-300"}`}
                                        >
                                            <span
                                                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showTargetMarkers ? "translate-x-5" : "translate-x-0"}`}
                                            />
                                        </button>
                                        <span className="text-sm" style={{ color: color.textMuted }}>
                                            Target Markers
                                        </span>
                                    </div>
                                </div>

                            </div>
                        </div>
                    ) : null}
                    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 mt-5 "
                        style={{ backgroundColor: color.surface, borderColor: color.border }}
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
                                    <span className="text-sm font-semibold" style={{ color: color.text }}>
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
                            </div>
                        ) : null}

                        <div className="flex w-full flex-col gap-2 pt-1">
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
                                            Plume View
                                        </span>
                                    </div>

                                    <div
                                        className="flex items-center gap-2 rounded-full border px-2 py-1"
                                        style={{ borderColor: color.border }}
                                    >
                                        <span className="text-xs" style={{ color: color.textMuted }}>
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
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
                                        <span className="text-sm" style={{ color: color.textMuted }}>
                                            Flight Path
                                        </span>
                                    </div>

                                    <div
                                        className="flex items-center gap-2 rounded-full border px-2 py-1"
                                        style={{ borderColor: color.border }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => setShowTargetMarkers((previous) => !previous)}
                                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none ${showTargetMarkers ? "bg-yellow-400" : "bg-gray-300"}`}
                                        >
                                            <span
                                                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-300 ease-in-out ${showTargetMarkers ? "translate-x-5" : "translate-x-0"}`}
                                            />
                                        </button>
                                        <span className="text-sm" style={{ color: color.textMuted }}>
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
