import React, { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import { tw , color } from '../constants/tailwind'

const latitude = 45.3844
const longitude = -75.699
const altitude = 500
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN

export function Map() {
    const mapContainerRef = useRef(null)
    const mapRef = useRef(null)

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

        map.addControl(new mapboxgl.NavigationControl(), 'top-right')

        const markerElement = document.createElement('div')
        markerElement.style.width = '16px'
        markerElement.style.height = '16px'
        markerElement.style.borderRadius = '999px'
        markerElement.style.background = color.orange
        markerElement.style.boxShadow = `0 0 0 6px ${color.orangeSoft}`
        markerElement.style.border = `2px solid ${color.text}`

        new mapboxgl.Marker({ element: markerElement })
            .setLngLat([longitude, latitude])
            .addTo(map)

        map.on('load', () => {
            map.resize()
        })

        return () => {
            map.remove()
            mapRef.current = null
        }
    }, [])

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

