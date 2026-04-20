import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
DEFAULT_DB_PATH = PROJECT_ROOT / 'data' / 'telemetry_events.db'
DEFAULT_OUTPUT_PATH = BACKEND_DIR / 'aeris_notebook_input.json'


def _pick_number(*candidates):
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            parsed = float(candidate)
            if parsed == parsed:
                return parsed
        except (TypeError, ValueError):
            continue
    return None


def _is_aeris_payload(payload):
    if not isinstance(payload, dict):
        return False

    sensor_mode = str(payload.get('sensorMode') or payload.get('sensor_type') or '').strip().lower()
    if sensor_mode == 'aeris':
        return True

    aeris_keys = (
        'acetylene',
        'c2h2',
        'n2o',
        'nitrous_oxide',
        'nitrousOxide',
        'ethylene',
        'c2h4',
    )
    return any(payload.get(key) is not None for key in aeris_keys)


def _extract_sample(row):
    payload_text = row['payload']
    payload = {}

    if payload_text:
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            payload = {}

    if not _is_aeris_payload(payload):
        return None

    return {
        'ts': row['ts'],
        'droneId': row['drone_id'],
        'topic': row['topic'],
        'latitude': _pick_number(row['latitude'], payload.get('latitude'), payload.get('lat')),
        'longitude': _pick_number(row['longitude'], payload.get('longitude'), payload.get('lon'), payload.get('lng')),
        'altitude': _pick_number(row['altitude'], payload.get('altitude'), payload.get('alt')),
        'methane': _pick_number(row['methane'], payload.get('methane'), payload.get('ch4'), payload.get('methane_ppm')),
        'acetylene': _pick_number(payload.get('acetylene'), payload.get('c2h2')),
        'nitrousOxide': _pick_number(payload.get('nitrousOxide'), payload.get('nitrous_oxide'), payload.get('n2o')),
        'payload': payload,
    }


def export_aeris_samples(limit=300, output_path=DEFAULT_OUTPUT_PATH, db_path=DEFAULT_DB_PATH):
    db_path = Path(db_path)
    output_path = Path(output_path)

    dataset = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'dbPath': str(db_path),
        'sampleCount': 0,
        'samples': [],
    }

    if not db_path.exists():
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(dataset, indent=2), encoding='utf-8')
        return dataset

    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row

    try:
        cursor = connection.execute(
            '''
            SELECT drone_id, topic, ts, latitude, longitude, altitude, methane, payload
            FROM telemetry_events
            ORDER BY id DESC
            LIMIT ?
            ''',
            (int(limit),),
        )
        rows = cursor.fetchall()
    finally:
        connectibon.close()

    samples = []
    for row in rows:
        extracted = _extract_sample(row)
        if extracted:
            samples.append(extracted)

    samples.reverse()

    dataset['sampleCount'] = len(samples)
    dataset['samples'] = samples

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dataset, indent=2), encoding='utf-8')
    return dataset


def _parse_args():
    parser = argparse.ArgumentParser(description='Export Aeris telemetry for notebook analysis.')
    parser.add_argument('--limit', type=int, default=300, help='Max telemetry events to inspect')
    parser.add_argument('--db-path', default=str(DEFAULT_DB_PATH), help='SQLite telemetry database path')
    parser.add_argument('--output', default=str(DEFAULT_OUTPUT_PATH), help='Output JSON path for notebook input')
    return parser.parse_args()


if __name__ == '__main__':
    args = _parse_args()

    dataset = export_aeris_samples(limit=max(1, args.limit), output_path=args.output, db_path=args.db_path)
    print(
        json.dumps(
            {
                'ok': True,
                'sampleCount': dataset['sampleCount'],
                'outputPath': str(Path(args.output).resolve()),
            }
        )
    )