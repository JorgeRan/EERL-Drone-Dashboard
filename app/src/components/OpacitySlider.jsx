import React from "react";

export const OpacityAdjuster = ({ value = 1, onChange }) => {
  const opacity = Number.isFinite(Number(value)) ? Number(value) : 1;

  const handleChange = (event) => {
    onChange?.(Number(event.target.value));
  };

  return (
    <div style={{ padding: "16px 20px" }}>
      <h3>Opacity: {Math.round(opacity * 100)}%</h3>

      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={opacity}
        onChange={handleChange}
        aria-label="Adjust trace opacity"
        style={{ width: "100%", maxWidth: "280px" }}
      />
    </div>
  );
};

export default OpacityAdjuster;
