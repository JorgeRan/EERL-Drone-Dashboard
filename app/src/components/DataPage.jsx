import { useCallback, useEffect, useMemo, useState } from "react";
import { color } from "../constants/tailwind";
import { RefreshCcw } from "lucide-react";
import { listMissions } from "../services/api";
import { CSVImportModal } from "./CSVModal";
import {
  extractTelemetryMetrics,
  toFiniteNumber,
} from "../constants/telemetryMetrics";

const PAGE_SIZE = 25;
const ALL_MISSIONS_OPTION = "ALL_MISSIONS";
const ALL_DRONES_OPTION = "ALL_DRONES";

const COLUMNS = [
  { key: "sampleIndex", label: "#", align: "right", width: "3rem" },
  { key: "time", label: "Time", align: "left", width: "7rem" },
  {
    key: "sensorMode",
    label: "Sensor",
    align: "left",
    width: "6.5rem",
  },
  {
    key: "methane",
    label: "Methane",
    align: "right",
    width: "6rem",
    unit: "ppm",
    decimals: 3,
  },
  {
    key: "acetylene",
    label: "Acetylene",
    align: "right",
    width: "6.5rem",
    unit: "ppm",
    decimals: 3,
  },
  {
    key: "nitrousOxide",
    label: "Nitrous Oxide",
    align: "right",
    width: "7.5rem",
    unit: "ppm",
    decimals: 3,
  },
  {
    key: "sniffer",
    label: "Sniffer",
    align: "right",
    width: "6rem",
    unit: "ppm",
    decimals: 3,
  },
  {
    key: "purway",
    label: "Purway",
    align: "right",
    width: "6rem",
    unit: "ppm-m",
    decimals: 3,
  },
  {
    key: "distance",
    label: "Distance",
    align: "right",
    width: "6rem",
    unit: "m",
    decimals: 1,
  },
  {
    key: "altitude",
    label: "Altitude",
    align: "right",
    width: "5.5rem",
    unit: "m",
    decimals: 1,
  },
  { key: "latitude", label: "Lat", align: "right", width: "7rem", decimals: 6 },
  {
    key: "longitude",
    label: "Lon",
    align: "right",
    width: "7rem",
    decimals: 6,
  },
  {
    key: "wind_u",
    label: "Wind U",
    align: "right",
    width: "5rem",
    unit: "m/s",
    decimals: 2,
  },
  {
    key: "wind_v",
    label: "Wind V",
    align: "right",
    width: "5rem",
    unit: "m/s",
    decimals: 2,
  },
  {
    key: "wind_w",
    label: "Wind W",
    align: "right",
    width: "5rem",
    unit: "m/s",
    decimals: 2,
  },
];

