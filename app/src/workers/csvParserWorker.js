const SENSOR_MODE_AERIS = "aeris";
const SENSOR_MODE_DUAL = "dual";

const parseNumber = (value) => {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const COORDINATE_OUTLIER_MAX_DISTANCE_METERS = 1000;
const COORDINATE_OUTLIER_MAX_SPEED_MPS = 60;
const COORDINATE_OUTLIER_MAX_TIME_GAP_SECONDS = 180;

const isValidLatitude = (value) =>
  Number.isFinite(value) && value >= -90 && value <= 90;

const isValidLongitude = (value) =>
  Number.isFinite(value) && value >= -180 && value <= 180;

const hasInvalidCoordinatePair = (latitude, longitude) => {
  const hasLatitude = Number.isFinite(latitude);
  const hasLongitude = Number.isFinite(longitude);

  if (!hasLatitude && !hasLongitude) {
    return false;
  }

  return (
    !hasLatitude ||
    !hasLongitude ||
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude)
  );
};

const hasOriginCoordinatePair = (latitude, longitude) =>
  Number(latitude) === 0 && Number(longitude) === 0;

const toRadians = (value) => (value * Math.PI) / 180;

const haversineDistanceMeters = (from, to) => {
  if (
    !from ||
    !to ||
    !isValidLatitude(from.latitude) ||
    !isValidLongitude(from.longitude) ||
    !isValidLatitude(to.latitude) ||
    !isValidLongitude(to.longitude)
  ) {
    return null;
  }

  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitudeRadians = toRadians(from.latitude);
  const toLatitudeRadians = toRadians(to.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitudeRadians) *
      Math.cos(toLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const resolvePointMapCoordinates = (point) => {
  const useTargetCoordinates = point?.payload?.map_coordinates === "target";
  const latitude = useTargetCoordinates
    ? point?.target_latitude ?? point?.payload?.target_latitude ?? point?.latitude
    : point?.latitude;
  const longitude = useTargetCoordinates
    ? point?.target_longitude ?? point?.payload?.target_longitude ?? point?.longitude
    : point?.longitude;

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }

  return { latitude, longitude };
};

const filterMissionResultEntryOutliers = (entry) => {
  const accepted = [];
  let droppedCount = 0;

  for (const point of Array.isArray(entry?.data) ? entry.data : []) {
    if (
      hasOriginCoordinatePair(point?.latitude, point?.longitude) ||
      hasOriginCoordinatePair(point?.target_latitude, point?.target_longitude) ||
      hasInvalidCoordinatePair(point?.latitude, point?.longitude) ||
      hasInvalidCoordinatePair(point?.target_latitude, point?.target_longitude)
    ) {
      droppedCount += 1;
      continue;
    }

    const currentCoordinates = resolvePointMapCoordinates(point);
    if (!currentCoordinates) {
      accepted.push(point);
      continue;
    }

    const previousPoint = accepted[accepted.length - 1] || null;
    const previousCoordinates = resolvePointMapCoordinates(previousPoint);

    if (!previousCoordinates) {
      accepted.push(point);
      continue;
    }

    const distanceMeters = haversineDistanceMeters(
      previousCoordinates,
      currentCoordinates,
    );

    if (
      !Number.isFinite(distanceMeters) ||
      distanceMeters <= COORDINATE_OUTLIER_MAX_DISTANCE_METERS
    ) {
      accepted.push(point);
      continue;
    }

    const currentTimestampMs = Number(point?.timestampMs);
    const previousTimestampMs = Number(previousPoint?.timestampMs);

    if (
      !Number.isFinite(currentTimestampMs) ||
      !Number.isFinite(previousTimestampMs)
    ) {
      droppedCount += 1;
      continue;
    }

    const elapsedSeconds =
      Math.abs(currentTimestampMs - previousTimestampMs) / 1000;

    if (elapsedSeconds > COORDINATE_OUTLIER_MAX_TIME_GAP_SECONDS) {
      accepted.push(point);
      continue;
    }

    if (elapsedSeconds === 0) {
      droppedCount += 1;
      continue;
    }

    const speedMetersPerSecond = distanceMeters / elapsedSeconds;
    if (speedMetersPerSecond > COORDINATE_OUTLIER_MAX_SPEED_MPS) {
      droppedCount += 1;
      continue;
    }

    accepted.push(point);
  }

  return {
    entry: accepted.length > 0 ? { ...entry, data: accepted } : null,
    droppedCount,
  };
};

const filterMissionResultsOutliers = (missionResults) => {
  let droppedCount = 0;

  const filtered = (Array.isArray(missionResults) ? missionResults : [])
    .map((entry) => {
      const result = filterMissionResultEntryOutliers(entry);
      droppedCount += result.droppedCount;
      return result.entry;
    })
    .filter((entry) => Array.isArray(entry?.data) && entry.data.length > 0);

  return {
    missionResults: filtered,
    droppedCount,
  };
};

const normalizeHeader = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[^a-z0-9._]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const parseGpsDateTime = (rawDate, rawTime) => {
  const dateValue = String(rawDate ?? "").trim();
  const timeValue = String(rawTime ?? "").trim();

  const dateMatch = dateValue.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = timeValue.match(/^(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const [, year, month, day] = dateMatch;
  const [, hours, minutes, seconds, fractional = "0"] = timeMatch;
  const milliseconds = String(fractional).padEnd(3, "0").slice(0, 3);
  const timestampIso = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;
  const timestampMs = new Date(timestampIso).getTime();

  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return { timestampIso, timestampMs };
};

const detectDelimiter = (headerLine) => {
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  const commaCount = (headerLine.match(/,/g) || []).length;
  return semicolonCount > commaCount ? ";" : ",";
};

const splitDelimitedLine = (line, delimiter) =>
  String(line ?? "").split(delimiter).map((value) => value.trim());

const formatDatePart = (date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const withTimeOnlyTimestamp = (timeValue, baseDateMs, lastTimestampMs) => {
  const match = String(timeValue ?? "")
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);

  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, fractional = "0"] = match;
  const milliseconds = String(fractional).padEnd(3, "0").slice(0, 3);
  const baseDate = new Date(baseDateMs);
  let timestampIso = `${formatDatePart(baseDate)}T${String(hours).padStart(2, "0")}:${minutes}:${seconds}.${milliseconds}Z`;
  let timestampMs = new Date(timestampIso).getTime();

  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  if (Number.isFinite(lastTimestampMs) && timestampMs < lastTimestampMs) {
    const rolloverDate = new Date(baseDateMs);
    rolloverDate.setUTCDate(rolloverDate.getUTCDate() + 1);
    timestampIso = `${formatDatePart(rolloverDate)}T${String(hours).padStart(2, "0")}:${minutes}:${seconds}.${milliseconds}Z`;
    timestampMs = new Date(timestampIso).getTime();
  }

  return { timestampIso, timestampMs };
};

const parseTimestamp = (rawTime, options = {}) => {
  const { baseDateMs = Date.now(), lastTimestampMs = null } = options;
  const value = String(rawTime ?? "").trim();
  if (!value) {
    return null;
  }

  const timeOnly = withTimeOnlyTimestamp(value, baseDateMs, lastTimestampMs);
  if (timeOnly) {
    return timeOnly;
  }

  const [datePart, timePart] = value.split("_");
  const tp = timePart?.split(":");
  if (!tp || tp.length < 4) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return {
      timestampIso: parsed.toISOString(),
      timestampMs: parsed.getTime(),
    };
  }

  const timestampIso = `${datePart}T${tp[0]}:${tp[1]}:${tp[2]}.${tp[3]}Z`;
  const timestampMs = new Date(timestampIso).getTime();
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return { timestampIso, timestampMs };
};

const parseStandardCsvToMissionResults = (
  lines,
  headers,
  fallbackDroneId,
  defaultSensorMode,
  parseOptions,
) => {
  const headerMap = new Map(
    headers.map((name, index) => [normalizeHeader(name), index]),
  );
  const idx = (...names) => {
    for (const name of names) {
      const match = headerMap.get(normalizeHeader(name));
      if (match !== undefined) return match;
    }
    return -1;
  };

  const timeIdx = idx("time", "timestamp", "ts");
  const gpsDateIdx = idx("gps_date");
  const gpsTimeIdx = idx("gps_time");
  const methaneIdx = idx("methane_concentration", "methane", "ch4");
  const acetyleneIdx = idx("acetylene", "c2h2");
  const ethyleneIdx = idx("ethylene", "c2h4");
  const nitrousOxideIdx = idx("nitrous_oxide", "nitrousoxide", "n2o");
  const snifferIdx = idx("sniffer", "sniffer_ppm", "sniffer_methane");
  const purwayIdx = idx("purway", "purway_ppm_m", "purway_ppn", "purway_ppm");
  const latIdx = idx("rtk_lat", "latitude", "lat", "center_lat", "gimbal_lat", "ref_lat");
  const lonIdx = idx("rtk_lon", "longitude", "lon", "lng", "center_lon", "gimbal_lon", "ref_lon");
  const altIdx = idx("rtk_hfsl", "altitude", "alt", "center_hfsl", "gimbal_hfsl", "ref_hfsl");
  const distIdx = idx("distance");
  const targetLatIdx = idx("dest_latitude", "target_latitude", "targ_lat", "targ_ref_lat", "Targ Lat [deg]");
  const targetLonIdx = idx("dest_longitude", "target_longitude", "targ_lon", "targ_ref_lon", "Targ Lon [deg]");
  const speedIdx = idx("speed", "spd", "ground_speed", "windc_vel");
  const windUIdx = idx("wind_u", "u_wind", "u");
  const windVIdx = idx("wind_v", "v_wind", "v");
  const windWIdx = idx("wind_w", "w_wind", "w");
  const droneIdx = idx("drone", "drone_id", "droneid");
  const sensorModeIdx = idx("sensor_mode", "sensor_type", "sensor");
  const methaneValidIdx = idx("methane_valid", "methanevalid", "methane_validity");

  if (timeIdx === -1 && (gpsDateIdx === -1 || gpsTimeIdx === -1)) return null;

  const usesPurwayMethaneColumn =
    defaultSensorMode === SENSOR_MODE_DUAL &&
    methaneIdx !== -1 &&
    snifferIdx !== -1 &&
    purwayIdx === -1;

  const rowsByDrone = new Map();
  let previousTimestampMs = null;

  const delimiter = detectDelimiter(lines[0]);
  for (const line of lines.slice(1)) {
    const cols = splitDelimitedLine(line, delimiter);
    const ts =
      (timeIdx !== -1
        ? parseTimestamp(cols[timeIdx], {
            ...parseOptions,
            lastTimestampMs: previousTimestampMs,
          })
        : null) ||
      parseGpsDateTime(
        gpsDateIdx !== -1 ? cols[gpsDateIdx] : null,
        gpsTimeIdx !== -1 ? cols[gpsTimeIdx] : null,
      );
    if (!ts) continue;
    previousTimestampMs = ts.timestampMs;

    const sniffer = snifferIdx !== -1 ? parseNumber(cols[snifferIdx]) : null;
    const methaneColumnValue =
      methaneIdx !== -1 ? parseNumber(cols[methaneIdx]) : null;
    const purway =
      purwayIdx !== -1
        ? parseNumber(cols[purwayIdx])
        : usesPurwayMethaneColumn
          ? methaneColumnValue
          : null;
    const methane = usesPurwayMethaneColumn
      ? sniffer ?? 0
      : methaneColumnValue ?? sniffer ?? 0;

    const droneLatitude = latIdx !== -1 ? parseNumber(cols[latIdx]) : null;
    const droneLongitude = lonIdx !== -1 ? parseNumber(cols[lonIdx]) : null;
    const targetLatitude =
      targetLatIdx !== -1 ? parseNumber(cols[targetLatIdx]) : null;
    const targetLongitude =
      targetLonIdx !== -1 ? parseNumber(cols[targetLonIdx]) : null;
    const useTargetCoordinates =
      targetLatitude !== null && targetLongitude !== null;

    const point = {
      timestampIso: ts.timestampIso,
      timestampMs: ts.timestampMs,
      sensorMode:
        sensorModeIdx !== -1
          ? String(cols[sensorModeIdx] || "")
              .trim()
              .toLowerCase() || defaultSensorMode
          : defaultSensorMode,
      methane,
      acetylene: acetyleneIdx !== -1 ? parseNumber(cols[acetyleneIdx]) : null,
      nitrousOxide:
        nitrousOxideIdx !== -1 ? parseNumber(cols[nitrousOxideIdx]) : null,
      ethylene: ethyleneIdx !== -1 ? parseNumber(cols[ethyleneIdx]) : null,
      sniffer,
      purway,
      latitude: droneLatitude,
      longitude: droneLongitude,
      altitude: altIdx !== -1 ? parseNumber(cols[altIdx]) : null,
      distance: distIdx !== -1 ? parseNumber(cols[distIdx]) : null,
      speed: speedIdx !== -1 ? parseNumber(cols[speedIdx]) : null,
      target_latitude: targetLatitude,
      target_longitude: targetLongitude,
      wind_u: windUIdx !== -1 ? parseNumber(cols[windUIdx]) : null,
      wind_v: windVIdx !== -1 ? parseNumber(cols[windVIdx]) : null,
      wind_w: windWIdx !== -1 ? parseNumber(cols[windWIdx]) : null,
      methane_valid: methaneValidIdx !== -1 ? parseNumber(cols[methaneValidIdx]) : null,
      payload: {
        source_latitude: droneLatitude,
        source_longitude: droneLongitude,
        target_latitude: targetLatitude,
        target_longitude: targetLongitude,
        map_coordinates: useTargetCoordinates ? "target" : "drone",
      },
    };

    const droneId =
      (droneIdx !== -1 ? String(cols[droneIdx] || "").trim() : "") ||
      fallbackDroneId;
    const bucket = rowsByDrone.get(droneId) || [];
    bucket.push(point);
    rowsByDrone.set(droneId, bucket);
  }

  const missionResults = Array.from(rowsByDrone.entries())
    .map(([drone, data]) => ({
      drone,
      data: data
        .filter((point) => Number.isFinite(point.timestampMs))
        .sort((a, b) => a.timestampMs - b.timestampMs),
    }))
    .filter((entry) => entry.data.length > 0);

  return missionResults.length > 0 ? missionResults : null;
};

const findHeaderIndex = (headers, matcher) =>
  headers.findIndex((header) => matcher(normalizeHeader(header)));

const normalizeCoordinatePair = (latitude, longitude) => {
  const hasLatitude = Number.isFinite(latitude);
  const hasLongitude = Number.isFinite(longitude);

  if (!hasLatitude && !hasLongitude) {
    return { latitude: null, longitude: null };
  }

  if (
    !hasLatitude ||
    !hasLongitude ||
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude) ||
    hasOriginCoordinatePair(latitude, longitude)
  ) {
    return { latitude: null, longitude: null };
  }

  return { latitude, longitude };
};

