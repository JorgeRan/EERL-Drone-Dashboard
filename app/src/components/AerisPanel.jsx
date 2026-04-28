import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from "recharts";
import { color } from "../constants/tailwind";

const seriesTheme = {
  methane: {
    label: "ppm",
    valueLabel: "Methane",
    stroke: color.orange,
    fill: "rgba(253, 148, 86, 0.26)",
  },
  acetylene: {
    label: "ppm",
    valueLabel: "Acetylene",
    stroke: color.green,
    fill: "rgba(106, 214, 194, 0.30)",
  },
  nitrousOxide: {
    label: "ppm",
    valueLabel: "Nitrous Oxide",
    stroke: color.blue,
    fill: "rgba(86, 142, 255, 0.30)",
  },
};

const chartConfigs = [
  {
    key: "methane",
    axisLabel: "CH4 ppm",
  },
  {
    key: "acetylene",
    axisLabel: "C2H2 ppm",
  },
  {
    key: "nitrousOxide",
    axisLabel: "N2O ppm",
  },
];

const chartFrame = {
  top: 72,
  bottom: 34,
  left: 52,
  right: 12,
};

const formatTooltipValue = (value) => {
  if (value === null || value === undefined) {
    return "--";
  }

  if (typeof value === "string" && value.trim() === "") {
    return "--";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "--";
};

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function clampSelection(selection, dataLength, maxPpm) {
  const minimumPpmBand = Math.min(Math.max(maxPpm * 0.02, 0.1), maxPpm);

  if (dataLength <= 1) {
    return {
      startIndex: 0,
      endIndex: 0,
      ppmMin: 0,
      ppmMax: maxPpm,
    };
  }

  const safeStart = Math.max(0, Math.min(selection.startIndex, dataLength - 2));
  const safeEnd = Math.max(
    safeStart + 1,
    Math.min(selection.endIndex, dataLength - 1),
  );

  if (maxPpm <= minimumPpmBand) {
    return {
      startIndex: safeStart,
      endIndex: safeEnd,
      ppmMin: 0,
      ppmMax: maxPpm,
    };
  }

  const safePpmMin = Math.max(
    0,
    Math.min(selection.ppmMin ?? 0, maxPpm - minimumPpmBand),
  );
  const safePpmMax = Math.max(
    safePpmMin + minimumPpmBand,
    Math.min(selection.ppmMax ?? maxPpm, maxPpm),
  );

  return {
    startIndex: safeStart,
    endIndex: safeEnd,
    ppmMin: safePpmMin,
    ppmMax: safePpmMax,
  };
}

export function AerisPanel({
  flowData,
  selection,
  onSelectionChange,
  resultsPageMode,
  onAnalyze,
  analyzeBusy = false,
  initialTracerRates,
  tracerAvailability,
}) {
  const chartId = useId().replace(/:/g, "");
  const navigatorRef = useRef(null);
  const ppmRangeRef = useRef(null);
  const dragHandleRef = useRef(null);
  const [acetyleneTracerRate, setAcetyleneTracerRate] = useState(
    initialTracerRates?.acetylene ?? "",
  );
  const [nitrousOxideTracerRate, setNitrousOxideTracerRate] = useState(
    initialTracerRates?.nitrousOxide ?? "",
  );
  const hasAcetyleneTracer = tracerAvailability?.acetylene ?? true;
  const hasNitrousOxideTracer = tracerAvailability?.nitrousOxide ?? true;
  const dataLength = flowData.length;
  const maxIndex = Math.max(dataLength - 1, 0);
  // Robustly compute the peak value across all series, fallback to 1 if empty
  const allValues = [
    ...flowData.map((point) => Number(point?.methane ?? 0)),
    ...flowData.map((point) => Number(point?.acetylene ?? 0)),
    ...flowData.map((point) => Number(point?.nitrousOxide ?? 0)),
  ].filter((v) => Number.isFinite(v));
  const fullPeakValue = allValues.length
    ? Math.max(1, allValues.reduce((max, v) => Math.max(max, v), -Infinity))
    : 1;
  
  const safeSelection = useMemo(
    () => clampSelection(selection, dataLength, fullPeakValue),
    [selection, dataLength, fullPeakValue],
  );
  const peakValueBySeries = useMemo(
    () =>
      chartConfigs.reduce((accumulator, chart) => {
        accumulator[chart.key] = Math.max(
          1,
          ...flowData.map((point) => Number(point?.[chart.key] ?? 0)),
        );
        return accumulator;
      }, {}),
    [flowData],
  );
  const windowedData = useMemo(
    () => flowData.slice(safeSelection.startIndex, safeSelection.endIndex + 1),
    [flowData, safeSelection],
  );
  const latestPoint = windowedData[windowedData.length - 1] ??
    flowData[dataLength - 1] ?? { acetylene: 0, methane: 0, nitrousOxide: 0 };
  const fullTicks = [
    0,
    Math.ceil(fullPeakValue * 0.35),
    Math.ceil(fullPeakValue * 0.7),
    Math.ceil(fullPeakValue),
  ];
  const plotFrameWidth = Math.max(1, 100 - chartFrame.left - chartFrame.right);
  const startPercent =
    maxIndex > 0 ? (safeSelection.startIndex / maxIndex) * 100 : 0;
  const endPercent =
    maxIndex > 0 ? (safeSelection.endIndex / maxIndex) * 100 : 100;
  const ppmMinPercent =
    fullPeakValue > 0
      ? 100 - (safeSelection.ppmMin / fullPeakValue) * 100
      : 100;
  const ppmMaxPercent =
    fullPeakValue > 0 ? 100 - (safeSelection.ppmMax / fullPeakValue) * 100 : 0;
  const windowStart = windowedData[0];
  const windowEnd = windowedData[windowedData.length - 1];
  const deltaTime = formatDuration(
    (windowEnd?.timestampMs ?? 0) - (windowStart?.timestampMs ?? 0),
  );

  useEffect(() => {
    setAcetyleneTracerRate(initialTracerRates?.acetylene ?? "");
    setNitrousOxideTracerRate(initialTracerRates?.nitrousOxide ?? "");
  }, [initialTracerRates?.acetylene, initialTracerRates?.nitrousOxide]);

  useEffect(() => {
    const minimumPpmBand = Math.min(
      Math.max(fullPeakValue * 0.02, 0.1),
      fullPeakValue,
    );

    const updateTimeSelectionFromClientX = (clientX) => {
      if (!navigatorRef.current || maxIndex <= 0) {
        return;
      }

      const bounds = navigatorRef.current.getBoundingClientRect();
      const plotLeft = bounds.left + chartFrame.left;
      const plotWidth = Math.max(
        bounds.width - chartFrame.left - chartFrame.right,
        1,
      );
      const clampedRatio = Math.max(
        0,
        Math.min((clientX - plotLeft) / plotWidth, 1),
      );
      const nextIndex = Math.round(clampedRatio * maxIndex);

      if (dragHandleRef.current?.handle === "start") {
        onSelectionChange({
          ...safeSelection,
          startIndex: Math.min(nextIndex, safeSelection.endIndex - 1),
        });
        return;
      }

      onSelectionChange({
        ...safeSelection,
        endIndex: Math.max(nextIndex, safeSelection.startIndex + 1),
      });
    };

    const updatePpmSelectionFromClientY = (clientY) => {
      if (!ppmRangeRef.current || fullPeakValue <= 0) {
        return;
      }

      const bounds = ppmRangeRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min(1 - (clientY - bounds.top) / bounds.height, 1),
      );
      const nextPpm = Number((clampedRatio * fullPeakValue).toFixed(2));

      if (dragHandleRef.current?.handle === "ppmMin") {
        onSelectionChange({
          ...safeSelection,
          ppmMin: Math.min(nextPpm, safeSelection.ppmMax - minimumPpmBand),
        });
        return;
      }

      onSelectionChange({
        ...safeSelection,
        ppmMax: Math.max(nextPpm, safeSelection.ppmMin + minimumPpmBand),
      });
    };

    const handlePointerMove = (event) => {
      if (!dragHandleRef.current) {
        return;
      }

      if (dragHandleRef.current.axis === "x") {
        updateTimeSelectionFromClientX(event.clientX);
        return;
      }

      updatePpmSelectionFromClientY(event.clientY);
    };

    const handlePointerUp = () => {
      dragHandleRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    fullPeakValue,
    maxIndex,
    onSelectionChange,
    safeSelection.endIndex,
    safeSelection.ppmMax,
    safeSelection.ppmMin,
    safeSelection.startIndex,
  ]);

  const beginHandleDrag = (axis, handle) => (event) => {
    event.preventDefault();
    dragHandleRef.current = { axis, handle };
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (axis === "x" && navigatorRef.current && maxIndex > 0) {
      const bounds = navigatorRef.current.getBoundingClientRect();
      const plotLeft = bounds.left + chartFrame.left;
      const plotWidth = Math.max(
        bounds.width - chartFrame.left - chartFrame.right,
        1,
      );
      const clampedRatio = Math.max(
        0,
        Math.min((event.clientX - plotLeft) / plotWidth, 1),
      );
      const nextIndex = Math.round(clampedRatio * maxIndex);

      if (handle === "start") {
        onSelectionChange({
          ...safeSelection,
          startIndex: Math.min(nextIndex, safeSelection.endIndex - 1),
        });
      } else {
        onSelectionChange({
          ...safeSelection,
          endIndex: Math.max(nextIndex, safeSelection.startIndex + 1),
        });
      }

      return;
    }

    if (axis === "y" && ppmRangeRef.current && fullPeakValue > 0) {
      const minimumPpmBand = Math.min(
        Math.max(fullPeakValue * 0.02, 0.1),
        fullPeakValue,
      );
      const bounds = ppmRangeRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min(1 - (event.clientY - bounds.top) / bounds.height, 1),
      );
      const nextPpm = Number((clampedRatio * fullPeakValue).toFixed(2));

      if (handle === "ppmMin") {
        onSelectionChange({
          ...safeSelection,
          ppmMin: Math.min(nextPpm, safeSelection.ppmMax - minimumPpmBand),
        });
      } else {
        onSelectionChange({
          ...safeSelection,
          ppmMax: Math.max(nextPpm, safeSelection.ppmMin + minimumPpmBand),
        });
      }
    }
  };

  return (
    <div
      className="flex h-full w-full flex-col gap-3 p-3 rounded-lg"
      style={{ backgroundColor: color.card }}
    >
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h3
            className="text-xl font-bold tracking-tight text-nowrap"
            style={{ color: color.text }}
          >
            Methane, Acetylene and Nitrous Oxide Levels
          </h3>
          <p
            className="mt-1 text-xs uppercase tracking-[0.12em]"
            style={{ color: color.textMuted }}
          >
            Window {windowStart?.time ?? "--"} to {windowEnd?.time ?? "--"}
          </p>
        </div>

        {resultsPageMode ? (
          <div
            className="grid w-full grid-cols-1 gap-2.5 rounded-xl md:max-w-[720px] md:grid-cols-2"
            // style={{
            //   background:
            //     "linear-gradient(145deg, rgba(17, 25, 40, 0.52), rgba(17, 25, 40, 0.2))",
            //   borderColor: color.borderStrong,
            // }}
          >
            <label
              className="relative rounded-lg border px-3 py-2"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.02)",
                borderColor: color.border,
              }}
            >
              <div
                className="mb-1 text-[10px] uppercase tracking-[0.14em]"
                style={{ color: color.green }}
              >
                Acetylene Tracer
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  placeholder={hasAcetyleneTracer ? "0.0" : "No tracer in selection"}
                  value={acetyleneTracerRate}
                  onChange={(event) =>
                    setAcetyleneTracerRate(event.target.value)
                  }
                  disabled={!hasAcetyleneTracer}
                  className="w-full bg-transparent text-sm font-semibold outline-none"
                  style={{ color: color.text }}
                />
                <span
                  className="shrink-0 rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                  style={{
                    color: color.text,
                    backgroundColor: "rgba(106, 214, 194, 0.18)",
                  }}
                >
                  ln/min
                </span>
              </div>
            </label>
            <label
              className="relative rounded-lg border px-3 py-2"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.02)",
                borderColor: color.border,
              }}
            >
              <div
                className="mb-1 text-[10px] uppercase tracking-[0.14em]"
                style={{ color: color.blue }}
              >
                Nitrous Oxide Tracer
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  placeholder={hasNitrousOxideTracer ? "0.0" : "No tracer in selection"}
                  value={nitrousOxideTracerRate}
                  onChange={(event) =>
                    setNitrousOxideTracerRate(event.target.value)
                  }
                  disabled={!hasNitrousOxideTracer}
                  className="w-full bg-transparent text-sm font-semibold outline-none"
                  style={{ color: color.text }}
                />
                <span
                  className="shrink-0 rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                  style={{
                    color: color.text,
                    backgroundColor: "rgba(86, 142, 255, 0.18)",
                  }}
                >
                  ln/min
                </span>
              </div>
            </label>
          </div>
        ) : null}

        {resultsPageMode ? (
          <div>
            <button
              className="rounded-md px-3 py-1.5 font-medium"
              style={{
                color: color.text,
                backgroundColor: color.orange,
                borderColor: color.orange,
              }}
              onClick={() => {
                if (typeof onAnalyze === "function") {
                  onAnalyze({
                    acetyleneTracerRate: hasAcetyleneTracer ? acetyleneTracerRate : "",
                    nitrousOxideTracerRate: hasNitrousOxideTracer ? nitrousOxideTracerRate : "",
                  });
                  return;
                }

                onSelectionChange(null);
              }}
              disabled={analyzeBusy}
            >
              <span className="lg:text-nowrap">
                {analyzeBusy ? "Analyzing..." : "Run Analysis"}
              </span>
            </button>
          </div>
        ) : (
          <div
            className="rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: color.orangeSoft, color: color.orange }}
          >
            Live
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {Object.entries(seriesTheme).map(([sensorKey, theme]) => {
          const latestValue = Number(latestPoint?.[sensorKey] ?? 0);

          return (
            <div
              key={sensorKey}
              className="rounded-lg border px-3 py-2.5"
              style={{
                backgroundColor: color.surface,
                borderColor: color.border,
              }}
            >
              <div
                className="text-[13px] uppercase tracking-[0.12em]"
                style={{ color: color.textMuted }}
              >
                {theme.valueLabel}
              </div>
              <div
                className="mt-1 flex flex-row text-lg font-semibold leading-none"
                style={{ color: theme.stroke }}
              >
                {latestValue.toFixed(1)}
                <p
                  className="ms-1 mt-1.5 text-[11px] uppercase tracking-[0.12em]"
                  style={{ color: color.textMuted }}
                >
                  {theme.label}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div
        ref={navigatorRef}
        className="relative min-h-[700px] rounded-xl border p-3 select-none"
        style={{
          backgroundColor: color.surface,
          borderColor: color.border,
          touchAction: "none",
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div
            className="flex flex-row-1 justify-evenly text-right w-full text-[11px] uppercase tracking-[0.12em]"
            style={{ color: color.textMuted }}
          >
            <div className="flex flex-row gap-4">
              <div>
                T1 = {windowStart?.time ?? "--"}
              </div>
              <div>
                T2 = {windowEnd?.time ?? "--"}
              </div>
            </div>
            <div className="flex items-center">ΔT = {deltaTime}</div>
          </div>
        </div>

        <div className="space-y-4 w-full">
          {chartConfigs.map((chart) => {
            const theme = seriesTheme[chart.key];
            const seriesPeakValue = peakValueBySeries[chart.key] ?? 1;
            const seriesTicks = [
              0,
              Math.ceil(seriesPeakValue * 0.35),
              Math.ceil(seriesPeakValue * 0.7),
              Math.ceil(seriesPeakValue),
            ];

            return (
              <div key={chart.key} className="h-[180px] w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
                  <AreaChart
                    data={flowData}
                    margin={{ top: 8, right: 6, left: 8, bottom: 18 }}
                  >
                    <defs>
                      <linearGradient
                        id={`flowGradient-${chartId}-${chart.key}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={theme.fill}
                          stopOpacity={0.95}
                        />
                        <stop
                          offset="70%"
                          stopColor={theme.fill}
                          stopOpacity={0.34}
                        />
                        <stop
                          offset="100%"
                          stopColor={theme.fill}
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="4 4"
                      stroke={color.borderStrong}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="time"
                      stroke={color.textDim}
                      style={{ fontSize: "11px" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                    />
                    <YAxis
                      stroke={color.textDim}
                      tickLine={false}
                      axisLine={{ stroke: color.borderStrong }}
                      width={44}
                      style={{ fontSize: "11px" }}
                      ticks={seriesTicks}
                      tick={{ fill: color.text, fontSize: 11 }}
                      label={{
                        value: chart.axisLabel,
                        angle: -90,
                        position: "insideLeft",
                        offset: 0,
                        fill: color.text,
                        fontSize: 11,
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: color.surface,
                        border: `1px solid ${color.borderStrong}`,
                        borderRadius: "8px",
                        color: color.text,
                      }}
                      labelFormatter={(value, payload) => {
                        const point = payload?.[0]?.payload;
                        return point?.timestampIso ?? value;
                      }}
                      formatter={(value) => formatTooltipValue(value)}
                      labelStyle={{ color: color.text }}
                    />
                    {safeSelection.startIndex > 0 ? (
                      <ReferenceArea
                        x1={flowData[0]?.time}
                        x2={flowData[safeSelection.startIndex]?.time}
                        fill="rgba(3, 7, 18, 0.62)"
                        ifOverflow="extendDomain"
                      />
                    ) : null}
                    {safeSelection.endIndex < maxIndex ? (
                      <ReferenceArea
                        x1={flowData[safeSelection.endIndex]?.time}
                        x2={flowData[maxIndex]?.time}
                        fill="rgba(3, 7, 18, 0.62)"
                        ifOverflow="extendDomain"
                      />
                    ) : null}
                    <Area
                      type="monotone"
                      dataKey={chart.key}
                      stroke={theme.stroke}
                      strokeWidth={2.3}
                      fill={`url(#flowGradient-${chartId}-${chart.key})`}
                      fillOpacity={0.18}
                      isAnimationActive={false}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: theme.stroke }}
                    />
                    <Line
                      type="monotone"
                      dataKey={chart.key}
                      stroke={theme.stroke}
                      strokeWidth={2.3}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>

        <div
          className="pointer-events-none absolute"
          style={{
            top: `${chartFrame.top}px`,
            right: `${chartFrame.right}px`,
            bottom: `${chartFrame.bottom}px`,
            left: `${chartFrame.left}px`,
          }}
        >
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: `${startPercent}%`,
              width: `${Math.max(endPercent - startPercent, 0)}%`,
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            }}
          />
        </div>

        <div
          ref={ppmRangeRef}
          className="absolute"
          style={{
            top: `${chartFrame.top}px`,
            right: `${chartFrame.right}px`,
            bottom: `${chartFrame.bottom}px`,
            left: `${chartFrame.left}px`,
            pointerEvents: "none",
          }}
        >
          <div
            className="absolute left-0 right-2"
            style={{
              top: `${ppmMaxPercent}%`,
              height: `${Math.max(ppmMinPercent - ppmMaxPercent, 0)}%`,
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            }}
          />
        </div>

        <div
          className="pointer-events-none absolute"
          style={{
            top: `${chartFrame.top}px`,
            right: `${chartFrame.right}px`,
            bottom: `${chartFrame.bottom}px`,
            left: `${chartFrame.left}px`,
          }}
        >
          <button
            type="button"
            aria-label="Adjust selection start"
            className="pointer-events-auto absolute bottom-[20px] w-8 -translate-x-1 cursor-ew-resize bg-transparent"
            style={{
              top: "-20px",
              left: `${startPercent}%`,
            }}
            onPointerDown={beginHandleDrag("x", "start")}
          >
            <span
              className="absolute left-1/2 top-0 h-full -translate-x-1/2"
              style={{
                width: "2px",
                backgroundColor: color.text,
                boxShadow: `0 0 0 1px ${color.orangeSoft}, 0 0 10px rgba(253, 148, 86, 0.25)`,
              }}
            />
            <span
              className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                backgroundColor: color.card,
                color: color.text,
                border: `1px solid ${color.text}`,
              }}
            >
              T1
            </span>
          </button>

          <button
            type="button"
            aria-label="Adjust selection end"
            className="pointer-events-auto absolute bottom-[20px] w-8 -translate-x-1/2 cursor-ew-resize bg-transparent"
            style={{
              top: "-20px",
              left: `${endPercent}%`,
            }}
            onPointerDown={beginHandleDrag("x", "end")}
          >
            <span
              className="absolute left-1/2 top-0 h-full -translate-x-1/2"
              style={{
                width: "2px",
                backgroundColor: color.text,
                boxShadow: `0 0 0 1px ${color.greenSoft}, 0 0 10px rgba(106, 214, 194, 0.22)`,
              }}
            />
            <span
              className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                backgroundColor: color.card,
                color: color.text,
                border: `1px solid ${color.text}`,
              }}
            >
              T2
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
