import { useState } from "react";
import {
    ChevronRight,
    CircleAlert,
    CircleCheck,
    CirclePlus,
    FileUp,
    Map,
    MapPinned,
    Mountain,
} from "lucide-react";
import { color } from "../constants/tailwind";
import { MissionModal } from "./MissionModal";
import { CreateSite } from "./CreateSite";

const formatCoordinates = (site) => {
    if (
        !Number.isFinite(site.latitude) ||
        !Number.isFinite(site.longitude)
    ) {
        return "Coordinates imported";
    }

    const latitude = `${Math.abs(site.latitude).toFixed(3)}\u00b0 ${site.latitude < 0 ? "S" : "N"}`;
    const longitude = `${Math.abs(site.longitude).toFixed(3)}\u00b0 ${site.longitude < 0 ? "W" : "E"}`;
    return `${latitude}, ${longitude}`;
};

export function ImportSitesModal({
    onClose,
    children,
    sites = [],
    onImport,
    onCreate,
    onSelectSite,
    onSaveSite,
}) {
    const [isCreating, setIsCreating] = useState(false);
    const [localSites, setLocalSites] = useState([]);
    const [savedMessage, setSavedMessage] = useState("");
    const savedSites = [...sites, ...localSites];

    if (isCreating) {
        return (
            <MissionModal onClose={onClose} size="editor">
                <CreateSite
                    onBack={() => setIsCreating(false)}
                    onSave={async (site) => {
                        if (onSaveSite) await onSaveSite(site);
                        else setLocalSites((previous) => [...previous, site]);
                        setSavedMessage(`${site.name} saved for this session.`);
                        setIsCreating(false);
                    }}
                />
            </MissionModal>
        );
    }

    return (
        <MissionModal onClose={onClose}>
            <div className="flex min-w-0 flex-col gap-5" style={{ color: color.text }}>
                <header className="space-y-2 pr-8">
                    <h2 className="flex items-center gap-2.5 text-xl font-semibold">
                        <MapPinned size={21} style={{ color: color.orange }} aria-hidden="true" />
                        Site Manager
                    </h2>
                    <p className="text-sm leading-relaxed" style={{ color: color.textMuted }}>
                        Manage survey locations and prepare them for offline fieldwork.
                    </p>
                </header>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {[
                        { label: "Import sites", detail: "CSV, GeoJSON, KML, ZIP", icon: <FileUp size={21} aria-hidden="true" />, action: onImport },
                        { label: "Create site", detail: "Coordinates or map selection", icon: <CirclePlus size={21} aria-hidden="true" />, action: onCreate || (() => setIsCreating(true)) },
                    ].map(({ label, detail, icon, action }) => (
                        <button
                            key={label}
                            type="button"
                            onClick={action}
                            disabled={!action}
                            title={!action ? `${label} is not connected yet` : undefined}
                            className="flex min-h-28 min-w-0 flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors enabled:hover:!border-[#fd9456] enabled:hover:!bg-[#4a494d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#fd9456] disabled:cursor-not-allowed"
                            style={{ borderColor: color.border, backgroundColor: color.surface }}
                        >
                              <span style={{ color: color.orange }}>{icon}</span>
                            <span className="text-sm font-semibold">{label}</span>
                            <span className="text-xs leading-relaxed" style={{ color: color.textDim }}>
                                {detail}
                            </span>
                        </button>
                    ))}
                </div>

                {savedMessage && <p role="status" className="text-xs" style={{ color: color.green }}>{savedMessage}</p>}

                <section className="border-t pt-5" style={{ borderColor: color.border }} aria-label="Saved sites">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold">Saved sites</h3>
                        <span className="text-xs tabular-nums" style={{ color: color.textDim }}>
                            {savedSites.length} {savedSites.length === 1 ? "site" : "sites"}
                        </span>
                    </div>

                    {savedSites.length === 0 ? (
                        <div className="flex min-h-40 flex-col items-center justify-center gap-3 py-6 text-center">
                            <Map size={28} strokeWidth={1.5} style={{ color: color.textDim }} aria-hidden="true" />
                            <p className="text-sm" style={{ color: color.textMuted }}>No saved sites yet</p>
                        </div>
                    ) : (
                        <ul className="m-0 list-none p-0">
                            {savedSites.map((site, index) => {
                                const SiteIcon = site.offlineReady ? Mountain : Map;
                                const StatusIcon = site.offlineReady ? CircleCheck : CircleAlert;
                                return (
                                    <li key={site.id} className={index > 0 ? "border-t" : ""} style={{ borderColor: color.border }}>
                                        <button
                                            type="button"
                                            onClick={() => onSelectSite?.(site)}
                                            disabled={!onSelectSite}
                                            title={!onSelectSite ? "Site details are not connected yet" : undefined}
                                            className="flex w-full min-w-0 items-center gap-4 rounded-md px-2 py-5 text-left transition-colors enabled:hover:!bg-[#4a494d] focus-visible:outline-2 focus-visible:outline-[#fd9456] disabled:cursor-default sm:gap-5"
                                        >
                                            <SiteIcon size={25} strokeWidth={1.7} className="shrink-0" style={{ color: color.textMuted }} aria-hidden="true" />
                                            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                                                <span className="break-words text-sm font-semibold">{site.name}</span>
                                                <span className="text-xs leading-relaxed" style={{ color: color.textDim }}>
                                                    {formatCoordinates(site)}
                                                </span>
                                                <span className="flex items-start gap-1.5 text-xs leading-relaxed" style={{ color: site.offlineReady ? color.green : color.warning }}>
                                                    <StatusIcon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                                    {site.offlineReady ? "Offline imagery ready" : "Imagery not downloaded"}
                                                </span>
                                            </span>
                                            <ChevronRight size={18} className="shrink-0" style={{ color: color.textDim }} aria-hidden="true" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                {children}

                <footer className="flex justify-end border-t pt-4" style={{ borderColor: color.border }}>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md border px-4 py-2 text-xs font-medium transition-colors hover:!bg-[#4a494d] focus-visible:outline-2 focus-visible:outline-[#fd9456]"
                        style={{ borderColor: color.borderStrong, color: color.textMuted }}
                    >
                        Close
                    </button>
                </footer>
            </div>
        </MissionModal>
    );
}