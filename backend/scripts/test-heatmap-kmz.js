import * as turf from '@turf/turf';
import tokml from 'tokml';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Automates the creation of a heatmap KMZ from raw fieldwork coordinates.
 * @param {Array<{lat:number,lng:number,value?:number}>} fieldData
 * @param {string} outputPath
 */
async function automateHeatmapGeneration(fieldData, outputPath) {
    if (!Array.isArray(fieldData) || fieldData.length === 0) {
        throw new Error('fieldData must be a non-empty array of observations.');
    }

    const pointsList = fieldData.map((obs, index) => {
        if (typeof obs?.lat !== 'number' || typeof obs?.lng !== 'number') {
            throw new Error(`Invalid lat/lng at index ${index}.`);
        }

        return turf.point([obs.lng, obs.lat], { weight: Number(obs.value) || 1 });
    });

    const pointCollection = turf.featureCollection(pointsList);
    const bbox = turf.bbox(pointCollection);

    // Handle tiny/extremely local datasets by padding the bbox so hexGrid always has area.
    const minPadding = 0.001;
    const paddedBbox = [
        bbox[0] - minPadding,
        bbox[1] - minPadding,
        bbox[2] + minPadding,
        bbox[3] + minPadding,
    ];

    const cellSide = 0.2;
    const spatialGrid = turf.hexGrid(paddedBbox, cellSide, { units: 'kilometers' });
    const processedGrid = turf.collect(spatialGrid, pointCollection, 'weight', 'values_array');

    processedGrid.features.forEach((cell) => {
        const values = cell.properties.values_array || [];
        const densityScore = values.reduce((sum, current) => sum + current, 0);
        cell.properties.density = densityScore;

        if (densityScore === 0) {
            cell.properties.fill = '#ffffff';
            cell.properties['fill-opacity'] = 0.0;
        } else if (densityScore > 20) {
            cell.properties.fill = '#ff0000';
            cell.properties['fill-opacity'] = 0.6;
        } else if (densityScore > 10) {
            cell.properties.fill = '#ffff00';
            cell.properties['fill-opacity'] = 0.5;
        } else {
            cell.properties.fill = '#00ff00';
            cell.properties['fill-opacity'] = 0.4;
        }

        cell.properties.stroke = '#ffffff';
        cell.properties['stroke-opacity'] = 0.8;
        cell.properties['stroke-width'] = 1.5;
    });

    const convertedKml = tokml(processedGrid, { simplestyle: true });

    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        writeStream.on('close', () => resolve(outputPath));
        archive.on('error', (error) => reject(error));

        archive.pipe(writeStream);
        archive.append(convertedKml, { name: 'doc.kml' });
        archive.finalize();
    });
}

const mockFieldworkObservations = [
    { lat: 45.4215, lng: -75.6972, value: 5 },
    { lat: 45.4217, lng: -75.6971, value: 12 },
    { lat: 45.4214, lng: -75.6969, value: 8 },
    { lat: 45.425, lng: -75.691, value: 2 },
];

const toFiniteNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const parseResultsPayload = (results) => {
    if (Array.isArray(results)) {
        return results;
    }

    if (typeof results === 'string') {
        try {
            const parsed = JSON.parse(results);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    return [];
};

const missionPointToObservation = (point) => {
    const lat = toFiniteNumber(point?.latitude);
    const lng = toFiniteNumber(point?.longitude);

    if (lat === null || lng === null) {
        return null;
    }

    const value =
        toFiniteNumber(point?.value) ??
        toFiniteNumber(point?.methane) ??
        toFiniteNumber(point?.sniffer) ??
        toFiniteNumber(point?.purway) ??
        toFiniteNumber(point?.payload?.methane) ??
        toFiniteNumber(point?.payload?.sniffer_ppm) ??
        toFiniteNumber(point?.payload?.purway_ppm_m) ??
        toFiniteNumber(point?.payload?.purway_ppn) ??
        1;

    return {
        lat,
        lng,
        value: Math.max(0, value),
    };
};

const buildObservationsFromMissionResults = (results) =>
    parseResultsPayload(results)
        .flatMap((entry) => (Array.isArray(entry?.data) ? entry.data : []))
        .map(missionPointToObservation)
        .filter(Boolean);

const parseArguments = () => {
    const args = process.argv.slice(2);
    const options = {
        mission: null,
        output: null,
    };

    for (let index = 0; index < args.length; index += 1) {
        const current = args[index];
        const next = args[index + 1];

        if ((current === '--mission' || current === '--mission-id') && next) {
            options.mission = String(next).trim();
            index += 1;
            continue;
        }

        if (current === '--output' && next) {
            options.output = String(next).trim();
            index += 1;
        }
    }

    return options;
};

const loadMissionObservations = async (missionReference) => {
    const rows = await sql.unsafe(
        `
        SELECT id, name, results
        FROM missions
        WHERE id = $1 OR LOWER(name) = LOWER($2)
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [missionReference, missionReference],
    );

    const mission = rows?.[0];
    if (!mission) {
        throw new Error(`Mission not found: ${missionReference}`);
    }

    const observations = buildObservationsFromMissionResults(mission.results);
    if (observations.length === 0) {
        throw new Error(`Mission has no mappable points: ${mission.name} (${mission.id})`);
    }

    return {
        mission,
        observations,
    };
};

const main = async () => {
    const options = parseArguments();
    const defaultOutput = path.resolve(__dirname, '..', 'analysis', 'Fieldwork_Heatmap.kmz');

    try {
        let selectedObservations = mockFieldworkObservations;
        let outputFile = options.output
            ? path.resolve(process.cwd(), options.output)
            : defaultOutput;

        if (options.mission) {
            const { mission, observations } = await loadMissionObservations(options.mission);
            selectedObservations = observations;

            if (!options.output) {
                const safeName = mission.name.replace(/[^a-z0-9_-]+/gi, '_');
                outputFile = path.resolve(__dirname, '..', 'analysis', `${safeName}_Heatmap.kmz`);
            }

            console.log(`Using mission: ${mission.name} (${mission.id})`);
            console.log(`Mission points used: ${selectedObservations.length}`);
        } else {
            console.log('Using mock test observations.');
        }

        const file = await automateHeatmapGeneration(selectedObservations, outputFile);
        console.log(`Automation complete. KMZ file built: ${file}`);
    } catch (err) {
        console.error('Generation failed:', err);
        process.exitCode = 1;
    } finally {
        await sql.end();
    }
};

main();
