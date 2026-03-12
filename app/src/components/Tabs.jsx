import React from 'react'
import { Wifi, Radio, Activity } from 'lucide-react'
import { color } from '../constants/tailwind'

const statusColorMap = {
  online: color.green,
  offline: color.offline,
  warning: color.warning,
}

const deviceIconMap = {
  Quadcopter: Wifi,
  Hexacopter: Radio,
  Octocopter: Activity,
}

export function DeviceTabs({
  devices,
  onSelectDevice = () => {},
  activeDeviceId,
}) {
  return (
    <div
      className="w-full border-b"
      style={{
        backgroundColor: color.card,
        borderColor: color.border,
      }}
    >
      <div className="flex h-24 w-full items-center px-6">
        <div className="flex min-w-0 flex-1 gap-4 overflow-x-auto no-scrollbar">
          {devices.map((device, index) => {
            const isActive = activeDeviceId
              ? activeDeviceId === device.id
              : index === 0

            return (
              <button
                key={device.id}
                onClick={() => onSelectDevice(device.id)}
                type="button"
                className="group my-3 flex items-center gap-3 whitespace-nowrap rounded-lg border px-4 py-3 text-sm font-medium transition-all duration-200"
                style={{
                  backgroundColor: isActive ? color.card : color.surface,
                  borderColor: isActive ? color.orange : color.border,
                  color: isActive ? color.text : color.textMuted,
                  boxShadow: isActive ? `0 0 0 1px ${color.orangeSoft}` : 'none',
                }}
              >
                
                <div
                  className="h-2.5 w-2.5 rounded-full transition-colors"
                  style={{
                    backgroundColor:
                      statusColorMap[device.status] || color.textDim,
                  }}
                />
                <span>{device.name}</span>
                <span
                  className="ml-1 rounded-full px-2.5 py-1 text-xs font-normal"
                  style={{
                    backgroundColor: isActive ? color.orangeSoft : color.cardMuted,
                    color: isActive ? color.orange : color.textDim,
                  }}
                >
                  {device.type}
                </span>
              </button>
            )
          })}
        </div>
        <div className="ml-4 flex shrink-0 justify-end rounded-lg px-4 py-3" style={{ backgroundColor: color.surface }}>
          <img src="/src/assets/EERL_logo_black.svg" alt="EERL Logo" className=" w-25 h-auto" />
        </div>
      </div>
    </div>
  )
}