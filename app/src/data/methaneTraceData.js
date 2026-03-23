export const traceOrigin = {
    latitude: 45.3844,
    longitude: -75.699,
    altitude: 500,
}

export const methaneLegend = [
    { label: '0 ppm', swatch: '#64748b' },
    { label: 'trace', swatch: '#38bdf8' },
    { label: 'elevated', swatch: '#facc15' },
    { label: 'high', swatch: '#fb923c' },
    { label: 'peak', swatch: '#ef4444' },
]

const traceStartTimestamp = Date.UTC(2026, 2, 13, 18, 0, 0)
const traceIntervalMs = 45 * 1000

function formatTimestampLabel(timestampMs) {
    const date = new Date(timestampMs)
    const hours = String(date.getUTCHours()).padStart(2, '0')
    const minutes = String(date.getUTCMinutes()).padStart(2, '0')
    const seconds = String(date.getUTCSeconds()).padStart(2, '0')

    return `${hours}:${minutes}:${seconds}`
}

function metersToLatitudeDegrees(meters) {
    return meters / 111320
}

function metersToLongitudeDegrees(meters, atLatitude) {
    return meters / (111320 * Math.cos((atLatitude * Math.PI) / 180))
}

export function getMethaneColor(value) {
    if (value === 0) return '#64748b'
    if (value < 0.8) return '#38bdf8'
    if (value < 1.6) return '#4ade80'
    if (value < 2.8) return '#facc15'
    if (value < 4.2) return '#fb923c'
    return '#ef4444'
}

export function generateMethaneTraceDataset({ centerLat, centerLon, centerAlt, sampleCount = 140 }) {
    const hotspotSeeds = [
        { east: -36, north: 14, intensity: 2.3, spread: 18 },
        { east: 12, north: -10, intensity: 4.8, spread: 14 },
        { east: 42, north: 22, intensity: 2.9, spread: 20 },
    ]

    let east = -58
    let north = -34

    const features = Array.from({ length: sampleCount }, (_, index) => {
        east += 1.5 + (Math.random() - 0.5) * 8
        north += (Math.random() - 0.5) * 7

        const methaneSignal = hotspotSeeds.reduce((sum, hotspot) => {
            const deltaEast = east - hotspot.east
            const deltaNorth = north - hotspot.north
            const distanceSquared = deltaEast * deltaEast + deltaNorth * deltaNorth

            return sum + hotspot.intensity * Math.exp(-distanceSquared / (2 * hotspot.spread * hotspot.spread))
        }, 0)

        const backgroundNoise = Math.max(0, (Math.random() - 0.3) * 0.45)
        let sniffer = Number(Math.max(0, methaneSignal * 1.08 + backgroundNoise + (Math.random() - 0.5) * 0.18).toFixed(2))
        let purway = Number(Math.max(0, methaneSignal * 0.94 + backgroundNoise * 0.82 + (Math.random() - 0.5) * 0.16).toFixed(2))
        let methane = Number((((sniffer + purway) / 2)).toFixed(2))

        if (methane < 0.12 || Math.random() < 0.16) {
            methane = 0
            sniffer = 0
            purway = 0
        }

        const sampleAltitude = Math.round(centerAlt + Math.sin(index / 8) * 12 + (Math.random() - 0.5) * 18)
        const sampleLat = centerLat + metersToLatitudeDegrees(north)
        const sampleLon = centerLon + metersToLongitudeDegrees(east, centerLat)
        const timestampMs = traceStartTimestamp + index * traceIntervalMs
        const timestampIso = new Date(timestampMs).toISOString()
        const timeLabel = formatTimestampLabel(timestampMs)

        return {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [sampleLon, sampleLat],
            },
            properties: {
                id: `trace-${index}`,
                sampleOrder: index,
                sampleIndex: index + 1,
                timestampMs,
                timestampIso,
                timeLabel,
                altitude: sampleAltitude,
                sniffer,
                purway,
                methane,
                detected: methane > 0,
                pointColor: getMethaneColor(methane),
            },
        }
    })

    return {
        type: 'FeatureCollection',
        features,
    }
}

export function buildMethanePlumeDataset(traceDataset) {
    const positiveFeatures = traceDataset.features.filter((feature) => feature.properties.methane > 0)

    if (positiveFeatures.length === 0) {
        return {
            type: 'FeatureCollection',
            features: [],
        }
    }

    const minimumAltitude = Math.min(...positiveFeatures.map((feature) => feature.properties.altitude))

    return {
        type: 'FeatureCollection',
        features: positiveFeatures.map((feature, index) => {
            const [sampleLon, sampleLat] = feature.geometry.coordinates
            const { methane, altitude } = feature.properties
            const footprintRadiusMeters = 3
            const latOffset = metersToLatitudeDegrees(footprintRadiusMeters)
            const lonOffset = metersToLongitudeDegrees(footprintRadiusMeters, sampleLat)
            const altitudeBand = altitude - minimumAltitude
            const baseHeight = 0
            const plumeHeight = methane * 10
            // const plumeHeight = baseHeight + 10 + methane * 20

            return {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
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
                    sampleIndex: feature.properties.sampleIndex,
                    sampleOrder: feature.properties.sampleOrder,
                    timestampMs: feature.properties.timestampMs,
                    timestampIso: feature.properties.timestampIso,
                    timeLabel: feature.properties.timeLabel,
                    methane,
                    altitude,
                    passBand: Math.floor(altitudeBand / 6) + 1,
                    pointColor: feature.properties.pointColor,
                    baseHeight,
                    plumeHeight,
                },
            }
        }),
    }
}

export const methaneTraceDataset = generateMethaneTraceDataset({
    centerLat: traceOrigin.latitude,
    centerLon: traceOrigin.longitude,
    centerAlt: traceOrigin.altitude,
})

export const methaneTraceCount = methaneTraceDataset.features.length
export const methanePositiveCount = methaneTraceDataset.features.filter((feature) => feature.properties.methane > 0).length
export const methanePeakValue = Math.max(...methaneTraceDataset.features.map((feature) => feature.properties.methane))
export const methanePlumeDataset = buildMethanePlumeDataset(methaneTraceDataset)
export const methanePassCount = Math.max(1, ...methanePlumeDataset.features.map((feature) => feature.properties.passBand))
export const flowChartData = methaneTraceDataset.features.map((feature) => ({
    sampleOrder: feature.properties.sampleOrder,
    sampleIndex: feature.properties.sampleIndex,
    timestampMs: feature.properties.timestampMs,
    timestampIso: feature.properties.timestampIso,
    time: feature.properties.timeLabel,
    sniffer: feature.properties.sniffer,
    purway: feature.properties.purway,
    methane: feature.properties.methane,
    altitude: feature.properties.altitude,
}))

export function sliceTraceDataset(traceDataset, startIndex, endIndex) {
    const safeStart = Math.max(0, Math.min(startIndex, traceDataset.features.length - 1))
    const safeEnd = Math.max(safeStart, Math.min(endIndex, traceDataset.features.length - 1))

    return {
        type: 'FeatureCollection',
        features: traceDataset.features.slice(safeStart, safeEnd + 1),
    }
}

export function filterTraceDatasetBySelection(traceDataset, selection) {
    const slicedDataset = sliceTraceDataset(traceDataset, selection.startIndex, selection.endIndex)

    return {
        type: 'FeatureCollection',
        features: slicedDataset.features.filter((feature) => {
            const methane = feature.properties?.methane ?? 0
            return methane >= selection.ppmMin && methane <= selection.ppmMax
        }),
    }
}