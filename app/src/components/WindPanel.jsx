import React from "react";
import { tw, color } from "../constants/tailwind";

export function WindPanel() {
  return (
    <div className={tw.panel} style={{ backgroundColor: color.card }}>
      <div className="flex h-full w-full flex-col gap-4">
        <p className={`text-xl font-bold tracking-tight ${color.text}`}>
          Wind Panel
        </p>
        <img
          src="src/assets/Wind.png"
          alt="Wind Panel Placeholder"
          className="w-auto rounded-lg object-contain"
        />
      </div>
    </div>
  );
}
