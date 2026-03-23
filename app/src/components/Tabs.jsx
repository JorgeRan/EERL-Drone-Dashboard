import React from 'react'
import { color } from '../constants/tailwind'

const statusColorMap = {
  online: color.green,
  offline: color.offline,
  warning: color.warning,
}

const getDroneMonogram = (droneId) => {
  const compact = String(droneId || '').replace(/[^A-Za-z0-9]/g, '')
  if (!compact) {
    return 'DR'
  }

  const letters = compact.replace(/[0-9]/g, '')
  const numbers = compact.replace(/[^0-9]/g, '')

  if (letters && numbers) {
    return `${letters.slice(0, 1).toUpperCase()}${numbers.slice(-1)}`
  }

  return compact.slice(0, 2).toUpperCase()
}

export function DeviceTabs({
  devices,
  onSelectDevice = () => {},
  activeDeviceId,
  latestPointByDrone = {},
}) {
  return (
    <div
      className="h-fit rounded-lg border p-1"
      style={{
        backgroundColor: color.card,
        borderColor: color.border,
      }}
    >
      <div className="flex flex-col items-center gap-2">
          {devices.map((device, index) => {
            const isActive = activeDeviceId
              ? activeDeviceId === device.id
              : index === 0
            const latestPoint = latestPointByDrone[device.id]
            const monogram = getDroneMonogram(device.id)

            return (
              <button
                key={device.id}
                onClick={() => onSelectDevice(device.id)}
                type="button"
                className="group relative flex h-[62px] w-[62px] items-center justify-center rounded-xl border transition-all duration-200"
                style={{
                  backgroundColor: isActive ? color.surface : color.cardMuted,
                  borderColor: isActive ? color.orange : color.border,
                  boxShadow: isActive ? `0 0 0 1px ${color.orangeSoft}` : 'none',
                }}
              >
                <div className="pointer-events-none absolute left-[-3px] top-[-3px] h-3 w-3 rounded-full border-2" style={{ backgroundColor: statusColorMap[device.status] || color.textDim, borderColor: color.card }} />

                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full border text-xs font-bold tracking-[0.08em]"
                  style={{
                    borderColor: isActive ? color.orange : color.border,
                    color: isActive ? color.orange : color.textMuted,
                    backgroundColor: isActive ? color.orangeSoft : color.surface,
                  }}
                >
                  {monogram}
                </div>

                <div
                  className="pointer-events-none absolute left-[72px] top-1/2 z-30 hidden min-w-[210px] -translate-y-1/2 rounded-lg border px-3 py-2 text-left opacity-0 transition-all duration-200 group-hover:block group-hover:opacity-100"
                  style={{
                    backgroundColor: color.surface,
                    borderColor: color.borderStrong,
                    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold" style={{ color: color.text }}>{device.name}</span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] uppercase"
                      style={{
                        backgroundColor: isActive ? color.orangeSoft : color.cardMuted,
                        color: isActive ? color.orange : color.textDim,
                      }}
                    >
                      {isActive ? 'Active' : 'Standby'}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: color.textMuted }}>
                    {device.type}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ color: color.textMuted }}>
                    <span>CH4 {Number(latestPoint?.methane ?? 0).toFixed(2)}</span>
                    <span>Alt {Number(latestPoint?.altitude ?? 0).toFixed(1)} m</span>
                  </div>
                </div>
              </button>
            )
          })}
      </div>

    
    </div>
  )
}