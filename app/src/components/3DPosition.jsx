import React, { useEffect, useMemo, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import { tw, color } from '../constants/tailwind'
import { buildMethaneColorExpression } from '../constants/methaneScale'
import {
  buildMethanePlumeDataset,
  traceOrigin,
} from '../data/methaneTraceData'

const latitude = traceOrigin.latitude
const longitude = traceOrigin.longitude
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN

export function Position({ traceDataset, lowerLimit = 0, upperLimit = 5, selectedDroneId }) {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const initialPlumeDatasetRef = useRef(buildMethanePlumeDataset(traceDataset))
  const initialLowerLimitRef = useRef(lowerLimit)
  const initialUpperLimitRef = useRef(upperLimit)
  const methanePlumeDataset = useMemo(() => buildMethanePlumeDataset(traceDataset), [traceDataset])
  const methanePositiveCount = useMemo(
    () => traceDataset.features.filter((feature) => feature.properties.methane > 0).length,
    [traceDataset],
  )
  const methanePeakValue = useMemo(
    () => Math.max(0, ...traceDataset.features.map((feature) => feature.properties.methane)),
    [traceDataset],
  )
  const selectedFocusCoordinates = useMemo(() => {
    if (!Array.isArray(traceDataset.features) || traceDataset.features.length === 0) {
      return [longitude, latitude]
    }

    const lastFeature = traceDataset.features[traceDataset.features.length - 1]
    const [lng, lat] = lastFeature?.geometry?.coordinates || [longitude, latitude]

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return [longitude, latitude]
    }

    return [lng, lat]
  }, [traceDataset])

  useEffect(() => {
    if (!mapboxToken || !mapContainerRef.current || mapRef.current) {
      return undefined
    }

    mapboxgl.accessToken = mapboxToken

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [longitude, latitude],
      zoom: 17.2,
      pitch: 72,
      bearing: 34,
      attributionControl: false,
      antialias: true,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.on('style.load', () => {
      const initialLower = initialLowerLimitRef.current
      const initialUpper = initialUpperLimitRef.current

      map.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      })

      map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.35 })
      map.setFog({
        color: 'rgba(255, 255, 255, 0.06)',
        'high-color': 'rgba(20, 31, 52, 0.14)',
        'space-color': '#0f172a',
        'horizon-blend': 0.08,
      })

      const labelLayerId = map
        .getStyle()
        ?.layers?.find((layer) => layer.type === 'symbol' && layer.layout?.['text-field'])?.id

      map.addLayer(
        {
          id: 'mapbox-3d-buildings',
          source: 'composite',
          'source-layer': 'building',
          filter: ['==', ['get', 'extrude'], 'true'],
          type: 'fill-extrusion',
          minzoom: 15,
          paint: {
            'fill-extrusion-color': [
              'interpolate',
              ['linear'],
              ['get', 'height'],
              0,
              'rgba(148, 163, 184, 0.65)',
              40,
              'rgba(203, 213, 225, 0.78)',
              120,
              'rgba(255, 255, 255, 0.9)',
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-height': ['coalesce', ['get', 'height'], 0],
            'fill-extrusion-opacity': 0.72,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        labelLayerId,
      )

      map.addSource('methane-plume', {
        type: 'geojson',
        data: initialPlumeDatasetRef.current,
      })

      map.addLayer({
        id: 'methane-plume-columns',
        type: 'fill-extrusion',
        source: 'methane-plume',
        paint: {
          'fill-extrusion-color': buildMethaneColorExpression(initialLower, initialUpper),
          'fill-extrusion-base': ['get', 'baseHeight'],
          'fill-extrusion-height': ['get', 'plumeHeight'],
          'fill-extrusion-opacity': 0.82,
          'fill-extrusion-vertical-gradient': true,
        },
      })

      map.addLayer({
        id: 'methane-plume-caps',
        type: 'line',
        source: 'methane-plume',
        paint: {
          'line-color': 'rgba(255,255,255,0.88)',
          'line-width': 1.1,
          'line-opacity': 0.45,
        },
      })
    })

    map.on('load', () => {
      map.resize()
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const currentMap = mapRef.current
    const plumeSource = currentMap?.getSource('methane-plume')

    if (plumeSource) {
      plumeSource.setData(methanePlumeDataset)
    }
  }, [methanePlumeDataset])

  useEffect(() => {
    const currentMap = mapRef.current

    if (!currentMap || !currentMap.getLayer('methane-plume-columns')) {
      return
    }

    currentMap.setPaintProperty('methane-plume-columns', 'fill-extrusion-color', buildMethaneColorExpression(lowerLimit, upperLimit))
  }, [lowerLimit, upperLimit])

  useEffect(() => {
    const currentMap = mapRef.current

    if (!currentMap) {
      return
    }

    currentMap.easeTo({
      center: selectedFocusCoordinates,
      duration: 900,
      essential: true,
    })
  }, [selectedDroneId, selectedFocusCoordinates])

  return (
    <div className={tw.panel} style={{ backgroundColor: color.card, padding: '0.75rem' }}>
      <div className='flex h-full w-full flex-col gap-3'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <p className='text-xs uppercase tracking-[0.18em]' style={{ color: color.green }}>
              3D position
            </p>
            <p className='text-xl font-bold tracking-tight' style={{ color: color.text }}>
              Terrain plume view
            </p>
          </div>
          <div
            className='rounded-full px-3 py-1 text-xs font-medium'
            style={{ backgroundColor: color.greenSoft, color: color.green }}
          >
            plume live
          </div>
        </div>

        {/* <div className='my-1 flex flex-wrap gap-x-4 gap-y-2 text-sm' style={{ color: color.textMuted }}>
          <span>lat: {latitude.toFixed(4)}° N</span>
          <span>lon: {Math.abs(longitude).toFixed(4)}° W</span>
          <span>alt: {altitude} m</span>
        </div> */}

        <div className='grid gap-3 md:grid-cols-2'>
          <div className='rounded-lg border px-3 py-2.5' style={{ backgroundColor: color.surface, borderColor: color.border }}>
            <div className='text-[11px] uppercase tracking-[0.12em]' style={{ color: color.text }}>
              Plume columns
            </div>
            <div className='mt-1 flex items-baseline gap-2'>
              <span className='text-lg font-semibold' style={{ color: color.orange }}>{methanePositiveCount}</span>
              <span className='text-sm' style={{ color: color.textMuted }}>methane detections extruded</span>
            </div>
          </div>

          <div className='rounded-lg border px-3 py-2.5' style={{ backgroundColor: color.surface, borderColor: color.border }}>
            <div className='text-[11px] uppercase tracking-[0.12em]' style={{ color: color.text }}>
              Peak plume value
            </div>
            <div className='mt-1 flex items-baseline gap-2'>
              <span className='text-lg font-semibold' style={{ color: color.green }}>{methanePeakValue.toFixed(2)}</span>
              <span className='text-sm' style={{ color: color.textMuted }}>ppm equivalent</span>
            </div>
          </div>
        </div>

        {mapboxToken ? (
          <div
            ref={mapContainerRef}
            className='h-full w-full rounded-lg border'
            style={{ borderColor: color.border }}
          />
        ) : (
          <div
            className='flex min-h-[360px] w-full items-center justify-center rounded-lg border px-6 text-center'
            style={{ backgroundColor: color.surface, borderColor: color.border, color: color.textMuted }}
          >
            Set VITE_MAPBOX_TOKEN in app/.env and restart the Vite dev server to load the 3D terrain plume view.
          </div>
        )}
      </div>
    </div>
  )
}