function SortIcon({ direction }) {
  if (!direction)
    return (
      <svg
        className="ml-1 inline-block opacity-25"
        width="10"
        height="10"
        viewBox="0 0 10 10"
      >
        <path
          d="M3 4l2-2 2 2M3 6l2 2 2-2"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (direction === "asc")
    return (
      <svg
        className="ml-1 inline-block"
        width="10"
        height="10"
        viewBox="0 0 10 10"
      >
        <path
          d="M2 7l3-4 3 4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg
      className="ml-1 inline-block"
      width="10"
      height="10"
      viewBox="0 0 10 10"
    >
      <path
        d="M2 3l3 4 3-4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div
      className="flex min-w-[130px] flex-1 flex-col gap-0.5 rounded-lg border px-4 py-3"
      style={{ backgroundColor: color.card, borderColor: color.border }}
    >
      <span
        className="text-[10px] uppercase tracking-widest"
        style={{ color: color.textDim }}
      >
        {label}
      </span>
      <span
        className="text-xl font-bold leading-tight"
        style={{ color: accent || color.text }}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[11px]" style={{ color: color.textMuted }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function exportCsv(rows, droneId) {
  const headers = COLUMNS.map(
    (c) => `${c.label}${c.unit ? ` (${c.unit})` : ""}`,
  );
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      COLUMNS.map((col) => {
        const val = row[col.key];
        if (val === null || val === undefined) return "";
        if (typeof val === "number" && col.decimals !== undefined)
          return val.toFixed(col.decimals);
        return String(val).replace(/,/g, ";");
      }).join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `telemetry_${droneId}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const normalizeMissionPoint = (point, index, droneId) => {
  const metrics = extractTelemetryMetrics(point);
  const timestampIso =
    point?.timestampIso ||
    point?.ts ||
    point?.timestamp ||
    new Date().toISOString();
  const rawTimestampMs = Number(point?.timestampMs);
  const derivedTimestampMs = new Date(timestampIso).getTime();
  const timestampMs = Number.isFinite(rawTimestampMs)
    ? rawTimestampMs
    : Number.isFinite(derivedTimestampMs)
      ? derivedTimestampMs
      : Date.now();

  return {
    sampleOrder: index,
    sampleIndex: index + 1,
    timestampMs,
    timestampIso,
    time:
      point?.time ||
      new Date(timestampMs).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    altitude: toFiniteNumber(point?.altitude),
    latitude: toFiniteNumber(point?.latitude),
    longitude: toFiniteNumber(point?.longitude),
    distance: toFiniteNumber(point?.distance),
    wind_u: toFiniteNumber(point?.wind_u),
    wind_v: toFiniteNumber(point?.wind_v),
    wind_w: toFiniteNumber(point?.wind_w),
    sensorMode: metrics.sensorMode,
    sniffer: metrics.sniffer,
    purway: metrics.purway,
    methane: metrics.methane,
    acetylene: metrics.acetylene,
    nitrousOxide: metrics.nitrousOxide,
    droneId,
  };
};

const flattenMissionRows = (results) =>
  (Array.isArray(results) ? results : [])
    .flatMap((entry) => {
      const droneId = entry?.drone || "unknown-drone";
      const data = Array.isArray(entry?.data) ? entry.data : [];
      return data.map((point, index) =>
        normalizeMissionPoint(point, index, droneId),
      );
    })
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((point, index) => ({
      ...point,
      sampleOrder: index,
      sampleIndex: index + 1,
    }));

export function DataPage({
  devices,
  sensorsMode,
  flowDataByDrone,
  selectedDeviceId,
  onSelectDevice,
  onImportComplete,
  onRefresh,
}) {
  const [sortKey, setSortKey] = useState("sampleIndex");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [csvModalFile, setCsvModalFile] = useState(null);
  const [importMessage, setImportMessage] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);
  const [missionsSample, setMissionsSample] = useState([]);
  const [selectedMissionId, setSelectedMissionId] = useState(ALL_MISSIONS_OPTION);
  const [selectedDroneFilterId, setSelectedDroneFilterId] = useState(
    selectedDeviceId || ALL_DRONES_OPTION,
  );

  const loadMissions = useCallback(async () => {
    const loadedMissions = await listMissions();
    setMissionsSample(loadedMissions);
  }, []);

  const openCsvPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = (event) => {
      const file = event.target.files?.[0] || null;
      if (file) setCsvModalFile(file);
    };
    input.click();
  };

  const refreshData = async () => {
    if (!onRefresh) {
      return;
    }

    setIsRefreshing(true);
    setRefreshMessage({ tone: "info", text: "Refreshing telemetry..." });
    try {
      const refreshed = await onRefresh();
      await loadMissions();
      setRefreshMessage(
        refreshed
          ? { tone: "success", text: "Data refreshed from backend" }
          : { tone: "warning", text: "Refresh completed, but no new rows were returned" },
      );
    } catch {
      setRefreshMessage({ tone: "error", text: "Refresh failed. Try again." });
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadMissions();
  }, [loadMissions]);

  useEffect(() => {
    if (!selectedDeviceId) {
      return;
    }

    setSelectedDroneFilterId((currentValue) =>
      currentValue === ALL_DRONES_OPTION ? currentValue : selectedDeviceId,
    );
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!refreshMessage || refreshMessage.tone === "info") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setRefreshMessage(null);
    }, 2800);

    return () => window.clearTimeout(timeoutId);
  }, [refreshMessage]);

  const allDataRows = useMemo(() => {
    return Object.entries(flowDataByDrone)
      .flatMap(([droneId, rows]) => {
        const safeRows = Array.isArray(rows) ? rows : [];
        return safeRows.map((row, index) =>
          normalizeMissionPoint(row, index, row?.droneId || droneId),
        );
      })
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((row, index) => ({
        ...row,
        sampleOrder: index,
        sampleIndex: index + 1,
      }));
  }, [flowDataByDrone]);

  const missions = useMemo(() => {
    return missionsSample
      .map((mission) => {
        const flowData = flattenMissionRows(mission?.results);
        const droneIds = Array.from(
          new Set(flowData.map((point) => point.droneId).filter(Boolean)),
        );

        return {
          id: mission.id,
          name: mission.name || "Untitled Mission",
          createdAt: mission.createdAt || null,
          flowData,
          droneIds,
          sampleCount: flowData.length,
        };
      })
      .filter((mission) => mission.sampleCount > 0);
  }, [missionsSample]);

  const missionOptions = useMemo(() => {
    const allDataDroneIds = Array.from(
      new Set(allDataRows.map((row) => row.droneId).filter(Boolean)),
    );

    return [
      {
        id: ALL_MISSIONS_OPTION,
        name: "All Data",
        flowData: allDataRows,
        droneIds: allDataDroneIds,
        sampleCount: allDataRows.length,
      },
      ...missions,
    ];
  }, [allDataRows, missions]);

  const selectedMission = useMemo(
    () =>
      missionOptions.find((mission) => mission.id === selectedMissionId) ||
      missionOptions[0] ||
      null,
    [missionOptions, selectedMissionId],
  );

  useEffect(() => {
    if (!missionOptions.length) {
      setSelectedMissionId(ALL_MISSIONS_OPTION);
      return;
    }

    const missionExists = missionOptions.some(
      (mission) => mission.id === selectedMissionId,
    );

    if (!missionExists) {
      setSelectedMissionId(missionOptions[0].id);
    }
  }, [missionOptions, selectedMissionId]);

  const droneOptions = useMemo(() => {
    const droneIds = selectedMission?.droneIds || [];
    return [
      { id: ALL_DRONES_OPTION, name: "All Drones" },
      ...droneIds.map((droneId) => {
        const deviceMatch = devices.find((device) => device.id === droneId);
        return {
          id: droneId,
          name: deviceMatch?.name || droneId,
        };
      }),
    ];
  }, [devices, selectedMission]);

  useEffect(() => {
    const droneExists = droneOptions.some(
      (drone) => drone.id === selectedDroneFilterId,
    );

    if (!droneExists) {
      setSelectedDroneFilterId(ALL_DRONES_OPTION);
    }
  }, [droneOptions, selectedDroneFilterId]);

  const rawRows = useMemo(() => {
    const sourceRows = selectedMission?.flowData || [];

    if (selectedDroneFilterId === ALL_DRONES_OPTION) {
      return sourceRows;
    }

    return sourceRows.filter((row) => row.droneId === selectedDroneFilterId);
  }, [selectedDroneFilterId, selectedMission]);

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rawRows;
    const q = filter.trim().toLowerCase();
    return rawRows.filter(
      (row) =>
        String(row.time).toLowerCase().includes(q) ||
        String(row.methane).includes(q) ||
        String(row.altitude).includes(q),
    );
  }, [rawRows, filter]);

  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageRows = sortedRows.slice(
    clampedPage * PAGE_SIZE,
    (clampedPage + 1) * PAGE_SIZE,
  );

  const stats = useMemo(() => {
    if (!rawRows.length) return null;
    const methaneVals = rawRows.map((r) => r.methane).filter(Number.isFinite);
    const altVals = rawRows.map((r) => r.altitude).filter(Number.isFinite);
    return {
      total: rawRows.length,
      avgMethane: methaneVals.length
        ? methaneVals.reduce((s, v) => s + v, 0) / methaneVals.length
        : 0,
      maxMethane: methaneVals.length ? Math.max(...methaneVals) : 0,
      minAlt: altVals.length ? Math.min(...altVals) : 0,
      maxAlt: altVals.length ? Math.max(...altVals) : 0,
    };
  }, [rawRows]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  };

  return (
    <>
    <div className="flex w-full flex-col gap-4 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-row items-center gap-4">
          <div>
            <p
              className="text-[11px] uppercase tracking-[0.16em]"
              style={{ color: color.green }}
            >
              Telemetry Log
            </p>
            <p className="text-xl font-bold" style={{ color: color.text }}>
              Data
            </p>
          </div>
          <div className="flex items-center">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={refreshData}
                disabled={isRefreshing}
                className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
                style={{
                  backgroundColor: color.text,
                  borderColor: color.text,
                  color: color.surface,
                  opacity: isRefreshing ? 0.7 : 1,
                }}
              >
                <RefreshCcw width={16} className={isRefreshing ? "animate-spin" : ""} />
                {isRefreshing ? "Refreshing..." : "Refresh Data"}
              </button>
              {refreshMessage ? (
                <div
                  className="rounded-full px-3 py-1 text-xs font-medium shadow-sm"
                  style={{
                    backgroundColor:
                      refreshMessage.tone === "success"
                        ? color.greenSoft
                        : refreshMessage.tone === "warning"
                          ? color.orangeSoft
                          : refreshMessage.tone === "error"
                            ? "rgba(248, 113, 113, 0.14)"
                            : color.surface,
                    color:
                      refreshMessage.tone === "success"
                        ? color.green
                        : refreshMessage.tone === "warning"
                          ? color.orange
                          : refreshMessage.tone === "error"
                            ? color.warning
                            : color.textMuted,
                    border: `1px solid ${
                      refreshMessage.tone === "success"
                        ? color.greenSoft
                        : refreshMessage.tone === "warning"
                          ? color.orangeSoft
                          : refreshMessage.tone === "error"
                            ? "rgba(248, 113, 113, 0.2)"
                            : color.border
                    }`,
                  }}
                >
                  {refreshMessage.text}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={selectedMissionId}
              onChange={(e) => {
                setSelectedMissionId(e.target.value);
                setSelectedDroneFilterId(ALL_DRONES_OPTION);
                setPage(0);
              }}
              className="appearance-none rounded-lg border py-2 pl-3 pr-8 text-sm font-medium focus:outline-none"
              style={{
                backgroundColor: color.card,
                borderColor: color.borderStrong,
                color: color.text,
              }}
            >
              {missionOptions.map((mission) => (
                <option
                  key={mission.id}
                  value={mission.id}
                  style={{ backgroundColor: color.card }}
                >
                  {mission.name}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
            >
              <path
                d="M2 4l4 4 4-4"
                stroke={color.textMuted}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="relative">
            <select
              value={selectedDroneFilterId}
              onChange={(e) => {
                const nextDroneId = e.target.value;
                setSelectedDroneFilterId(nextDroneId);
                if (
                  nextDroneId !== ALL_DRONES_OPTION &&
                  typeof onSelectDevice === "function"
                ) {
                  onSelectDevice(nextDroneId);
                }
                setPage(0);
              }}
              className="appearance-none rounded-lg border py-2 pl-3 pr-8 text-sm font-medium focus:outline-none"
              style={{
                backgroundColor: color.card,
                borderColor: color.borderStrong,
                color: color.text,
              }}
            >
              {droneOptions.map((drone) => (
                <option
                  key={drone.id}
                  value={drone.id}
                  style={{ backgroundColor: color.card }}
                >
                  {drone.name}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
            >
              <path
                d="M2 4l4 4 4-4"
                stroke={color.textMuted}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <input
            type="text"
            placeholder="Filter by time or value…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
            className="rounded-lg border py-2 pl-3 pr-3 text-sm focus:outline-none"
            style={{
              backgroundColor: color.card,
              borderColor: color.borderStrong,
              color: color.text,
              width: "200px",
            }}
          />

          <button
            type="button"
            onClick={() =>
              exportCsv(
                sortedRows,
                `${selectedMission?.name || "all-data"}_${selectedDroneFilterId}`,
              )
            }
            className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
            style={{
              backgroundColor: color.surface,
              borderColor: color.borderStrong,
              color: color.orange,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path
                d="M6.5 1v7M3.5 5l3 3 3-3M2 10h9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Export CSV
          </button>
          <button
            type="button"
            onClick={openCsvPicker}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
            style={{
              backgroundColor: color.surface,
              borderColor: color.borderStrong,
              color: color.green,
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 13 13"
              fill="none"
              transform="rotate(180)"
            >
              <path
                d="M6.5 1v7M3.5 5l3 3 3-3M2 10h9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Upload CSV
          </button>

          {importMessage && (
            <span
              className="text-xs"
              style={{
                color: importMessage.startsWith("Error")
                  ? color.warning
                  : color.green,
              }}
            >
              {importMessage}
            </span>
          )}
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-3">
          <StatCard
            label="Total Readings"
            value={stats.total.toLocaleString()}
          />
          <StatCard
            label="Avg CH4"
            value={`${stats.avgMethane.toFixed(3)}`}
            sub="ppm"
            accent={color.orange}
          />
          <StatCard
            label="Max CH4"
            value={`${stats.maxMethane.toFixed(3)}`}
            sub="ppm"
            accent={color.warning}
          />
          <StatCard
            label="Alt Range"
            value={`${stats.minAlt.toFixed(1)} – ${stats.maxAlt.toFixed(1)}`}
            sub="meters"
            accent={color.green}
          />
        </div>
      )}

      <div
        className="w-full overflow-x-auto rounded-lg border"
        style={{ borderColor: color.border }}
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ backgroundColor: color.surface }}>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="cursor-pointer select-none whitespace-nowrap border-b px-3 py-2.5 font-medium"
                  style={{
                    textAlign: col.align,
                    width: col.width,
                    borderColor: color.border,
                    color: sortKey === col.key ? color.orange : color.textMuted,
                  }}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {col.unit && (
                    <span
                      className="ml-0.5 text-[10px]"
                      style={{ color: color.textDim }}
                    >
                      {col.unit}
                    </span>
                  )}
                  <SortIcon direction={sortKey === col.key ? sortDir : null} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="py-10 text-center text-sm"
                  style={{ color: color.textDim, backgroundColor: color.card }}
                >
                  No data available for this mission and drone filter.
                </td>
              </tr>
            ) : (
              pageRows.map((row, rowIdx) => {
                const isEven = rowIdx % 2 === 0;
                const highlight = row.methane > 0;
                return (
                  <tr
                    key={row.sampleOrder}
                    style={{
                      backgroundColor: isEven ? color.card : color.cardMuted,
                    }}
                  >
                    {COLUMNS.map((col) => {
                      const val = row[col.key];
                      let display = val;
                      if (
                        typeof val === "number" &&
                        col.decimals !== undefined
                      ) {
                        display = val.toFixed(col.decimals);
                      }
                      const isMethane = col.key === "methane";
                      return (
                        <td
                          key={col.key}
                          className="whitespace-nowrap border-b px-3 py-2 font-mono text-xs"
                          style={{
                            textAlign: col.align,
                            borderColor: color.border,
                            color:
                              isMethane && highlight
                                ? color.orange
                                : color.textMuted,
                          }}
                        >
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs" style={{ color: color.textDim }}>
            {filteredRows.length.toLocaleString()} rows &nbsp;·&nbsp; page{" "}
            {clampedPage + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={clampedPage === 0}
              onClick={() => setPage(0)}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-30"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
                color: color.textMuted,
              }}
            >
              ««
            </button>
            <button
              type="button"
              disabled={clampedPage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-30"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
                color: color.textMuted,
              }}
            >
              ‹ Prev
            </button>

            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              const halfWindow = 3;
              let start = Math.max(0, clampedPage - halfWindow);
              const end = Math.min(totalPages - 1, start + 6);
              start = Math.max(0, end - 6);
              const pageNum = start + i;
              if (pageNum > end) return null;
              return (
                <button
                  key={pageNum}
                  type="button"
                  onClick={() => setPage(pageNum)}
                  className="rounded-md border px-2.5 py-1 text-xs"
                  style={{
                    backgroundColor:
                      pageNum === clampedPage
                        ? color.orangeSoft
                        : color.surface,
                    borderColor:
                      pageNum === clampedPage ? color.orange : color.border,
                    color:
                      pageNum === clampedPage ? color.orange : color.textMuted,
                  }}
                >
                  {pageNum + 1}
                </button>
              );
            })}

            <button
              type="button"
              disabled={clampedPage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-30"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
                color: color.textMuted,
              }}
            >
              Next ›
            </button>
            <button
              type="button"
              disabled={clampedPage >= totalPages - 1}
              onClick={() => setPage(totalPages - 1)}
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-30"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
                color: color.textMuted,
              }}
            >
              »»
            </button>
          </div>
        </div>
      )}
    </div>

    {csvModalFile && (
      <CSVImportModal
        file={csvModalFile}
        devices={devices}
        sensorsMode={sensorsMode}
        preferredDroneId={selectedDeviceId}
        onClose={() => setCsvModalFile(null)}
        onComplete={(msg) => {
          setImportMessage(msg);
          onImportComplete?.();
          void loadMissions();
          window.setTimeout(() => setImportMessage(null), 4000);
        }}
      />
    )}
    </>
  );
}

export default DataPage;
