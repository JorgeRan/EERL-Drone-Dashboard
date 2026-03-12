import React, { useEffect, useRef, useState } from "react";
import { tw, color } from "../constants/tailwind";

const latitude = 45.3844;
const longitude = -75.699;
const altitude = 10;
const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

let googleMaps3DLoader = null;

function loadGoogleMaps3D(apiKey) {
  if (!apiKey) {
    return Promise.reject(new Error("Missing Google Maps API key"));
  }

  if (window.customElements?.get("gmp-map-3d")) {
    return Promise.resolve();
  }

  if (googleMaps3DLoader) {
    return googleMaps3DLoader;
  }

  googleMaps3DLoader = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-google-maps-3d="true"]');

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Failed to load Google Maps 3D script")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps3d = "true";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=beta&libraries=maps3d`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Maps 3D script"));
    document.head.appendChild(script);
  });

  return googleMaps3DLoader;
}

export function Position() {
  const mapContainerRef = useRef(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!googleMapsApiKey || !mapContainerRef.current) {
      return undefined;
    }

    let isMounted = true;
    let mapElement = null;

    loadGoogleMaps3D(googleMapsApiKey)
      .then(() => {
        if (!isMounted || !mapContainerRef.current) {
          return;
        }

        mapContainerRef.current.innerHTML = "";
        mapElement = document.createElement("gmp-map-3d");
        mapElement.setAttribute("center", `${latitude}, ${longitude}, ${altitude}`);
        mapElement.setAttribute("range", "1200");
        mapElement.setAttribute("tilt", "68");
        mapElement.setAttribute("heading", "35");
        mapElement.setAttribute("mode", "hybrid");
        mapElement.style.display = "block";
        mapElement.style.width = "100%";
        mapElement.style.height = "100%";

        mapContainerRef.current.appendChild(mapElement);
        setLoadError("");
      })
      .catch((error) => {
        if (isMounted) {
          setLoadError(error.message || "Failed to load Google Maps 3D.");
        }
      });

    return () => {
      isMounted = false;
      if (mapContainerRef.current) {
        mapContainerRef.current.innerHTML = "";
      }
    };
  }, []);

  return (
    <div className={tw.panel} style={{ backgroundColor: color.card, padding: "0.75rem" }}>
      <div className="flex h-full w-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em]" style={{ color: color.green }}>
              3D position
            </p>
            <p className="text-xl font-bold tracking-tight" style={{ color: color.text }}>
              Terrain perspective
            </p>
          </div>
          <div
            className="rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: color.greenSoft, color: color.green }}
          >
            3D live
          </div>
        </div>

        <div className="my-1 flex flex-wrap gap-x-4 gap-y-2 text-sm" style={{ color: color.textMuted }}>
          <span>lat: {latitude.toFixed(4)}° N</span>
          <span>lon: {Math.abs(longitude).toFixed(4)}° W</span>
          <span>alt: {altitude} m</span>
        </div>

        {googleMapsApiKey ? (
          <div
            ref={mapContainerRef}
            className="min-h-[360px] w-full rounded-lg border"
            style={{ borderColor: color.border }}
          />
        ) : (
          <div
            className="flex min-h-[360px] w-full items-center justify-center rounded-lg border px-6 text-center"
            style={{
              backgroundColor: color.surface,
              borderColor: color.border,
              color: color.textMuted,
            }}
          >
            Set VITE_GOOGLE_MAPS_API_KEY in app/.env and restart the Vite dev server to load the Google 3D terrain view.
          </div>
        )}

        {loadError ? (
          <p className="text-sm" style={{ color: color.warning }}>
            {loadError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
