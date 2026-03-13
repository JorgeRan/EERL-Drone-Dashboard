import React, { useEffect, useMemo, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import m350Marker from '../assets/M350.png'
import { tw , color } from '../constants/tailwind'
import {
    methaneLegend,
    traceOrigin,
} from '../data/methaneTraceData'

const latitude = traceOrigin.latitude
const longitude = traceOrigin.longitude
const altitude = traceOrigin.altitude
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN

export function Map({ traceDataset }) {
    const mapContainerRef = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const methaneTraceCount = traceDataset.features.length
    const methanePositiveCount = useMemo(
        () => traceDataset.features.filter((feature) => feature.properties.methane > 0).length,
        [traceDataset],
    )

    useEffect(() => {
        if (!mapboxToken || !mapContainerRef.current || mapRef.current) {
            return undefined
        }

        mapboxgl.accessToken = mapboxToken

        const map = new mapboxgl.Map({
            container: mapContainerRef.current,
            style: 'mapbox://styles/mapbox/satellite-streets-v12',
            center: [longitude, latitude],
            zoom: 18,
            pitch: 0,
            bearing: 0,
            attributionControl: false,
        })

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

        new mapboxgl.Marker({ element: markerElement, anchor: 'center' })
            .setLngLat([longitude, latitude])
            .addTo(map)

        map.on('load', () => {
            map.addSource('methane-traces', {
                type: 'geojson',
                data: traceDataset,
            })

            map.addLayer({
                id: 'methane-trace-heatmap',
                type: 'heatmap',
                source: 'methane-traces',
                filter: ['>', ['get', 'methane'], 0],
                paint: {
                    'heatmap-weight': [
                        'interpolate',
                        ['linear'],
                        ['get', 'methane'],
                        0, 0,
                        0.8, 0.2,
                        2.8, 0.6,
                        5, 1,
                    ],
                    'heatmap-intensity': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        13, 0.65,
                        18, 1.25,
                    ],
                    'heatmap-color': [
                        'interpolate',
                        ['linear'],
                        ['heatmap-density'],
                        0, 'rgba(56, 189, 248, 0)',
                        0.18, '#38bdf8',
                        0.36, '#4ade80',
                        0.58, '#facc15',
                        0.8, '#fb923c',
                        1, '#ef4444',
                    ],
                    'heatmap-radius': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        13, 18,
                        18, 34,
                    ],
                    'heatmap-opacity': 0.8,
                },
            })

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
                    'circle-color': ['get', 'pointColor'],
                    'circle-radius': [
                        'interpolate',
                        ['linear'],
                        ['get', 'methane'],
                        0, 2.5,
                        0.8, 3.5,
                        2.8, 5,
                        5, 6.5,
                    ],
                    'circle-stroke-width': 1,
                    'circle-stroke-color': 'rgba(255,255,255,0.9)',
                    'circle-opacity': 0.8,
                },
            })

            const attachTraceTooltip = (layerId) => {
                map.on('mousemove', layerId, (event) => {
                    const hoveredFeature = event.features?.[0]

                    if (!hoveredFeature || !popupRef.current) {
                        return
                    }

                    const { methane, altitude, sampleIndex, timeLabel } = hoveredFeature.properties
                    map.getCanvas().style.cursor = 'pointer'
                    popupRef.current
                        .setLngLat(event.lngLat)
                        .setHTML(`
                            <div style="min-width: 148px; color: #e5eef8;">
                                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: #9fb0c2;">Sample ${sampleIndex}</div>
                                <div style="margin-top: 4px; font-size: 13px; font-weight: 700; color: #ffffff;">Methane ${Number(methane).toFixed(2)} ppm</div>
                                <div style="margin-top: 4px; font-size: 12px; color: #d2dce8;">Altitude ${Number(altitude).toFixed(0)} m</div>
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

            map.resize()
        })

        return () => {
            popupRef.current?.remove()
            popupRef.current = null
            map.remove()
            mapRef.current = null
        }
    }, [])

    useEffect(() => {
        const currentMap = mapRef.current
        const methaneSource = currentMap?.getSource('methane-traces')

        if (methaneSource) {
            methaneSource.setData(traceDataset)
        }
    }, [traceDataset])

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
                        style={{ backgroundColor: color.orangeSoft, color: color.orange }}
                    >
                        Live
                    </div>
                </div>

                <div className='my-1 flex flex-wrap gap-x-4 gap-y-2 text-sm' style={{ color: color.textMuted }}>
                    <span>lat: {latitude.toFixed(4)}° N</span>
                    <span>lon: {Math.abs(longitude).toFixed(4)}° W</span>
                    <span>alt: {altitude} m</span>
                </div>

                <div className='grid gap-3 md:grid-cols-[1.2fr_1fr]'>
                    <div className='rounded-lg border px-3 py-2.5' style={{ backgroundColor: color.surface, borderColor: color.border }}>
                        <div className='text-[11px] uppercase tracking-[0.12em]' style={{ color: color.text }}>
                            Methane trace points
                        </div>
                        <div className='mt-1 flex items-baseline gap-2'>
                            <span className='text-lg font-semibold' style={{ color: color.orange }}>{methanePositiveCount}</span>
                            <span className='text-sm' style={{ color: color.textMuted }}>positive / {methaneTraceCount} total</span>
                        </div>
                    </div>

                    <div className='rounded-lg border px-3 py-2.5' style={{ backgroundColor: color.surface, borderColor: color.border }}>
                        <div className='text-[11px] uppercase tracking-[0.12em]' style={{ color: color.text }}>
                            Trace color scale
                        </div>
                        <div className='mt-2 flex flex-wrap gap-2'>
                            {methaneLegend.map((entry) => (
                                <div key={entry.label} className='flex items-center gap-2 rounded-full px-2.5 py-1' style={{ backgroundColor: color.cardMuted }}>
                                    <span className='h-2.5 w-2.5 rounded-full' style={{ backgroundColor: entry.swatch }} />
                                    <span className='text-[11px] uppercase tracking-[0.08em]' style={{ color: color.text }}>{entry.label}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {mapboxToken ? (
                    <div
                        ref={mapContainerRef}
                        className='min-h-[360px] w-full rounded-lg border'
                        style={{ borderColor: color.border }}
                    />
                ) : (
                    <div
                        className='flex min-h-[360px] w-full items-center justify-center rounded-lg border px-6 text-center'
                        style={{ backgroundColor: color.surface, borderColor: color.border, color: color.textMuted }}
                    >
                        Set VITE_MAPBOX_TOKEN in app/.env and restart the Vite dev server to load the map.
                    </div>
                )}
            </div>
        </div>
    )
}



