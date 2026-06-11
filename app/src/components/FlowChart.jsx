import React, { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
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

const CHART_HEIGHT_PX = 360;
const MIN_SAMPLES_PER_BUCKET = 2;

function buildMinMaxDownsampledData(rawData, targetBucketCount) {
  const x = rawData?.[0] ?? [];
  const left = rawData?.[1] ?? [];
  const right = rawData?.[2] ?? [];
  const length = x.length;

  if (length <= 2 || targetBucketCount <= 0 || length <= targetBucketCount * 2) {
    return rawData;
  }

  const bucketSize = Math.max(MIN_SAMPLES_PER_BUCKET, Math.floor(length / targetBucketCount));
  const sampledX = [x[0]];
  const sampledLeft = [left[0]];
  const sampledRight = [right[0]];

  let bucketStart = 1;
  while (bucketStart < length - 1) {
    const bucketEnd = Math.min(length - 1, bucketStart + bucketSize);

    let minLeftIndex = bucketStart;
    let maxLeftIndex = bucketStart;
    let minRightIndex = bucketStart;
    let maxRightIndex = bucketStart;

    for (let index = bucketStart + 1; index < bucketEnd; index += 1) {
      if ((left[index] ?? 0) < (left[minLeftIndex] ?? 0)) {
        minLeftIndex = index;
      }
      if ((left[index] ?? 0) > (left[maxLeftIndex] ?? 0)) {
        maxLeftIndex = index;
      }
      if ((right[index] ?? 0) < (right[minRightIndex] ?? 0)) {
        minRightIndex = index;
      }
      if ((right[index] ?? 0) > (right[maxRightIndex] ?? 0)) {
        maxRightIndex = index;
      }
    }

    const indices = Array.from(
      new Set([minLeftIndex, maxLeftIndex, minRightIndex, maxRightIndex]),
    ).sort((a, b) => a - b);

    for (const index of indices) {
      sampledX.push(x[index]);
      sampledLeft.push(left[index]);
      sampledRight.push(right[index]);
    }

    bucketStart = bucketEnd;
  }

  sampledX.push(x[length - 1]);
  sampledLeft.push(left[length - 1]);
  sampledRight.push(right[length - 1]);

  return [sampledX, sampledLeft, sampledRight];
}

function HighVolumeLineChart({ flowData, leftAxisPeakValue, rightAxisPeakValue }) {
  const hostRef = useRef(null);
  const plotRef = useRef(null);

  const rawChartData = useMemo(() => {
    const length = flowData.length;
    const xValues = new Array(length);
    const purwayValues = new Array(length);
    const snifferValues = new Array(length);

    for (let index = 0; index < length; index += 1) {
      const point = flowData[index] ?? {};
      xValues[index] = index;
      purwayValues[index] = Number(point.purway) || 0;
      snifferValues[index] = Number(point.sniffer) || 0;
    }

    return [xValues, purwayValues, snifferValues];
  }, [flowData]);

  const getChartDataForWidth = useMemo(() => {
    return (width) => {
      const bucketCount = Math.max(100, Math.floor(width));
      return buildMinMaxDownsampledData(rawChartData, bucketCount);
    };
  }, [rawChartData]);

  const xAxisFormatter = useMemo(() => {
    return (_plot, rawSplits) =>
      rawSplits.map((value) => {
        const safeIndex = Math.max(
          0,
          Math.min(flowData.length - 1, Math.round(Number(value) || 0)),
        );
        return flowData[safeIndex]?.time ?? "";
      });
  }, [flowData]);

  useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const hostElement = hostRef.current;

    const mountPlot = () => {
      const width = Math.max(320, Math.floor(hostElement.clientWidth));
      const chartData = getChartDataForWidth(width);

      const options = {
        width,
        height: CHART_HEIGHT_PX,
        legend: { show: false },
        cursor: {
          drag: {
            setScale: false,
            x: false,
            y: false,
          },
        },
        scales: {
          x: {
            time: false,
          },
          left: {
            range: [0, Math.max(1, leftAxisPeakValue)],
          },
          right: {
            range: [0, Math.max(1, rightAxisPeakValue)],
          },
        },
        axes: [
          {
            scale: "x",
            stroke: color.textDim,
            grid: { stroke: color.borderStrong },
            values: xAxisFormatter,
            size: 26,
            gap: 10,
          },
          {
            scale: "left",
            stroke: color.textDim,
            grid: { stroke: color.borderStrong },
            values: (_plot, rawSplits) =>
              rawSplits.map((value) => Number(value).toFixed(0)),
            size: 44,
            gap: 10,
          },
          {
            scale: "right",
            side: 1,
            stroke: seriesTheme.sniffer.stroke,
            grid: { show: false },
            values: (_plot, rawSplits) =>
              rawSplits.map((value) => Number(value).toFixed(0)),
            size: 44,
            gap: 10,
          },
        ],
        series: [
          {},
          {
            label: "Purway",
            scale: "left",
            stroke: seriesTheme.purway.stroke,
            width: 2,
            points: { show: false },
          },
          {
            label: "Sniffer",
            scale: "right",
            stroke: seriesTheme.sniffer.stroke,
            width: 2,
            points: { show: false },
          },
        ],
      };

      if (plotRef.current) {
        plotRef.current.destroy();
      }

      plotRef.current = new uPlot(options, chartData, hostElement);
    };

    mountPlot();

    const resizeObserver = new ResizeObserver(() => {
      if (!plotRef.current || !hostRef.current) {
        return;
      }
      const width = Math.max(320, Math.floor(hostRef.current.clientWidth));
      const chartData = getChartDataForWidth(width);
      plotRef.current.setData(chartData, false);
      plotRef.current.setSize({
        width,
        height: CHART_HEIGHT_PX,
      });
    });
    resizeObserver.observe(hostElement);

    return () => {
      resizeObserver.disconnect();
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, [getChartDataForWidth, leftAxisPeakValue, rightAxisPeakValue, xAxisFormatter]);

  return <div ref={hostRef} className="h-[360px] w-full min-w-0 overflow-hidden" />;
}

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

export function FlowChart({ flowData, selection, onSelectionChange, resultsPageMode, onRenderComplete }) {
  const chartContainerRef = useRef(null);
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
  // const rightAxisPeakValue = Math.max(
  //   1,
  //   ...rightAxisData.map((point) => point.sniffer),
  // );
  const rightAxisPeakValue = (Array.isArray(rightAxisData) ? rightAxisData : []).reduce(
    (max, point) => Math.max(max, Number(point?.sniffer) || 0),
    0,
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
    safeSelection,
  ]);

  useEffect(() => {
    if (!resultsPageMode || typeof onRenderComplete !== "function") {
      return undefined;
    }

    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));

      secondFrame = window.requestAnimationFrame(() => {
        if (cancelled || !chartContainerRef.current) {
          return;
        }

        onRenderComplete();
      });
    });

    return () => {
      cancelled = true;
      if (firstFrame) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    dataLength,
    onRenderComplete,
    resultsPageMode,
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
    <div ref={chartContainerRef} className="flex h-full w-full flex-col gap-3">
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

        <HighVolumeLineChart
          flowData={flowData}
          leftAxisPeakValue={leftAxisPeakValue}
          rightAxisPeakValue={rightAxisPeakValue}
        />

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
