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

from typing import Any, Optional
import math
import shutil
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlencode

from qgis.PyQt.QtCore import QSize, Qt
from qgis.PyQt.QtGui import QImage, QPainter
from qgis import processing
from qgis.core import (
    QgsCoordinateReferenceSystem,
    QgsCoordinateTransform,
    QgsMapRendererCustomPainterJob,
    QgsMapSettings,
    QgsProject,
    QgsRasterLayer,
    QgsProcessingAlgorithm,
    QgsProcessingContext,
    QgsProcessingException,
    QgsProcessingFeedback,
    QgsProcessingLayerPostProcessorInterface,
    QgsProcessingParameterBoolean,
    QgsProcessingParameterCrs,
    QgsProcessingParameterFile,
    QgsProcessingParameterFileDestination,
    QgsProcessingParameterNumber,
    QgsProcessingParameterRasterDestination,
    QgsProcessingParameterString,
    QgsProcessingUtils,
    QgsVectorLayer,
)


def _apply_renderer_stretch(layer, feedback, label: str = "Style"):
    provider = layer.dataProvider()
    renderer = layer.renderer()
    if renderer is None:
        return

    set_min = getattr(renderer, "setClassificationMin", None)
    set_max = getattr(renderer, "setClassificationMax", None)
    if not callable(set_min) or not callable(set_max):
        return

    stretch_min = None
    stretch_max = None

    cumulative_cut = getattr(provider, "cumulativeCut", None)
    if callable(cumulative_cut):
        try:
            stretch_min, stretch_max = cumulative_cut(1, 0.02, 0.98, layer.extent(), 0)
        except TypeError:
            try:
                stretch_min, stretch_max = cumulative_cut(1, 0.02, 0.98)
            except Exception:
                stretch_min, stretch_max = None, None
        except Exception:
            stretch_min, stretch_max = None, None

    if not (
        isinstance(stretch_min, (int, float))
        and isinstance(stretch_max, (int, float))
        and math.isfinite(float(stretch_min))
        and math.isfinite(float(stretch_max))
        and float(stretch_min) < float(stretch_max)
    ):
        stats = provider.bandStatistics(1)
        stretch_min = float(stats.minimumValue)
        stretch_max = float(stats.maximumValue)
        source = "min/max"
    else:
        source = "2-98 percentile"

    if math.isfinite(float(stretch_min)) and math.isfinite(float(stretch_max)) and float(stretch_min) < float(stretch_max):
        set_min(float(stretch_min))
        set_max(float(stretch_max))
        feedback.pushInfo(
            f"{label} range set from {source}: min={float(stretch_min)}, max={float(stretch_max)}"
        )


class HeatmapStylePostProcessor(QgsProcessingLayerPostProcessorInterface):
    def __init__(self, style_path: str):
        super().__init__()
        self.style_path = style_path

    def postProcessLayer(self, layer, context, feedback):
        if not self.style_path:
            return

        if not layer or not layer.isValid():
            feedback.pushWarning("Cannot style heatmap because output layer is invalid.")
            return

        style_file = Path(self.style_path)
        if not style_file.exists():
            feedback.pushWarning(
                f"QML style file not found, skipping style: {self.style_path}"
            )
            return

        load_result = layer.loadNamedStyle(str(style_file))
        if isinstance(load_result, tuple):
            message = str(load_result[0]) if len(load_result) > 0 else ""
            ok = bool(load_result[1]) if len(load_result) > 1 else False
        else:
            ok = bool(load_result)
            message = ""

        if not ok:
            feedback.pushWarning(
                f"Failed to apply QML style: {message}"
            )
            return

        try:
            _apply_renderer_stretch(layer, feedback, label="Output style")
        except Exception as exc:
            feedback.pushWarning(f"Could not auto-adjust style range: {exc}")

        layer.triggerRepaint()
        feedback.pushInfo(f"Applied QML style to heatmap: {self.style_path}")


