import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { distance } from "@turf/turf";
import {
  ArrowLeft, Check, Circle, Hand, LocateFixed, MapPin, PanelRightClose,
  PanelRightOpen, Pentagon, Save, Search, Square, Trash2, Undo2,
} from "lucide-react";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import "./CreateSite.css";
import satelliteImage from "../assets/satellite.png";
import { color } from "../constants/tailwind";
import { buildOfflineImageCoordinates, buildOfflineSatelliteStyle, shouldUseOnlineMap } from "../constants/offlineMap";
import { traceOrigin } from "../data/methaneTraceData";
import {
  buildSiteRadius, buildSiteRectangle, summarizeSiteGeometry,
} from "../shared/siteGeometry";
import { coordinateSiteLocations, searchMapboxLocations } from "../services/siteSearch";

const TOOLS = [
  { id: "navigate", label: "Pan / edit", icon: <Hand size={17} /> },
  // { id: "point", label: "Point", icon: <MapPin size={17} /> },
  { id: "polygon", label: "Polygon", icon: <Pentagon size={17} /> },
  { id: "rectangle", label: "Rectangle", icon: <Square size={17} /> },
  { id: "radius", label: "Radius", icon: <Circle size={17} /> },
];
const EMPTY = { type: "FeatureCollection", features: [] };
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const DEFAULT_CENTER = [traceOrigin.longitude, traceOrigin.latitude];
const IMAGE_COORDINATES = buildOfflineImageCoordinates({
  centerLat: traceOrigin.latitude, centerLon: traceOrigin.longitude,
});

