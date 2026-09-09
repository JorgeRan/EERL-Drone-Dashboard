import os
import glob

import numpy as np
import pandas as pd

import matplotlib.pyplot as plt
from matplotlib.colors import Normalize
from scipy.interpolate import griddata

# -----------------------------
# SETTINGS
# -----------------------------

DATA_FOLDER = r"C:\Users\Jorge Rangel\Downloads"
OUTPUT_FOLDER = "outputs"

BACKGROUND_PERCENT = 0.05

FIG_DPI = 300

os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# -----------------------------
# PROCESS EVERY CSV
# -----------------------------

csv_files = glob.glob(os.path.join(DATA_FOLDER, "*.csv"))

for file in csv_files:

    print(f"Processing {os.path.basename(file)}")

    df = pd.read_csv(file)

    # -------------------------
    # CLEAN
    # -------------------------

    df = df[df["Distance [m]"] > 0].copy()

    df["Raw"] = (
        df["Methane [ppm*m]"]
        / df["Distance [m]"]
    )

    df["Background"] = (
        df["Raw"] * BACKGROUND_PERCENT
    )

    df["Corrected"] = (
        df["Raw"] - df["Background"]
    )

    basename = os.path.splitext(os.path.basename(file))[0]

    # ====================================================
    # RAW MAP
    # ====================================================

    fig, ax = plt.subplots(figsize=(10,8))

    sc = ax.scatter(
        df["Targ Lon [deg]"],
        df["Targ Lat [deg]"],
        c=df["Raw"],
        cmap="turbo",
        s=25
    )

    ax.plot(
        df["Center Lon [deg]"],
        df["Center Lat [deg]"],
        color="cyan",
        linewidth=2,
        label="Flight Path"
    )

    plt.colorbar(sc,label="Raw Methane (ppm·m / m)")

    ax.set_title("Raw Methane Map")

    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")

    ax.legend()

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Raw_Map.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

    # ====================================================
    # CORRECTED MAP
    # ====================================================

    fig, ax = plt.subplots(figsize=(10,8))

    sc = ax.scatter(
        df["Targ Lon [deg]"],
        df["Targ Lat [deg]"],
        c=df["Corrected"],
        cmap="turbo",
        s=25
    )

    ax.plot(
        df["Center Lon [deg]"],
        df["Center Lat [deg]"],
        color="cyan",
        linewidth=2
    )

    plt.colorbar(sc,label="Corrected Methane")

    ax.set_title("Corrected Methane Map")

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Corrected_Map.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

    # ====================================================
    # RAW VS CORRECTED
    # ====================================================

    fig,axs = plt.subplots(
        1,
        2,
        figsize=(16,7)
    )

    s1 = axs[0].scatter(
        df["Targ Lon [deg]"],
        df["Targ Lat [deg]"],
        c=df["Raw"],
        cmap="turbo",
        s=20
    )

    axs[0].plot(
        df["Center Lon [deg]"],
        df["Center Lat [deg]"],
        color="white"
    )

    axs[0].set_title("Raw")

    s2 = axs[1].scatter(
        df["Targ Lon [deg]"],
        df["Targ Lat [deg]"],
        c=df["Corrected"],
        cmap="turbo",
        s=20
    )

    axs[1].plot(
        df["Center Lon [deg]"],
        df["Center Lat [deg]"],
        color="white"
    )

    axs[1].set_title("Corrected")

    plt.colorbar(
        s2,
        ax=axs,
        shrink=.8,
        label="Methane"
    )

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Comparison.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

    # ====================================================
    # DISTANCE PROFILE
    # ====================================================

    fig,ax=plt.subplots(figsize=(12,4))

    ax.plot(
        df["Distance [m]"],
        color="navy"
    )

    ax.set_title("Sensor-to-Ground Distance")

    ax.set_ylabel("Distance (m)")

    ax.set_xlabel("Sample")

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Distance_Profile.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

    # ====================================================
    # ALTITUDE PROFILE
    # ====================================================

    fig,ax=plt.subplots(figsize=(12,4))

    ax.plot(
        df["RTK HFSL [m]"],
        label="Drone Altitude"
    )

    if "rel_alt" in df.columns:

        ax.plot(
            df["rel_alt"],
            label="Relative Altitude"
        )

    ax.legend()

    ax.set_title("Altitude Profile")

    ax.set_ylabel("Meters")

    ax.set_xlabel("Sample")

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Altitude_Profile.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

    # ====================================================
    # METHANE PROFILE
    # ====================================================

    fig,ax=plt.subplots(figsize=(12,4))

    ax.plot(
        df["Raw"],
        label="Raw"
    )

    ax.plot(
        df["Corrected"],
        label="Corrected"
    )

    ax.legend()

    ax.set_title("Methane Along Flight")

    ax.set_ylabel("ppm·m / m")

    ax.set_xlabel("Sample")

    plt.tight_layout()

    plt.savefig(
        os.path.join(
            OUTPUT_FOLDER,
            basename+"_Methane_Profile.png"
        ),
        dpi=FIG_DPI
    )

    plt.close()

print("Done.")