class MethaneHeatmapAlgorithm(QgsProcessingAlgorithm):
    _style_post_processor = None

    INPUT_CSV = "INPUT_CSV"
    ORTHOPHOTO = "ORTHOPHOTO"
    ANALYSIS_CRS = "ANALYSIS_CRS"
    WEIGHT_FIELD = "WEIGHT_FIELD"
    CONVERT_TO_PPM = "CONVERT_TO_PPM"
    STYLE_QML = "STYLE_QML"
    KMZ_OUTPUT = "KMZ_OUTPUT"
    NORMALIZE_PERCENT = "NORMALIZE_PERCENT"
    RADIUS = "RADIUS"
    PIXEL_SIZE = "PIXEL_SIZE"
    OUTPUT = "OUTPUT"

    def name(self) -> str:
        return "methane_heatmap_from_telemetry"

    def displayName(self) -> str:
        return "Methane Heatmap From Telemetry"

    def group(self) -> str:
        return "EERL Drone"

    def groupId(self) -> str:
        return "eerl_drone"

    def shortDescription(self) -> str:
        return "Validates telemetry columns and builds a methane heatmap raster."

    def shortHelpString(self) -> str:
        return (
            "Input must be a telemetry CSV containing these fields: sample_index, "
            "drone_id, sensor_mode, timestamp_iso, timestamp_ms, "
            "time_local, latitude, longitude, altitude, target_latitude, "
            "target_longitude, target_altitude, methane, sniffer, purway, acetylene, "
            "nitrous_oxide, ethylene, distance, speed, wind_u, wind_v, wind_w, "
            "methane_valid. All records are included; methane_valid values such as 0, "
            "1, and 3 are accepted and not filtered out. Longitude and latitude are "
            "used to build the point layer automatically. Heatmap radius and pixel size "
            "are interpreted in analysis CRS units, so a projected CRS (meters) is "
            "recommended. Optionally load an orthophoto raster into the map when "
            "the algorithm runs. By default, output values remain raw relative "
            "intensity. Enable normalization to convert output to 0-100 percent of "
            "maximum intensity."
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
            QgsProcessingParameterFile(
                self.ORTHOPHOTO,
                "Optional orthophoto (KMZ)",
                optional=True,
            )
        )

        self.addParameter(
            QgsProcessingParameterCrs(
                self.ANALYSIS_CRS,
                "Analysis CRS (use projected CRS for meter-based radius)",
                defaultValue="EPSG:3857",
            )
        )

        self.addParameter(
            QgsProcessingParameterString(
                self.WEIGHT_FIELD,
                "Weight field",
                defaultValue="purway",
            )
        )

        self.addParameter(
            QgsProcessingParameterBoolean(
                self.CONVERT_TO_PPM,
                "Convert selected weight from ppm*m to ppm (divide by distance)",
                defaultValue=True,
            )
        )

        style_param = QgsProcessingParameterFile(
            self.STYLE_QML,
            "Optional QML style file",
            extension="qml",
            optional=True,
        )
        self.addParameter(style_param)

        self.addParameter(
            QgsProcessingParameterFileDestination(
                name=self.KMZ_OUTPUT,
                description="Output combined KMZ",
                fileFilter="KMZ files (*.kmz)",
                optional=True,
                createByDefault=False,
            )
        )

        self.addParameter(
            QgsProcessingParameterBoolean(
                self.NORMALIZE_PERCENT,
                "Normalize output raster to 0-100 percent",
                defaultValue=False,
            )
        )

        self.addParameter(
            QgsProcessingParameterNumber(
                self.RADIUS,
                "Heatmap radius (meters)",
                type=QgsProcessingParameterNumber.Double,
                defaultValue=20.0,
                minValue=0.1,
            )
        )

        self.addParameter(
            QgsProcessingParameterNumber(
                self.PIXEL_SIZE,
                "Heatmap pixel size",
                type=QgsProcessingParameterNumber.Double,
                defaultValue=0.50,
                minValue=0.1,
            )
        )

        self.addParameter(
            QgsProcessingParameterRasterDestination(
                self.OUTPUT,
                "Output methane heatmap",
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

        delimiter = self._detect_delimiter(csv_file)
        input_layer = self._load_csv_layer(csv_file, delimiter)
        if input_layer is None or not input_layer.isValid():
            feedback.pushInfo(
                "Delimited text URI: " + self._build_csv_uri(csv_file, delimiter)
            )
            raise QgsProcessingException(
                f"Failed to load telemetry CSV: {csv_path} (delimiter='{delimiter}')"
            )
        required_fields = {
            "mission_name", 
            "mission_id",
            "sample_index",
            "drone_id",
            "sensor_mode",
            "timestamp_iso",
            "timestamp_ms",
            "time_local",
            "latitude",
            "longitude",
            "altitude",
            "target_latitude",
            "target_longitude",
            "target_altitude",
            "methane",
            "sniffer",
            "purway",
            "acetylene",
            "nitrous_oxide",
            "ethylene",
            "distance",
            "speed",
            "wind_u",
            "wind_v",
            "wind_w",
            "methane_valid"
        }

        
        layer_fields = {field.name() for field in input_layer.fields()}
        missing = sorted(required_fields - layer_fields)
        if missing:
            raise QgsProcessingException(
                "Input is missing required columns: " + ", ".join(missing)
            )

        radius = self.parameterAsDouble(parameters, self.RADIUS, context)
        pixel_size = self.parameterAsDouble(parameters, self.PIXEL_SIZE, context)
        output_path = self.parameterAsOutputLayer(parameters, self.OUTPUT, context)
        weight_field = self.parameterAsString(parameters, self.WEIGHT_FIELD, context).strip()
        style_qml = self.parameterAsFile(parameters, self.STYLE_QML, context)
        orthophoto_path = self.parameterAsFile(parameters, self.ORTHOPHOTO, context)
        kmz_output = self.parameterAsFileOutput(parameters, self.KMZ_OUTPUT, context)
        if kmz_output:
            kmz_path = Path(kmz_output)
            if kmz_path.suffix in ("", "."):
                kmz_output = str(kmz_path.with_suffix(".kmz"))
        normalize_percent = self.parameterAsBool(parameters, self.NORMALIZE_PERCENT, context)
        convert_to_ppm = self.parameterAsBool(parameters, self.CONVERT_TO_PPM, context)
        if not weight_field:
            weight_field = "purway"

        if orthophoto_path:
            orthophoto_file = Path(orthophoto_path)
            if not orthophoto_file.exists():
                raise QgsProcessingException(
                    f"Orthophoto file not found: {orthophoto_path}"
                )
            orthophoto_layer = self._load_orthophoto_layer(
                orthophoto_file, context, feedback
            )
            if orthophoto_layer is None or not orthophoto_layer.isValid():
                raise QgsProcessingException(
                    f"Failed to load GroundOverlay KMZ: {orthophoto_path}"
                )

            QgsProject.instance().addMapLayer(orthophoto_layer, True)
            feedback.pushInfo(f"Orthophoto loaded: {orthophoto_path}")

        analysis_crs = self.parameterAsCrs(parameters, self.ANALYSIS_CRS, context)
        if not analysis_crs.isValid():
            analysis_crs = QgsCoordinateReferenceSystem("EPSG:3857")

        if weight_field not in layer_fields:
            raise QgsProcessingException(
                f"Weight field '{weight_field}' was not found in input CSV."
            )

        heatmap_input = input_layer
        
        feedback.pushInfo(f"Weight field selected: {weight_field}")
        
        for i, feat in enumerate(heatmap_input.getFeatures()):
            feedback.pushInfo(
                f"Raw value: {feat[weight_field]}"
                f"({type(feat[weight_field]).__name__})"
            )
            
            if i >= 10:
                break
                
        # feedback.pushInfo("=== Second Line ===")
        # for i,feat in enumerate(input_layer.getFeatures()):
        #     for i in range(0,23):
        #         feedback.pushInfo(f"{feat[i]}")
                
        #     if i == 2:
        #         break
        
        feedback.pushInfo("=== 3000 Values ===")
        
        for i, feat in enumerate(input_layer.getFeatures()):
            feedback.pushInfo(
                f"purway={feat['sniffer']} distance={feat['nitrous_oxide']}"
            )
            
            if i == 2999:
                break
        
        if heatmap_input.sourceCrs().isValid() and heatmap_input.sourceCrs() != analysis_crs:
            feedback.pushInfo(
                f"Reprojecting input layer from {heatmap_input.sourceCrs().authid()} to {analysis_crs.authid()} for heatmap analysis"
            )
            reproject_output = processing.run(
                "native:reprojectlayer",
                {
                    "INPUT": heatmap_input,
                    "TARGET_CRS": analysis_crs,
                    "OUTPUT": "memory:",
                },
                context=context,
                feedback=feedback,
                is_child_algorithm=True,
            )["OUTPUT"]

            if hasattr(reproject_output, "featureCount"):
                heatmap_input = reproject_output
            else:
                resolved_layer = QgsProcessingUtils.mapLayerFromString(
                    str(reproject_output), context
                )
                if resolved_layer is None:
                    raise QgsProcessingException(
                        "Failed to resolve reprojected layer for heatmap input."
                    )
                heatmap_input = resolved_layer

        if convert_to_ppm:
            feedback.pushInfo("Weight conversion mode: ppm (weight / distance)")
            numeric_weight_expression = (
                f"with_variable('w_raw', trim(coalesce(\"{weight_field}\", '')), "
                "with_variable('w_norm', replace(@w_raw, ',', '.'), "
                "with_variable('w_clean', regexp_replace(@w_norm, '[^0-9eE+.-]', ''), "
                "with_variable('w_val', coalesce(try(to_real(@w_norm), NULL), try(to_real(@w_clean), NULL), 0), "
                "with_variable('d_raw', trim(coalesce(\"distance\", '')), "
                "with_variable('d_norm', replace(@d_raw, ',', '.'), "
                "with_variable('d_clean', regexp_replace(@d_norm, '[^0-9eE+.-]', ''), "
                "with_variable('d_val', coalesce(try(to_real(@d_norm), NULL), try(to_real(@d_clean), NULL), 0), "
                "if(@d_val <= 0, 0, @w_val / @d_val)))))))))"
            )
        else:
            feedback.pushInfo("Weight conversion mode: raw selected weight field (no distance division)")
            numeric_weight_expression = (
                f"with_variable('w_raw', trim(coalesce(\"{weight_field}\", '')), "
                "with_variable('w_norm', replace(@w_raw, ',', '.'), "
                "with_variable('w_clean', regexp_replace(@w_norm, '[^0-9eE+.-]', ''), "
                "coalesce(try(to_real(@w_norm), NULL), try(to_real(@w_clean), NULL), 0))))"
            )
        weighted_output = processing.run(
            "native:fieldcalculator",
            {
                "INPUT": heatmap_input,
                "FIELD_NAME": "_w_num",
                "FIELD_TYPE": 0,
                "FIELD_LENGTH": 20,
                "FIELD_PRECISION": 8,
                "FORMULA": numeric_weight_expression,
                "OUTPUT": "memory:",
            },
            context=context,
            feedback=feedback,
            is_child_algorithm=True,
        )["OUTPUT"]

        if hasattr(weighted_output, "featureCount"):
            heatmap_input = weighted_output
        else:
            resolved_weighted_layer = QgsProcessingUtils.mapLayerFromString(
                str(weighted_output), context
            )
            if resolved_weighted_layer is None:
                raise QgsProcessingException(
                    "Failed to resolve weighted input layer for heatmap."
                )
            heatmap_input = resolved_weighted_layer

        stats = processing.run(
            "qgis:basicstatisticsforfields",
            {
                "INPUT_LAYER": heatmap_input,
                "FIELD_NAME": "_w_num",
                "OUTPUT_HTML_FILE": "TEMPORARY_OUTPUT",
            },
            context=context,
            feedback=feedback,
            is_child_algorithm=True,
        )
        feedback.pushInfo(
            f"Weight stats (_w_num) -> min: {stats.get('MIN', 'n/a')}, max: {stats.get('MAX', 'n/a')}, mean: {stats.get('MEAN', 'n/a')}"
        )

        valid_count = heatmap_input.featureCount()
        if valid_count <= 0:
            raise QgsProcessingException(
                "No features available to build heatmap."
            )

        feedback.pushInfo(f"Building heatmap from {valid_count} points")
        raw_output_path = "TEMPORARY_OUTPUT" if normalize_percent else output_path
        result = processing.run(
            "qgis:heatmapkerneldensityestimation",
            {
                "INPUT": heatmap_input,
                "WEIGHT_FIELD": "_w_num",
                "RADIUS": radius,
                "RADIUS_FIELD": "",
                "PIXEL_SIZE": pixel_size,
                "KERNEL": 0,
                "DECAY": 0,
                "OUTPUT_VALUE": 0,
                "OUTPUT": raw_output_path,
            },
            context=context,
            feedback=feedback,
            is_child_algorithm=True,
        )

        final_output = result["OUTPUT"]
        if normalize_percent:
            raw_heatmap_path = str(result["OUTPUT"])
            raw_layer = QgsRasterLayer(raw_heatmap_path, "Raw Heatmap", "gdal")
            if not raw_layer.isValid():
                raise QgsProcessingException(
                    "Failed to load raw heatmap for 0-100 normalization."
                )

            max_value = raw_layer.dataProvider().bandStatistics(1).maximumValue
            if not math.isfinite(max_value) or max_value <= 0:
                raise QgsProcessingException(
                    f"Cannot normalize heatmap: invalid maximum value ({max_value})."
                )

            feedback.pushInfo(
                f"Normalizing heatmap to 0-100 using max intensity {max_value}"
            )
            normalized_result = processing.run(
                "qgis:rastercalculator",
                {
                    "EXPRESSION": f'("{raw_heatmap_path}@1" / {max_value}) * 100',
                    "LAYERS": [raw_heatmap_path],
                    "CELLSIZE": pixel_size,
                    "EXTENT": None,
                    "CRS": analysis_crs,
                    "OUTPUT": output_path,
                },
                context=context,
                feedback=feedback,
                is_child_algorithm=True,
            )
            final_output = normalized_result["OUTPUT"]
        else:
            feedback.pushInfo(
                "Using raw relative intensity output (not 0-100 normalized)."
            )

        if kmz_output:
            orthophoto_kmz_for_export = None
            if orthophoto_path:
                if Path(orthophoto_path).suffix.lower() == ".kmz":
                    orthophoto_kmz_for_export = orthophoto_path
                else:
                    feedback.pushWarning(
                        "ORTHOPHOTO is not a KMZ. Exporting KMZ with heatmap overlay only."
                    )

            self._export_combined_groundoverlay_kmz(
                heatmap_path=str(final_output),
                orthophoto_kmz_path=orthophoto_kmz_for_export,
                style_qml=style_qml,
                kmz_output=kmz_output,
                feedback=feedback,
            )
        # feedback.pushInfo(f"Field type: {field.typeName()}")
        # feedback.pushInfo(f"Feature count: {heatmap_input.featureCount()}")
        
        # for feat in heatmap_input.getFeatures():
        #     feedback.pushInfo(
        #         f"{feat[weight_field]} -> {feat['_w_num']}"
        #     )
        #     break
        
        if context.willLoadLayerOnCompletion(final_output):
            details = context.layerToLoadOnCompletionDetails(final_output)
            if style_qml:
                self.__class__._style_post_processor = HeatmapStylePostProcessor(style_qml)
                details.setPostProcessor(self.__class__._style_post_processor)
                feedback.pushInfo(f"Style post-processor registered: {style_qml}")
            else:
                feedback.pushInfo("No QML style file provided; using default raster style.")
        else:
            feedback.pushWarning(
                "Output layer is not set to load on completion, so the QML style will not be applied automatically."
            )
    

        return {self.OUTPUT: final_output}

    def _detect_delimiter(self, csv_file: Path) -> str:
        with csv_file.open("r", encoding="utf-8-sig", newline="") as handle:
            header_line = handle.readline()

        if "\t" in header_line and header_line.count("\t") > header_line.count(","):
            return "\t"
        return ","

    def _load_csv_layer(self, csv_file: Path, delimiter: str) -> QgsVectorLayer:
        uri = self._build_csv_uri(csv_file, delimiter)
        return QgsVectorLayer(uri, "Telemetry CSV", "delimitedtext")

    def _build_csv_uri(self, csv_file: Path, delimiter: str) -> str:
        uri_params = {
            "type": "csv",
            "delimiter": delimiter,
            "xField": "target_longitude",
            "yField": "target_latitude",
            "crs": "EPSG:4326",
            "encoding": "UTF-8",
            "detectTypes": "yes",
            "useHeader": "yes",
            "trimFields": "yes",
            "skipEmptyFields": "yes",
        }
        query = unquote(urlencode(uri_params))
        return f"{csv_file.resolve().as_uri()}?{query}"

    def _load_orthophoto_layer(self, orthophoto_file: Path, context, feedback):
        orthophoto_path = str(orthophoto_file)
        zip_path = "/vsizip/" + orthophoto_path.replace("\\", "/")

        candidates = [
            orthophoto_path,
            f"{zip_path}/doc.kml",
        ]

        for uri in candidates:
            feedback.pushInfo(f"Trying GroundOverlay KMZ/KML: {uri}")

            layer = QgsVectorLayer(uri, orthophoto_file.stem, "ogr")
            if layer.isValid():
                feedback.pushInfo(f"GroundOverlay loaded: {uri}")
                return layer

            feedback.pushWarning(f"GroundOverlay load failed: {layer.error().message()}")

        return None

    def _export_combined_groundoverlay_kmz(
        self,
        heatmap_path: str,
        orthophoto_kmz_path: Optional[str],
        style_qml: str,
        kmz_output: str,
        feedback,
    ):
        wgs84 = QgsCoordinateReferenceSystem("EPSG:4326")

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            files_dir = tmp_path / "files"
            files_dir.mkdir()

            orthophoto_overlay = None
            if orthophoto_kmz_path:
                orthophoto_overlay = self._extract_first_groundoverlay(
                    Path(orthophoto_kmz_path),
                    files_dir,
                    "orthophoto",
                    feedback,
                )

            heatmap_png = files_dir / "heatmap.png"
            heatmap_bounds = self._render_raster_to_groundoverlay_png(
                heatmap_path,
                style_qml,
                heatmap_png,
                wgs84,
                feedback,
            )

            overlay_blocks = []
            if orthophoto_overlay is not None:
                overlay_blocks.append(
                    f"""
    <GroundOverlay>
      <name>Orthophoto</name>
      <Icon>
        <href>{orthophoto_overlay['href']}</href>
      </Icon>
      <LatLonBox>
        <north>{orthophoto_overlay['north']}</north>
        <south>{orthophoto_overlay['south']}</south>
        <east>{orthophoto_overlay['east']}</east>
        <west>{orthophoto_overlay['west']}</west>
      </LatLonBox>
    </GroundOverlay>
"""
                )

            overlay_blocks.append(
                f"""
    <GroundOverlay>
      <name>Methane Heatmap</name>
      <Icon>
        <href>files/heatmap.png</href>
      </Icon>
      <LatLonBox>
        <north>{heatmap_bounds['north']}</north>
        <south>{heatmap_bounds['south']}</south>
        <east>{heatmap_bounds['east']}</east>
        <west>{heatmap_bounds['west']}</west>
      </LatLonBox>
    </GroundOverlay>
"""
            )

            kml_text = (
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<kml xmlns=\"http://www.opengis.net/kml/2.2\">\n"
                "  <Document>\n"
                "    <name>Methane Heatmap Export</name>\n"
                f"{''.join(overlay_blocks)}"
                "  </Document>\n"
                "</kml>\n"
            )

            (tmp_path / "doc.kml").write_text(kml_text, encoding="utf-8")

            with zipfile.ZipFile(kmz_output, "w", zipfile.ZIP_DEFLATED) as kmz:
                kmz.write(tmp_path / "doc.kml", "doc.kml")
                for file_path in files_dir.rglob("*"):
                    if file_path.is_file():
                        kmz.write(file_path, file_path.relative_to(tmp_path).as_posix())

        feedback.pushInfo(f"Combined KMZ exported: {kmz_output}")

    def _extract_first_groundoverlay(self, kmz_path: Path, files_dir: Path, prefix: str, feedback):
        ns = {"kml": "http://www.opengis.net/kml/2.2"}

        with zipfile.ZipFile(kmz_path, "r") as kmz:
            kml_name = next(
                (name for name in kmz.namelist() if name.lower().endswith(".kml")),
                None,
            )
            if not kml_name:
                raise QgsProcessingException("No KML file found inside orthophoto KMZ.")

            root = ET.fromstring(kmz.read(kml_name))
            overlay = root.find(".//kml:GroundOverlay", ns)
            if overlay is None:
                raise QgsProcessingException("No GroundOverlay found in orthophoto KMZ.")

            href_node = overlay.find(".//kml:Icon/kml:href", ns)
            box = overlay.find(".//kml:LatLonBox", ns)

            if href_node is None or box is None:
                raise QgsProcessingException("GroundOverlay is missing Icon href or LatLonBox.")

            source_href = href_node.text.strip()
            source_href_zip = str((Path(kml_name).parent / source_href).as_posix())

            if source_href_zip not in kmz.namelist():
                source_href_zip = source_href

            image_ext = Path(source_href).suffix or ".png"
            output_name = f"{prefix}{image_ext}"
            output_path = files_dir / output_name

            with kmz.open(source_href_zip) as src, output_path.open("wb") as dst:
                shutil.copyfileobj(src, dst)

        feedback.pushInfo(f"Extracted orthophoto GroundOverlay image: {output_name}")
        return {
            "href": f"files/{output_name}",
            "north": box.findtext("kml:north", namespaces=ns),
            "south": box.findtext("kml:south", namespaces=ns),
            "east": box.findtext("kml:east", namespaces=ns),
            "west": box.findtext("kml:west", namespaces=ns),
        }

    def _render_raster_to_groundoverlay_png(
        self,
        raster_path: str,
        style_qml: str,
        png_path: Path,
        output_crs: QgsCoordinateReferenceSystem,
        feedback,
    ):
        layer = QgsRasterLayer(raster_path, "Methane Heatmap", "gdal")
        if not layer.isValid():
            raise QgsProcessingException(f"Failed to load heatmap raster for KMZ: {raster_path}")

        if style_qml:
            layer.loadNamedStyle(style_qml)
            try:
                _apply_renderer_stretch(layer, feedback, label="KMZ render style")
            except Exception as exc:
                feedback.pushWarning(f"KMZ style range auto-adjust failed: {exc}")

        transform = QgsCoordinateTransform(
            layer.crs(),
            output_crs,
            QgsProject.instance(),
        )
        wgs84_extent = transform.transformBoundingBox(layer.extent())

        # QGIS 4 / Qt6 may expose QImage formats under QImage.Format.*
        image_format = getattr(QImage, "Format_ARGB32_Premultiplied", None)
        if image_format is None and hasattr(QImage, "Format"):
            image_format = getattr(QImage.Format, "Format_ARGB32_Premultiplied", None)
        if image_format is None:
            raise QgsProcessingException(
                "Qt image format Format_ARGB32_Premultiplied is unavailable in this runtime."
            )

        transparent_color = getattr(Qt, "transparent", None)
        if transparent_color is None and hasattr(Qt, "GlobalColor"):
            transparent_color = getattr(Qt.GlobalColor, "transparent", None)
        if transparent_color is None:
            raise QgsProcessingException(
                "Qt transparent color enum is unavailable in this runtime."
            )

        image = QImage(QSize(2048, 2048), image_format)
        image.fill(transparent_color)

        settings = QgsMapSettings()
        settings.setLayers([layer])
        settings.setDestinationCrs(output_crs)
        settings.setExtent(wgs84_extent)
        settings.setOutputSize(image.size())
        settings.setBackgroundColor(transparent_color)

        painter = QPainter(image)
        job = QgsMapRendererCustomPainterJob(settings, painter)
        job.start()
        job.waitForFinished()
        painter.end()

        image.save(str(png_path), "PNG")

        feedback.pushInfo(f"Rendered heatmap GroundOverlay PNG: {png_path}")

        return {
            "north": wgs84_extent.yMaximum(),
            "south": wgs84_extent.yMinimum(),
            "east": wgs84_extent.xMaximum(),
            "west": wgs84_extent.xMinimum(),
        }

    def createInstance(self):
        return self.__class__()