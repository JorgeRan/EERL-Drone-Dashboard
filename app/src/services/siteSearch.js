export function coordinateSiteLocations(query) {
  const match = query.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*[,;\s]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 85 || Math.abs(longitude) > 180) return [];
  return [{ id: "coordinates", name: `${latitude}, ${longitude}`, latitude, longitude }];
}

export async function searchMapboxLocations(query, { token, signal, fetcher = fetch } = {}) {
  const coordinates = coordinateSiteLocations(query);
  if (coordinates) return coordinates;
  if (query.trim().length < 2) return [];
  if (!token) throw new Error("Location search needs a Mapbox token. Coordinate entry is still available.");
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.search = new URLSearchParams({ q: query.trim(), access_token: token, autocomplete: "true", limit: "5" }).toString();
  const response = await fetcher(url, { signal });
  if (!response.ok) {
    throw new Error(response.status === 429
      ? "Too many searches. Please try again shortly."
      : "Location search is unavailable. Check your connection or enter coordinates.");
  }
  const data = await response.json();
  return (data.features || []).flatMap((feature) => {
    const [longitude, latitude] = feature.geometry?.coordinates || [];
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) return [];
    const properties = feature.properties || {};
    return [{
      id: feature.id || properties.mapbox_id,
      name: properties.full_address || [properties.name, properties.place_formatted].filter(Boolean).join(", "),
      latitude,
      longitude,
    }];
  });
}