const buildAerisSnapshotPoint = (timestamp, sensorMode, state) => {
  const point = {
    timestampIso: timestamp.timestampIso,
    timestampMs: timestamp.timestampMs,
    sensorMode,
    payload: {
      sensorMode,
    },
  };

  if (Number.isFinite(state?.latitude)) {
    point.latitude = state.latitude;
    point.payload.latitude = state.latitude;
  }

  if (Number.isFinite(state?.longitude)) {
    point.longitude = state.longitude;
    point.payload.longitude = state.longitude;
  }

  const optionalFields = {
    methane: state.methane,
    acetylene: state.acetylene,
    nitrousOxide: state.nitrousOxide,
    altitude: state.altitude,
    wind_u: state.wind_u,
    wind_v: state.wind_v,
    wind_w: state.wind_w,
  };

  Object.entries(optionalFields).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      point[key] = value;
      point.payload[key] = value;
    }
  });

  return point;
};

const hasAerisHeaders = (headers) => {
  const normalizedHeaders = headers.map(normalizeHeader);
  return (
    normalizedHeaders.includes("utctime") &&
    normalizedHeaders.some(
      (header) =>
        header.endsWith(".ch4") ||
        header.endsWith(".c2h2_ppb") ||
        header.endsWith(".n2o"),
    )
  );
};

