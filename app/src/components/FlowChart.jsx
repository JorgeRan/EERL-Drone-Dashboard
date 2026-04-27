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
    label: "ppm-m",
    valueLabel: "Purway",
    stroke: color.orange,
    fill: "rgba(253, 148, 86, 0.26)",
  },
  sniffer: {
    label: "ppm",
    valueLabel: "Sniffer",
    stroke: color.green,
    fill: "rgba(106, 214, 194, 0.30)",
  },
};

const chartFrame = {
  top: 72,
  bottom: 34,
  left: 52,
  right: 52,
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

export function FlowChart({ flowData, selection, onSelectionChange, resultsPageMode}) {
  const chartId = useId().replace(/:/g, "");
  const navigatorRef = useRef(null);
  const ppmRangeRef = useRef(null);
  const dragHandleRef = useRef(null);
  const dataLength = flowData.length;
  const maxIndex = Math.max(dataLength - 1, 0);
  // const fullLeftAxisPeakValue = Math.max(
  //   1,
  //   ...flowData.map((point) => point.purway),
  //   ...flowData.map((point) => point.methane),
  // );
  const fullLeftAxisPeakValue = (Array.isArray(flowData) ? flowData : []).reduce(
    (max, point) =>
      Math.max(max, Number(point?.purway) || 0, Number(point?.methane) || 0),
    0,
  );
  const safeSelection = useMemo(
    () => clampSelection(selection, dataLength, fullLeftAxisPeakValue),
    [selection, dataLength, fullLeftAxisPeakValue],
  );
  const windowedData = useMemo(
    () => flowData.slice(safeSelection.startIndex, safeSelection.endIndex + 1),
    [flowData, safeSelection],
  );
  const leftAxisData = resultsPageMode ? windowedData : flowData;
  const rightAxisData = resultsPageMode ? windowedData : flowData;
  // const leftAxisPeakValue = Math.max(
  //   1,
  //   safeSelection.ppmMax ?? 0,
  //   ...leftAxisData.map((point) => point.purway),
  //   ...leftAxisData.map((point) => point.methane),
  // );
  const leftAxisPeakValue = (Array.isArray(leftAxisData) ? leftAxisData : []).reduce(
    (max, point) =>
      Math.max(max, Number(point?.purway) || 0, Number(point?.methane) || 0),
    0,
  );
  const rightAxisPeakValue = Math.max(
    1,
    ...rightAxisData.map((point) => point.sniffer),
  );
  const filteredData = useMemo(
    () =>
      windowedData.filter(
        (point) =>
          point.methane >= safeSelection.ppmMin &&
          point.methane <= safeSelection.ppmMax,
      ),
    [windowedData, safeSelection],
  );
  const latestPoint =
    filteredData[filteredData.length - 1] ??
    windowedData[windowedData.length - 1] ??
    flowData[dataLength - 1] ??
    { sniffer: 0, purway: 0, methane: 0 };
  const leftAxisTicks = [
    0,
    Math.ceil(leftAxisPeakValue * 0.35),
    Math.ceil(leftAxisPeakValue * 0.7),
    Math.ceil(leftAxisPeakValue),
  ];
  const rightAxisTicks = [
    0,
    Math.ceil(rightAxisPeakValue * 0.35),
    Math.ceil(rightAxisPeakValue * 0.7),
    Math.ceil(rightAxisPeakValue),
  ];
  const startPercent =
    maxIndex > 0 ? (safeSelection.startIndex / maxIndex) * 100 : 0;
  const endPercent =
    maxIndex > 0 ? (safeSelection.endIndex / maxIndex) * 100 : 100;
  const ppmMinPercent =
    leftAxisPeakValue > 0
      ? 100 - (safeSelection.ppmMin / leftAxisPeakValue) * 100
      : 100;
  const ppmMaxPercent =
    leftAxisPeakValue > 0
      ? 100 - (safeSelection.ppmMax / leftAxisPeakValue) * 100
      : 0;
  const windowStart = windowedData[0];
  const windowEnd = windowedData[windowedData.length - 1];
  const deltaTime = formatDuration(
    (windowEnd?.timestampMs ?? 0) - (windowStart?.timestampMs ?? 0),
  );

  useEffect(() => {
    const minimumPpmBand = Math.min(
      Math.max(leftAxisPeakValue * 0.02, 0.1),
      leftAxisPeakValue,
    );

    const updateTimeSelectionFromClientX = (clientX) => {
      if (!navigatorRef.current || maxIndex <= 0) {
        return;
      }

      const bounds = navigatorRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min((clientX - bounds.left) / bounds.width, 1),
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
      if (!ppmRangeRef.current || leftAxisPeakValue <= 0) {
        return;
      }

      const bounds = ppmRangeRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min(1 - (clientY - bounds.top) / bounds.height, 1),
      );
      const nextPpm = Number((clampedRatio * leftAxisPeakValue).toFixed(2));

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
    leftAxisPeakValue,
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
      const clampedRatio = Math.max(
        0,
        Math.min((event.clientX - bounds.left) / bounds.width, 1),
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

    if (axis === "y" && ppmRangeRef.current && leftAxisPeakValue > 0) {
      const minimumPpmBand = Math.min(
        Math.max(leftAxisPeakValue * 0.02, 0.1),
        leftAxisPeakValue,
      );
      const bounds = ppmRangeRef.current.getBoundingClientRect();
      const clampedRatio = Math.max(
        0,
        Math.min(1 - (event.clientY - bounds.top) / bounds.height, 1),
      );
      const nextPpm = Number((clampedRatio * leftAxisPeakValue).toFixed(2));

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
    <div className="flex h-full w-full flex-col gap-3">
      {!resultsPageMode ? 
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
      </div> : null}

      <div className="grid gap-3 sm:grid-cols-2">
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
        className="relative min-h-[440px] rounded-xl border p-3 select-none"
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
            <div>
              <div>T1 = {windowStart?.time ?? "--"}</div> 
              <div>T2 = {windowEnd?.time ?? "--"}</div>
            </div>
            <div className="flex items-center">
              ΔT = {deltaTime}
            </div>
            <div>
              <div>PPM1 = {safeSelection.ppmMin.toFixed(2)}</div>
              <div>PPM2 = {safeSelection.ppmMax.toFixed(2)}</div>
            </div>
            <div className="flex items-center">
                ΔPPM = {(safeSelection.ppmMax - safeSelection.ppmMin).toFixed(2)}
            </div>

          </div>
        </div>

        <div className="h-[360px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={360}>
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
                yAxisId="left"
                stroke={color.textDim}
                tickLine={false}
                axisLine={{ stroke: color.borderStrong }}
                width={44}
                style={{ fontSize: "11px" }}
                domain={[0, leftAxisPeakValue]}
                ticks={leftAxisTicks}
                tick={{ fill: color.text, fontSize: 11 }}
                label={{
                  value: "Trace",
                  angle: -90,
                  position: "insideLeft",
                  offset: 0,
                  fill: color.text,
                  fontSize: 11,
                }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke={seriesTheme.sniffer.stroke}
                tickLine={false}
                axisLine={{ stroke: color.borderStrong }}
                width={44}
                style={{ fontSize: "11px" }}
                domain={[0, rightAxisPeakValue]}
                ticks={rightAxisTicks}
                tick={{ fill: seriesTheme.sniffer.stroke, fontSize: 11 }}
                label={{
                  value: "Sniffer",
                  angle: 90,
                  position: "insideRight",
                  offset: 0,
                  fill: seriesTheme.sniffer.stroke,
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
              {safeSelection.ppmMin > 0 ? (
                <ReferenceArea
                  y1={0}
                  y2={safeSelection.ppmMin}
                  fill="rgba(3, 7, 18, 0.44)"
                  ifOverflow="extendDomain"
                />
              ) : null}
              {safeSelection.ppmMax < leftAxisPeakValue ? (
                <ReferenceArea
                  y1={safeSelection.ppmMax}
                  y2={leftAxisPeakValue}
                  fill="rgba(3, 7, 18, 0.44)"
                  ifOverflow="extendDomain"
                />
              ) : null}
              {Object.entries(seriesTheme).map(([sensorKey, theme]) => {
                const dataKey = sensorKey;
                const yAxisId = sensorKey === "sniffer" ? "right" : "left";

                return (
                  <React.Fragment key={sensorKey}>
                    <Area
                      yAxisId={yAxisId}
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
                      yAxisId={yAxisId}
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
            left: `${startPercent}%`,
            width: `${Math.max(endPercent - startPercent, 0)}%`,
            backgroundColor: "rgba(255, 255, 255, 0.04)",
          }}
        />

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
            className="absolute left-0 right-0"
            style={{
              top: `${ppmMaxPercent}%`,
              height: `${Math.max(ppmMinPercent - ppmMaxPercent, 0)}%`,
              backgroundColor: "rgba(255, 255, 255, 0.04)",
            }}
          />

          <button
            type="button"
            aria-label="Adjust minimum ppm selection"
            className="absolute left-0 right-0 h-8 -translate-y-1/2 cursor-ns-resize bg-transparent"
            style={{ top: `${ppmMinPercent}%`, pointerEvents: "auto" }}
            onPointerDown={beginHandleDrag("y", "ppmMin")}
          >
            <span
              className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2"
              style={{
                backgroundColor: color.text,
                boxShadow: `0 0 0 1px ${color.orangeSoft}, 0 0 10px rgba(253, 148, 86, 0.25)`,
              }}
            />
            <span
              className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                backgroundColor: color.card,
                color: color.text,
                border: `1px solid ${color.text}`,
              }}
            >
              PPM1 {safeSelection.ppmMin.toFixed(2)}
            </span>
          </button>

          <button
            type="button"
            aria-label="Adjust maximum ppm selection"
            className="absolute left-0 right-0 h-8 -translate-y-1/2 cursor-ns-resize bg-transparent"
            style={{ top: `${ppmMaxPercent}%`, pointerEvents: "auto" }}
            onPointerDown={beginHandleDrag("y", "ppmMax")}
          >
            <span
              className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2"
              style={{
                backgroundColor: color.text,
                boxShadow: `0 0 0 1px ${color.greenSoft}, 0 0 10px rgba(106, 214, 194, 0.22)`,
              }}
            />
            <span
              className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                backgroundColor: color.card,
                color: color.text,
                border: `1px solid ${color.text}`,
              }}
            >
              PPM2 {safeSelection.ppmMax.toFixed(2)}
            </span>
          </button>
        </div>

        <button
          type="button"
          aria-label="Adjust selection start"
          className="absolute top-[72px] bottom-[20px] w-8 -translate-x-1/2 cursor-ew-resize bg-transparent"
          style={{ left: `${startPercent}%` }}
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
          className="absolute top-[72px] bottom-[20px] w-8 -translate-x-1/2 cursor-ew-resize bg-transparent"
          style={{ left: `${endPercent}%` }}
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
  );
}
