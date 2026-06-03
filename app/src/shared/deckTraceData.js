import { extractTelemetryMetrics, SENSOR_MODE_AERIS, toFiniteNumber } from "../constants/telemetryMetrics";

const START_POINT_FILTER_RADIUS_METERS = 6;
const START_POINT_FILTER_MAX_PREFIX_POINTS = 10000;

const degreesToRadians = (value) => (value * Math.PI) / 180;

const calculateDistanceMeters = (latitudeA, longitudeA, latitudeB, longitudeB) => {
  const earthRadiusMeters = 6371000;
  const latA = degreesToRadians(latitudeA);
  const latB = degreesToRadians(latitudeB);
  const latDelta = degreesToRadians(latitudeB - latitudeA);
  const lonDelta = degreesToRadians(longitudeB - longitudeA);

  const haversine =
    Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(latA) * Math.cos(latB) * Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);

  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadiusMeters * angularDistance;
};

const filterStartupPointsByDrone = (points) => {
  const rows = Array.isArray(points) ? points : [];

  if (rows.length <= 1) {
    return rows;
  }

  const groupedByDrone = new globalThis.Map();

  rows.forEach((point) => {
    const droneId = String(point?.droneId || "unknown").trim() || "unknown";
    const existingGroup = groupedByDrone.get(droneId);

    if (existingGroup) {
      existingGroup.push(point);
      return;
    }

    groupedByDrone.set(droneId, [point]);
  });

  const filtered = [];

  groupedByDrone.forEach((dronePoints) => {
    if (dronePoints.length <= 1) {
      filtered.push(...dronePoints);
      return;
    }

    const firstPoint = dronePoints[0];
    const startLatitude = Number(firstPoint?.latitude);
    const startLongitude = Number(firstPoint?.longitude);

    if (!Number.isFinite(startLatitude) || !Number.isFinite(startLongitude)) {
      filtered.push(...dronePoints);
      return;
    }

    const keptPoints = [];
    let droppedPrefixCount = 0;
    let startupWindowOpen = true;

    dronePoints.forEach((point, index) => {
      const latitude = Number(point?.latitude);
      const longitude = Number(point?.longitude);

      if (!startupWindowOpen) {
        keptPoints.push(point);
        return;
      }

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        droppedPrefixCount >= START_POINT_FILTER_MAX_PREFIX_POINTS
      ) {
        startupWindowOpen = false;
        keptPoints.push(point);
        return;
      }

      const distanceFromStartMeters = calculateDistanceMeters(
        startLatitude,
        startLongitude,
        latitude,
        longitude,
      );

      if (index > 0 && distanceFromStartMeters <= START_POINT_FILTER_RADIUS_METERS) {
        droppedPrefixCount += 1;
        return;
      }

      startupWindowOpen = false;
      keptPoints.push(point);
    });

    if (keptPoints.length === 0) {
      filtered.push(firstPoint);
      return;
    }

    filtered.push(...keptPoints);
  });

  return filtered;
};

