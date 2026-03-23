export const legendStepCount = 10
export const minimumLegendSpan = 0.1

const methanePalette = ['#38bdf8', '#44cbd1', '#4ade80', '#facc15', '#fb923c', '#ef4444']

export function formatLegendValue(value) {
    return Number(value.toFixed(1)).toString()
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum)
}

function interpolateHexColor(startHex, endHex, ratio) {
    const safeRatio = clamp(ratio, 0, 1)
    const start = startHex.replace('#', '')
    const end = endHex.replace('#', '')
    const red = Math.round(parseInt(start.slice(0, 2), 16) + (parseInt(end.slice(0, 2), 16) - parseInt(start.slice(0, 2), 16)) * safeRatio)
    const green = Math.round(parseInt(start.slice(2, 4), 16) + (parseInt(end.slice(2, 4), 16) - parseInt(start.slice(2, 4), 16)) * safeRatio)
    const blue = Math.round(parseInt(start.slice(4, 6), 16) + (parseInt(end.slice(4, 6), 16) - parseInt(start.slice(4, 6), 16)) * safeRatio)

    return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`
}

export function getScaledMethaneColor(value, lowerLimit, upperLimit) {
    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan)
    const normalizedValue = clamp((value - lowerLimit) / span, 0, 1)
    const scaledIndex = normalizedValue * (methanePalette.length - 1)
    const lowerIndex = Math.floor(scaledIndex)
    const upperIndex = Math.min(lowerIndex + 1, methanePalette.length - 1)
    const interpolationRatio = scaledIndex - lowerIndex

    return interpolateHexColor(methanePalette[lowerIndex], methanePalette[upperIndex], interpolationRatio)
}

export function buildMethaneColorExpression(lowerLimit, upperLimit, propertyName = 'methane') {
    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan)
    const stops = methanePalette.flatMap((_, index) => {
        const stopValue = lowerLimit + span * (index / (methanePalette.length - 1))
        return [stopValue, getScaledMethaneColor(stopValue, lowerLimit, upperLimit)]
    })

    return [
        'interpolate',
        ['linear'],
        ['get', propertyName],
        ...stops,
    ]
}

export function buildHeatmapColorExpression(lowerLimit, upperLimit) {
    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan)
    const densityStops = methanePalette.flatMap((_, index) => {
        const densityValue = 0.14 + (0.86 * index) / (methanePalette.length - 1)
        const methaneValue = lowerLimit + span * (index / (methanePalette.length - 1))
        return [densityValue, getScaledMethaneColor(methaneValue, lowerLimit, upperLimit)]
    })

    return [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0, 'rgba(56, 189, 248, 0)',
        ...densityStops,
    ]
}

export function buildHeatmapWeightExpression(lowerLimit, upperLimit) {
    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan)

    return [
        'interpolate',
        ['linear'],
        ['get', 'methane'],
        lowerLimit, 0.08,
        lowerLimit + span * 0.25, 0.28,
        lowerLimit + span * 0.55, 0.58,
        upperLimit, 1,
    ]
}

export function buildHotspotRadiusExpression(lowerLimit, upperLimit) {
    const span = Math.max(upperLimit - lowerLimit, minimumLegendSpan)

    return [
        'interpolate',
        ['linear'],
        ['get', 'methane'],
        lowerLimit, 2.5,
        lowerLimit + span * 0.3, 3.6,
        lowerLimit + span * 0.65, 5,
        upperLimit, 6.5,
    ]
}

export function buildMethaneScale(lowerLimit, upperLimit) {
    const interval = (upperLimit - lowerLimit) / legendStepCount

    return Array.from({ length: legendStepCount + 1 }, (_, index) => {
        const upperBound = upperLimit - interval * index
        const lowerBound = Math.max(lowerLimit, upperBound - interval)

        if (index === 0) {
            return {
                id: 'upper-limit',
                kind: 'upper',
                label: formatLegendValue(upperLimit),
                swatch: getScaledMethaneColor(upperLimit, lowerLimit, upperLimit),
            }
        }

        if (index === legendStepCount) {
            return {
                id: 'lower-limit',
                kind: 'lower',
                label: formatLegendValue(lowerLimit),
                swatch: getScaledMethaneColor(lowerLimit, lowerLimit, upperLimit),
            }
        }

        return {
            id: `range-${index}`,
            kind: 'range',
            label: `${formatLegendValue(lowerBound)}-${formatLegendValue(upperBound)}`,
            swatch: getScaledMethaneColor((upperBound + lowerBound) / 2, lowerLimit, upperLimit),
        }
    })
}

export function buildMethaneGradient(lowerLimit, upperLimit) {
    const methaneScale = buildMethaneScale(lowerLimit, upperLimit)

    return `linear-gradient(to top, ${methaneScale
        .slice()
        .reverse()
        .map((entry, index, entries) => `${entry.swatch} ${(index / (entries.length - 1)) * 100}%`)
        .join(', ')})`
}