import React, { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import m350Marker from '../assets/M350.png'
import satelliteImage from '../assets/satellite.png'
import { tw, color } from '../constants/tailwind'
import { buildOfflineImageCoordinates, buildOfflineSatelliteStyle, shouldUseOnlineMap } from '../constants/offlineMap'
import {
    buildHeatmapColorExpression,
    buildHeatmapWeightExpression,
    buildHotspotRadiusExpression,
    buildMethaneColorExpression,
    buildMethaneGradient,
    buildMethaneScale,
    formatLegendValue,
    minimumLegendSpan,
} from '../constants/methaneScale'
import { traceOrigin } from '../data/methaneTraceData'

const latitude = traceOrigin.latitude
const longitude = traceOrigin.longitude
const altitude = traceOrigin.altitude
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN
const backendHttpUrl = (import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:3000`).replace(/\/$/, '')
const backendWsBaseUrl = (import.meta.env.VITE_BACKEND_WS_URL || backendHttpUrl.replace(/^http/i, 'ws')).replace(/\/$/, '')

const toFiniteNumber = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

const normalizeDroneState = (entry) => ({
    drone_id: entry.drone_id,
    topic: entry.topic,
    ts: entry.ts,
    latitude: toFiniteNumber(entry.latitude),
    longitude: toFiniteNumber(entry.longitude),
    altitude: toFiniteNumber(entry.altitude),
    battery: toFiniteNumber(entry.battery),
    speed: toFiniteNumber(entry.speed),
    sniffer: toFiniteNumber(entry.sniffer),
    purway: toFiniteNumber(entry.purway),
    methane: toFiniteNumber(entry.methane),
    payload: entry.payload || {},
})

const buildDroneFeatureCollection = (drones) => ({
    type: 'FeatureCollection',
    features: drones
        .filter((drone) => Number.isFinite(drone.longitude) && Number.isFinite(drone.latitude))
        .map((drone) => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [drone.longitude, drone.latitude],
            },
            properties: {
                droneId: drone.drone_id,
                topic: drone.topic,
                altitude: drone.altitude,
                battery: drone.battery,
                speed: drone.speed,
                sniffer: drone.sniffer,
                purway: drone.purway,
                methane: Number.isFinite(drone.purway) ? drone.purway : drone.methane,
                ts: drone.ts,
            },
        })),
})

const getTraceMaxMethane = (dataset) => {
    if (!dataset?.features?.length) {
        return 5
    }

    const values = dataset.features
        .map((feature) => Number(feature?.properties?.methane))
        .filter((value) => Number.isFinite(value))

    if (!values.length) {
        return 5
    }

    return Math.max(5, ...values)
}

export function Map({ traceDataset, onScaleChange, selectedDroneId }) {
    const mapContainerRef = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const primaryMarkerRef = useRef(null)
    const initialTraceDatasetRef = useRef(traceDataset)
    const datasetMaxMethane = getTraceMaxMethane(traceDataset)
    const initialUpperLimitRef = useRef(datasetMaxMethane)
    const initialLowerLimitRef = useRef(0)
    const [upperLimit, setUpperLimit] = useState(datasetMaxMethane)
    const [lowerLimit, setLowerLimit] = useState(0)
    const [upperLimitInput, setUpperLimitInput] = useState(String(datasetMaxMethane))
    const [lowerLimitInput, setLowerLimitInput] = useState('0')
    const [droneStates, setDroneStates] = useState([])
    const [isTelemetryConnected, setIsTelemetryConnected] = useState(false)
    const [mapMode, setMapMode] = useState(() => (shouldUseOnlineMap(mapboxToken) ? 'online' : 'offline'))
    const methaneScale = buildMethaneScale(lowerLimit, upperLimit)
    const methaneGradient = buildMethaneGradient(lowerLimit, upperLimit)
    const focusedDrone = droneStates.find((drone) => drone.drone_id === selectedDroneId) || droneStates[0] || null
    const displayLatitude = Number.isFinite(focusedDrone?.latitude) ? focusedDrone.latitude : latitude
    const displayLongitude = Number.isFinite(focusedDrone?.longitude) ? focusedDrone.longitude : longitude
    const displayAltitude = Number.isFinite(focusedDrone?.altitude) ? focusedDrone.altitude : altitude
    

    const handleLimitChange = (limitType, rawValue) => {
        const nextValue = rawValue.replace(',', '.')

        if (limitType === 'upper') {
            setUpperLimitInput(nextValue)
        } else {
            setLowerLimitInput(nextValue)
        }

        const parsedValue = Number(nextValue)

        if (!Number.isFinite(parsedValue)) {
            return
        }

        if (limitType === 'upper' && parsedValue > lowerLimit) {
            setUpperLimit(parsedValue)
        }

        if (limitType === 'lower' && parsedValue < upperLimit) {
            setLowerLimit(parsedValue)
        }
    }

    const commitLimit = (limitType) => {
        if (limitType === 'upper') {
            const parsedValue = Number(upperLimitInput)
            const safeValue = Number.isFinite(parsedValue)
                ? Math.max(parsedValue, lowerLimit + minimumLegendSpan)
                : upperLimit

            setUpperLimit(safeValue)
            setUpperLimitInput(formatLegendValue(safeValue))
            return
        }

        const parsedValue = Number(lowerLimitInput)
        const safeValue = Number.isFinite(parsedValue)
            ? Math.min(parsedValue, upperLimit - minimumLegendSpan)
            : lowerLimit

        setLowerLimit(safeValue)
        setLowerLimitInput(formatLegendValue(safeValue))
    }

    useEffect(() => {
        if (!mapContainerRef.current || mapRef.current) {
            return undefined
        }

        const isOnlineMode = shouldUseOnlineMap(mapboxToken)
        const offlineCoordinates = buildOfflineImageCoordinates({
            centerLat: latitude,
            centerLon: longitude,
        })

        if (isOnlineMode) {
            mapboxgl.accessToken = mapboxToken
        }

        const map = new mapboxgl.Map({
            container: mapContainerRef.current,
            style: isOnlineMode
                ? 'mapbox://styles/mapbox/satellite-streets-v12'
                : buildOfflineSatelliteStyle({
                    imageUrl: satelliteImage,
                    coordinates: offlineCoordinates,
                }),
            center: [displayLongitude, displayLatitude],
            zoom: 18,
            pitch: 0,
            bearing: 0,
            attributionControl: false,
        })

        setMapMode(isOnlineMode ? 'online' : 'offline')
        mapRef.current = map
        popupRef.current = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 14,
            className: 'methane-trace-popup',
        })

        map.addControl(new mapboxgl.NavigationControl(), 'top-right')

        const markerElement = document.createElement('div')
        markerElement.style.width = '52px'
        markerElement.style.height = '52px'
        markerElement.style.display = 'flex'
        markerElement.style.alignItems = 'center'
        markerElement.style.justifyContent = 'center'
        markerElement.style.borderRadius = '999px'
        markerElement.style.background = 'rgba(255, 255, 255, 0.92)'
        markerElement.style.border = `3px solid ${color.orange}`
        markerElement.style.boxShadow = `0 0 0 8px rgba(253, 148, 86, 0.28), 0 10px 22px rgba(0, 0, 0, 0.42)`

        const markerImage = document.createElement('div')
        markerImage.style.width = '52px'
        markerImage.style.height = '52px'
        markerImage.style.backgroundImage = `url(${m350Marker})`
        markerImage.style.backgroundPosition = 'center'
        markerImage.style.backgroundRepeat = 'no-repeat'
        markerImage.style.backgroundSize = 'contain'
        markerImage.style.filter = 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.24))'

        markerElement.appendChild(markerImage)

        primaryMarkerRef.current = new mapboxgl.Marker({ element: markerElement, anchor: 'center' })
            .setLngLat([longitude, latitude])
            .addTo(map)

        map.on('load', () => {
            if (!isOnlineMode) {
                map.fitBounds([offlineCoordinates[3], offlineCoordinates[1]], {
                    duration: 0,
                    padding: 30,
                })
            }

            const initialLowerLimit = initialLowerLimitRef.current
            const initialUpperLimit = initialUpperLimitRef.current

            map.addSource('methane-traces', {
                type: 'geojson',
                data: initialTraceDatasetRef.current,
            })

            // map.addLayer({
            //     id: 'methane-trace-heatmap',
            //     type: 'heatmap',
            //     source: 'methane-traces',
            //     filter: ['>', ['get', 'methane'], 0],
            //     paint: {
            //         'heatmap-weight': buildHeatmapWeightExpression(initialLowerLimit, initialUpperLimit),
            //         'heatmap-intensity': [
            //             'interpolate',
            //             ['linear'],
            //             ['zoom'],
            //             13, 0.65,
            //             18, 1.25,
            //         ],
            //         'heatmap-color': buildHeatmapColorExpression(initialLowerLimit, initialUpperLimit),
            //         'heatmap-radius': [
            //             'interpolate',
            //             ['linear'],
            //             ['zoom'],
            //             13, 18,
            //             18, 34,
            //         ],
            //         'heatmap-opacity': 0.8,
            //     },
            // })

            map.addLayer({
                id: 'methane-trace-zero-points',
                type: 'circle',
                source: 'methane-traces',
                filter: ['==', ['get', 'methane'], 0],
                paint: {
                    'circle-color': ['get', 'pointColor'],
                    'circle-radius': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        13, 2.4,
                        18, 4.4,
                    ],
                    'circle-stroke-width': 0.9,
                    'circle-stroke-color': 'rgba(255,255,255,0.72)',
                    'circle-opacity': 0.88,
                },
            })

            map.addLayer({
                id: 'methane-trace-hotspots',
                type: 'circle',
                source: 'methane-traces',
                filter: ['>', ['get', 'methane'], 0],
                paint: {
                    'circle-color': buildMethaneColorExpression(initialLowerLimit, initialUpperLimit),
                    'circle-radius': buildHotspotRadiusExpression(initialLowerLimit, initialUpperLimit),
                    'circle-stroke-width': 1,
                    'circle-stroke-color': 'rgba(255,255,255,0.9)',
                    'circle-opacity': 0.8,
                },
            })

            map.addSource('live-drones', {
                type: 'geojson',
                data: buildDroneFeatureCollection([]),
            })

            map.addLayer({
                id: 'live-drones-points',
                type: 'circle',
                source: 'live-drones',
                paint: {
                    'circle-color': color.orange,
                    'circle-radius': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        11, 5,
                        18, 9,
                    ],
                    'circle-stroke-width': 1.4,
                    'circle-stroke-color': '#ffffff',
                    'circle-opacity': 0.94,
                },
            })

            map.addLayer({
                id: 'live-drones-labels',
                type: 'symbol',
                source: 'live-drones',
                layout: {
                    'text-field': ['get', 'droneId'],
                    'text-size': 11,
                    'text-offset': [0, 1.3],
                    'text-allow-overlap': true,
                },
                paint: {
                    'text-color': '#ffffff',
                    'text-halo-color': 'rgba(0,0,0,0.82)',
                    'text-halo-width': 1.1,
                },
            })

            const attachTraceTooltip = (layerId) => {
                map.on('mousemove', layerId, (event) => {
                    const hoveredFeature = event.features?.[0]

                    if (!hoveredFeature || !popupRef.current) {
                        return
                    }

                    const { methane, averageMethane, sniffer, purway, altitude: pointAltitude, sampleIndex, timeLabel } = hoveredFeature.properties
                    map.getCanvas().style.cursor = 'pointer'
                    popupRef.current
                        .setLngLat(event.lngLat)
                        .setHTML(`
                            <div style="min-width: 148px; color: #e5eef8;">
                                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: #9fb0c2;">Sample ${sampleIndex}</div>
                                <div style="margin-top: 4px; font-size: 13px; font-weight: 700; color: #ffffff;">Purway ${Number(methane).toFixed(2)}</div>
                                <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Sniffer ${Number(sniffer ?? 0).toFixed(2)} ppm</div>
                                <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">CH4 avg ${Number(averageMethane ?? methane).toFixed(2)}</div>
                                <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Purway raw ${Number(purway ?? methane).toFixed(2)}</div>
                                <div style="margin-top: 4px; font-size: 12px; color: #d2dce8;">Altitude ${Number(pointAltitude).toFixed(0)} m</div>
                                <div style="margin-top: 2px; font-size: 11px; color: #9fb0c2;">Flight mark ${timeLabel}</div>
                            </div>
                        `)
                        .addTo(map)
                })

                map.on('mouseleave', layerId, () => {
                    map.getCanvas().style.cursor = ''
                    popupRef.current?.remove()
                })
            }

            attachTraceTooltip('methane-trace-zero-points')
            attachTraceTooltip('methane-trace-hotspots')

            map.on('mousemove', 'live-drones-points', (event) => {
                const feature = event.features?.[0]

                if (!feature || !popupRef.current) {
                    return
                }

                const { droneId, altitude: liveAltitude, battery, speed, methane, sniffer, purway, ts } = feature.properties
                map.getCanvas().style.cursor = 'pointer'

                popupRef.current
                    .setLngLat(event.lngLat)
                    .setHTML(`
                        <div style="min-width: 160px; color: #e5eef8;">
                            <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: #9fb0c2;">${droneId}</div>
                            <div style="margin-top: 4px; font-size: 12px; color: #ffffff;">Alt ${Number(liveAltitude || 0).toFixed(1)} m</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Battery ${battery ?? '-'}%</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Speed ${speed ?? '-'} m/s</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Purway ${purway ?? methane ?? '-'} ppm</div>
                            <div style="margin-top: 2px; font-size: 12px; color: #d2dce8;">Sniffer ${sniffer ?? '-'} ppm</div>
                            <div style="margin-top: 2px; font-size: 11px; color: #9fb0c2;">${ts ? new Date(ts).toLocaleString() : ''}</div>
                        </div>
                    `)
                    .addTo(map)
            })

            map.on('mouseleave', 'live-drones-points', () => {
                map.getCanvas().style.cursor = ''
                popupRef.current?.remove()
            })

            map.resize()
        })

        return () => {
            popupRef.current?.remove()
            popupRef.current = null
            primaryMarkerRef.current?.remove()
            primaryMarkerRef.current = null
            map.remove()
            mapRef.current = null
        }
    }, [])

    useEffect(() => {
        if (!focusedDrone || !Number.isFinite(displayLatitude) || !Number.isFinite(displayLongitude)) {
            return
        }

        const currentMap = mapRef.current
        if (currentMap) {
            currentMap.easeTo({
                center: [displayLongitude, displayLatitude],
                duration: 900,
                essential: true,
            })
        }

        primaryMarkerRef.current?.setLngLat([displayLongitude, displayLatitude])
    }, [displayLatitude, displayLongitude, focusedDrone])

    useEffect(() => {
        const nextUpperLimit = Math.max(datasetMaxMethane, lowerLimit + minimumLegendSpan)

        setUpperLimit(nextUpperLimit)
        setUpperLimitInput(formatLegendValue(nextUpperLimit))
        initialUpperLimitRef.current = nextUpperLimit
    }, [datasetMaxMethane, lowerLimit])

    useEffect(() => {
        const currentMap = mapRef.current
        const methaneSource = currentMap?.getSource('methane-traces')

        if (methaneSource) {
            methaneSource.setData(traceDataset)
        }
    }, [traceDataset])

    useEffect(() => {
        const currentMap = mapRef.current
        const liveDroneSource = currentMap?.getSource('live-drones')

        if (liveDroneSource) {
            liveDroneSource.setData(buildDroneFeatureCollection(droneStates))
        }
    }, [droneStates])

    useEffect(() => {
        let isCancelled = false
        const wsUrl = `${backendWsBaseUrl}/ws/telemetry`
        let socket

        const upsertDroneState = (incomingEntry) => {
            const normalizedEntry = normalizeDroneState(incomingEntry)

            setDroneStates((previousState) => {
                const dedupedState = previousState.filter((item) => item.drone_id !== normalizedEntry.drone_id)
                const nextState = [normalizedEntry, ...dedupedState]
                nextState.sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime())
                return nextState
            })
        }

        const loadLatestState = async () => {
            try {
                const response = await fetch(`${backendHttpUrl}/api/drones/latest`)
                if (!response.ok) {
                    return
                }

                const payload = await response.json()
                if (isCancelled || !Array.isArray(payload?.data)) {
                    return
                }

                const normalizedRows = payload.data.map(normalizeDroneState)
                normalizedRows.sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime())
                setDroneStates(normalizedRows)
            } catch {
                // Keep map functional when backend is unavailable.
            }
        }

        loadLatestState()

        try {
            socket = new WebSocket(wsUrl)
            socket.onopen = () => {
                if (!isCancelled) {
                    setIsTelemetryConnected(true)
                }
            }

            socket.onclose = () => {
                if (!isCancelled) {
                    setIsTelemetryConnected(false)
                }
            }

            socket.onerror = () => {
                if (!isCancelled) {
                    setIsTelemetryConnected(false)
                }
            }

            socket.onmessage = (event) => {
                try {
                    const packet = JSON.parse(event.data)
                    if (packet?.type !== 'telemetry' || !packet.data) {
                        return
                    }

                    upsertDroneState(packet.data)
                } catch {
                    // Ignore malformed packets.
                }
            }
        } catch {
            setIsTelemetryConnected(false)
        }

        return () => {
            isCancelled = true
            setIsTelemetryConnected(false)
            socket?.close()
        }
    }, [])

    useEffect(() => {
        const currentMap = mapRef.current

        if (!currentMap || !currentMap.getLayer('methane-trace-heatmap') || !currentMap.getLayer('methane-trace-hotspots')) {
            return
        }

        currentMap.setPaintProperty('methane-trace-heatmap', 'heatmap-weight', buildHeatmapWeightExpression(lowerLimit, upperLimit))
        currentMap.setPaintProperty('methane-trace-heatmap', 'heatmap-color', buildHeatmapColorExpression(lowerLimit, upperLimit))
        currentMap.setPaintProperty('methane-trace-hotspots', 'circle-color', buildMethaneColorExpression(lowerLimit, upperLimit))
        currentMap.setPaintProperty('methane-trace-hotspots', 'circle-radius', buildHotspotRadiusExpression(lowerLimit, upperLimit))
    }, [lowerLimit, upperLimit])

    useEffect(() => {
        onScaleChange?.({ lowerLimit, upperLimit })
    }, [lowerLimit, onScaleChange, upperLimit])

    return (
        <div className={tw.panel} style={{ backgroundColor: color.card, padding: '0.5rem' }}>
            <div className='flex h-full w-full flex-col gap-3'>
                <div className='flex items-start justify-between gap-3'>
                    <div>
                        <p className='text-xs uppercase tracking-[0.18em]' style={{ color: color.green }}>
                            Position
                        </p>
                        <p className='text-xl font-bold tracking-tight' style={{ color: color.text }}>
                            Drone satellite view
                        </p>
                    </div>
                    <div
                        className='rounded-full px-3 py-1 text-xs font-medium'
                        style={{
                            backgroundColor: isTelemetryConnected ? color.orangeSoft : color.surface,
                            color: isTelemetryConnected ? color.orange : color.textMuted,
                        }}
                    >
                        {isTelemetryConnected ? 'Live telemetry' : 'Waiting telemetry'} • {mapMode}
                    </div>
                </div>

                <div className='my-1 flex flex-wrap gap-x-4 gap-y-2 text-sm' style={{ color: color.textMuted }}>
                    <span>lat: {displayLatitude.toFixed(4)} deg N</span>
                    <span>lon: {Math.abs(displayLongitude).toFixed(4)} deg W</span>
                    <span>alt: {displayAltitude.toFixed(1)} m</span>
                    <span>drones: {droneStates.length}</span>
                </div>

                <div className='flex items-stretch gap-2'>
                    <div
                        ref={mapContainerRef}
                        className='min-h-[460px] w-full rounded-lg border'
                        style={{ borderColor: color.border }}
                    />

                    <div className='flex h-full min-w-[100px] items-center gap-3'>
                        <div className='flex h-[292px] items-stretch gap-2'>
                            <div
                                className='w-5 rounded-[4px] border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                                style={{ background: methaneGradient, borderColor: color.border }}
                            />
                            <div className='flex h-full flex-col justify-between py-[2px]'>
                                {methaneScale.map((entry) => (
                                    <div key={entry.id} className='flex items-center gap-1.5'>
                                        <span
                                            className='block h-px w-2'
                                            style={{ backgroundColor: color.textMuted }}
                                        />

                                        {entry.kind === 'upper' ? (
                                            <input
                                                type='number'
                                                step='0.1'
                                                value={upperLimitInput}
                                                onChange={(event) => handleLimitChange('upper', event.target.value)}
                                                onBlur={() => commitLimit('upper')}
                                                className='w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none'
                                                style={{ borderColor: color.border, color: color.text }}
                                                aria-label='Upper methane scale limit'
                                            />
                                        ) : null}

                                        {entry.kind === 'range' ? (
                                            <span
                                                className='text-[10px] font-semibold leading-none'
                                                style={{ color: color.text }}
                                            >
                                                {entry.label}
                                            </span>
                                        ) : null}

                                        {entry.kind === 'lower' ? (
                                            <input
                                                type='number'
                                                step='0.1'
                                                value={lowerLimitInput}
                                                onChange={(event) => handleLimitChange('lower', event.target.value)}
                                                onBlur={() => commitLimit('lower')}
                                                className='w-14 rounded-sm border bg-transparent px-1 py-0.5 text-[10px] font-semibold leading-none outline-none'
                                                style={{ borderColor: color.border, color: color.text }}
                                                aria-label='Lower methane scale limit'
                                            />
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
