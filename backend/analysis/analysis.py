# from __future__ import annotations

# import argparse
# import csv
# import math
# from dataclasses import dataclass
# from datetime import datetime
# from pathlib import Path
# from typing import Iterable

# METHANE_MOLAR_MASS = 0.01604  # kg / mol
# UNIVERSAL_GAS_CONSTANT = 8.314 # J / (mol * K)

# def ppm_to_kg_m3(
#     methane_ppm: float,
#     temperature_k: float = 293.15,
#     pressure_pa: float = 101_325.0,
# ) -> float:
#     if methane_ppm <= 0:
#         return 0.0
    
#     mole_fraction = methane_ppm * 1e-6
    
#     methane_mol_per_m3 = mole_fraction * (pressure_pa / (UNIVERSAL_GAS_CONSTANT * temperature_k))
#     return methane_mol_per_m3 * METHANE_MOLAR_MASS

# @dataclass(slots=True)
# class TelemetrySample:
#     timestamp_s: float
#     methane_ppm: float
#     wind_normal_m_s: float
#     latitude: float | None = None
#     longitude: float | None = None
#     altitude_m: float | None = None
    
# def estimate_mass_flux(
#     samples: Iterable[TelemetrySample],
#     transect_width_m: float,
#     mixing_height_m: float,
#     background_ppm: float = 1.9,
#     temperatur_k: float = 293.15,
#     pressure_pa: float = 101_325.0
# ) -> dict[str, float]:
    
#     sample_list = list(samples)
#     count = len(sample_list)
    
#     if count == 0 or transect_width_m <= 0 or mixing_height_m <= 0:
#         return {
#             "mass_flux_kg_s": 0.0,
#             "mass_flux_kg_h": 0.0,
#             "sample_count": float(count),
#             "surface_area_m2": max(0.0, transect_width_m * mixing_height_m),
#         }
#     area_total = transect_width_m * mixing_height_m
#     area_per_sample = area_total / count
#     flux_kg_s = 0.0
    
#     for sample in sample_list:
#         enhancement_ppm = max(0.0, sample.methane_ppm - background_ppm)
#         enhancement_kg_m3 = ppm_to_kg_m3(
#             enhancement_ppm,
#             temperature_k=temperatur_k,
#             pressure_pa=pressure_pa,
#         )
#         wind_normal = max(0.0, sample.wind_normal_m_s)
#         flux_kg_s += enhancement_kg_m3 * wind_normal * area_per_sample
    
#     return {
#         "mass_flux_kg_s": flux_kg_s,
#         "mass_flux_kg_h": flux_kg_s * 3600.0,
#         "sample_count": float(count),
#         "surface_area_m2": area_total,
#     }
    
from flask import Flask, request, jsonify
app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response

@app.route('/process_data', methods=['POST', 'OPTIONS'])
def handle_data():
    if request.method == 'OPTIONS':
        return ('', 204)

    data = request.get_json() 
    print(data)
    return jsonify({"status": "success", "received": data})

if __name__ == '__main__':
    app.run(port=5000)
