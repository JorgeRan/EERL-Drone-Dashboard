import { useEffect, useMemo, useState } from "react";
import { color } from "../constants/tailwind";
import { Trash2, RefreshCcw } from "lucide-react";

const PAGE_SIZE = 25;

const COLUMNS = [
  { key: "sampleIndex", label: "#", align: "right", width: "3rem" },
  { key: "time", label: "Time", align: "left", width: "7rem" },
  {
    key: "methane",
    label: "CH4 avg",
    align: "right",
    width: "6rem",
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
    unit: "ppb",
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

export function ResultsPage({
  devices,
  flowDataByDrone,
  selectedDeviceId,
  onSelectDevice,
  backendUrl,
  onImportComplete,
  onRefresh,
}) {
  const [sortKey, setSortKey] = useState("sampleIndex");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [importStatus, setImportStatus] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState(null);

  const importCsv = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = (event) => {
      const file = event.target.files?.[0] || null;
      setSelectedFile(file);
      setImportStatus(null);
    };
    input.click();
  };

  const mergeData = async () => {
    if (!selectedFile) return;
    setImportStatus("Parsing…");
    try {
      const text = await selectedFile.text();
      const lines = text.trim().split("\n");
      if (lines.length < 2) {
        setImportStatus("Error: CSV is empty");
        return;
      }
      const headers = lines[0].split(",").map((h) => h.trim());
      const timeIdx = headers.indexOf("time");
      const methaneIdx = headers.indexOf("methane_concentration");
      const distanceIdx = headers.indexOf("distance");
      if (timeIdx === -1 || distanceIdx === -1) {
        setImportStatus("Error: CSV must have 'time' and 'distance' columns");
        return;
      }
      const rows = [];
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cols = line.split(",");
        const rawTime = cols[timeIdx]?.trim();
        if (!rawTime) continue;
        // Parse "2026-03-10_00:55:57:164" → ISO UTC
        const [datePart, timePart] = rawTime.split("_");
        const tp = timePart?.split(":");
        if (!tp || tp.length < 4) continue;
        const isoTime = `${datePart}T${tp[0]}:${tp[1]}:${tp[2]}.${tp[3]}Z`;
        const tsMs = new Date(isoTime).getTime();
        if (!Number.isFinite(tsMs)) continue;
        const methane = parseFloat(cols[methaneIdx]) || 0;
        const distance = parseFloat(cols[distanceIdx]);
        if (!Number.isFinite(distance)) continue;
        rows.push({ tsMs, methane, distance });
      }
      if (rows.length === 0) {
        setImportStatus("Error: no valid rows found in CSV");
        return;
      }
      setImportStatus(`Uploading ${rows.length} rows…`);
      const response = await fetch(
        `${backendUrl}/api/drones/${selectedDeviceId}/import-distance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows }),
        },
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setImportStatus(`Error: ${err.error || response.statusText}`);
        return;
      }
      const result = await response.json();
      setImportStatus(`Done: ${result.updated}/${result.total} rows matched`);
      onImportComplete?.();
    } catch (err) {
      setImportStatus(`Error: ${err.message}`);
    }
  };

  const refreshData = async () => {
    if (!onRefresh) {
      return;
    }

    setIsRefreshing(true);
    setRefreshMessage({ tone: "info", text: "Refreshing telemetry..." });
    try {
      const refreshed = await onRefresh();
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
    if (!refreshMessage || refreshMessage.tone === "info") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setRefreshMessage(null);
    }, 2800);

    return () => window.clearTimeout(timeoutId);
  }, [refreshMessage]);

  const rawRows = useMemo(
    () => flowDataByDrone[selectedDeviceId] || [],
    [flowDataByDrone, selectedDeviceId],
  );

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
              Results
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
              value={selectedDeviceId}
              onChange={(e) => {
                onSelectDevice(e.target.value);
                setPage(0);
              }}
              className="appearance-none rounded-lg border py-2 pl-3 pr-8 text-sm font-medium focus:outline-none"
              style={{
                backgroundColor: color.card,
                borderColor: color.borderStrong,
                color: color.text,
              }}
            >
              {devices.map((d) => (
                <option
                  key={d.id}
                  value={d.id}
                  style={{ backgroundColor: color.card }}
                >
                  {d.name}
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
            onClick={() => exportCsv(sortedRows, selectedDeviceId)}
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
            onClick={() => importCsv()}
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

          {selectedFile && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-row items-center gap-6">
                <div className="flex flex-row items-center gap-1">
                  <span className="text-xs" style={{ color: color.textDim }}>
                    {selectedFile.name}
                  </span>
                  <button onClick={() => setSelectedFile(null)}>
                    <Trash2
                      width={20}
                      height={20}
                      style={{ color: color.textDim }}
                    />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={mergeData}
                  className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    backgroundColor: color.greenSoft,
                    borderColor: color.greenSoft,
                    color: color.green,
                  }}
                >
                  Merge Data
                </button>
              </div>
              {importStatus && (
                <span
                  className="text-xs"
                  style={{
                    color: importStatus.startsWith("Error")
                      ? color.warning
                      : color.green,
                  }}
                >
                  {importStatus}
                </span>
              )}
            </div>
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
                  No data available for this drone.
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
  );
}

export default ResultsPage;
