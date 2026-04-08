

from __future__ import annotations

import argparse
import csv
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


METHANE_MOLAR_MASS_KG_PER_MOL = 0.01604
UNIVERSAL_GAS_CONSTANT = 8.314462618  # J / (mol * K)


@dataclass(slots=True)
class TelemetrySample:
	timestamp_s: float
	methane_ppm: float
	wind_normal_m_s: float
	latitude: float | None = None
	longitude: float | None = None
	altitude_m: float | None = None


def ppm_to_kg_m3(
	methane_ppm: float,
	temperature_k: float = 293.15,
	pressure_pa: float = 101_325.0,
) -> float:
	"""Convert methane concentration in ppm (mole fraction) to kg/m^3."""
	if methane_ppm <= 0:
		return 0.0

	mole_fraction = methane_ppm * 1e-6
	# Ideal gas law: c_molar = p / (R * T), methane share = x * c_molar.
	methane_mol_per_m3 = mole_fraction * (pressure_pa / (UNIVERSAL_GAS_CONSTANT * temperature_k))
	return methane_mol_per_m3 * METHANE_MOLAR_MASS_KG_PER_MOL


def _safe_float(value: object, default: float = 0.0) -> float:
	try:
		return float(value)
	except (TypeError, ValueError):
		return default


def estimate_mass_flux(
	samples: Iterable[TelemetrySample],
	transect_width_m: float,
	mixing_height_m: float,
	background_ppm: float = 1.9,
	temperature_k: float = 293.15,
	pressure_pa: float = 101_325.0,
) -> dict[str, float]:
	"""Estimate mass flux through a control surface using discrete samples.

	Formula (discrete approximation):
	  Q ~= sum_i(ΔC_i * U_{n,i} * ΔA)
	where:
	  - ΔC_i is methane enhancement above background in kg/m^3
	  - U_{n,i} is wind speed normal to transect in m/s
	  - ΔA is per-sample area element of the transect in m^2
	"""
	sample_list = list(samples)
	count = len(sample_list)

	if count == 0 or transect_width_m <= 0 or mixing_height_m <= 0:
		return {
			"mass_flux_kg_s": 0.0,
			"mass_flux_kg_h": 0.0,
			"sample_count": float(count),
			"surface_area_m2": max(0.0, transect_width_m * mixing_height_m),
		}

	area_total = transect_width_m * mixing_height_m
	area_per_sample = area_total / count
	flux_kg_s = 0.0

	for sample in sample_list:
		enhancement_ppm = max(0.0, sample.methane_ppm - background_ppm)
		enhancement_kg_m3 = ppm_to_kg_m3(
			enhancement_ppm,
			temperature_k=temperature_k,
			pressure_pa=pressure_pa,
		)
		wind_normal = max(0.0, sample.wind_normal_m_s)
		flux_kg_s += enhancement_kg_m3 * wind_normal * area_per_sample

	return {
		"mass_flux_kg_s": flux_kg_s,
		"mass_flux_kg_h": flux_kg_s * 3600.0,
		"sample_count": float(count),
		"surface_area_m2": area_total,
	}


def estimate_emission_rate(
	samples: Iterable[TelemetrySample],
	transect_width_m: float,
	mixing_height_m: float,
	background_ppm: float = 1.9,
	temperature_k: float = 293.15,
	pressure_pa: float = 101_325.0,
) -> dict[str, float]:
	"""Estimate source emission rate with a bulk-average control-surface model.

	This is a simpler companion estimate that uses mean enhancement and mean
	normal wind speed:
	  E ~= mean(ΔC) * mean(U_n) * A
	"""
	sample_list = list(samples)
	count = len(sample_list)

	if count == 0 or transect_width_m <= 0 or mixing_height_m <= 0:
		return {
			"emission_rate_kg_s": 0.0,
			"emission_rate_kg_h": 0.0,
			"sample_count": float(count),
			"surface_area_m2": max(0.0, transect_width_m * mixing_height_m),
		}

	enhancements_kg_m3 = []
	wind_normals = []
	for sample in sample_list:
		enhancement_ppm = max(0.0, sample.methane_ppm - background_ppm)
		enhancements_kg_m3.append(
			ppm_to_kg_m3(
				enhancement_ppm,
				temperature_k=temperature_k,
				pressure_pa=pressure_pa,
			)
		)
		wind_normals.append(max(0.0, sample.wind_normal_m_s))

	mean_enhancement = sum(enhancements_kg_m3) / count
	mean_wind = sum(wind_normals) / count
	area_total = transect_width_m * mixing_height_m
	emission_kg_s = mean_enhancement * mean_wind * area_total

	return {
		"emission_rate_kg_s": emission_kg_s,
		"emission_rate_kg_h": emission_kg_s * 3600.0,
		"sample_count": float(count),
		"surface_area_m2": area_total,
	}


