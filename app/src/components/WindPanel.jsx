import React, { useMemo } from "react";
import { tw, color } from "../constants/tailwind";
import { Chart, calculateWindRose, classifyDir } from "@eunchurn/react-windrose";

const fallbackWindSamples = [
  { u: 1.4, v: -3.8, w: 0.2 },
  { u: 1.9, v: -4.1, w: 0.4 },
  { u: 2.2, v: -4.6, w: 0.5 },
  { u: 2.8, v: -5.0, w: 0.3 },
  { u: 3.1, v: -5.2, w: 0.1 },
  { u: 2.5, v: -4.4, w: -0.2 },
  { u: 1.7, v: -3.7, w: -0.3 },
  { u: 0.9, v: -2.8, w: -0.1 },
  { u: -0.6, v: -2.0, w: 0.0 },
  { u: -1.2, v: -1.4, w: 0.2 },
  { u: -2.0, v: -0.9, w: 0.5 },
  { u: -2.4, v: -0.2, w: 0.7 },
  { u: -1.6, v: 0.6, w: 0.4 },
  { u: -0.8, v: 1.1, w: 0.1 },
  { u: 0.5, v: 0.8, w: -0.2 },
  { u: 1.0, v: -0.7, w: -0.4 },
];

const windColumns = ["angle", "0-1", "1-2", "2-3", "3-4", "4-5", "5-6", "6-7", "7+"];
const primaryAngles = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function WindPanel({ windSamples = fallbackWindSamples }) {
  const { chartData, prevailingDirection, averageSpeed, peakSpeed, averageVertical } = useMemo(() => {
    if (!windSamples.length) {
      return {
        chartData: [],
        prevailingDirection: "N",
        averageSpeed: 0,
        peakSpeed: 0,
        averageVertical: 0,
      };
    }

    const speed = windSamples.map(({ u, v }) => Math.sqrt(u * u + v * v));
    const direction = windSamples.map(({ u, v }) => {
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
      averageVertical: windSamples.reduce((sum, sample) => sum + sample.w, 0) / windSamples.length,
    };
  }, []);

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
            style={{ backgroundColor: color.greenSoft, color: color.green }}
          >
            Live
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
          <div className="w-full h-full max-w-[360px] [&_svg_text]:fill-white [&_svg_text]:opacity-100 m-0 p-0">
            <Chart
              chartData={chartData}
              columns={windColumns}
              width={360}
              height={360}
              legendGap={14}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

