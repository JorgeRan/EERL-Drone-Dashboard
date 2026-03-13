import React, { useEffect, useId, useMemo, useRef } from "react";
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
  purway: {
    label: "ln/min",
    valueLabel: "Purway",
    stroke: color.orange,
    fill: "rgba(253, 148, 86, 0.26)",
  },
  sniffer: {
    label: "ln/min",
    valueLabel: "Sniffer",
    stroke: color.green,
    fill: "rgba(106, 214, 194, 0.30)",
  },
};

function clampWindow(selection, dataLength) {
  if (dataLength <= 1) {
    return { startIndex: 0, endIndex: 0 };
  }

  const safeStart = Math.max(0, Math.min(selection.startIndex, dataLength - 2));
  const safeEnd = Math.max(
    safeStart + 1,
    Math.min(selection.endIndex, dataLength - 1),
  );

  return {
    startIndex: safeStart,
    endIndex: safeEnd,
  };
}

export function FlowChart({ flowData, selection, onSelectionChange }) {
  const chartId = useId().replace(/:/g, "");
  const navigatorRef = useRef(null);
  const dragHandleRef = useRef(null);
  const dataLength = flowData.length;
  const maxIndex = Math.max(dataLength - 1, 0);
  const safeSelection = useMemo(
    () => clampWindow(selection, dataLength),
    [selection, dataLength],
  );
  const filteredData = useMemo(
    () => flowData.slice(safeSelection.startIndex, safeSelection.endIndex + 1),
    [flowData, safeSelection],
  );
  const latestPoint =
    filteredData[filteredData.length - 1] ?? flowData[dataLength - 1];
  const peakValue = Math.max(
    1,
    ...filteredData.map((point) => point.sniffer),
    ...filteredData.map((point) => point.purway),
  );
  const fullPeakValue = Math.max(
    1,
    ...flowData.map((point) => point.sniffer),
    ...flowData.map((point) => point.purway),
  );
  const leftTicks = [
    0,
    Math.ceil(peakValue * 0.35),
    Math.ceil(peakValue * 0.7),
    Math.ceil(peakValue),
  ];
  const fullTicks = [
    0,
    Math.ceil(fullPeakValue * 0.35),
    Math.ceil(fullPeakValue * 0.7),
    Math.ceil(fullPeakValue),
  ];
  const startPercent = maxIndex > 0 ? (safeSelection.startIndex / maxIndex) * 100 : 0;
  const endPercent =
    maxIndex > 0 ? (safeSelection.endIndex / maxIndex) * 100 : 100;
  const windowStart = filteredData[0];
  const windowEnd = filteredData[filteredData.length - 1];

  useEffect(() => {
    const updateSelectionFromClientX = (clientX) => {
      if (!navigatorRef.current || !dragHandleRef.current || maxIndex <= 0) {
        return;
      }

      const bounds = navigatorRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min((clientX - bounds.left) / bounds.width, 1),
      );
      const nextIndex = Math.round(clampedRatio * maxIndex);

      if (dragHandleRef.current === "start") {
        onSelectionChange({
          startIndex: Math.min(nextIndex, safeSelection.endIndex - 1),
          endIndex: safeSelection.endIndex,
        });
        return;
      }

      onSelectionChange({
        startIndex: safeSelection.startIndex,
        endIndex: Math.max(nextIndex, safeSelection.startIndex + 1),
      });
    };

    const handlePointerMove = (event) => {
      updateSelectionFromClientX(event.clientX);
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
    maxIndex,
    onSelectionChange,
    safeSelection.endIndex,
    safeSelection.startIndex,
  ]);

  const beginHandleDrag = (handle) => (event) => {
    event.preventDefault();
    dragHandleRef.current = handle;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (navigatorRef.current && maxIndex > 0) {
      const bounds = navigatorRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min((event.clientX - bounds.left) / bounds.width, 1),
      );
      const nextIndex = Math.round(clampedRatio * maxIndex);

      if (handle === "start") {
        onSelectionChange({
          startIndex: Math.min(nextIndex, safeSelection.endIndex - 1),
          endIndex: safeSelection.endIndex,
        });
      } else {
        onSelectionChange({
          startIndex: safeSelection.startIndex,
          endIndex: Math.max(nextIndex, safeSelection.startIndex + 1),
        });
      }
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p
            className="text-xs uppercase tracking-[0.18em]"
            style={{ color: color.green }}
          >
            methane flow
          </p>
          <h3
            className="text-xl font-bold tracking-tight"
            style={{ color: color.text }}
          >
            Combined sensor view
          </h3>
          <p
            className="mt-1 text-xs uppercase tracking-[0.12em]"
            style={{ color: color.textMuted }}
          >
            Window {windowStart?.time ?? "--"} to {windowEnd?.time ?? "--"}
          </p>
        </div>
        <div
          className="rounded-full px-3 py-1 text-xs font-medium"
          style={{ backgroundColor: color.orangeSoft, color: color.orange }}
        >
          Live
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(seriesTheme).map(([sensorKey, theme]) => {
          const latestValue = latestPoint[sensorKey];

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
        className="relative min-h-[440px] rounded-xl border p-3 select-none"
        style={{
          backgroundColor: color.surface,
          borderColor: color.border,
          touchAction: "none",
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p
              className="text-xs uppercase tracking-[0.18em]"
              style={{ color: color.text }}
            >
              Time window selector
            </p>
            <p
              className="text-[11px] uppercase tracking-[0.12em]"
              style={{ color: color.textMuted }}
            >
              Drag the two vertical columns to filter the chart and both maps.
            </p>
          </div>
          <div
            className="text-right text-[11px] uppercase tracking-[0.12em]"
            style={{ color: color.textMuted }}
          >
            <div className="flex flex-row-1 gap-2">
              <div
                id="rectangle"
                style={{
                  width: "10px",
                  height: "3px",
                  backgroundColor: color.orange,
                  borderColor: color.orange,
                  margin: "7px 0 0 0",
                }}
              ></div>
              {windowStart?.timestampIso ?? "--"}
            </div>
            <div className="flex flex-row-1 gap-2">
              <div
                id="rectangle"
                style={{
                  width: "10px",
                  height: "3px",
                  backgroundColor: color.green,
                  borderColor: color.green,
                  margin: "7px 0 0 0",
                }}
              ></div>
              {windowEnd?.timestampIso ?? "--"}
            </div>
          </div>
        </div>

        <div className="h-[360px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={flowData}
              margin={{ top: 8, right: 6, left: 8, bottom: 18 }}
            >
              <defs>
                {Object.entries(seriesTheme).map(([sensorKey, theme]) => (
                  <linearGradient
                    key={sensorKey}
                    id={`flowGradient-${chartId}-${sensorKey}`}
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
                ))}
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
                ticks={fullTicks}
                tick={{ fill: color.text, fontSize: 11 }}
                label={{
                  value: "ln/min",
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
                formatter={(value) =>
                  value != null && !Number.isNaN(value)
                    ? Number(value).toFixed(2)
                    : "0.00"
                }
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
              {Object.entries(seriesTheme).map(([sensorKey, theme]) => {
                const dataKey = sensorKey;

                return (
                  <React.Fragment key={sensorKey}>
                    <Area
                      type="monotone"
                      dataKey={dataKey}
                      stroke={theme.stroke}
                      strokeWidth={2.3}
                      fill={`url(#flowGradient-${chartId}-${sensorKey})`}
                      fillOpacity={0.18}
                      isAnimationActive={false}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: theme.stroke }}
                    />
                    <Line
                      type="monotone"
                      dataKey={dataKey}
                      stroke={theme.stroke}
                      strokeWidth={2.3}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </React.Fragment>
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div
          className="pointer-events-none absolute top-[72px] bottom-[34px]"
          style={{
            left: `${startPercent }%`,
            width: `${Math.max(endPercent - startPercent, 0)}%`,
            backgroundColor: "rgba(255, 255, 255, 0.04)",
           // boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          }}
        />

        <button
          type="button"
          aria-label="Adjust selection start"
          className="absolute top-[72px] bottom-[20px] w-8 -translate-x-1/2 cursor-ew-resize bg-transparent"
          style={{ left: `${startPercent}%` }}
          onPointerDown={beginHandleDrag("start")}
        >
          <span
            className="absolute left-1/2 top-0 h-full -translate-x-1/2"
            style={{
              width: "2px",
              backgroundColor: color.orange,
              boxShadow: `0 0 0 1px ${color.orangeSoft}, 0 0 10px rgba(253, 148, 86, 0.25)`,
            }}
          />
          <span
            className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ backgroundColor: color.card, color: color.orange, border: `1px solid ${color.orange}` }}
          >
            T1
          </span>
        </button>

        <button
          type="button"
          aria-label="Adjust selection end"
          className="absolute top-[72px] bottom-[20px] w-8 -translate-x-1/2 cursor-ew-resize bg-transparent"
          style={{ left: `${endPercent}%` }}
          onPointerDown={beginHandleDrag("end")}
        >
          <span
            className="absolute left-1/2 top-0 h-full -translate-x-1/2"
            style={{
              width: "2px",
              backgroundColor: color.green,
              boxShadow: `0 0 0 1px ${color.greenSoft}, 0 0 10px rgba(106, 214, 194, 0.22)`,
            }}
          />
          <span
            className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ backgroundColor: color.card, color: color.green, border: `1px solid ${color.green}` }}
          >
            T2
          </span>
        </button>
      </div>
    </div>
  );
}
