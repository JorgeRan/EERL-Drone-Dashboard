export const SENSOR_MODE_DUAL = "dual";
export const SENSOR_MODE_AERIS = "aeris";
export const SENSOR_MODE_MIXED = "mixed";
export const SENSOR_MODE_UNKNOWN = "unknown";

export const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export const calculateDistanceMeters = (
  latitudeA,
  longitudeA,
  latitudeB,
  longitudeB,
) => {
  const earthRadiusMeters = 6371000;
  const deltaLatitude = toRadians(latitudeB - latitudeA);
  const deltaLongitude = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(deltaLongitude / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
};

const median = (values) => {
  if (!values.length) {
    return null;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2;
  }

  return sortedValues[middleIndex];
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

const hasFiniteCoordinates = (point) =>
  Number.isFinite(toFiniteNumber(point?.latitude)) &&
  Number.isFinite(toFiniteNumber(point?.longitude));

export const filterCoordinateOutliers = (flowData, options = {}) => {
  const {
    minimumPoints = 6,
    minimumThresholdMeters = 150,
    percentileRatio = 0.9,
    percentileMultiplier = 3,
    medianMultiplier = 6,
  } = options;

  const points = Array.isArray(flowData) ? flowData : [];
  const geoPoints = points.filter(hasFiniteCoordinates);

  if (geoPoints.length < minimumPoints) {
    return points;
  }

  const centerLatitude = median(
    geoPoints
      .map((point) => toFiniteNumber(point.latitude))
      .filter((value) => value !== null),
  );
  const centerLongitude = median(
    geoPoints
      .map((point) => toFiniteNumber(point.longitude))
      .filter((value) => value !== null),
  );

  if (!Number.isFinite(centerLatitude) || !Number.isFinite(centerLongitude)) {
    return points;
  }

  const distances = geoPoints
    .map((point) =>
      calculateDistanceMeters(
        centerLatitude,
        centerLongitude,
        toFiniteNumber(point.latitude),
        toFiniteNumber(point.longitude),
      ),
    )
    .filter((value) => Number.isFinite(value));

  const medianDistance = median(distances);
  const percentileDistance = quantile(distances, percentileRatio);

  if (!Number.isFinite(medianDistance) || !Number.isFinite(percentileDistance)) {
    return points;
  }

  const maxDistanceMeters = Math.max(
    minimumThresholdMeters,
    medianDistance * medianMultiplier,
    percentileDistance * percentileMultiplier,
  );

  return points.filter((point) => {
    if (!hasFiniteCoordinates(point)) {
      return true;
    }

    const distanceFromCenter = calculateDistanceMeters(
      centerLatitude,
      centerLongitude,
      toFiniteNumber(point.latitude),
      toFiniteNumber(point.longitude),
    );

    return distanceFromCenter <= maxDistanceMeters;
  });
};

export const pickFiniteMetric = (...values) => {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
};

const normalizeSensorMode = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (["aeris", "aeris-box", "aeris_box"].includes(normalized)) {
    return SENSOR_MODE_AERIS;
  }

  if (["dual", "sniffer-purway", "sniffer_purway", "methane"].includes(normalized)) {
    return SENSOR_MODE_DUAL;
  }

  return null;
};

export const extractTelemetryMetrics = (source) => {
  const payload = source?.payload && typeof source.payload === "object"
    ? source.payload
    : {};
  const aerisPayload =
    payload.aeris && typeof payload.aeris === "object" ? payload.aeris : {};

  const explicitSensorMode = normalizeSensorMode(
    source?.sensorMode ??
      source?.sensor_type ??
      source?.sensorType ??
      payload.sensorMode ??
      payload.sensor_type ??
      payload.sensorType,
  );

  const methane = pickFiniteMetric(
    source?.methane,
    source?.methane_concentration,
    source?.methane_ppm,
    source?.ch4,
    source?.ch4_ppm,
    payload.methane,
    payload.methane_concentration,
    payload.methane_ppm,
    payload.ch4,
    payload.ch4_ppm,
    aerisPayload.methane,
  );
  const sniffer = pickFiniteMetric(
    source?.sniffer,
    source?.sniffer_ppm,
    source?.sniffer_methane,
    payload.sniffer,
    payload.sniffer_ppm,
    payload.sniffer_methane,
  );
  const purway = pickFiniteMetric(
    source?.purway,
    source?.purway_ppm_m,
    source?.purway_ppn,
    source?.purway_ppm,
    payload.purway,
    payload.purway_ppm_m,
    payload.purway_ppn,
    payload.purway_ppm,
  );
  const acetylene = pickFiniteMetric(
    source?.acetylene,
    source?.c2h2,
    payload.acetylene,
    payload.c2h2,
    aerisPayload.acetylene,
  );
  const nitrousOxide = pickFiniteMetric(
    source?.nitrousOxide,
    source?.nitrous_oxide,
    source?.n2o,
    payload.nitrousOxide,
    payload.nitrous_oxide,
    payload.n2o,
    aerisPayload.nitrousOxide,
    aerisPayload.nitrous_oxide,
    aerisPayload.n2o,
  );

  const hasAerisMetrics = acetylene !== null || nitrousOxide !== null;
  const hasDualMetrics = sniffer !== null || purway !== null;

  let resolvedMethane = methane;
  if (resolvedMethane === null) {
    resolvedMethane = sniffer ?? acetylene;
  }

  const sensorMode =
    explicitSensorMode ||
    (hasAerisMetrics ? SENSOR_MODE_AERIS : SENSOR_MODE_DUAL);

  const resolvedSniffer =
    sniffer ?? (sensorMode === SENSOR_MODE_DUAL ? resolvedMethane : null);
  const resolvedPurway = purway;

  return {
    sensorMode,
    methane: resolvedMethane ?? 0,
    sniffer: resolvedSniffer,
    purway: resolvedPurway,
    acetylene,
    nitrousOxide,
  };
};

export const inferFlowSensorMode = (flowData) => {
  const sensorModes = new Set(
    (Array.isArray(flowData) ? flowData : [])
      .map((point) => extractTelemetryMetrics(point).sensorMode)
      .filter(Boolean),
  );

  if (sensorModes.size > 1) {
    return SENSOR_MODE_MIXED;
  }

  return sensorModes.values().next().value || SENSOR_MODE_UNKNOWN;
};

export const isAerisFlow = (flowData) =>
  inferFlowSensorMode(flowData) === SENSOR_MODE_AERIS;

export const getTelemetryPeakValue = (flowData) =>
  Math.max(
    1,
    ...(Array.isArray(flowData) ? flowData : []).flatMap((point) => {
      const metrics = extractTelemetryMetrics(point);
      return [
        metrics.methane,
        metrics.sniffer,
        metrics.purway,
        metrics.acetylene,
        metrics.nitrousOxide,
      ].map((value) => Number(value || 0));
    }),
  );