"""
***************************************************************************
*                                                                         *
*   This program is free software; you can redistribute it and/or modify  *
*   it under the terms of the GNU General Public License as published by  *
*   the Free Software Foundation; either version 2 of the License, or     *
*   (at your option) any later version.                                   *
*                                                                         *
***************************************************************************
"""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Any, Optional

from qgis.PyQt.QtCore import QVariant
from qgis.core import (
	Qgis,
	QgsCoordinateReferenceSystem,
	QgsFeature,
	QgsField,
	QgsFields,
	QgsGeometry,
	QgsProcessing,
	QgsProcessingAlgorithm,
	QgsProcessingContext,
	QgsProcessingException,
	QgsProcessingFeedback,
	QgsProcessingLayerPostProcessorInterface,
	QgsProcessingParameterBoolean,
	QgsProcessingParameterCrs,
	QgsProcessingParameterFeatureSink,
	QgsProcessingParameterFile,
	QgsProcessingParameterNumber,
	QgsProcessingParameterString,
	QgsWkbTypes,
)


class AutoOpen3DPostProcessor(QgsProcessingLayerPostProcessorInterface):
	def __init__(self, should_open: bool):
		super().__init__()
		self.should_open = should_open

	def _apply_3d_renderer(self, layer, feedback):
		try:
			import qgis._3d as q3d  # type: ignore
		except Exception:
			feedback.pushWarning("3D API module is unavailable; cannot auto-configure 3D renderer.")
			return

		renderer_cls = getattr(q3d, "QgsVectorLayer3DRenderer", None)
		symbol_cls = getattr(q3d, "QgsPolygon3DSymbol", None)
		if renderer_cls is None or symbol_cls is None:
			feedback.pushWarning("3D renderer classes are unavailable in this QGIS build.")
			return

		if not hasattr(layer, "setRenderer3D"):
			feedback.pushWarning("Layer does not support setRenderer3D in this runtime.")
			return

		try:
			symbol = symbol_cls()

			set_altitude_clamping = getattr(symbol, "setAltitudeClamping", None)
			if callable(set_altitude_clamping):
				clamp_mode = None
				if hasattr(Qgis, "AltitudeClamping"):
					clamp_mode = getattr(Qgis.AltitudeClamping, "Relative", None)
				if clamp_mode is not None:
					set_altitude_clamping(clamp_mode)

			if hasattr(symbol, "setExtrusionHeightExpression"):
				symbol.setExtrusionHeightExpression('"height"')
			elif hasattr(symbol, "setExtrusionHeight"):
				symbol.setExtrusionHeight(1.0)

			if hasattr(symbol, "setHeightExpression"):
				symbol.setHeightExpression('"base_z"')

			renderer = renderer_cls(symbol)
			layer.setRenderer3D(renderer)
			layer.triggerRepaint()
			feedback.pushInfo("Configured layer 3D renderer: extruded polygons using field 'height'.")
		except Exception as exc:
			feedback.pushWarning(f"Could not configure 3D renderer automatically: {exc}")

	def postProcessLayer(self, layer, context, feedback):
		if layer is not None:
			self._apply_3d_renderer(layer, feedback)

		if not self.should_open:
			return

		try:
			from qgis.utils import iface  # type: ignore
		except Exception:
			feedback.pushWarning("QGIS GUI interface is unavailable; could not auto-open 3D map view.")
			return

		if iface is None:
			feedback.pushWarning("QGIS interface is unavailable; could not auto-open 3D map view.")
			return

		opened = False

		for method_name in ("createNewMapCanvas3D", "open3DMapView", "new3DMapCanvas"):
			method = getattr(iface, method_name, None)
			if callable(method):
				try:
					method()
					opened = True
					break
				except Exception:
					continue

		if not opened:
			for action_name in ("actionNew3DMapCanvas", "actionNew3DMapView"):
				action_getter = getattr(iface, action_name, None)
				if callable(action_getter):
					try:
						action = action_getter()
						if action is not None:
							action.trigger()
							opened = True
							break
					except Exception:
						continue

		if opened:
			feedback.pushInfo("Opened 3D map view automatically. Set extrusion to field 'height' for cylinder columns.")
		else:
			feedback.pushWarning("Could not find a compatible API to auto-open 3D map view in this QGIS build.")


