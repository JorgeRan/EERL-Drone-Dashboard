import React, { useId } from "react";
import {
  Area,
  AreaChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { color } from "../constants/tailwind";

const safeData = [
  {
    time: "18:00",
    flow_sensor1: 0.5,
    setpoint_sensor1: 0.4,
    flow_sensor2: 0.3,
    setpoint_sensor2: 0.2,
  },
  {
    time: "18:10",
    flow_sensor1: 1.8,
    setpoint_sensor1: 1.4,
    flow_sensor2: 1.4,
    setpoint_sensor2: 1.1,
  },
  {
    time: "18:18",
    flow_sensor1: 4.6,
    setpoint_sensor1: 3.9,
    flow_sensor2: 3.8,
    setpoint_sensor2: 3.2,
  },
  {
    time: "18:24",
    flow_sensor1: 6.8,
    setpoint_sensor1: 5.6,
    flow_sensor2: 5.1,
    setpoint_sensor2: 4.4,
  },
  {
    time: "18:30",
    flow_sensor1: 8.5,
    setpoint_sensor1: 7.1,
    flow_sensor2: 6.3,
    setpoint_sensor2: 5.2,
  },
  {
    time: "18:38",
    flow_sensor1: 10.2,
    setpoint_sensor1: 8.7,
    flow_sensor2: 7.5,
    setpoint_sensor2: 6.0,
  },
  {
    time: "18:46",
    flow_sensor1: 11.4,
    setpoint_sensor1: 9.8,
    flow_sensor2: 8.4,
    setpoint_sensor2: 6.8,
  },
  {
    time: "19:00",
    flow_sensor1: 11.6,
    setpoint_sensor1: 10.0,
    flow_sensor2: 8.8,
    setpoint_sensor2: 7.1,
  },
  {
    time: "19:30",
    flow_sensor1: 11.6,
    setpoint_sensor1: 10.0,
    flow_sensor2: 8.8,
    setpoint_sensor2: 7.1,
  },
  {
    time: "20:00",
    flow_sensor1: 11.7,
    setpoint_sensor1: 10.1,
    flow_sensor2: 8.9,
    setpoint_sensor2: 7.2,
  },
  {
    time: "Now",
    flow_sensor1: 11.9,
    setpoint_sensor1: 10.1,
    flow_sensor2: 9.0,
    setpoint_sensor2: 7.2,
  },
];

const sensorTheme = {
  sensor1: {
    title: "Methane",
    flowStroke: color.green,
    flowFill: "rgba(106, 214, 194, 0.34)",
    setpointStroke: color.orange,
    setpointFill: "rgba(253, 148, 86, 0.28)",
  },
  sensor2: {
    title: "Sniffer",
    flowStroke: "#59d5ff",
    flowFill: "rgba(89, 213, 255, 0.30)",
    setpointStroke: "#ffb16b",
    setpointFill: "rgba(255, 177, 107, 0.24)",
  },
};

export function FlowChart({ sensor = "sensor1" }) {
  const chartId = useId().replace(/:/g, "");
  const flowKey = `flow_${sensor}`;
  const setpointKey = `setpoint_${sensor}`;
  const theme = sensorTheme[sensor] || sensorTheme.sensor1;
  const latestPoint = safeData[safeData.length - 1];
  const latestFlow = latestPoint[flowKey];
  const latestSetpoint = latestPoint[setpointKey];
  const peakValue = Math.max(
    ...safeData.map((point) => point[flowKey]),
    ...safeData.map((point) => point[setpointKey]),
  );
  const leftTicks = [
    0,
    Math.ceil(peakValue * 0.35),
    Math.ceil(peakValue * 0.7),
    Math.ceil(peakValue),
  ];

  return (
    <div
      className="flex h-full w-full flex-col rounded-xl border px-3 py-3"
      style={{ backgroundColor: color.surface, borderColor: color.border }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3
            className="text-sm font-bold uppercase tracking-[0.12em]"
            style={{ color: color.textMuted }}
          >
            {theme.title}
          </h3>
        </div>
        <div className="flex flex-row">
          <div className="text-right me-10">
            <div
              className="text-lg font-semibold leading-none"
              style={{ color: color.orange }}
            >
              {latestFlow.toFixed(1)}
            </div>
            <div
              className="text-[11px] uppercase tracking-[0.12em]"
              style={{ color: color.textDim }}
            >
              Purway
            </div>
          </div>
          <div className="text-right ms-10">
            <div
              className="text-lg font-semibold leading-none"
              style={{ color: color.green }}
            >
              {latestFlow.toFixed(1)}
            </div>
            <div
              className="text-[11px] uppercase tracking-[0.12em]"
              style={{ color: color.textDim }}
            >
              Sniffer
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-[240px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={safeData}
            margin={{ top: 8, right: 6, left: -24, bottom: 0 }}
          >
            <defs>
              <linearGradient
                id={`flowGradient-${chartId}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={theme.flowFill}
                  stopOpacity={0.95}
                />
                <stop
                  offset="72%"
                  stopColor={theme.flowFill}
                  stopOpacity={0.34}
                />
                <stop
                  offset="100%"
                  stopColor={theme.flowFill}
                  stopOpacity={0}
                />
              </linearGradient>
              <linearGradient
                id={`setpointGradient-${chartId}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={theme.setpointFill}
                  stopOpacity={0.9}
                />
                <stop
                  offset="72%"
                  stopColor={theme.setpointFill}
                  stopOpacity={0.28}
                />
                <stop
                  offset="100%"
                  stopColor={theme.setpointFill}
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
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="left"
              stroke={color.textDim}
              tickLine={false}
              axisLine={false}
              width={28}
              style={{ fontSize: "11px" }}
              ticks={leftTicks}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={color.textDim}
              tickLine={false}
              axisLine={false}
              width={34}
              style={{ fontSize: "11px" }}
              ticks={leftTicks.map((tick) => Number((tick * 70).toFixed(0)))}
              tickFormatter={(value) => `${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: color.surface,
                border: `1px solid ${color.borderStrong}`,
                borderRadius: "8px",
                color: color.text,
              }}
              formatter={(value) =>
                value != null && !Number.isNaN(value)
                  ? Number(value).toFixed(2)
                  : "0.00"
              }
              labelStyle={{ color: color.text }}
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey={setpointKey}
              stroke={theme.setpointStroke}
              strokeWidth={2}
              fill={`url(#setpointGradient-${chartId})`}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: theme.setpointStroke }}
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey={flowKey}
              stroke={theme.flowStroke}
              strokeWidth={2.5}
              fill={`url(#flowGradient-${chartId})`}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: theme.flowStroke }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey={setpointKey}
              stroke={theme.setpointStroke}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey={flowKey}
              stroke={theme.flowStroke}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>

        <div
          className="mt-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em]"
          style={{ color: color.textDim }}
        >
          <span style={{ color: theme.setpointStroke }}>
            Setpoint {latestSetpoint.toFixed(1)}
          </span>
          <span style={{ color: theme.flowStroke }}>
            Flow {latestFlow.toFixed(1)}
          </span>
        </div>
      </div>
    </div>
  );
}
