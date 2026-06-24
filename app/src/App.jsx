import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Messages } from "primereact/messages";
import "primereact/resources/themes/lara-light-indigo/theme.css";
import "primereact/resources/primereact.min.css";
import "primeicons/primeicons.css";
import { tw, color } from "./constants/tailwind";
import { DeviceTabs } from "./components/Tabs";
import { MethanePanel } from "./components/MethanePanel";
import { AerisPanel } from "./components/AerisPanel";
import { WindPanel } from "./components/WindPanel";
import { DataPage } from "./components/DataPage";
import { ResultsPage } from "./components/ResultsPage";
import { MeasurementControls } from "./components/MeasurementControls";
import { MissionModal } from "./components/MissionModal";
import {DeckMap} from "./components/DeckMap";
import { Map } from "./components/Map";
import { buildDeckTracePointsFromFlowData } from "./shared/deckTraceData";
import {
  calculateDistanceMeters,
  extractTelemetryMetrics,
  inferFlowSensorMode,
  SENSOR_MODE_AERIS,
  toFiniteNumber,
} from "./constants/telemetryMetrics";
import logoSvg from "./assets/EERL_logo_black.svg";
import {
  backendHttpUrl,
  backendWsBaseUrl,
  getMeasurementStatus,
  pauseMeasurement,
  resumeMeasurement,
  saveMission,
  syncAndPullData,
  startMeasurement,
  stopMeasurement,
  updateMission,
  waitForBackendReady,
} from "./services/api";
import SignalStatus from "./components/SignalStatus";
import { sampleSignalHistory, sampleSeqHistory } from "./components/signalStatusTestData";
import { Signal } from "lucide-react";
import { COMPort } from "./components/COMPort";

const sensorsMode = [
  { id: "dual", name: "Dual CH4" },
  { id: "aeris", name: "Aeris Box" },
];

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection", features: [] };

const devices = [
  {
    id: "M350",
    name: "M350",
    type: "Drone",
    status: "online",
  },
  {
    id: "M400-1",
    name: "M400-1",
    type: "Drone",
    status: "online",
  },
  {
    id: "M400-2",
    name: "M400-2",
    type: "Drone",
    status: "warning",
  },
  {
    id: "Aeris",
    name: "Aeris Sensor",
    type: "Sensor",
    status: "online",
  },
];

const REQUIRED_FLIGHT_STATUS = 2;

const getTelemetryFlightStatus = (source) =>
  toFiniteNumber(
    source?.flight_status ??
      source?.flightStatus ??
      source?.payload?.flight_status ??
      source?.payload?.flightStatus,
  );

const shouldDisplayTelemetry = (source) => {
  const flightStatus = getTelemetryFlightStatus(source);

  // Keep telemetry visible when flight_status is missing (e.g. simulator payloads).
  if (flightStatus === null) {
    return true;
  }

  return flightStatus === REQUIRED_FLIGHT_STATUS;
};

const METHANE_VALID_VALID = 1;
const METHANE_VALID_INVALID = 2;

const resolveRawMethaneValidity = (source) => {
  const candidates = [
    source?.methane_valid,
    source?.methaneValid,
    source?.payload?.methane_valid,
    source?.payload?.methaneValid,
  ];

  return candidates.find(
    (candidate) => candidate !== undefined && candidate !== null,
  );
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
  const methaneValidity = getTelemetryMethaneValidity(source);

  // Keep points that do not carry methane_valid metadata.
  if (methaneValidity === null) {
    return true;
  }

  if (methaneValidity === METHANE_VALID_VALID) {
    return visibility.valid;
  }

  if (methaneValidity === METHANE_VALID_INVALID) {
    return visibility.invalid;
  }

  // methane_valid=0 represents explicit unknown/no-data quality.
  return visibility.noData;
};

const getTelemetryCoordinate = (source, axis) => {
  if (axis === "latitude") {
    return (
      toFiniteNumber(source?.latitude) ??
      toFiniteNumber(source?.position?.latitude) ??
      toFiniteNumber(source?.position?.lat) ??
      null
    );
  }

  if (axis === "longitude") {
    return (
      toFiniteNumber(source?.longitude) ??
      toFiniteNumber(source?.position?.longitude) ??
      toFiniteNumber(source?.position?.lon) ??
      toFiniteNumber(source?.position?.lng) ??
      null
    );
  }

  return (
    toFiniteNumber(source?.altitude) ??
    toFiniteNumber(source?.position?.altitude) ??
    toFiniteNumber(source?.position?.alt) ??
    0
  );
};

const getTelemetryWindComponent = (payload, axis) => {
  // Try wind_u/v/w, wind_x/y/z, and wind_direction.x/y/z
  if (axis === "x" || axis === "u") {
    return (
      toFiniteNumber(payload?.wind_u) ??
      toFiniteNumber(payload?.wind_x) ??
      toFiniteNumber(payload?.wind_direction?.x) ??
      toFiniteNumber(payload?.wind_direction?.u) ??
      0
    );
  }
  if (axis === "y" || axis === "v") {
    return (
      toFiniteNumber(payload?.wind_v) ??
      toFiniteNumber(payload?.wind_y) ??
      toFiniteNumber(payload?.wind_direction?.y) ??
      toFiniteNumber(payload?.wind_direction?.v) ??
      0
    );
  }
  if (axis === "z" || axis === "w") {
    return (
      toFiniteNumber(payload?.wind_w) ??
      toFiniteNumber(payload?.wind_z) ??
      toFiniteNumber(payload?.wind_direction?.z) ??
      toFiniteNumber(payload?.wind_direction?.w) ??
      0
    );
  }
  return 0;
};

