import React, { useMemo } from "react";
import { tw, color } from "../constants/tailwind";
import { Chart, calculateWindRose, classifyDir } from "@eunchurn/react-windrose";

const windColumns = ["angle", "0-1", "1-2", "2-3", "3-4", "4-5", "5-6", "6-7", "7+"];
const primaryAngles = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function WindPanel({ windSamples = [] }) {
  const validWindSamples = useMemo(
    () =>
      (Array.isArray(windSamples) ? windSamples : []).filter(
        ({ u, v, w }) =>
          Number.isFinite(u) || Number.isFinite(v) || Number.isFinite(w),
      ),
    [windSamples],
  );

  const { chartData, prevailingDirection, averageSpeed, peakSpeed } = useMemo(() => {
    if (!validWindSamples.length) {
      return {
        chartData: [],
        prevailingDirection: "N",
        averageSpeed: 0,
        peakSpeed: 0,
        averageVertical: 0,
      };
    }

    const speed = validWindSamples.map(({ u, v }) =>
      Math.sqrt((u ?? 0) * (u ?? 0) + (v ?? 0) * (v ?? 0)),
    );
    const direction = validWindSamples.map(({ u, v }) => {
      return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    });

    const rose = calculateWindRose({ direction, speed });
    const roseData = Array.isArray(rose)
      ? rose.filter((entry) => primaryAngles.includes(entry.angle))
      : [];
    const prevailing = roseData.reduce((best, current) => {
      if (!best || current.total > best.total) {
        return current;
      }
      return best;
    }, null);

    return {
      chartData: roseData,
      prevailingDirection: prevailing?.angle || classifyDir(direction[0] || 0),
      averageSpeed: speed.reduce((sum, value) => sum + value, 0) / speed.length,
      peakSpeed: Math.max(...speed),
      averageVertical:
        validWindSamples.reduce((sum, sample) => sum + (sample.w ?? 0), 0) /
        validWindSamples.length,
    };
  }, [validWindSamples]);

  return (
    <div className={tw.panel} style={{ backgroundColor: color.card, padding: "0.75rem" }}>
      <div className="flex h-full w-full flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em]" style={{ color: color.text }}>
              wind profile
            </p>
            <p className="text-xl font-bold tracking-tight" style={{ color: color.text }}>
              Rose and direction
            </p>
          </div>
          <div
            className="rounded-full px-3 py-1 text-xs font-medium"
            style={{
              backgroundColor: validWindSamples.length
                ? color.greenSoft
                : color.surface,
              color: validWindSamples.length ? color.green : color.textMuted,
            }}
          >
            {validWindSamples.length ? "Live" : "No Wind Data"}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border px-3 py-2.5" style={{ backgroundColor: color.surface, borderColor: color.border }}>
            <div className="text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
              Prevailing
            </div>
            <div className="mt-1 text-lg font-semibold leading-none" style={{ color: color.green }}>
              {prevailingDirection}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
              dominant heading
            </div>
          </div>

          <div className="rounded-lg border px-3 py-2.5" style={{ backgroundColor: color.surface, borderColor: color.border }}>
            <div className="text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
              Average speed
            </div>
            <div className="mt-1 text-lg font-semibold leading-none" style={{ color: color.orange }}>
              {averageSpeed.toFixed(1)}
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
              peak {peakSpeed.toFixed(1)} m/s
            </div>
          </div>
        </div>

        {/* <div className="rounded-lg border px-3 py-2.5" style={{ backgroundColor: color.surface, borderColor: color.border }}>
          <div className="text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
            Vertical wind
          </div>
          <div className="mt-1 text-lg font-semibold leading-none" style={{ color: averageVertical >= 0 ? color.green : color.orange }}>
            {averageVertical >= 0 ? "+" : ""}{averageVertical.toFixed(1)}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.12em]" style={{ color: color.text }}>
            average W component
          </div>
        </div> */}

        <div
          className="flex min-h-[300px] h-full w-full items-center justify-center rounded-xl border m-0 p-0"
          style={{ backgroundColor: color.surface, borderColor: color.border }}
        >
          {validWindSamples.length ? (
            <div className="w-full h-full max-w-[360px] [&_svg_text]:fill-white [&_svg_text]:opacity-100 m-0 p-0">
              <Chart
                chartData={chartData}
                columns={windColumns}
                width={360}
                height={360}
                legendGap={14}
              />
            </div>
          ) : (
            <p className="px-6 text-center text-sm" style={{ color: color.textMuted }}>
              Waiting for live wind telemetry to render the wind rose.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

