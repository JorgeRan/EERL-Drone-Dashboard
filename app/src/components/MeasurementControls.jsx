import { useMemo } from "react";
import { color } from "../constants/tailwind";


const formatDuration = (seconds) => {
  const totalSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
};

export function MeasurementControls({
  status = "idle",
  elapsedSeconds = 0,
  isBusy = false,
  onStart = () => {},
  onPause = () => {},
  onResume = () => {},
  onStop = () => {},
}) {
  const statusMeta = useMemo(() => {
    if (status === "running") {
      return {
        label: "Recording",
        toneColor: color.green,
        toneBackground: color.greenSoft,
      };
    }

    if (status === "paused") {
      return {
        label: "Paused",
        toneColor: color.warning,
        toneBackground: "rgba(240, 193, 93, 0.14)",
      };
    }

    return {
      label: "Ready",
      toneColor: color.textMuted,
      toneBackground: color.surface,
    };
  }, [status]);

  return (
    <div
      className="flex flex-row items-center rounded-lg border p-3  gap-4"
      style={{
        backgroundColor: color.card,
        borderColor: color.border,
      }}
    >
      <div>
        <p
          className="text-[11px] uppercase tracking-[0.16em]"
          style={{ color: color.textDim }}
        >
          Measurement
        </p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{
              backgroundColor: statusMeta.toneBackground,
              color: statusMeta.toneColor,
            }}
          >
            {statusMeta.label}
          </span>

          <span className="text-sm font-semibold" style={{ color: color.text }}>
            {formatDuration(elapsedSeconds)}
          </span>
        </div>
      </div>
      
      <div >
        {status === "idle" ? (
          <button
            type="button"
            onClick={onStart}
            disabled={isBusy}
            className="w-full rounded-md px-3 py-2 text-sm font-semibold text-nowrap transition-colors"
            style={{
              backgroundColor: color.orange,
              color: color.surface,
              opacity: isBusy ? 0.65 : 1,
            }}
          >
            {isBusy ? "Starting..." : "Start Mission"}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={status === "running" ? onPause : onResume}
              disabled={isBusy}
              className="rounded-md border px-3 py-2 text-sm font-semibold transition-colors"
              style={{
                borderColor: color.borderStrong,
                color: color.text,
                backgroundColor: color.surface,
                opacity: isBusy ? 0.65 : 1,
              }}
            >
              {isBusy ? "Working..." : status === "running" ? "Pause" : "Resume"}
            </button>

            <button
              type="button"
              onClick={onStop}
              disabled={isBusy}
              className="rounded-md px-3 py-2 text-sm font-semibold transition-colors"
              style={{
                backgroundColor: color.red,
                color: "#1f2937",
                opacity: isBusy ? 0.65 : 1,
              }}
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