const buildFlowDataFromHistory = (historyRows) => {
  const sortedRows = [...historyRows].sort(
    (a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime(),
  );

  return sortedRows.filter(shouldDisplayTelemetry).map((row, index) => {
    const payload = row.payload || {};
    const metrics = extractTelemetryMetrics({
      ...row,
      payload,
    });
    const timestampMs = new Date(row.ts || Date.now()).getTime();

    return {
      droneId: row.drone_id || row.droneId || null,
      sampleOrder: index,
      sampleIndex: index + 1,
      timestampMs,
      timestampIso: row.ts,
      time: new Date(timestampMs).toLocaleTimeString(),
      sensorMode: metrics.sensorMode,
      sniffer: metrics.sniffer,
      purway: metrics.purway,
      methane: metrics.methane,
      acetylene: metrics.acetylene,
      nitrousOxide: metrics.nitrousOxide,
      altitude: getTelemetryCoordinate(row, "altitude"),
      latitude: getTelemetryCoordinate(row, "latitude"),
      longitude: getTelemetryCoordinate(row, "longitude"),
      wind_u: getTelemetryWindComponent(payload, "x"),
      wind_v: getTelemetryWindComponent(payload, "y"),
      wind_w: getTelemetryWindComponent(payload, "z"),
      distance: row.distance ?? null,
      methane_valid: getTelemetryMethaneValidity({ ...row, payload }),
      payload,
    };
  });
};

const buildFlowPointFromTelemetry = (telemetryRow, sampleOrder) => {
  const payload = telemetryRow.payload || {};
  const metrics = extractTelemetryMetrics({
    ...telemetryRow,
    payload,
  });
  const timestampMs = new Date(telemetryRow.ts || Date.now()).getTime();

  return {
    droneId: telemetryRow.drone_id || telemetryRow.droneId || null,
    sampleOrder,
    sampleIndex: sampleOrder + 1,
    timestampMs,
    timestampIso: telemetryRow.ts,
    time: new Date(timestampMs).toLocaleTimeString(),
    sensorMode: metrics.sensorMode,
    sniffer: metrics.sniffer,
    purway: metrics.purway,
    methane: metrics.methane,
    acetylene: metrics.acetylene,
    nitrousOxide: metrics.nitrousOxide,
    altitude: getTelemetryCoordinate(telemetryRow, "altitude"),
    latitude: getTelemetryCoordinate(telemetryRow, "latitude"),
    longitude: getTelemetryCoordinate(telemetryRow, "longitude"),
    wind_u: getTelemetryWindComponent(payload, "x"),
    wind_v: getTelemetryWindComponent(payload, "y"),
    wind_w: getTelemetryWindComponent(payload, "z"),
    distance: telemetryRow.distance ?? null,
    methane_valid: getTelemetryMethaneValidity({ ...telemetryRow, payload }),
    payload,
  };
};

// const appendFlowPoints = (series, telemetryRows, options = {}) => {
//   const existingSeries = series || [];
//   const rows = Array.isArray(telemetryRows) ? telemetryRows : [];
//   const maxPoints = Number.isFinite(options.maxPoints)
//     ? Math.max(0, options.maxPoints)
//     : null;

//   if (rows.length === 0) {
//     return existingSeries;
//   }

//   let changed = false;
//   let nextSeries = existingSeries;

//   const insertAtTimestamp = (nextTimestampMs, telemetryRow) => {
//     let low = 0;
//     let high = nextSeries.length;

//     while (low < high) {
//       const midpoint = Math.floor((low + high) / 2);
//       if (nextSeries[midpoint].timestampMs <= nextTimestampMs) {
//         low = midpoint + 1;
//       } else {
//         high = midpoint;
//       }
//     }

//     const insertionIndex = low;
//     nextSeries.splice(
//       insertionIndex,
//       0,
//       buildFlowPointFromTelemetry(telemetryRow, insertionIndex),
//     );

//     for (let index = insertionIndex + 1; index < nextSeries.length; index += 1) {
//       const point = nextSeries[index];
//       nextSeries[index] = {
//         ...point,
//         sampleOrder: index,
//         sampleIndex: index + 1,
//       };
//     }
//   };

//   rows.forEach((telemetryRow) => {
//     if (!shouldDisplayTelemetry(telemetryRow)) {
//       return;
//     }

//     if (!changed) {
//       nextSeries = existingSeries.slice();
//       changed = true;
//     }

//     const nextTimestampMs = new Date(telemetryRow.ts || Date.now()).getTime();
//     const lastPoint = nextSeries[nextSeries.length - 1] || null;

//     if (!lastPoint || nextTimestampMs >= lastPoint.timestampMs) {
//       nextSeries.push(buildFlowPointFromTelemetry(telemetryRow, nextSeries.length));
//       return;
//     }

//     insertAtTimestamp(nextTimestampMs, telemetryRow);
//   });

//   if (!changed) {
//     return existingSeries;
//   }

//   if (maxPoints !== null && nextSeries.length > maxPoints) {
//     nextSeries = nextSeries.slice(nextSeries.length - maxPoints).map((point, index) => ({
//       ...point,
//       sampleOrder: index,
//       sampleIndex: index + 1,
//     }));
//   }

//   return nextSeries;
// };

// Appends a batch of raw telemetry rows to an existing flow series.
// Sorts and trims once per batch instead of once per packet to avoid
// O(batch_size × series_length) allocations per flush cycle.
const appendFlowPoints = (series, telemetryRows, { maxPoints = null } = {}) => {
  const existingSeries = series || [];
  const rows = Array.isArray(telemetryRows) ? telemetryRows : [telemetryRows];

  if (rows.length === 0) {
    return existingSeries;
  }

  const newPoints = rows
    .filter(shouldDisplayTelemetry)
    .map((row) => buildFlowPointFromTelemetry(row, 0));

  if (newPoints.length === 0) {
    return existingSeries;
  }

  const sortedNewPoints = newPoints
    .slice()
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const lastExistingPoint = existingSeries[existingSeries.length - 1] || null;
  const canFastAppend =
    !lastExistingPoint ||
    sortedNewPoints[0].timestampMs >= Number(lastExistingPoint.timestampMs || 0);

  if (canFastAppend) {
    const rebasedNewPoints = sortedNewPoints.map((point, index) => ({
      ...point,
      sampleOrder: existingSeries.length + index,
      sampleIndex: existingSeries.length + index + 1,
    }));
    const appended = existingSeries.concat(rebasedNewPoints);

    if (maxPoints !== null && appended.length > maxPoints) {
      const trimmed = appended.slice(appended.length - maxPoints);
      return trimmed.map((point, index) => ({
        ...point,
        sampleOrder: index,
        sampleIndex: index + 1,
      }));
    }

    return appended;
  }

  const merged = existingSeries.concat(sortedNewPoints);
  const sorted = merged.sort((a, b) => a.timestampMs - b.timestampMs);
  const trimmed = maxPoints !== null && sorted.length > maxPoints
    ? sorted.slice(sorted.length - maxPoints)
    : sorted;

  return trimmed.map((point, index) => ({
    ...point,
    sampleOrder: index,
    sampleIndex: index + 1,
  }));
};

const buildCombinedFlowDataForDrones = ({
  devices,
  measurementTraceByDrone,
  liveTelemetryByDrone,
  recordedFlowDataByDrone,
  visibleDroneIds,
  maxTotalPoints = null,
}) => {
  const visibleIdSet = new Set(
    (Array.isArray(visibleDroneIds) ? visibleDroneIds : [])
      .map((droneId) => String(droneId || "").trim())
      .filter(Boolean),
  );

  const visibleDevices = devices.filter((device) => visibleIdSet.has(device.id));
  if (!visibleDevices.length) {
    return [];
  }

  const maxPointsPerDrone = Number.isFinite(maxTotalPoints)
    ? Math.max(1, Math.floor(maxTotalPoints / visibleDevices.length))
    : null;

  const combined = [];

  visibleDevices.forEach((device) => {
    const measurementSeries = measurementTraceByDrone[device.id] || [];
    const liveSeries = liveTelemetryByDrone[device.id] || [];
    const recordedSeries = recordedFlowDataByDrone[device.id] || [];
    const activeSeries = measurementSeries.length
      ? measurementSeries
      : liveSeries.length
        ? liveSeries
        : recordedSeries;

    if (!activeSeries.length) {
      return;
    }

    const startIndex =
      maxPointsPerDrone !== null && activeSeries.length > maxPointsPerDrone
        ? activeSeries.length - maxPointsPerDrone
        : 0;

    for (let index = startIndex; index < activeSeries.length; index += 1) {
      const point = activeSeries[index];
      if (!point) {
        continue;
      }

      if (!point.droneId) {
        combined.push({
          ...point,
          droneId: device.id,
        });
        continue;
      }

      combined.push(point);
    }
  });

  return combined;
};

const getDashboardFlowSelectionValue = (point) => {
  const purway = Number(point?.purway);
  if (Number.isFinite(purway)) {
    return purway;
  }

  const methane = Number(point?.methane);
  if (Number.isFinite(methane)) {
    return methane;
  }

  return null;
};

const HOLD_DELAY = 2000;
const MOVEMENT_THRESHOLD_METERS = 1.5;
const START_MISSION_PROMPT_COOLDOWN_MS = 45000;
const START_MISSION_PROMPT_SNOOZE_AFTER_SAVE_MS = 120000;
const TELEMETRY_FLUSH_INTERVAL_MS = 10000;
const LIVE_TELEMETRY_RENDER_LIMIT = 100000;
const MEASUREMENT_TRACE_STORAGE_LIMIT = 120000;
const DASHBOARD_MAP_SOURCE_POINT_LIMIT = 100000;
const DASHBOARD_START_POINT_FILTER_DEFAULT_RADIUS_METERS = 25;

const toDashboardMapTracePoint = (point) => ({
  id: point.id,
  droneId: point.droneId,
  sampleOrder: point.sampleOrder,
  sampleIndex: point.sampleIndex,
  timestampMs: point.timestampMs,
  timestampIso: point.timestampIso,
  timeLabel: point.timeLabel,
  altitude: point.altitude,
  methane: point.methane,
  methaneValid: point.methaneValid,
  displayMetricLabel: point.displayMetricLabel,
  displayMetricUnits: point.displayMetricUnits,
  sniffer: point.sniffer,
  purway: point.purway,
  ch4: point.ch4,
  acetylene: point.acetylene,
  nitrousOxide: point.nitrousOxide,
  sensorMode: point.sensorMode,
  sourceLatitude: point.sourceLatitude,
  sourceLongitude: point.sourceLongitude,
  targetLatitude: point.targetLatitude,
  targetLongitude: point.targetLongitude,
  mapCoordinates: point.mapCoordinates,
  detected: point.detected,
  pointColor: point.pointColor,
  latitude: point.latitude,
  longitude: point.longitude,
});

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

function App() {
  const [currentView, setCurrentView] = useState("dashboard");
  const currentViewRef = useRef(currentView);
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0].id);
  const [measurementStatus, setMeasurementStatus] = useState("idle");
  const [measurementElapsedSeconds, setMeasurementElapsedSeconds] = useState(0);
  const [measurementBusy, setMeasurementBusy] = useState(false);
  const [continuingMission, setContinuingMission] = useState(null);
  const [recordedFlowDataByDrone, setRecordedFlowDataByDrone] = useState({});
  const [measurementTraceByDrone, setMeasurementTraceByDrone] = useState({});
  const [liveTelemetryByDrone, setLiveTelemetryByDrone] = useState({});
  const measurementStatusRef = useRef(measurementStatus);
  const telemetrySourceByDroneRef = useRef({});
  const lastKnownPositionByDroneRef = useRef({});
  const lastMissionPromptAtRef = useRef(0);
  const missionPromptSnoozeUntilRef = useRef(0);
  const msgs = useRef(null);

  const [isMissionModalOpen, setIsMissionModalOpen] = useState(false);
  const [missionName, setMissionName] = useState("");
  const [deleteHoldProgress, setDeleteHoldProgress] = useState(0);
  const deleteHoldRafRef = useRef(null);

  const [TELEMETRY_SOURCE, setTelemetrySource] = useState("MQTT");
  const [showDashboardPlotData, setShowDashboardPlotData] = useState(true);
  const [methaneValidityVisibility, setMethaneValidityVisibility] = useState({
    valid: true,
    invalid: true,
    noData: false,
  });
  const [dashboardDroneVisibility, setDashboardDroneVisibility] = useState(() =>
    devices.reduce((accumulator, device) => {
      accumulator[device.id] = true;
      return accumulator;
    }, {}),
  );
  const [plumeViewEnabled, setPlumeViewEnabled] = useState(false);
  const [startPointFilterEnabled, setStartPointFilterEnabled] = useState(false);
  const [startPointFilterRadiusMeters, setStartPointFilterRadiusMeters] =
    useState(DASHBOARD_START_POINT_FILTER_DEFAULT_RADIUS_METERS);
  const [startPointPickModeEnabled, setStartPointPickModeEnabled] =
    useState(false);
  const [startPointCoordinates, setStartPointCoordinates] = useState(null);
  const liveFlowData = useMemo(() => {
    const selectedDroneData = liveTelemetryByDrone[selectedDeviceId];
    if (Array.isArray(selectedDroneData) && selectedDroneData.length > 0) {
      return selectedDroneData;
    }

    const selectedRecordedData = recordedFlowDataByDrone[selectedDeviceId];
    if (
      Array.isArray(selectedRecordedData) &&
      selectedRecordedData.length > 0
    ) {
      return selectedRecordedData;
    }

    return []; // flowChartData;
  }, [liveTelemetryByDrone, recordedFlowDataByDrone, selectedDeviceId]);

  const filteredLiveFlowData = useMemo(
    () =>
      liveFlowData.filter((point) =>
        shouldIncludeMethaneValidity(point, methaneValidityVisibility),
      ),
    [liveFlowData, methaneValidityVisibility],
  );
  const dashboardChartFlowData = useMemo(
    () => filteredLiveFlowData,
    [filteredLiveFlowData],
  );
  const [selectedWindow, setSelectedWindow] = useState({
    startIndex: 0,
    endIndex: 1,
    ppmMin: 0,
    ppmMax: 1,
  });
  const selectedWindowForDashboard = useMemo(() => {
    const dataLength = dashboardChartFlowData.length;
    const maxPpm = Math.max(
      1,
      ...dashboardChartFlowData.map(
        (point) => getDashboardFlowSelectionValue(point) ?? 0,
      ),
    );
    const minimumPpmBand = Math.min(Math.max(maxPpm * 0.02, 0.1), maxPpm);

    if (dataLength <= 1) {
      return {
        startIndex: 0,
        endIndex: 1,
        ppmMin: 0,
        ppmMax: maxPpm,
      };
    }

    const safeStart = Math.max(0, Math.min(selectedWindow.startIndex ?? 0, dataLength - 2));
    const safeEnd = Math.max(
      safeStart + 1,
      Math.min(selectedWindow.endIndex ?? dataLength - 1, dataLength - 1),
    );
    const safePpmMin = Math.max(
      0,
      Math.min(selectedWindow.ppmMin ?? 0, maxPpm - minimumPpmBand),
    );
    const safePpmMax = Math.max(
      safePpmMin + minimumPpmBand,
      Math.min(selectedWindow.ppmMax ?? maxPpm, maxPpm),
    );

    return {
      startIndex: safeStart,
      endIndex: safeEnd,
      ppmMin: safePpmMin,
      ppmMax: safePpmMax,
    };
  }, [dashboardChartFlowData, selectedWindow]);
  const dashboardSelectedWindowFlowData = useMemo(
    () =>
      dashboardChartFlowData.slice(
        selectedWindowForDashboard.startIndex,
        selectedWindowForDashboard.endIndex + 1,
      ),
    [dashboardChartFlowData, selectedWindowForDashboard],
  );
  const dashboardSelectedTimeRange = useMemo(() => {
    const windowStart = dashboardSelectedWindowFlowData[0] ?? null;
    const windowEnd =
      dashboardSelectedWindowFlowData[dashboardSelectedWindowFlowData.length - 1] ??
      null;
    const startTimestampMs = Number(windowStart?.timestampMs);
    const endTimestampMs = Number(windowEnd?.timestampMs);

    if (!Number.isFinite(startTimestampMs) || !Number.isFinite(endTimestampMs)) {
      return null;
    }

    return {
      startTimestampMs: Math.min(startTimestampMs, endTimestampMs),
      endTimestampMs: Math.max(startTimestampMs, endTimestampMs),
    };
  }, [dashboardSelectedWindowFlowData]);
  const windSamples = useMemo(
    () => dashboardChartFlowData,
    [dashboardChartFlowData],
  );

  useEffect(() => {
    let isCancelled = false;

    const loadHistoryForDrone = async (droneId) => {
      try {
        console.log(
          `[App] Loading history for ${droneId} from ${backendHttpUrl}/api/drones/${droneId}/history`,
        );
        const response = await fetch(
          `${backendHttpUrl}/api/drones/${droneId}/history?limit=1000`,
        );
        if (!response.ok) {
          console.warn(
            `[App] History fetch failed for ${droneId}: ${response.status} ${response.statusText}`,
          );
          return;
        }

        const payload = await response.json();
        console.log(
          `[App] Got history for ${droneId}:`,
          payload.data?.length ?? 0,
          "rows",
        );
        if (
          isCancelled ||
          !Array.isArray(payload?.data) ||
          payload.data.length === 0
        ) {
          console.warn(
            `[App] No data for ${droneId} (cancelled=${isCancelled})`,
          );
          return;
        }

        const flowData = buildFlowDataFromHistory(payload.data);
        console.log(
          `[App] Built flow data for ${droneId}:`,
          flowData.length,
          "samples",
        );
        setRecordedFlowDataByDrone((previous) => ({
          ...previous,
          [droneId]: flowData,
        }));
      } catch (error) {
        console.error(`[App] History fetch error for ${droneId}:`, error);
      }
    };

    void (async () => {
      const isBackendReady = await waitForBackendReady();
      if (!isBackendReady || isCancelled) {
        return;
      }

      devices.forEach((device) => {
        loadHistoryForDrone(device.id);
      });
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    let telemetryWorker;
    let flushTimer;
    const queuedTelemetryByDrone = new globalThis.Map();

    const flushQueuedTelemetry = () => {
      flushTimer = null;

      if (queuedTelemetryByDrone.size === 0) {
        return;
      }

      const queuedEntries = Array.from(queuedTelemetryByDrone.entries());
      queuedTelemetryByDrone.clear();

      setLiveTelemetryByDrone((previous) => {
        let changed = false;
        const next = { ...previous };

        queuedEntries.forEach(([droneId, telemetryRows]) => {
          const currentSeries = previous[droneId] || [];
          const updatedSeries = appendFlowPoints(currentSeries, telemetryRows, {
            maxPoints: LIVE_TELEMETRY_RENDER_LIMIT,
          });

          if (updatedSeries !== currentSeries) {
            next[droneId] = updatedSeries;
            changed = true;
          }
        });

        return changed ? next : previous;
      });

      if (measurementStatusRef.current === "running") {
        setMeasurementTraceByDrone((previous) => {
          let changed = false;
          const next = { ...previous };

          queuedEntries.forEach(([droneId, telemetryRows]) => {
            const currentSeries = previous[droneId] || [];
            const updatedSeries = appendFlowPoints(currentSeries, telemetryRows, {
              maxPoints: MEASUREMENT_TRACE_STORAGE_LIMIT,
            });

            if (updatedSeries !== currentSeries) {
              next[droneId] = updatedSeries;
              changed = true;
            }
          });

          return changed ? next : previous;
        });
      }
    };

    const enqueueTelemetry = (droneId, telemetryRow) => {
      const existingRows = queuedTelemetryByDrone.get(droneId) || [];
      existingRows.push(telemetryRow);
      queuedTelemetryByDrone.set(droneId, existingRows);

      if (!flushTimer) {
        flushTimer = window.setTimeout(
          flushQueuedTelemetry,
          TELEMETRY_FLUSH_INTERVAL_MS,
        );
      }
    };

    void waitForBackendReady().then((isBackendReady) => {
      if (isBackendReady) {
        telemetryWorker = new Worker(
          new URL("./workers/telemetryStreamWorker.js", import.meta.url),
          { type: "module" },
        );

        telemetryWorker.onmessage = (workerEvent) => {
          const payload = workerEvent.data || {};
          if (payload.type !== "telemetry-batch") {
            return;
          }

          const packets = Array.isArray(payload.packets) ? payload.packets : [];
          if (packets.length === 0 || currentViewRef.current !== "dashboard") {
            return;
          }

          packets.forEach((packet) => {
            const packetDataForSeries = packet?.telemetry;

            if (!packetDataForSeries?.droneId && !packetDataForSeries?.drone_id) {
              return;
            }

            const droneId = packetDataForSeries.drone_id || packetDataForSeries.droneId;
            const source =
              packet?.source === "UDP"
                ? "UDP"
                : packet?.source === "MQTT"
                  ? "MQTT"
                  : packet?.source === "USB-serial"
                    ? "USB-serial"
                    : null;

            if (source) {
              const previousSource = telemetrySourceByDroneRef.current[droneId];
              if (previousSource && previousSource != source) {
                msgs.current?.clear();
                msgs.current?.show({
                  life: 3000,
                  severity: "info",
                  summary: "Data Source Changed",
                  detail: `${droneId} switched from ${previousSource} to ${source}.`,
                  closable: true,
                });
              }

              telemetrySourceByDroneRef.current[droneId] = source;
              if (previousSource !== source) {
                setTelemetrySource(source);
              }
            }

            enqueueTelemetry(droneId, packetDataForSeries);

            const latitude = Number(packetDataForSeries.latitude);
            const longitude = Number(packetDataForSeries.longitude);
            const previousPosition =
              lastKnownPositionByDroneRef.current[droneId];
            const hasValidPosition =
              Number.isFinite(latitude) && Number.isFinite(longitude);
            let isDroneMoving = false;

            if (
              hasValidPosition &&
              previousPosition &&
              Number.isFinite(previousPosition.latitude) &&
              Number.isFinite(previousPosition.longitude)
            ) {
              const distanceMovedMeters = calculateDistanceMeters(
                previousPosition.latitude,
                previousPosition.longitude,
                latitude,
                longitude,
              );
              isDroneMoving = distanceMovedMeters > MOVEMENT_THRESHOLD_METERS;
            }

            if (hasValidPosition) {
              lastKnownPositionByDroneRef.current[droneId] = {
                latitude,
                longitude,
              };
            }

            if (measurementStatusRef.current === "idle" && isDroneMoving) {
              const now = Date.now();
              if (now < missionPromptSnoozeUntilRef.current) {
                return;
              }

              if (
                now - lastMissionPromptAtRef.current >=
                START_MISSION_PROMPT_COOLDOWN_MS
              ) {
                lastMissionPromptAtRef.current = now;
                msgs.current?.show({
                  life: 4500,
                  severity: "warn",
                  summary: "Drone Movement Detected",
                  detail:
                    "Drone is moving while mission is idle. Start Mission to create a mission-specific recording while all telemetry continues to be stored in history.",
                  closable: true,
                });
              }
            }
          });
        };

        telemetryWorker.postMessage({
          type: "start",
          wsUrl: `${backendWsBaseUrl}/ws/telemetry?format=binary`,
        });
      }
    });

    return () => {
      if (flushTimer) {
        window.clearTimeout(flushTimer);
      }

      flushQueuedTelemetry();

      if (telemetryWorker) {
        telemetryWorker.postMessage({ type: "stop" });
        telemetryWorker.terminate();
        telemetryWorker = null;
      }
    };
  }, []);

  const visibleDashboardDroneIds = useMemo(() => {
    if (!showDashboardPlotData) {
      return [];
    }

    return devices
      .filter((device) => dashboardDroneVisibility[device.id] !== false)
      .map((device) => device.id);
  }, [dashboardDroneVisibility, showDashboardPlotData]);
  const dashboardMapTracePointsImmediate = useMemo(
    () => {
      if (currentView !== "dashboard") {
        return [];
      }

      const combinedFlowData = buildCombinedFlowDataForDrones({
        devices,
        measurementTraceByDrone,
        liveTelemetryByDrone,
        recordedFlowDataByDrone,
        visibleDroneIds: visibleDashboardDroneIds,
        maxTotalPoints: DASHBOARD_MAP_SOURCE_POINT_LIMIT,
      });
      const methaneFilteredFlowData = combinedFlowData.filter((point) =>
        shouldIncludeMethaneValidity(point, methaneValidityVisibility),
      );
      const baseMapFlowData = methaneFilteredFlowData.length
        ? methaneFilteredFlowData
        : combinedFlowData;
      const mapFlowData = baseMapFlowData.filter((point) => {
        const selectionValue = getDashboardFlowSelectionValue(point);
        if (
          selectionValue === null ||
          selectionValue < selectedWindowForDashboard.ppmMin ||
          selectionValue > selectedWindowForDashboard.ppmMax
        ) {
          return false;
        }

        if (!dashboardSelectedTimeRange) {
          return true;
        }

        const timestampMs = Number(point?.timestampMs);
        return (
          Number.isFinite(timestampMs) &&
          timestampMs >= dashboardSelectedTimeRange.startTimestampMs &&
          timestampMs <= dashboardSelectedTimeRange.endTimestampMs
        );
      });

      return buildDeckTracePointsFromFlowData(
        filterFlowPointsOutsideStartRadius(mapFlowData, {
          enabled: startPointFilterEnabled,
          startPoint: startPointCoordinates,
          radiusMeters: startPointFilterRadiusMeters,
        }),
      ).map(toDashboardMapTracePoint);
    },
    [
      currentView,
      measurementTraceByDrone,
      liveTelemetryByDrone,
      recordedFlowDataByDrone,
      visibleDashboardDroneIds,
      selectedWindowForDashboard,
      dashboardSelectedTimeRange,
      methaneValidityVisibility,
      startPointCoordinates,
      startPointFilterEnabled,
      startPointFilterRadiusMeters,
    ],
  );

  const dashboardMapTracePoints = useDeferredValue(
    dashboardMapTracePointsImmediate,
  );

  

  const latestPointByDrone = useMemo(() => {
    const entries = {};

    devices.forEach((device) => {
      const liveSeries = liveTelemetryByDrone[device.id] || [];
      const recordedSeries = recordedFlowDataByDrone[device.id] || [];
      const filteredLiveSeries = liveSeries.filter((point) =>
        shouldIncludeMethaneValidity(point, methaneValidityVisibility),
      );
      const filteredRecordedSeries = recordedSeries.filter((point) =>
        shouldIncludeMethaneValidity(point, methaneValidityVisibility),
      );
      const activeSeries =
        filteredLiveSeries.length > 0
          ? filteredLiveSeries
          : filteredRecordedSeries;
      entries[device.id] = activeSeries.length
        ? activeSeries[activeSeries.length - 1]
        : null;
    });

    return entries;
  }, [
    liveTelemetryByDrone,
    recordedFlowDataByDrone,
    methaneValidityVisibility,
  ]);

  const reloadHistory = useCallback(
    async (droneId) => {
      try {
        const response = await fetch(
          `${backendHttpUrl}/api/drones/${droneId}/history?limit=1000`,
        );
        if (!response.ok) return false;

        const payload = await response.json();
        if (!Array.isArray(payload?.data) || payload.data.length === 0)
          return false;

        const flowData = buildFlowDataFromHistory(payload.data);
        const previousFlowData = recordedFlowDataByDrone[droneId] || [];
        const previousLastPoint =
          previousFlowData[previousFlowData.length - 1] || null;
        const nextLastPoint = flowData[flowData.length - 1] || null;
        const hasChanged =
          previousFlowData.length !== flowData.length ||
          previousLastPoint?.timestampIso !== nextLastPoint?.timestampIso ||
          previousLastPoint?.distance !== nextLastPoint?.distance ||
          previousLastPoint?.methane !== nextLastPoint?.methane;

        if (hasChanged) {
          setRecordedFlowDataByDrone((previous) => ({
            ...previous,
            [droneId]: flowData,
          }));
        }

        return hasChanged;
      } catch {
        return false;
      }
    },
    [recordedFlowDataByDrone],
  );

  const reloadAllHistory = useCallback(async () => {
    await syncAndPullData();

    const refreshResults = await Promise.all(
      devices.map((device) => reloadHistory(device.id)),
    );

    return refreshResults.some(Boolean);
  }, [reloadHistory]);

  const activeDevice =
    devices.find((device) => device.id === selectedDeviceId) || devices[0];
  const activePoint = latestPointByDrone[selectedDeviceId] || null;
  const detectedSensorModeByDrone = useMemo(() => {
    return devices.reduce((accumulator, device) => {
      const liveSeries = liveTelemetryByDrone[device.id] || [];
      const recordedSeries = recordedFlowDataByDrone[device.id] || [];
      const combinedSeries =
        liveSeries.length > 0 ? liveSeries : recordedSeries;
      accumulator[device.id] = inferFlowSensorMode(combinedSeries);
      return accumulator;
    }, {});
  }, [liveTelemetryByDrone, recordedFlowDataByDrone]);
  const activeSensorMode = useMemo(() => {
    return (
      detectedSensorModeByDrone[selectedDeviceId] ||
      inferFlowSensorMode(filteredLiveFlowData)
    );
  }, [detectedSensorModeByDrone, filteredLiveFlowData, selectedDeviceId]);

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
        // Keep at least one methane_valid category visible.
        next[key] = true;
      }

      return next;
    });
  }, []);
  const handleToggleDashboardDroneVisibility = useCallback((droneId) => {
    setDashboardDroneVisibility((previous) => ({
      ...previous,
      [droneId]: previous[droneId] === false,
    }));
  }, []);
  const missionDroneIds = useMemo(
    () =>
      Object.keys(measurementTraceByDrone).filter(
        (droneId) => (measurementTraceByDrone[droneId] || []).length > 0,
      ),
    [measurementTraceByDrone],
  );

  useEffect(() => {
    measurementStatusRef.current = measurementStatus;
  }, [measurementStatus]);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    let cancelled = false;

    const syncMeasurementStatus = async () => {
      const status = await getMeasurementStatus();
      if (!status || cancelled) {
        return;
      }

      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
    };

    void syncMeasurementStatus();
    const intervalId = window.setInterval(() => {
      void syncMeasurementStatus();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const handleStartMeasurement = async () => {
    if (measurementStatusRef.current !== "idle") {
      return;
    }

    setMeasurementBusy(true);
    const status = await startMeasurement();

    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
      setMeasurementTraceByDrone({});
      setContinuingMission(null);
      setCurrentView("dashboard");
      msgs.current?.clear();
      msgs.current?.show({
        life: 2500,
        severity: "success",
        summary: "Mission Started",
        detail: "Measurement recording is now active.",
        closable: true,
      });
    } else {
      msgs.current?.clear();
      msgs.current?.show({
        life: 3500,
        severity: "error",
        summary: "Start Failed",
        detail: "Could not start measurement. Please try again.",
        closable: true,
      });
    }

    setMeasurementBusy(false);
  };

  const handlePauseMeasurement = async () => {
    if (measurementStatusRef.current !== "running") {
      return;
    }

    setMeasurementBusy(true);
    const status = await pauseMeasurement();

    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
    }

    setMeasurementBusy(false);
  };

  const handleResumeMeasurement = async () => {
    if (measurementStatusRef.current !== "paused") {
      return;
    }

    setMeasurementBusy(true);
    const status = await resumeMeasurement();

    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
    }

    setMeasurementBusy(false);
  };

  const handleDiscardMeasurement = async () => {
    setMeasurementBusy(true);
    const status = await stopMeasurement();
    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
    }
    setMeasurementTraceByDrone({});
    setMissionName("");
    setContinuingMission(null);
    setMeasurementBusy(false);
  };

  const handleContinueMission = async (mission) => {
    if (!mission?.id) {
      return;
    }

    if (measurementStatusRef.current !== "idle") {
      msgs.current?.clear();
      msgs.current?.show({
        life: 3500,
        severity: "warn",
        summary: "Measurement Active",
        detail: "Stop the current measurement before continuing another mission.",
        closable: true,
      });
      return;
    }

    setMeasurementBusy(true);
    setMeasurementTraceByDrone({});
    setMissionName(mission.name || "");
    setContinuingMission({
      id: mission.id,
      name: mission.name || "Untitled Mission",
    });

    const status = await startMeasurement();

    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
      setCurrentView("dashboard");
      msgs.current?.clear();
      msgs.current?.show({
        life: 3000,
        severity: "success",
        summary: "Continuing Mission",
        detail: `Recording resumed into ${mission.name || "Untitled Mission"}.`,
        closable: true,
      });
    } else {
      setContinuingMission(null);
      msgs.current?.clear();
      msgs.current?.show({
        life: 3500,
        severity: "error",
        summary: "Continue Failed",
        detail: "Could not start measurement to continue this mission.",
        closable: true,
      });
    }

    setMeasurementBusy(false);
  };

  const startDeleteHold = () => {
    const startTime = Date.now();
    const tick = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(100, (elapsed / HOLD_DELAY) * 100);
      setDeleteHoldProgress(progress);
      if (progress < 100) {
        deleteHoldRafRef.current = requestAnimationFrame(tick);
      } else {
        deleteHoldRafRef.current = null;
        setDeleteHoldProgress(0);
        void handleDiscardMeasurement();
        setIsMissionModalOpen(false);
      }
    };
    deleteHoldRafRef.current = requestAnimationFrame(tick);
  };

  const cancelDeleteHold = () => {
    if (deleteHoldRafRef.current) {
      cancelAnimationFrame(deleteHoldRafRef.current);
      deleteHoldRafRef.current = null;
    }
    setDeleteHoldProgress(0);
  };

  const handleSaveMeasurement = async () => {
    setMeasurementBusy(true);

    const missionResults = devices
      .map((device) => ({
        drone: device.id,
        data: measurementTraceByDrone[device.id] || [],
      }))
      .filter((entry) => Array.isArray(entry.data) && entry.data.length > 0);

    if (missionResults.length === 0) {
      msgs.current?.clear();
      msgs.current?.show({
        life: 3500,
        severity: "warn",
        summary: "No Mission Data",
        detail: "No telemetry was captured for any drone during this mission.",
        closable: true,
      });
      setMeasurementBusy(false);
      return;
    }

    const missionPayload = continuingMission
      ? {
        results: missionResults,
      }
      : {
        id: `mission-${Date.now()}`,
        name: missionName.trim() || `Mission ${new Date().toLocaleString()}`,
        createdAt: new Date().toISOString(),
        elapsedSeconds: measurementElapsedSeconds,
        results: missionResults,
      };

    const savedMission = continuingMission
      ? await updateMission(continuingMission.id, missionPayload)
      : await saveMission(missionPayload);

    if (!savedMission) {
      msgs.current?.clear();
      msgs.current?.show({
        life: 3500,
        severity: "error",
        summary: "Mission Save Failed",
        detail: "Could not save mission data. Please try again.",
        closable: true,
      });
      setMeasurementBusy(false);
      return;
    }

    const status = await stopMeasurement();
    if (status) {
      setMeasurementStatus(status.status);
      setMeasurementElapsedSeconds(status.elapsedSeconds);
    }

    msgs.current?.clear();
    msgs.current?.show({
      life: 3000,
      severity: "success",
      summary: continuingMission ? "Mission Continued" : "Mission Saved",
      detail: continuingMission
        ? `${savedMission.name} updated with additional telemetry.`
        : `${savedMission.name} saved with ${savedMission.results.length} drone result(s).`,
      closable: true,
    });

    missionPromptSnoozeUntilRef.current =
      Date.now() + START_MISSION_PROMPT_SNOOZE_AFTER_SAVE_MS;

    setMeasurementTraceByDrone({});
    setMissionName("");
    setContinuingMission(null);
    setMeasurementBusy(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc] text-slate-900 font-sans">
      {isMissionModalOpen && (
        <MissionModal onClose={() => setIsMissionModalOpen(false)}>
          <div className="flex flex-col gap-5 pr-8">
            <div className="space-y-1">
              <p
                className="text-[11px] uppercase tracking-[0.2em]"
                style={{ color: color.textDim }}
              >
                End Mission
              </p>
              <h2
                className="text-2xl font-semibold"
                style={{ color: color.text }}
              >
                Save Mission Snapshot
              </h2>
              <p className="text-sm" style={{ color: color.textMuted }}>
                Add a label before saving this mission. You can review this run
                later in results.
              </p>
            </div>

            <div
              className="rounded-xl border px-3 py-3"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
              }}
            >
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: color.textMuted }}>
                  Drones in Mission
                </span>
                <span style={{ color: color.text }}>
                  {missionDroneIds.length > 0
                    ? `${missionDroneIds.length} (${missionDroneIds.join(", ")})`
                    : "0"}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span style={{ color: color.textMuted }}>Elapsed</span>
                <span style={{ color: color.text }}>
                  {Math.floor(measurementElapsedSeconds / 60)}m{" "}
                  {measurementElapsedSeconds % 60}s
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full">
              <input
                placeholder="Mission name"
                value={missionName}
                onChange={(event) => setMissionName(event.target.value)}
                className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none"
                style={{
                  backgroundColor: color.surface,
                  borderColor: color.border,
                  color: color.text,
                }}
              />
            </div>
            <div className="flex flex-row justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    await handleSaveMeasurement();
                    setIsMissionModalOpen(false);
                  }}
                  disabled={measurementBusy}
                  className="rounded-md px-4 py-2 text-white transition-colors disabled:opacity-60"
                  style={{ backgroundColor: color.saveGreen }}
                >
                  {measurementBusy ? "Saving..." : "Save Mission"}
                </button>

                <button
                  onClick={() => setIsMissionModalOpen(false)}
                  className="rounded-md px-4 py-2 text-white transition-colors"
                  style={{
                    backgroundColor: color.red,
                    color: "#ffffff",
                  }}
                >
                  Cancel
                </button>
              </div>
              <button
                onPointerDown={startDeleteHold}
                onPointerUp={cancelDeleteHold}
                onPointerLeave={cancelDeleteHold}
                className="relative overflow-hidden rounded-md px-4 py-2 text-white select-none"
                style={{
                  backgroundColor: "#f33232",
                  color: "#ffffff",
                  minWidth: "80px",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: "rgba(0,0,0,0.28)",
                    width: `${deleteHoldProgress}%`,
                    transition:
                      deleteHoldProgress === 0 ? "none" : "width 0.05s linear",
                  }}
                />
                <span style={{ position: "relative" }}>
                  {deleteHoldProgress > 0 ? "Hold..." : "Delete"}
                </span>
              </button>
            </div>
          </div>
        </MissionModal>
      )}
      <header
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ backgroundColor: color.surface, borderColor: color.border }}
      >
        <div className="flex items-center gap-2">
          <img
            src={logoSvg}
            alt="EERL Logo"
            className="h-7 w-auto object-contain"
          />
          <span
            className="text-xs font-semibold tracking-[0.12em] uppercase"
            style={{ color: color.textMuted }}
          >
            Drone Monitor
          </span>
        </div>
        <nav className="flex items-center gap-1">
          {[
            { id: "dashboard", label: "Dashboard" },
            { id: "results", label: "Analysis" },
            { id: "data", label: "Data" },
          ].map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => setCurrentView(view.id)}
              className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
              style={{
                backgroundColor:
                  currentView === view.id ? color.orangeSoft : "transparent",
                color: currentView === view.id ? color.orange : color.textMuted,
              }}
            >
              {view.label}
            </button>
          ))}
        </nav>
      </header>

      <main
        className={`flex-1 bg-slate-100 ${color.text}`}
        style={{ backgroundColor: color.background, color: color.text }}
      >
        {currentView === "results" ? (
          <ResultsPage
            devices={devices}
            sensorsMode={sensorsMode}
            flowDataByDrone={recordedFlowDataByDrone}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={setSelectedDeviceId}
            onContinueMission={handleContinueMission}
            continuingMissionId={continuingMission?.id || null}
            measurementStatus={measurementStatus}
            onDataRefresh={reloadAllHistory}
          />
        ) : currentView === "data" ? (
          <DataPage
            devices={devices}
            sensorsMode={sensorsMode}
            flowDataByDrone={recordedFlowDataByDrone}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={setSelectedDeviceId}
            onImportComplete={() => reloadHistory(selectedDeviceId)}
            onRefresh={reloadAllHistory}
          />
        ) : null}
        <div className="pointer-events-none fixed top-3 left-1/2 z-50 w-full max-w-3xl -translate-x-1/2 px-3">
          <div className="pointer-events-auto rounded-xl bg-white/90 shadow-md backdrop-blur-sm">
            <Messages ref={msgs} />
          </div>
        </div>

        <section
          className={tw.shell}
          style={{ display: currentView === "dashboard" ? undefined : "none" }}
        >
          <div className="grid w-full gap-3 lg:grid-cols-[96px_minmax(0,1fr)]">
            <div>
              <div className="flex h-fit flex-col gap-3 mb-3">
                <DeviceTabs
                  devices={devices}
                  activeDeviceId={selectedDeviceId}
                  onSelectDevice={setSelectedDeviceId}
                  latestPointByDrone={latestPointByDrone}
                />
              </div>
              
            </div>
            <div className="grid w-full gap-3">
              <div className="flex flex-row gap-3">
                <div className="flex h-full w-full flex-row justify-between  items-center gap-3">
                  <div
                    className="flex-2 rounded-lg border px-4 py-3 h-full w-full"
                    style={{
                      backgroundColor: color.card,
                      borderColor: color.border,
                    }}
                  >
                    <div className="flex flex-wrap items-center h-full justify-between gap-3">
                      <div>
                        <p
                          className="text-[11px] uppercase tracking-[0.16em]"
                          style={{ color: color.green }}
                        >
                          Active Drone
                        </p>
                        <p
                          className="text-xl font-bold tracking-tight"
                          style={{ color: color.text }}
                        >
                          {activeDevice.name}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <div className="flex items-center gap-2 mr-4">
                          <span
                            className="rounded-full px-3 py-1"
                            style={{
                              backgroundColor:
                                activeSensorMode === SENSOR_MODE_AERIS
                                  ? color.greenSoft
                                  : color.surface,
                              color:
                                activeSensorMode === SENSOR_MODE_AERIS
                                  ? color.green
                                  : color.textMuted,
                            }}
                          >
                            {activeSensorMode === SENSOR_MODE_AERIS
                              ? "Aeris Detected"
                              : "Dual Sensor Detected"}
                          </span>
                        </div>
                        <span
                          className="rounded-full px-3 py-1"
                          style={{
                            backgroundColor: color.surface,
                            color: color.textMuted,
                          }}
                        >
                          Type {activeDevice.type}
                        </span>
                        <span
                          className="rounded-full px-3 py-1"
                          style={{
                            backgroundColor: color.orangeSoft,
                            color: color.orange,
                          }}
                        >
                          CH4 {Number(activePoint?.methane ?? 0).toFixed(2)} ppm
                        </span>
                        <span
                          className="rounded-full px-3 py-1"
                          style={{
                            backgroundColor: color.greenSoft,
                            color: color.green,
                          }}
                        >
                          Alt {Number(activePoint?.altitude ?? 0).toFixed(1)} m
                        </span>
                        <span
                          className="rounded-full px-3 py-1 font-mono"
                          style={{
                            backgroundColor: color.surface,
                            color: color.textMuted,
                            border: `1px solid ${color.border}`,
                          }}
                          title="Live sample count (debug)"
                        >
                          {filteredLiveFlowData.length.toLocaleString()} samples
                        </span>
                      </div>
                    </div>
                  </div>
                  <COMPort />
                  <div
                    className="flex flex-row h-full items-center rounded-lg border p-3 gap-4"
                    style={{
                      backgroundColor: color.card,
                      borderColor: color.border,
                    }}
                  >
                    {/* <SignalStatus
                      signalHistory={
                        (liveTelemetryByDrone[selectedDeviceId] || []).map((pt) => ({
                          q0: pt.payload?.q0,
                          q1: pt.payload?.q1,
                        }))
                      }
                      seqHistory={
                        (liveTelemetryByDrone[selectedDeviceId] || []).map((pt) => {
                          return pt.payload?.seq ?? pt.seq;
                        }).filter((v) => v !== undefined && v !== null)
                      }
                      color={color}
                    /> */}
                    
                    <SignalStatus
                      signalHistory={sampleSignalHistory}
                      seqHistory={sampleSeqHistory}
                      color={color}
                    />
                  </div>
                </div>
                
                <MeasurementControls
                  status={measurementStatus}
                  elapsedSeconds={measurementElapsedSeconds}
                  isBusy={measurementBusy}
                  onStart={handleStartMeasurement}
                  onPause={handlePauseMeasurement}
                  onResume={handleResumeMeasurement}
                  onStop={() => setIsMissionModalOpen(true)}
                />

              </div>

              {/* <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]"> */}
               <div className="grid w-full gap-3 ">
                <DeckMap
                  traceDataset={EMPTY_FEATURE_COLLECTION}
                  tracePoints={dashboardMapTracePoints}
                  selectedDroneId={selectedDeviceId}
                  heatmapOnlyMode={false}
                  visibleDroneIds={visibleDashboardDroneIds}
                  devices={devices}
                  showAllPlottedData={showDashboardPlotData}
                  onToggleAllPlottedData={() =>
                    setShowDashboardPlotData((previous) => !previous)
                  }
                  droneVisibilityById={dashboardDroneVisibility}
                  onToggleDroneVisibility={handleToggleDashboardDroneVisibility}
                  methaneValidityVisibility={methaneValidityVisibility}
                  onToggleMethaneValidity={
                    handleToggleMethaneValidityVisibility
                  }
                  plumeViewEnabled={plumeViewEnabled}
                  onTogglePlumeView={() =>
                    setPlumeViewEnabled((previous) => !previous)
                  }
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
                  resultsPageMode={false}
                  onPlumeViewAutoChange={setPlumeViewEnabled}
                />
              </div>
              {selectedDeviceId === "Aeris" ? (
                <AerisPanel
                  flowData={dashboardChartFlowData}
                  selection={selectedWindowForDashboard}
                  onSelectionChange={setSelectedWindow}
                  resultsPageMode={false}
                />
              ) : (
                <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
                  <MethanePanel
                    flowData={dashboardChartFlowData}
                    selection={selectedWindowForDashboard}
                    onSelectionChange={setSelectedWindow}
                    resultsPageMode={false}
                  />
                  <WindPanel windSamples={windSamples} />
                </div>
              )}
              
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
