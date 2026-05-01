const DEFAULT_BACKGROUND_PPM = 1.9;
const DEFAULT_TEMPERATURE_K = 293.15;
const DEFAULT_PRESSURE_PA = 101325.0;
const DEFAULT_TRANSECT_WIDTH_M = 80.0;
const DEFAULT_MIXING_HEIGHT_M = 25.0;
const METHANE_MOLAR_MASS_KG_PER_MOL = 0.01604;
const UNIVERSAL_GAS_CONSTANT = 8.314462618;

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const calculateDistanceMeters = (
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

const filterCoordinateOutliers = (flowData, options = {}) => {
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
  if (point?.sensorMode === "aeris") {
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
  const meanWindNormal = windNormals.reduce((sum, value) => sum + value, 0) / count;
  const surfaceAreaM2 = transectWidthM * mixingHeightM;
  const emissionRateKgS = meanEnhancementKgM3 * meanWindNormal * surfaceAreaM2;

  return {
    emissionRateKgS,
    emissionRateKgH: emissionRateKgS * 3600,
    sampleCount: count,
    surfaceAreaM2,
  };
};

const emptyDerived = {
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
  const flowData = Array.isArray(selectedFlowData) ? selectedFlowData : [];

  if (!flowData.length) {
    return emptyDerived;
  }

  const safeStart = Math.max(
    0,
    Math.min(Number(selectedWindow?.startIndex ?? 0), flowData.length - 1),
  );
  const safeEnd = Math.max(
    safeStart,
    Math.min(Number(selectedWindow?.endIndex ?? 0), flowData.length - 1),
  );
  const ppmMin = Number(selectedWindow?.ppmMin ?? 0);
  const ppmMax = Number(selectedWindow?.ppmMax ?? Number.POSITIVE_INFINITY);

  const selectedWindowFlowData = flowData.slice(safeStart, safeEnd + 1);
  const notebookAnalysisSamples = selectedWindowFlowData
    .filter((point) => {
      const methane = Number(point?.methane ?? 0);
      return methane >= ppmMin && methane <= ppmMax;
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
        (sum, point) => sum + Number(point?.methane || 0),
        0,
      ) / selectedAnalysisFlowData.length
    : 0;

  const thresholdSamples = selectedAnalysisFlowData.filter(
    (point) => Number(point?.methane || 0) >= 2,
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

self.onmessage = (event) => {
  const { requestId, selectedFlowData, selectedWindow } = event.data || {};

  try {
    const result = computeAnalysisDerivatives(selectedFlowData, selectedWindow);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
