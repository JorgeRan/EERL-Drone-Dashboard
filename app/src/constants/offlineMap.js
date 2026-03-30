const metersToLatitudeDegrees = (meters) => meters / 111320

const metersToLongitudeDegrees = (meters, atLatitude) => {
  const latitudeRadians = (atLatitude * Math.PI) / 180
  const metersPerDegree = 111320 * Math.cos(latitudeRadians)

  if (!Number.isFinite(metersPerDegree) || metersPerDegree === 0) {
    return 0
  }

  return meters / metersPerDegree
}

export const hasInternetConnection = () => {
  if (typeof navigator === 'undefined') {
    return true
  }

  return navigator.onLine
}

export const shouldUseOnlineMap = (mapboxToken) => Boolean(mapboxToken) && hasInternetConnection()

export const buildOfflineImageCoordinates = ({
  centerLat,
  centerLon,
  widthMeters = 280,
  heightMeters = 160,
}) => {
  const halfWidth = widthMeters / 2
  const halfHeight = heightMeters / 2

  const latOffset = metersToLatitudeDegrees(halfHeight)
  const lonOffset = metersToLongitudeDegrees(halfWidth, centerLat)

  const north = centerLat + latOffset
  const south = centerLat - latOffset
  const west = centerLon - lonOffset
  const east = centerLon + lonOffset

  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ]
}

export const buildOfflineSatelliteStyle = ({ imageUrl, coordinates }) => ({
  version: 8,
  sources: {
    'offline-satellite': {
      type: 'image',
      url: imageUrl,
      coordinates,
    },
  },
  layers: [
    {
      id: 'offline-background',
      type: 'background',
      paint: {
        'background-color': '#0f172a',
      },
    },
    {
      id: 'offline-satellite-layer',
      type: 'raster',
      source: 'offline-satellite',
      paint: {
        'raster-opacity': 1,
      },
    },
  ],
})
