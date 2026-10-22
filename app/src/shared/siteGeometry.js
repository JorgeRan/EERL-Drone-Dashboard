import { area, bbox, bboxPolygon, booleanValid, circle, distance, kinks } from "@turf/turf";

export const sampleSiteLocations = [
  { name: "Mer Bleue Research Area", latitude: 45.409, longitude: -75.518 },
  { name: "EERL survey field, Ottawa", latitude: 45.3844, longitude: -75.699 },
  { name: "Bucaramanga survey area", latitude: 7.1193, longitude: -73.1227 },
];

export function searchSiteLocations(query) {
  const text = query.trim();
  if (!text) return [];
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (match) {
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Math.abs(latitude) <= 85 && Math.abs(longitude) <= 180) {
      return [{ name: `${latitude}, ${longitude}`, latitude, longitude }];
    }
    return [];
  }
  return sampleSiteLocations.filter((location) =>
    location.name.toLowerCase().includes(text.toLowerCase()),
  );
}

export function buildSiteRectangle(start, end) {
  return bboxPolygon([
    Math.min(start[0], end[0]), Math.min(start[1], end[1]),
    Math.max(start[0], end[0]), Math.max(start[1], end[1]),
  ]);
}

export function buildSiteRadius(center, radiusMeters) {
  return circle(center, radiusMeters / 1000, { steps: 64, units: "kilometers" });
}

export function summarizeSiteGeometry(feature) {
  if (!feature) return { valid: false, areaMeters: 0, widthMeters: 0, heightMeters: 0 };
  const bounds = bbox(feature);
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const isPoint = feature.geometry.type === "Point";
  const areaMeters = isPoint ? 0 : area(feature);
  const valid = booleanValid(feature) && (isPoint || (areaMeters >= 1 && kinks(feature).features.length === 0));
  return {
    valid, isPoint, areaMeters, center, bounds,
    widthMeters: distance([bounds[0], center[1]], [bounds[2], center[1]], { units: "meters" }),
    heightMeters: distance([center[0], bounds[1]], [center[0], bounds[3]], { units: "meters" }),
  };
}