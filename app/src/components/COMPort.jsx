import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { color } from "../constants/tailwind";
import { getCOMPorts } from "../services/api";

export function COMPort() {
    const [ports, setPorts] = useState([]);
    const [selectedPort, setSelectedPort] = useState("");
    const [isConnected, setIsConnected] = useState(false);

    const baudRate = 9600;
    const dataBits = 8;
    const parity = "None";
    const stopBits = 1;
    const flowControl = "None";

    useEffect(() => {
        getCOMPorts().then((list) => {
            setPorts(list);
            if (list.length > 0) setSelectedPort(list[0].path);
        });
    }, []);

    const handleConnect = () => setIsConnected((v) => !v);

    return (
        <div
            className="relative flex flex-col items-center rounded-lg border py-2 px-2 gap-1"
            style={{
                backgroundColor: color.card,
                borderColor: color.border,
            }}
        >
            <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold" style={{ color: color.textDim }}>
                    Serial Port
                </label>
                <select
                    className="rounded border px-2 py-1 text-sm"
                    style={{
                        backgroundColor: color.surface,
                        borderColor: color.border,
                        color: color.text,
                    }}
                    value={selectedPort}
                    onChange={(e) => setSelectedPort(e.target.value)}
                    disabled={isConnected || ports.length === 0}
                >
                    {ports.map((port) => (
                        <option key={port.path} value={port.path}>
                            {port.friendlyName || port.path}
                        </option>
                    ))}
                </select>
                {ports.length === 0 && (
                    <span className="text-xs text-red-500 mt-1">No ports found</span>
                )}
            </div>
            <div className="flex flex-row justify-between items-center w-full">
                <div className="flex flex-col gap-1 justify-start items-start w-full">
                    {/* <label className="text-xs font-semibold" style={{ color: color.textDim }}>
                    Settings
                </label> */}
                    <div className="flex flex-row gap-2 text-xs" style={{ color: color.textMuted }}>
                        <span>Baud: <b>{baudRate}</b></span>
                        <span>{dataBits}N{stopBits}</span>
                        <span>Parity: {parity}</span>
                        <span>Flow: {flowControl}</span>
                    </div>
                </div>
                <button
                    className={`rounded px-4 py-2 text-white text-sm font-semibold transition-colors ${isConnected ? "bg-red-500" : "bg-green-600"}`}
                    onClick={handleConnect}
                >
                    {isConnected ? "Disconnect" : "Connect"}
                </button>
            </div>
            {isConnected && (
                <span className=" absolute right-3 top-2 text-green-600 font-bold text-xs">Connected</span>
            )}
        </div>
    )
}