export function CreateSite({ onBack, onSave }) {
  const mapContainer = useRef(null);
  const controls = useRef(null);
  const [tool, setTool] = useState("navigate");
  const [geometry, setGeometry] = useState(null);
  const [historyLength, setHistoryLength] = useState(0);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResponse, setSearchResponse] = useState({ query: "", results: [], error: "" });
  const [activeResult, setActiveResult] = useState(-1);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [onlineMap] = useState(() => shouldUseOnlineMap(MAPBOX_TOKEN));
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [drawingStatus, setDrawingStatus] = useState("");
  const [radius, setRadius] = useState(100);
  const [isRadius, setIsRadius] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const summary = summarizeSiteGeometry(geometry);
  const coordinateResults = coordinateSiteLocations(query);
  const results = coordinateResults ?? (searchResponse.query === query ? searchResponse.results : []);
  const searchPending = coordinateResults === null && query.trim().length >= 2 && searchResponse.query !== query;
  const searchError = searchResponse.query === query ? searchResponse.error : "";

  useEffect(() => {
    if (!searchOpen || query.trim().length < 2 || coordinateSiteLocations(query) !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const locations = await searchMapboxLocations(query, { token: MAPBOX_TOKEN, signal: controller.signal });
        if (!controller.signal.aborted) setSearchResponse({ query, results: locations, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) {
          setSearchResponse({
            query, results: [], error: error instanceof TypeError
              ? "Location search is unavailable. Check your connection or enter coordinates."
              : error.message
          });
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchOpen]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      accessToken: MAPBOX_TOKEN || undefined,
      style: onlineMap
        ? "mapbox://styles/mapbox/satellite-streets-v12"
        : buildOfflineSatelliteStyle({ imageUrl: satelliteImage, coordinates: IMAGE_COORDINATES }),
      center: DEFAULT_CENTER,
      zoom: 17,
      attributionControl: onlineMap ? { compact: true } : false,
    });
    
    const draw = new MapboxDraw({ displayControlsDefault: false });

    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");
    let activeTool = "navigate";
    let anchor = null;
    let currentFeature = null;
    let radiusCenter = null;
    const history = [];
    const clearPreview = () => map.getSource("site-preview")?.setData(EMPTY);
    const remember = (nextFeature) => {
      history.push(currentFeature ? structuredClone(currentFeature) : null);
      currentFeature = nextFeature ? structuredClone(nextFeature) : null;
      setGeometry(currentFeature);
      setIsRadius(Boolean(radiusCenter));
      setHistoryLength(history.length);
      setSaveError("");
    };
    const finish = (feature) => {
      draw.deleteAll();
      const [featureId] = draw.add(feature);
      draw.changeMode("simple_select", { featureIds: [featureId] });
      remember(draw.get(featureId));
      anchor = null;
      clearPreview();
      activeTool = "navigate";
      map.getCanvas().style.cursor = "";
      setTool("navigate");
      setDrawingStatus("");
    };
    const buildFromAnchor = (end) => activeTool === "rectangle"
      ? buildSiteRectangle(anchor, end)
      : buildSiteRadius(anchor, distance(anchor, end, { units: "meters" }));

    map.on("load", () => {
      map.addSource("site-preview", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "site-preview-fill", type: "fill", source: "site-preview", paint: { "fill-color": color.green, "fill-opacity": 0.2 } });
      map.addLayer({ id: "site-preview-line", type: "line", source: "site-preview", paint: { "line-color": color.green, "line-width": 2, "line-dasharray": [2, 2] } });
      setMapReady(true);
    });
    map.on("error", (event) => setMapError(event.error?.message || "Map unavailable"));
    map.on("draw.create", (event) => {
      radiusCenter = null;
      const feature = event.features[0];
      const otherIds = draw.getAll().features.filter((entry) => entry.id !== feature.id).map((entry) => entry.id);
      draw.delete(otherIds);
      remember(feature);
      activeTool = "navigate";
      map.getCanvas().style.cursor = "";
      setTool("navigate");
      setDrawingStatus("");
    });
    map.on("draw.update", () => {
      radiusCenter = null;
      remember(draw.getAll().features[0] || null);
    });
    map.on("draw.delete", () => remember(null));
    map.on("click", (event) => {
      if (activeTool !== "rectangle" && activeTool !== "radius") return;
      const coordinate = [event.lngLat.lng, event.lngLat.lat];
      if (!anchor) {
        anchor = coordinate;
        setDrawingStatus(activeTool === "rectangle" ? "Choose opposite corner" : "Choose radius edge");
        return;
      }
      const feature = buildFromAnchor(coordinate);
      if (!summarizeSiteGeometry(feature).valid) return;
      radiusCenter = activeTool === "radius" ? [...anchor] : null;
      if (radiusCenter) setRadius(Math.round(distance(anchor, coordinate, { units: "meters" })));
      finish(feature);
    });
    map.on("mousemove", (event) => {
      if (!anchor) return;
      map.getSource("site-preview")?.setData(buildFromAnchor([event.lngLat.lng, event.lngLat.lat]));
    });

    controls.current = {
      selectTool(nextTool) {
        anchor = null;
        clearPreview();
        draw.changeMode("simple_select");
        activeTool = nextTool;
        if (nextTool === "point") draw.changeMode("draw_point");
        if (nextTool === "polygon") draw.changeMode("draw_polygon");
        map.getCanvas().style.cursor = nextTool === "navigate" ? "" : "crosshair";
        setTool(nextTool);
        setDrawingStatus(nextTool === "rectangle" ? "Choose first corner" : nextTool === "radius" ? "Choose center" : nextTool === "polygon" ? "Polygon in progress" : "");
      },
      undo() {
        if (draw.getMode() === "draw_polygon") {
          draw.trash();
          return;
        }
        if (anchor) {
          anchor = null;
          clearPreview();
          setDrawingStatus("Drawing reset");
          return;
        }
        if (!history.length) return;
        const previous = history.pop();
        draw.changeMode("simple_select");
        draw.set(previous ? { type: "FeatureCollection", features: [previous] } : EMPTY);
        currentFeature = previous;
        radiusCenter = null;
        setGeometry(previous);
        setIsRadius(false);
        setHistoryLength(history.length);
        activeTool = "navigate";
        map.getCanvas().style.cursor = "";
        setTool("navigate");
        setDrawingStatus("");
      },
      clear() {
        anchor = null;
        radiusCenter = null;
        clearPreview();
        draw.changeMode("simple_select");
        draw.deleteAll();
        remember(null);
        activeTool = "navigate";
        map.getCanvas().style.cursor = "";
        setTool("navigate");
        setDrawingStatus("");
      },
      locate(location) {
        map.flyTo({ center: [location.longitude, location.latitude], zoom: 16, essential: true });
      },
      resize() { map.resize(); },
      setRadius(meters) {
        if (!radiusCenter || !Number.isFinite(meters) || meters < 1 || meters > 50000) return;
        finish(buildSiteRadius(radiusCenter, meters));
      },
    };
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(mapContainer.current);
    return () => {
      observer.disconnect();
      controls.current = null;
      map.remove();
    };
  }, [onlineMap]);

  const selectResult = (location) => {
    controls.current?.locate(location);
    setQuery(location.name);
    setSearchOpen(false);
    setActiveResult(-1);
  };
  const save = async (event) => {
    event.preventDefault();
    if (!name.trim() || !summary.valid || tool !== "navigate" || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSave({
        id: `site-${crypto.randomUUID()}`,
        name: name.trim(), notes: notes.trim(),
        longitude: summary.center[0], latitude: summary.center[1],
        geometry: structuredClone(geometry), areaMeters: summary.areaMeters,
        offlineReady: false, createdAt: new Date().toISOString(),
      });
    } catch {
      setSaveError("Site could not be saved. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div className="create-site">
      <header className="create-site-heading">
        <button type="button" className="site-icon-button" onClick={onBack} aria-label="Back to Site Manager" title="Back to Site Manager"><ArrowLeft size={20} /></button>
        <div><h2>Create Site</h2><p>Define a survey area for your drone missions.</p></div>
      </header>

      <div className="site-search" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false);
      }}>
        <form onSubmit={(event) => { event.preventDefault(); const selected = results[activeResult] || results[0]; if (selected) selectResult(selected); }}>
          <Search size={17} aria-hidden="true" />
          <input
            role="combobox"
            aria-label="Search locations or coordinates"
            aria-expanded={searchOpen && Boolean(query.trim())}
            aria-controls="site-location-results"
            aria-autocomplete="list"
            aria-activedescendant={searchOpen && results[activeResult] ? `site-location-${activeResult}` : undefined}
            autoComplete="off"
            placeholder="Search a town, address or coordinates..."
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); setActiveResult(-1); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSearchOpen(false);
                setActiveResult(-1);
              }
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
                event.preventDefault();
                setSearchOpen(true);
                setActiveResult((previous) => previous < 0
                  ? event.key === "ArrowDown" ? 0 : results.length - 1
                  : (previous + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
              }
            }}
          />
        </form>
        {searchOpen && query.trim() && (
          <div id="site-location-results" role="listbox" aria-label="Location results" aria-busy={searchPending} className="site-search-results">
            {results.length ? results.map((location, index) => (
              <button key={location.id || location.name} id={`site-location-${index}`} role="option" aria-selected={activeResult === index} type="button" onClick={() => selectResult(location)}><MapPin size={16} /><span>{location.name}<small>{location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}</small></span></button>
            )) : <p role="status">{coordinateResults !== null
              ? "Invalid coordinates. Latitude must be between -85 and 85; longitude between -180 and 180."
              : query.trim().length < 2 ? "Enter at least two characters."
                : searchPending ? "Searching locations..."
                  : searchError || "No locations found. Try a more specific address or coordinates."}</p>}
          </div>
        )}
      </div>

      <div className="site-editor-heading"><h3>Site area editor</h3><span>{onlineMap ? "Satellite map" : "Offline image preview"}</span></div>
      <div className="site-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="site-drawing-tools">
          {TOOLS.map((entry) => <button key={entry.id} type="button" disabled={!mapReady} aria-pressed={tool === entry.id} title={entry.label} onClick={() => { setSearchOpen(false); controls.current?.selectTool(entry.id); }}>{entry.icon}<span>{entry.label}</span></button>)}
        </div>
        <div className="site-history-tools">
          <button type="button" className="site-icon-button" disabled={!mapReady || (!historyLength && tool === "navigate")} onClick={() => controls.current?.undo()} aria-label="Undo last action" title="Undo last action"><Undo2 size={17} /></button>
          <button type="button" className="site-icon-button" disabled={!mapReady} onClick={() => controls.current?.clear()} aria-label="Clear boundary" title="Clear boundary"><Trash2 size={17} /></button>
          <button type="button" className="site-icon-button" disabled={!mapReady} onClick={() => selectResult({ name: "EERL HQ, Ottawa", latitude: traceOrigin.latitude, longitude: traceOrigin.longitude })} aria-label="Return to HQ" title="Return to HQ"><LocateFixed size={17} /></button>
          <button type="button" className="site-icon-button" onClick={() => setDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen} aria-controls="site-details" aria-label="Toggle site details" title="Toggle site details">{detailsOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>
        </div>
      </div>

      <div className={`site-editor-workspace ${detailsOpen ? "" : "site-details-hidden"}`}>
        <div className="site-map-region">
          <div ref={mapContainer} className="site-map" aria-label="Survey boundary drawing map" />
          {!onlineMap && <span className="site-map-caption">{MAPBOX_TOKEN ? "Offline sample imagery" : "Sample imagery - Mapbox token not configured"}</span>}
          {mapError && <p role="alert" className="site-map-error">{mapError}</p>}
          <div className="site-map-readout" aria-live="polite">
            {drawingStatus || (geometry ? summary.isPoint ? "Sampling point selected" : `${(summary.areaMeters / 10000).toFixed(2)} ha · ${summary.widthMeters.toFixed(0)} × ${summary.heightMeters.toFixed(0)} m` : "No survey boundary")}
          </div>
        </div>

        {detailsOpen && <form id="site-details" className="site-details" onSubmit={save}>
          <h3>Site details</h3>
          <label htmlFor="site-name">Site name <span aria-hidden="true">*</span></label>
          <input id="site-name" required maxLength={120} placeholder="e.g. Colombia Landfill" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="site-notes">Notes <span>(optional)</span></label>
          <textarea id="site-notes" rows={3} maxLength={2000} placeholder="Survey purpose, access notes, etc." value={notes} onChange={(event) => setNotes(event.target.value)} />
          {isRadius && <><label htmlFor="site-radius">Radius (m)</label><input id="site-radius" type="number" min="1" max="50000" value={radius} onChange={(event) => { const value = Number(event.target.value); setRadius(event.target.value); controls.current?.setRadius(value); }} /></>}
          <dl className="site-measurements"><div><dt>Area</dt><dd>{summary.isPoint ? "Point" : `${(summary.areaMeters / 10000).toFixed(2)} ha`}</dd></div><div><dt>Boundary</dt><dd>{geometry ? geometry.geometry.type : "Not set"}</dd></div></dl>
          {summary.isPoint && <p className="site-point-warning">Sampling location only. A radius or area boundary is required for offline imagery.</p>}
          {geometry && !summary.valid && <p role="alert" className="site-point-warning">Boundary must not cross itself and must cover at least 1 m².</p>}
          <div className="site-save-area">
            <p aria-live="polite">{summary.valid && name.trim() && tool === "navigate" ? <><Check size={14} /> Ready to save</> : !summary.valid ? "Boundary required before saving" : tool !== "navigate" ? "Complete the current drawing before saving" : "Site name required before saving"}</p>
            {saveError && <p role="alert">{saveError}</p>}
            <button type="submit" disabled={!summary.valid || !name.trim() || tool !== "navigate" || saving}><Save size={16} />{saving ? "Saving..." : "Save site"}</button>
            <small>Session-only save · No imagery download</small>
          </div>
        </form>}
      </div>
    </div>
  );
}