def _parse_time_to_seconds(raw_value: str, fallback_index: int) -> float:
	if not raw_value:
		return float(fallback_index)

	try:
		# Expected form: YYYY-MM-DD_HH:MM:SS:ms
		base, millis = raw_value.rsplit(":", 1)
		timestamp = datetime.strptime(base, "%Y-%m-%d_%H:%M:%S")
		return timestamp.timestamp() + (_safe_float(millis) / 1000.0)
	except ValueError:
		try:
			return datetime.fromisoformat(raw_value.replace("Z", "+00:00")).timestamp()
		except ValueError:
			return float(fallback_index)


def _read_samples_from_csv(csv_path: Path) -> list[TelemetrySample]:
	samples: list[TelemetrySample] = []

	with csv_path.open("r", newline="", encoding="utf-8") as file_obj:
		reader = csv.DictReader(file_obj)
		for index, row in enumerate(reader):
			methane_ppm = _safe_float(
				row.get("methane")
				or row.get("methane_concentration")
				or row.get("sniffer_ppm")
				or row.get("purway_ppm")
				or row.get("purway_ppn"),
				default=0.0,
			)

			wind_u = _safe_float(row.get("wind_u"), default=0.0)
			wind_v = _safe_float(row.get("wind_v"), default=0.0)
			wind_normal = math.hypot(wind_u, wind_v)
			if wind_normal <= 0:
				wind_normal = _safe_float(row.get("speed"), default=0.0)

			samples.append(
				TelemetrySample(
					timestamp_s=_parse_time_to_seconds(row.get("time", ""), index),
					methane_ppm=max(0.0, methane_ppm),
					wind_normal_m_s=max(0.0, wind_normal),
					latitude=_safe_float(row.get("latitude"), default=math.nan),
					longitude=_safe_float(row.get("longitude"), default=math.nan),
					altitude_m=_safe_float(row.get("altitude"), default=math.nan),
				)
			)

	return samples


def _build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(description="Methane mass flux + emission rate analysis")
	parser.add_argument(
		"--csv",
		default="../data/methane20260310005557.csv",
		help="Path to telemetry CSV file",
	)
	parser.add_argument("--transect-width", type=float, default=80.0, help="Transect width (m)")
	parser.add_argument("--mixing-height", type=float, default=25.0, help="Mixing/plume height (m)")
	parser.add_argument("--background-ppm", type=float, default=1.9, help="Background CH4 concentration (ppm)")
	parser.add_argument("--temperature-k", type=float, default=293.15, help="Air temperature (K)")
	parser.add_argument("--pressure-pa", type=float, default=101325.0, help="Air pressure (Pa)")
	return parser


def main() -> None:
	parser = _build_parser()
	args = parser.parse_args()

	csv_path = Path(args.csv).expanduser().resolve()
	if not csv_path.exists():
		raise FileNotFoundError(f"CSV not found: {csv_path}")

	samples = _read_samples_from_csv(csv_path)

	mass_flux = estimate_mass_flux(
		samples,
		transect_width_m=args.transect_width,
		mixing_height_m=args.mixing_height,
		background_ppm=args.background_ppm,
		temperature_k=args.temperature_k,
		pressure_pa=args.pressure_pa,
	)
	emission_rate = estimate_emission_rate(
		samples,
		transect_width_m=args.transect_width,
		mixing_height_m=args.mixing_height,
		background_ppm=args.background_ppm,
		temperature_k=args.temperature_k,
		pressure_pa=args.pressure_pa,
	)

	print(f"CSV: {csv_path}")
	print(f"Samples: {len(samples)}")
	print("---")
	print(
		"Mass Flux Estimation: "
		f"{mass_flux['mass_flux_kg_s']:.8f} kg/s "
		f"({mass_flux['mass_flux_kg_h']:.5f} kg/h)"
	)
	print(
		"Emission Rate Estimation: "
		f"{emission_rate['emission_rate_kg_s']:.8f} kg/s "
		f"({emission_rate['emission_rate_kg_h']:.5f} kg/h)"
	)


if __name__ == "__main__":
	main()

