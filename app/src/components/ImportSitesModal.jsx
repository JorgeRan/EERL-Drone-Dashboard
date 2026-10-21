import { MapPinned } from "lucide-react";
import { color } from "../constants/tailwind";
import { MissionModal } from "./MissionModal";

export function ImportSitesModal({ onClose, children }) {
    return (
        <MissionModal onClose={onClose}>
            <div className="flex flex-col gap-5">
                
                    <h2
                        className="flex items-center gap-2 text-xl font-semibold"
                        style={{ color: color.text }}
                    >
                        <MapPinned size={20} />
                        Site Manager
                    </h2>
                    
            

                <div className="min-h-40">{children}</div>

                <div className="flex justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg border px-4 py-2 text-sm font-medium"
                        style={{
                            borderColor: color.borderStrong,
                            color: color.textMuted,
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </MissionModal>
    );
}