class TargetDistanceColumnsAlgorithm(QgsProcessingAlgorithm):
	_post_processor = None

	INPUT_CSV = "INPUT_CSV"
	INPUT_CRS = "INPUT_CRS"
	X_FIELD = "X_FIELD"
	Y_FIELD = "Y_FIELD"
	DISTANCE_FIELD = "DISTANCE_FIELD"
	BASE_Z = "BASE_Z"
	HEIGHT_SCALE = "HEIGHT_SCALE"
	CYLINDER_RADIUS = "CYLINDER_RADIUS"
	CIRCLE_SEGMENTS = "CIRCLE_SEGMENTS"
	AUTO_OPEN_3D = "AUTO_OPEN_3D"
	LOG_EVERY_N = "LOG_EVERY_N"
	OUTPUT = "OUTPUT"

	def name(self) -> str:
		return "target_distance_columns_3d"

	def displayName(self) -> str:
		return "Target Distance Columns (3D)"

	def group(self) -> str:
		return "EERL Drone"

	def groupId(self) -> str:
		return "eerl_drone"

	def shortDescription(self) -> str:
		return "Creates cylinder footprint polygons with height attributes for 3D columns."

	def shortHelpString(self) -> str:
		return (
			"Builds cylinder footprint polygons from telemetry CSV rows. Each feature is centered "
			"at target_longitude/target_latitude and contains base_z and height attributes, where "
			"height = distance * height_scale. In 3D map view, set extrusion to field 'height' "
			"to visualize vertical columns."
		)

	def initAlgorithm(self, config: Optional[dict[str, Any]] = None):
		self.addParameter(
			QgsProcessingParameterFile(
				self.INPUT_CSV,
				"Telemetry CSV file",
				extension="csv",
			)
		)

		self.addParameter(
			QgsProcessingParameterCrs(
				self.INPUT_CRS,
				"Coordinate reference system for target coordinates",
				defaultValue="EPSG:4326",
			)
		)

		self.addParameter(
			QgsProcessingParameterString(
				self.X_FIELD,
				"Longitude field",
				defaultValue="target_longitude",
			)
		)

		self.addParameter(
			QgsProcessingParameterString(
				self.Y_FIELD,
				"Latitude field",
				defaultValue="target_latitude",
			)
		)

		self.addParameter(
			QgsProcessingParameterString(
				self.DISTANCE_FIELD,
				"Distance/height field",
				defaultValue="distance",
			)
		)

		self.addParameter(
			QgsProcessingParameterNumber(
				self.BASE_Z,
				"Base Z value",
				type=QgsProcessingParameterNumber.Double,
				defaultValue=0.0,
			)
		)

		self.addParameter(
			QgsProcessingParameterNumber(
				self.HEIGHT_SCALE,
				"Height scale multiplier",
				type=QgsProcessingParameterNumber.Double,
				defaultValue=1.0,
				minValue=0.0,
			)
		)

		self.addParameter(
			QgsProcessingParameterNumber(
				self.CYLINDER_RADIUS,
				"Cylinder radius (meters)",
				type=QgsProcessingParameterNumber.Double,
				defaultValue=0.75,
				minValue=0.01,
			)
		)

		self.addParameter(
			QgsProcessingParameterNumber(
				self.CIRCLE_SEGMENTS,
				"Circle segments",
				type=QgsProcessingParameterNumber.Integer,
				defaultValue=12,
				minValue=4,
			)
		)

		self.addParameter(
			QgsProcessingParameterBoolean(
				self.AUTO_OPEN_3D,
				"Open 3D map view automatically",
				defaultValue=True,
			)
		)

		self.addParameter(
			QgsProcessingParameterNumber(
				self.LOG_EVERY_N,
				"Log distance/height every N rows (0 to disable)",
				type=QgsProcessingParameterNumber.Integer,
				defaultValue=1000,
				minValue=0,
			)
		)

		self.addParameter(
			QgsProcessingParameterFeatureSink(
				self.OUTPUT,
				"Output cylinder footprints (use height field for 3D extrusion)",
				type=QgsProcessing.TypeVectorPolygon,
			)
		)

	def processAlgorithm(
		self,
		parameters: dict[str, Any],
		context: QgsProcessingContext,
		feedback: QgsProcessingFeedback,
	) -> dict[str, Any]:
		csv_path = self.parameterAsFile(parameters, self.INPUT_CSV, context)
		if not csv_path:
			raise QgsProcessingException("Telemetry CSV file is required.")

		csv_file = Path(csv_path)
		if not csv_file.exists():
			raise QgsProcessingException(f"Telemetry CSV file not found: {csv_path}")

		input_crs = self.parameterAsCrs(parameters, self.INPUT_CRS, context)
		if not input_crs.isValid():
			input_crs = QgsCoordinateReferenceSystem("EPSG:4326")

		x_field = self.parameterAsString(parameters, self.X_FIELD, context).strip() or "target_longitude"
		y_field = self.parameterAsString(parameters, self.Y_FIELD, context).strip() or "target_latitude"
		distance_field = self.parameterAsString(parameters, self.DISTANCE_FIELD, context).strip() or "distance"
		base_z = self.parameterAsDouble(parameters, self.BASE_Z, context)
		height_scale = self.parameterAsDouble(parameters, self.HEIGHT_SCALE, context)
		cylinder_radius_m = self.parameterAsDouble(parameters, self.CYLINDER_RADIUS, context)
		circle_segments = int(self.parameterAsInt(parameters, self.CIRCLE_SEGMENTS, context))
		auto_open_3d = self.parameterAsBool(parameters, self.AUTO_OPEN_3D, context)
		log_every_n = int(self.parameterAsInt(parameters, self.LOG_EVERY_N, context))
        
		fields = QgsFields()
		fields.append(QgsField("row_id", QVariant.Int))
		fields.append(QgsField("x", QVariant.Double))
		fields.append(QgsField("y", QVariant.Double))
		fields.append(QgsField("distance", QVariant.Double))
		fields.append(QgsField("base_z", QVariant.Double))
		fields.append(QgsField("height", QVariant.Double))
		fields.append(QgsField("radius_m", QVariant.Double))

		sink, dest_id = self.parameterAsSink(
			parameters,
			self.OUTPUT,
			context,
			fields,
			QgsWkbTypes.Polygon,
			input_crs,
		)
		if sink is None:
			raise QgsProcessingException("Could not create output sink for cylinder footprints.")

		delimiter = self._detect_delimiter(csv_file)
		created = 0
		skipped = 0

		with csv_file.open("r", encoding="utf-8-sig", newline="") as handle:
			reader = csv.DictReader(handle, delimiter=delimiter)
			if not reader.fieldnames:
				raise QgsProcessingException("CSV appears to be empty or missing a header row.")

			headers = set(reader.fieldnames)
			required = [x_field, y_field, distance_field]
			missing = [name for name in required if name not in headers]
			if missing:
				raise QgsProcessingException(
					"Input is missing required columns: " + ", ".join(missing)
				)

			for row_id, row in enumerate(reader, start=1):
				x = self._to_float(row.get(x_field))
				y = self._to_float(row.get(y_field))
				distance = self._to_float(row.get(distance_field))

				if x is None or y is None:
					skipped += 1
					continue

				distance_value = max(0.0, distance if distance is not None else 0.0)
				height = distance_value * height_scale

				radius_map_units = self._meters_to_map_units(cylinder_radius_m, y, input_crs)
				if radius_map_units <= 0:
					skipped += 1
					continue

				geom = QgsGeometry.fromWkt(f"POINT ({x} {y})").buffer(radius_map_units, circle_segments)
				if geom is None or geom.isEmpty():
					skipped += 1
					continue

				feature = QgsFeature(fields)
				feature.setGeometry(geom)
				feature.setAttributes([row_id, x, y, distance_value, base_z, height, cylinder_radius_m])
				sink.addFeature(feature)
				created += 1

				if log_every_n > 0 and row_id % log_every_n == 0:
					feedback.pushInfo(
						f"Row {row_id}: distance={distance_value}, height={height}, x={x}, y={y}"
					)
		feedback.pushInfo(
			f"Created {created} cylinder footprints; skipped {skipped} invalid rows. "
			"In 3D view, extrude by field 'height'."
		)

		if context.willLoadLayerOnCompletion(dest_id):
			self.__class__._post_processor = AutoOpen3DPostProcessor(auto_open_3d)
			context.layerToLoadOnCompletionDetails(dest_id).setPostProcessor(
				self.__class__._post_processor
			)

		return {self.OUTPUT: dest_id}

	def createInstance(self):
		return self.__class__()

	def _detect_delimiter(self, csv_file: Path) -> str:
		with csv_file.open("r", encoding="utf-8-sig", newline="") as handle:
			header_line = handle.readline()

		if "\t" in header_line and header_line.count("\t") > header_line.count(","):
			return "\t"
		return ","

	def _to_float(self, value: Any) -> Optional[float]:
		if value is None:
			return None

		text = str(value).strip()
		if text == "":
			return None

		text = text.replace(",", ".")
		filtered = "".join(ch for ch in text if ch.isdigit() or ch in ".-+eE")
		if filtered in ("", ".", "-", "+"):
			return None

		try:
			return float(filtered)
		except ValueError:
			return None

	def _meters_to_map_units(
		self,
		meters: float,
		latitude: float,
		crs: QgsCoordinateReferenceSystem,
	) -> float:
		if meters <= 0:
			return 0.0

		if not crs.isGeographic():
			return meters

		# Approximate conversion at the feature latitude for geographic CRS.
		lat_rad = math.radians(latitude)
		meters_per_degree_lon = max(1e-9, 111320.0 * abs(math.cos(lat_rad)))
		return meters / meters_per_degree_lon

