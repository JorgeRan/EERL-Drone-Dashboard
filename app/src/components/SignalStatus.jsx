import React, { useEffect, useRef, useState } from "react";
import { Dot } from 'lucide-react';

function hexToDec(hex) {
    if (!hex) return 0;
    return parseInt(hex, 16);
}

function signalBars(value) {
    if (value >= 200) return 4;
    if (value >= 150) return 3;
    if (value >= 100) return 2;
    if (value >= 50) return 1;
    return 0;
}

function Sparkline({ data0, data1, width = 80, height = 24 }) {
    if (!data0.length || !data1.length) return null;
    const max = Math.max(...data0, ...data1, 1);
    const min = Math.min(...data0, ...data1, 0);
    const n = Math.max(data0.length, data1.length);
    const xStep = width / (n - 1 || 1);
    const scaleY = (v) => height - ((v - min) / (max - min || 1)) * height;
    const line = (arr, color) =>
        arr
            .map((v, i) => `${i === 0 ? "M" : "L"}${i * xStep},${scaleY(v)}`)
            .join(" ");
    return (
        <svg width={width} height={height} style={{ display: "block" }}>
            <path d={line(data0, "#1e90ff")} fill="none" stroke="#1e90ff" strokeWidth="1.5" />
            <path d={line(data1, "#f59e42")} fill="none" stroke="#f59e42" strokeWidth="1.5" />
        </svg>
    );
}

export default function SignalStatus({ signalHistory, seqHistory, color }) {

    const [packetLoss, setPacketLoss] = useState(false);
    const lossTimeout = useRef();

    const last = signalHistory[signalHistory.length - 1] || {};
    const q0 = hexToDec(last.q0);
    const q1 = hexToDec(last.q1);
    const best = Math.max(q0, q1);
    const bars = signalBars(best);

    const data0 = signalHistory.slice(-30).map((d) => hexToDec(d.q0));
    const data1 = signalHistory.slice(-30).map((d) => hexToDec(d.q1));


    useEffect(() => {
        if (seqHistory.length < 2) return;
        const prev = seqHistory[seqHistory.length - 2];
        const curr = seqHistory[seqHistory.length - 1];
        if (curr !== prev + 1) {
            setPacketLoss(true);
            clearTimeout(lossTimeout.current);
            lossTimeout.current = setTimeout(() => setPacketLoss(false), 5000);
        }
    }, [seqHistory]);

    const barColor = packetLoss ? "#f33232" : color.green;

    const width = 80;
const height = 24;
const padding = 2;

function normalize(data, min, max) {
  return data.map((v) => {
    if (max === min) return height / 2;
    return (
      height -
      padding -
      ((v - min) / (max - min)) * (height - padding * 2)
    );
  });
}

function buildPath(data, min, max) {
  const points = normalize(data, min, max);
  const step = width / (data.length - 1);

  return points
    .map((y, i) => `${i === 0 ? "M" : "L"} ${i * step} ${y}`)
    .join(" ");
}


  const all = [...data0, ...data1];
  const min = Math.min(...all);
  const max = Math.max(...all);

  const path0 = buildPath(data0, min, max);
  const path1 = buildPath(data1, min, max);

  const lastX = width;
  const lastY0 = normalize(data0, min, max).slice(-1)[0];
  const lastY1 = normalize(data1, min, max).slice(-1)[0];
    return (
        <div className="relative flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 backdrop-blur-md border border-white/10 shadow-sm">

            <div className="flex items-end gap-1 h-6">
                {[0, 1, 2, 3].map((i) => (
                    <div
                        key={i}
                        style={{
                            width: 5,
                            height: 8 + i * 6,
                            background: i < bars ? barColor : "rgba(255,255,255,0.15)",
                            borderRadius: 3,
                            transition: "all 0.2s ease",
                        }}
                    />
                ))}
            </div>

            {/* Sparkline
    <div className="w-20 h-6">
      <Sparkline data0={data0} data1={data1} />
    </div> */}

            <div className="flex flex-col gap-1">
                {/* Graph */}
                <svg width={width} height={height}>
                    {/* q0 line */}
                    <path
                        d={path0}
                        fill="none"
                        stroke="#60a5fa" // blue
                        strokeWidth="1.5"
                        opacity="0.9"
                    />
                    {/* q1 line */}
                    <path
                        d={path1}
                        fill="none"
                        stroke="#fb923c" // orange
                        strokeWidth="1.5"
                        opacity="0.9"
                    />

                    {/* last point markers */}
                    <circle cx={lastX} cy={lastY0} r="2" fill="#60a5fa" />
                    <circle cx={lastX} cy={lastY1} r="2" fill="#fb923c" />
                </svg>

                {/* Legend */}
                <div className="flex gap-2 text-[9px] opacity-70">
                    <span className="flex items-center gap-1">
                        <div className="w-2 h-2 bg-blue-400 rounded-full" />
                        q0
                    </span>
                    <span className="flex items-center gap-1">
                        <div className="w-2 h-2 bg-orange-400 rounded-full" />
                        q1
                    </span>
                </div>
            </div>

            {packetLoss && (
                <div className="absolute -top-1 -right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500/90 text-white text-[10px] font-medium shadow">
                    <span>PL</span>
                    <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                </div>
            )}
        </div>
    );
}