const getTraceDisplayMetric = (point) => {
  if (point.sensorMode === SENSOR_MODE_AERIS) {
    const aerisCandidates = [
      { label: "CH4", units: "ppm", value: toFiniteNumber(point.methane) },
      { label: "Acetylene", units: "ppm", value: toFiniteNumber(point.acetylene) },
      { label: "Nitrous Oxide", units: "ppm", value: toFiniteNumber(point.nitrousOxide) },
    ].filter((candidate) => candidate.value !== null && candidate.value > 0);

    if (aerisCandidates.length) {
      return aerisCandidates.reduce((best, candidate) =>
        candidate.value > best.value ? candidate : best,
      );
    }

    return { label: "CH4", units: "ppm", value: 0 };
  }

  const purway = toFiniteNumber(point.purway);
  if (purway !== null) {
    return { label: "Purway", units: "ppm-m", value: Math.max(0, purway) };
  }

  return {
    label: "CH4",
    units: "ppm",
    value: Math.max(0, toFiniteNumber(point.methane) ?? 0),
  };
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

const metersToLatitudeDegrees = (meters) => meters / 111320;

const metersToLongitudeDegrees = (meters, atLatitude) =>
  meters / (111320 * Math.cos((atLatitude * Math.PI) / 180));

export const buildDeckTracePointsFromFlowData = (datasetFlowData) => {
  const points = filterStartupPointsByDrone(datasetFlowData);

  return points
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .map((point) => {
      const traceDisplayMetric = getTraceDisplayMetric(point);
      const traceValue = traceDisplayMetric.value;
      const sourceLatitude = point.latitude;
      const sourceLongitude = point.longitude;
      const targetLatitude = point.target_latitude ?? point.payload?.target_latitude ?? null;
      const targetLongitude = point.target_longitude ?? point.payload?.target_longitude ?? null;

      return {
        id: `trace-${point.droneId || "drone"}-${point.timestampMs || point.sampleOrder}`,
        droneId: point.droneId || null,
        sampleOrder: point.sampleOrder,
        sampleIndex: point.sampleIndex,
        timestampMs: point.timestampMs,
        timestampIso: point.timestampIso,
        timeLabel: point.time,
        altitude: point.altitude ?? getTelemetryCoordinate(point, "altitude"),
        sniffer: point.sniffer,
        purway: point.purway,
        acetylene: point.acetylene,
        nitrousOxide: point.nitrousOxide,
        sensorMode: point.sensorMode || extractTelemetryMetrics(point)?.sensorMode,
        ch4: point.methane,
        methane: traceValue,
        methaneValid: point.methane_valid,
        displayMetricLabel: traceDisplayMetric.label,
        displayMetricUnits: traceDisplayMetric.units,
        sourceLatitude,
        sourceLongitude,
        targetLatitude,
        targetLongitude,
        mapCoordinates: point.payload?.map_coordinates === "target" ? "target" : "drone",
        detected: traceValue > 0,
        pointColor: traceValue > 0 ? "#4ade80" : "#64748b",
        longitude: sourceLongitude,
        latitude: sourceLatitude,
        payload: point.payload || {},
      };
    });
};

export const buildMethanePlumeDatasetFromPoints = (tracePoints) => {
  const positivePoints = (Array.isArray(tracePoints) ? tracePoints : [])
    .filter((point) => Number(point?.methane ?? 0) > 0)
    .sort((left, right) => {
      const leftMethane = Number(left?.methane ?? 0);
      const rightMethane = Number(right?.methane ?? 0);

      if (leftMethane !== rightMethane) {
        return leftMethane - rightMethane;
      }

      return Number(left?.sampleOrder ?? 0) - Number(right?.sampleOrder ?? 0);
    });

  if (positivePoints.length === 0) {
    return {
      type: "FeatureCollection",
      features: [],
    };
  }

  const minimumAltitude = Math.min(
    ...positivePoints.map((point) => Number(point?.altitude ?? 0)),
  );

  return {
    type: "FeatureCollection",
    features: positivePoints.map((point, index) => {
      const sampleLon = Number(point?.longitude ?? point?.sourceLongitude ?? 0);
      const sampleLat = Number(point?.latitude ?? point?.sourceLatitude ?? 0);
      const methane = Number(point?.methane ?? 0);
      const altitude = Number(point?.altitude ?? 0);
      const footprintRadiusMeters = 1;
      const latOffset = metersToLatitudeDegrees(footprintRadiusMeters);
      const lonOffset = metersToLongitudeDegrees(footprintRadiusMeters, sampleLat);
      const altitudeBand = altitude - minimumAltitude;
      const baseHeight = 0;
      const plumeHeight = methane * 0.01;

      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [sampleLon - lonOffset, sampleLat - latOffset],
            [sampleLon + lonOffset, sampleLat - latOffset],
            [sampleLon + lonOffset, sampleLat + latOffset],
            [sampleLon - lonOffset, sampleLat + latOffset],
            [sampleLon - lonOffset, sampleLat - latOffset],
          ]],
        },
        properties: {
          id: `plume-${index}`,
          sampleIndex: point?.sampleIndex,
          sampleOrder: point?.sampleOrder,
          timestampMs: point?.timestampMs,
          timestampIso: point?.timestampIso,
          timeLabel: point?.timeLabel,
          methane,
          altitude,
          passBand: Math.floor(altitudeBand / 6) + 1,
          pointColor: point?.pointColor,
          baseHeight,
          plumeHeight,
        },
      };
    }),
  };
};
