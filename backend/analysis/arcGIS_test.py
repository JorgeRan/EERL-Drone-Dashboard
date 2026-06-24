import arcpy
from arcpy.sa import KernelDensity

# Check out the ArcGIS Spatial Analyst extension license
arcpy.CheckOutExtension("Spatial")

# 1. Define your environment workspaces and data paths
arcpy.env.workspace = r"C:\Path\To\Your\Project.gdb"
arcpy.env.overwriteOutput = True

# 2. Define input point features and the column containing weights (if any)
input_points = "YourDataPointsLayer"  # Name of layer in map or full path to feature class
population_field = "NONE"             # Change to a specific column name if points have different weights

# 3. Define output raster parameters
output_raster_name = "Heatmap_Output"
cell_size = 10                        # Output pixel resolution (in map units, e.g., meters)
search_radius = 500                   # The neighborhood radius for density calculation

print("Starting heatmap generation...")

# 4. Execute Kernel Density tool
heatmap_raster = KernelDensity(
    in_features=input_points,
    population_field=population_field,
    cell_size=cell_size,
    search_radius=search_radius,
    area_unit_scale_factor="SQUARE_MAP_UNITS"
)

# 5. Save the final output to your geodatabase
heatmap_raster.save(output_raster_name)

print(f"Success! Heatmap saved as '{output_raster_name}' in your workspace.")

# Check the license back in
arcpy.CheckInExtension("Spatial")
