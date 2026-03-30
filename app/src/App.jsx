import { useCallback, useEffect, useMemo, useState } from "react";
import { tw, color } from "./constants/tailwind";
import { DeviceTabs } from "./components/Tabs";
import { MethanePanel } from "./components/MethanePanel";
import { Map } from "./components/Map";
import { WindPanel } from "./components/WindPanel";
import { Position } from "./components/3DPosition";
import { ResultsPage } from "./components/ResultsPage";
import {
  filterTraceDatasetBySelection,
  flowChartData,
  methaneTraceDataset,
} from "./data/methaneTraceData";
import logoSvg from "./assets/EERL_logo_black.svg";

const backendHttpUrl = (
  import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:3000`
).replace(/\/$/, "");
const backendWsBaseUrl = (
  import.meta.env.VITE_BACKEND_WS_URL || backendHttpUrl.replace(/^http/i, "ws")
).replace(/\/$/, "");

const devices = [
  {
    id: "M350",
    name: "M350",
    type: "Drone",
    status: "online",
  },
  {
    id: "M400-1",
    name: "M400-1",
    type: "Drone",
    status: "online",
  },
  {
    id: "M400-2",
    name: "M400-2",
    type: "Drone",
    status: "warning",
  },
];

const fallbackMaxSelectablePpm = Math.max(
  1,
  ...flowChartData.map((point) =>
    Math.max(point.sniffer, point.purway, point.methane),
  ),
);

const buildFlowDataFromHistory = (historyRows) => {
  const sortedRows = [...historyRows].sort(
    (a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime(),
  );

  return sortedRows.map((row, index) => {
    const payload = row.payload || {};
    const sniffer = Number(payload.sniffer_ppm ?? row.methane ?? 0);
    const purway = Number(payload.purway_ppn ?? row.purway_ppn ?? sniffer ?? 0);
    const methane = Number.isFinite((sniffer + purway) / 2)
      ? (sniffer + purway) / 2
      : 0;
    const timestampMs = new Date(row.ts || Date.now()).getTime();

    return {
      sampleOrder: index,
      sampleIndex: index + 1,
      timestampMs,
      timestampIso: row.ts,
      time: new Date(timestampMs).toLocaleTimeString(),
      sniffer: Number.isFinite(sniffer) ? sniffer : 0,
      purway: Number.isFinite(purway) ? purway : 0,
      methane: Number.isFinite(methane) ? methane : 0,
      altitude: Number(row.altitude ?? 0),
      latitude: Number(row.latitude ?? 0),
      longitude: Number(row.longitude ?? 0),
      wind_u: Number(payload.wind_u ?? 0),
      wind_v: Number(payload.wind_v ?? 0),
      wind_w: Number(payload.wind_w ?? 0),
      distance: row.distance ?? null,
    };
  });
};

const buildFlowPointFromTelemetry = (telemetryRow, sampleOrder) => {
  const payload = telemetryRow.payload || {};
  const sniffer = Number(payload.sniffer_ppm ?? telemetryRow.methane ?? 0);
  const purway = Number(
    payload.purway_ppn ?? payload.sniffer_ppm ?? telemetryRow.methane ?? 0,
  );
  const methane = Number.isFinite((sniffer + purway) / 2)
    ? (sniffer + purway) / 2
    : 0;
  const timestampMs = new Date(telemetryRow.ts || Date.now()).getTime();

  return {
    sampleOrder,
    sampleIndex: sampleOrder + 1,
    timestampMs,
    timestampIso: telemetryRow.ts,
    time: new Date(timestampMs).toLocaleTimeString(),
    sniffer: Number.isFinite(sniffer) ? sniffer : 0,
    purway: Number.isFinite(purway) ? purway : 0,
    methane: Number.isFinite(methane) ? methane : 0,
    altitude: Number(telemetryRow.altitude ?? 0),
    latitude: Number(telemetryRow.latitude ?? 0),
    longitude: Number(telemetryRow.longitude ?? 0),
    wind_u: Number(payload.wind_u ?? 0),
    wind_v: Number(payload.wind_v ?? 0),
    wind_w: Number(payload.wind_w ?? 0),
    distance: null,
  };
};

const buildTraceDatasetFromFlowData = (datasetFlowData) => ({
  type: "FeatureCollection",
  features: datasetFlowData
    .filter(
      (point) =>
        Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
    )
    .map((point) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [point.longitude, point.latitude],
      },
      properties: {
        id: `trace-${point.sampleOrder}`,
        sampleOrder: point.sampleOrder,
        sampleIndex: point.sampleIndex,
        timestampMs: point.timestampMs,
        timestampIso: point.timestampIso,
        timeLabel: point.time,
        altitude: point.altitude,
        sniffer: point.sniffer,
        purway: point.purway,
        methane: point.methane,
        detected: point.methane > 0,
        pointColor: point.methane > 0 ? "#4ade80" : "#64748b",
      },
    })),
});

function App() {
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0].id);
  const [flowDataByDrone, setFlowDataByDrone] = useState({});
  const [legendScale, setLegendScale] = useState({
    lowerLimit: 0,
    upperLimit: 5,
  });
  const liveFlowData = useMemo(() => {
    const selectedDroneData = flowDataByDrone[selectedDeviceId];
    if (Array.isArray(selectedDroneData) && selectedDroneData.length > 0) {
      return selectedDroneData;
    }

    return flowChartData;
  }, [flowDataByDrone, selectedDeviceId]);

  const maxSelectablePpm = Math.max(
    1,
    ...liveFlowData.map((point) =>
      Math.max(point.sniffer, point.purway, point.methane),
    ),
  );
  const [selectedWindow, setSelectedWindow] = useState({
    startIndex: 0,
    endIndex: liveFlowData.length - 1,
    ppmMin: 0,
    ppmMax: fallbackMaxSelectablePpm,
  });

  useEffect(() => {
    let isCancelled = false;

    const loadHistoryForDrone = async (droneId) => {
      try {
        console.log(`[App] Loading history for ${droneId} from ${backendHttpUrl}/api/drones/${droneId}/history`);
        const response = await fetch(
          `${backendHttpUrl}/api/drones/${droneId}/history?limit=1000`,
        );
        if (!response.ok) {
          console.warn(`[App] History fetch failed for ${droneId}: ${response.status} ${response.statusText}`);
          return;
        }

        const payload = await response.json();
        console.log(`[App] Got history for ${droneId}:`, payload.data?.length ?? 0, 'rows');
        if (
          isCancelled ||
          !Array.isArray(payload?.data) ||
          payload.data.length === 0
        ) {
          console.warn(`[App] No data for ${droneId} (cancelled=${isCancelled})`);
          return;
        }

        const flowData = buildFlowDataFromHistory(payload.data);
        console.log(`[App] Built flow data for ${droneId}:`, flowData.length, 'samples');
        setFlowDataByDrone((previous) => ({
          ...previous,
          [droneId]: flowData,
        }));
      } catch (error) {
        console.error(`[App] History fetch error for ${droneId}:`, error);
      }
    };

    devices.forEach((device) => {
      loadHistoryForDrone(device.id);
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const wsUrl = `${backendWsBaseUrl}/ws/telemetry`;
    let socket;

    try {
      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
          if (packet?.type !== "telemetry" || !packet.data?.drone_id) {
            return;
          }

          const droneId = packet.data.drone_id;
          setFlowDataByDrone((previous) => {
            const existingSeries = previous[droneId] || [];
            const nextPoint = buildFlowPointFromTelemetry(
              packet.data,
              existingSeries.length,
            );
            const nextSeries = [...existingSeries, nextPoint]
              .sort((a, b) => a.timestampMs - b.timestampMs)
              .slice(-1000)
              .map((point, index) => ({
                ...point,
                sampleOrder: index,
                sampleIndex: index + 1,
              }));

            return {
              ...previous,
              [droneId]: nextSeries,
            };
          });
        } catch {
          // Ignore malformed websocket payloads.
        }
      };
    } catch {
      // Keep history-driven view when websocket is unavailable.
    }

    return () => {
      socket?.close();
    };
  }, []);

  useEffect(() => {
    setSelectedWindow({
      startIndex: 0,
      endIndex: Math.max(0, liveFlowData.length - 1),
      ppmMin: 0,
      ppmMax: maxSelectablePpm,
    });
  }, [liveFlowData, maxSelectablePpm]);

  const activeTraceDataset = useMemo(
    () => buildTraceDatasetFromFlowData(liveFlowData),
    [liveFlowData],
  );

  const filteredTraceDataset = useMemo(
    () => filterTraceDatasetBySelection(activeTraceDataset, selectedWindow),
    [activeTraceDataset, selectedWindow],
  );

  const windSamples = useMemo(
    () =>
      liveFlowData.map((point) => ({
        u: point.wind_u ?? 0,
        v: point.wind_v ?? 0,
        w: point.wind_w ?? 0,
      })),
    [liveFlowData],
  );

  const latestPointByDrone = useMemo(() => {
    const entries = {};

    devices.forEach((device) => {
      const series = flowDataByDrone[device.id] || [];
      entries[device.id] = series.length ? series[series.length - 1] : null;
    });

    return entries;
  }, [flowDataByDrone]);

  const reloadHistory = useCallback(async (droneId) => {
    try {
      const response = await fetch(`${backendHttpUrl}/api/drones/${droneId}/history?limit=1000`);
      if (!response.ok) return false;

      const payload = await response.json();
      if (!Array.isArray(payload?.data) || payload.data.length === 0) return false;

      const flowData = buildFlowDataFromHistory(payload.data);
      const previousFlowData = flowDataByDrone[droneId] || [];
      const previousLastPoint = previousFlowData[previousFlowData.length - 1] || null;
      const nextLastPoint = flowData[flowData.length - 1] || null;
      const hasChanged =
        previousFlowData.length !== flowData.length ||
        previousLastPoint?.timestampIso !== nextLastPoint?.timestampIso ||
        previousLastPoint?.distance !== nextLastPoint?.distance ||
        previousLastPoint?.methane !== nextLastPoint?.methane;

      if (hasChanged) {
        setFlowDataByDrone((previous) => ({ ...previous, [droneId]: flowData }));
      }

      return hasChanged;
    } catch {
      return false;
    }
  }, [flowDataByDrone]);

  const reloadAllHistory = useCallback(async () => {
    const refreshResults = await Promise.all(
      devices.map((device) => reloadHistory(device.id)),
    );

    return refreshResults.some(Boolean);
  }, [reloadHistory]);

  const activeDevice =
    devices.find((device) => device.id === selectedDeviceId) || devices[0];
  const activePoint = latestPointByDrone[selectedDeviceId] || null;

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc] text-slate-900 font-sans">
      <header
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ backgroundColor: color.surface, borderColor: color.border }}
      >
        <div className="flex items-center gap-2">
          <img
            src={logoSvg}
            alt="EERL Logo"
            className="h-7 w-auto object-contain"
          />
          <span className="text-xs font-semibold tracking-[0.12em] uppercase" style={{ color: color.textMuted }}>
            Drone Monitor
          </span>
        </div>
        <nav className="flex items-center gap-1">
          {[{ id: 'dashboard', label: 'Dashboard' }, { id: 'results', label: 'Results' }].map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => setCurrentView(view.id)}
              className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
              style={{
                backgroundColor: currentView === view.id ? color.orangeSoft : 'transparent',
                color: currentView === view.id ? color.orange : color.textMuted,
              }}
            >
              {view.label}
            </button>
          ))}
        </nav>
      </header>

      <main
        className={`flex-1 bg-slate-100 ${color.text}`}
        style={{ backgroundColor: color.background, color: color.text }}
      >
        {currentView === 'results' ? (
          <ResultsPage
            devices={devices}
            flowDataByDrone={flowDataByDrone}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={setSelectedDeviceId}
            backendUrl={backendHttpUrl}
            onImportComplete={() => reloadHistory(selectedDeviceId)}
            onRefresh={reloadAllHistory}
          />
        ) : null}
        <section className={tw.shell} style={{ display: currentView === 'dashboard' ? undefined : 'none' }}>
          <div className="grid w-full gap-3 lg:grid-cols-[96px_minmax(0,1fr)]">
            <DeviceTabs
              devices={devices}
              activeDeviceId={selectedDeviceId}
              onSelectDevice={setSelectedDeviceId}
              latestPointByDrone={latestPointByDrone}
            />

            <div className="grid w-full gap-3">
              <div className="flex h-full w-full flex-row justify-between  items-center gap-3">
              <div
                className="flex-2 rounded-lg border px-4 py-3"
                style={{
                  backgroundColor: color.card,
                  borderColor: color.border,
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p
                      className="text-[11px] uppercase tracking-[0.16em]"
                      style={{ color: color.green }}
                    >
                      Active Drone
                    </p>
                    <p
                      className="text-xl font-bold tracking-tight"
                      style={{ color: color.text }}
                    >
                      {activeDevice.name}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="rounded-full px-3 py-1"
                      style={{
                        backgroundColor: color.surface,
                        color: color.textMuted,
                      }}
                    >
                      Type {activeDevice.type}
                    </span>
                    <span
                      className="rounded-full px-3 py-1"
                      style={{
                        backgroundColor: color.orangeSoft,
                        color: color.orange,
                      }}
                    >
                      CH4 {Number(activePoint?.methane ?? 0).toFixed(2)} ppm
                    </span>
                    <span
                      className="rounded-full px-3 py-1"
                      style={{
                        backgroundColor: color.greenSoft,
                        color: color.green,
                      }}
                    >
                      Alt {Number(activePoint?.altitude ?? 0).toFixed(1)} m
                    </span>
                  </div>
                </div>
              </div>
              
              </div>

              <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
                <Map
                  traceDataset={filteredTraceDataset}
                  onScaleChange={setLegendScale}
                  selectedDroneId={selectedDeviceId}
                />
                <Position
                  traceDataset={filteredTraceDataset}
                  lowerLimit={legendScale.lowerLimit}
                  upperLimit={legendScale.upperLimit}
                  selectedDroneId={selectedDeviceId}
                />
              </div>

              <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
                <MethanePanel
                  flowData={liveFlowData}
                  selection={selectedWindow}
                  onSelectionChange={setSelectedWindow}
                />
                <WindPanel windSamples={windSamples} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