const parseAerisCsvToMissionResults = (
  lines,
  headers,
  fallbackDroneId,
  defaultSensorMode,
  parseOptions,
) => {
  const delimiter = detectDelimiter(lines[0]);
  const timeIdx = findHeaderIndex(headers, (header) => header === "utctime");
  const methaneIdx = findHeaderIndex(headers, (header) => header.endsWith(".ch4"));
  const acetyleneIdx = findHeaderIndex(headers, (header) =>
    header.endsWith(".c2h2_ppb"),
  );
  const nitrousOxideIdx = findHeaderIndex(headers, (header) =>
    header.endsWith(".n2o"),
  );
  const latitudeIdx = findHeaderIndex(headers, (header) => header.endsWith(".lat"));
  const longitudeIdx = findHeaderIndex(headers, (header) => header.endsWith(".lon"));
  const altitudeIdx = findHeaderIndex(headers, (header) => header.endsWith(".alt"));
  const windUIdx = findHeaderIndex(headers, (header) => header.endsWith(".velx"));
  const windVIdx = findHeaderIndex(headers, (header) => header.endsWith(".vely"));
  const windWIdx = findHeaderIndex(headers, (header) => header.endsWith(".velz"));

  if (timeIdx === -1) {
    return null;
  }

  const rows = [];
  const rollingState = {
    methane: null,
    acetylene: null,
    nitrousOxide: null,
    latitude: null,
    longitude: null,
    altitude: null,
    wind_u: null,
    wind_v: null,
    wind_w: null,
  };
  let previousTimestampMs = null;

  for (const line of lines.slice(1)) {
    const cols = splitDelimitedLine(line, delimiter);
    const ts = parseTimestamp(cols[timeIdx], {
      ...parseOptions,
      lastTimestampMs: previousTimestampMs,
    });
    if (!ts) {
      continue;
    }
    previousTimestampMs = ts.timestampMs;

    const methane = methaneIdx !== -1 ? parseNumber(cols[methaneIdx]) : null;
    const acetylenePpb =
      acetyleneIdx !== -1 ? parseNumber(cols[acetyleneIdx]) : null;
    const nitrousOxide =
      nitrousOxideIdx !== -1 ? parseNumber(cols[nitrousOxideIdx]) : null;
    const rawLatitude = latitudeIdx !== -1 ? parseNumber(cols[latitudeIdx]) : null;
    const rawLongitude =
      longitudeIdx !== -1 ? parseNumber(cols[longitudeIdx]) : null;
    const normalizedCoordinates = normalizeCoordinatePair(
      rawLatitude,
      rawLongitude,
    );
    const altitude = altitudeIdx !== -1 ? parseNumber(cols[altitudeIdx]) : null;
    const windU = windUIdx !== -1 ? parseNumber(cols[windUIdx]) : null;
    const windV = windVIdx !== -1 ? parseNumber(cols[windVIdx]) : null;
    const windW = windWIdx !== -1 ? parseNumber(cols[windWIdx]) : null;

    const updates = {
      methane,
      acetylene: acetylenePpb !== null ? acetylenePpb / 1000 : null,
      nitrousOxide,
      latitude: normalizedCoordinates.latitude,
      longitude: normalizedCoordinates.longitude,
      altitude,
      wind_u: windU,
      wind_v: windV,
      wind_w: windW,
    };

    const changedEntries = Object.entries(updates).filter(
      ([, value]) => value !== null,
    );

    if (!changedEntries.length) {
      continue;
    }

    changedEntries.forEach(([key, value]) => {
      rollingState[key] = value;
    });

    const snapshotPoint = buildAerisSnapshotPoint(
      ts,
      defaultSensorMode,
      rollingState,
    );

    if (snapshotPoint) {
      rows.push(snapshotPoint);
    }
  }

  if (!rows.length) {
    return null;
  }

  return [
    {
      drone: fallbackDroneId,
      data: rows,
    },
  ];
};

const parseCsvToMissionResults = (text, options) => {
  const { fallbackDroneId, defaultSensorMode, fileLastModified } = options;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { missionResults: null, droppedCount: 0 };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitDelimitedLine(lines[0], delimiter);
  const parseOptions = {
    baseDateMs: fileLastModified || Date.now(),
  };

  if (defaultSensorMode === SENSOR_MODE_AERIS || hasAerisHeaders(headers)) {
    const aerisResults = parseAerisCsvToMissionResults(
      lines,
      headers,
      fallbackDroneId,
      SENSOR_MODE_AERIS,
      parseOptions,
    );

    if (aerisResults) {
      return filterMissionResultsOutliers(aerisResults);
    }
  }

  const standardResults = parseStandardCsvToMissionResults(
    lines,
    headers,
    fallbackDroneId,
    defaultSensorMode || SENSOR_MODE_DUAL,
    parseOptions,
  );

  if (!standardResults) {
    return { missionResults: null, droppedCount: 0 };
  }

  return filterMissionResultsOutliers(standardResults);
};

self.onmessage = (event) => {
  const { requestId, text, options } = event.data || {};

  try {
    const result = parseCsvToMissionResults(text, options || {});
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
