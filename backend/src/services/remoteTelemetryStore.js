import postgres from 'postgres';

export const createRemoteTelemetryStore = ({ telemetryTable, latestStateTable }) => {
    const remoteDatabaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '';
    const remoteRetryMs = Math.max(1000, Number(process.env.REMOTE_DB_RETRY_MS || 30000));
    const remoteConnectTimeoutSeconds = Math.max(1, Number(process.env.REMOTE_DB_CONNECT_TIMEOUT_SECONDS || 3));
    const remoteSslMode = (process.env.REMOTE_DB_SSL_MODE || 'require').toLowerCase();
    const maxPendingQueueSize = Math.max(100, Number(process.env.REMOTE_DB_PENDING_QUEUE_SIZE || 5000));
    const resolveSslOption = () => (remoteSslMode === 'disable' ? false : 'require');

    if (!remoteDatabaseUrl) {
        return {
            enabled: false,
            initialize: async () => false,
            mirrorTelemetry: async () => false,
            getStatus: () => ({ enabled: false, available: false, initialized: false, lastError: null, pendingCount: 0 }),
        };
    }

    const remoteSql = postgres(remoteDatabaseUrl, {
        connect_timeout: remoteConnectTimeoutSeconds,
        idle_timeout: 20,
        max: 1,
        prepare: false,
        ssl: resolveSslOption(),
    });

    let initialized = false;
    let available = false;
    let initializationPromise = null;
    let nextRetryAt = 0;
    let lastError = null;
    let lastLoggedError = null;
    let writeQueue = Promise.resolve(false);
    let replayTimer = null;
    const pendingQueue = [];

    const clearReplayTimer = () => {
        if (replayTimer) {
            clearTimeout(replayTimer);
            replayTimer = null;
        }
    };

    const scheduleReplayAttempt = (delayMs = 0) => {
        if (pendingQueue.length === 0 || replayTimer) {
            return;
        }

        replayTimer = setTimeout(() => {
            replayTimer = null;

            writeQueue = writeQueue
                .catch(() => false)
                .then(() => flushPendingTelemetry());
        }, Math.max(0, delayMs));
    };

    const cloneTelemetry = (telemetry) => ({
        ...telemetry,
        payload: telemetry.payload && typeof telemetry.payload === 'object'
            ? JSON.parse(JSON.stringify(telemetry.payload))
            : telemetry.payload,
    });

    const enqueuePendingTelemetry = (telemetry) => {
        if (pendingQueue.length >= maxPendingQueueSize) {
            pendingQueue.shift();
        }

        pendingQueue.push(cloneTelemetry(telemetry));
        scheduleReplayAttempt(nextRetryAt > Date.now() ? nextRetryAt - Date.now() : 0);
    };

    const markRemoteFailure = (error, context) => {
        initialized = false;
        available = false;
        nextRetryAt = Date.now() + remoteRetryMs;
        lastError = error.message;

        const logKey = `${context}:${error.message}`;
        if (lastLoggedError !== logKey) {
            console.warn(`Remote telemetry sync unavailable (${context}): ${error.message}`);
            lastLoggedError = logKey;
        }

        scheduleReplayAttempt(remoteRetryMs);
    };

    const markRemoteAvailable = () => {
        available = true;
        lastError = null;
        lastLoggedError = null;
        nextRetryAt = 0;
        clearReplayTimer();

        if (pendingQueue.length > 0) {
            scheduleReplayAttempt(0);
        }
    };

    const ensureRemoteSchema = async () => {
        await remoteSql.unsafe(`
            CREATE TABLE IF NOT EXISTS ${telemetryTable} (
                id BIGSERIAL PRIMARY KEY,
                drone_id TEXT NOT NULL,
                topic TEXT NOT NULL,
                ts TIMESTAMPTZ NOT NULL,
                latitude DOUBLE PRECISION,
                longitude DOUBLE PRECISION,
                altitude DOUBLE PRECISION,
                target_latitude DOUBLE PRECISION,
                target_longitude DOUBLE PRECISION,
                methane DOUBLE PRECISION,
                sniffer DOUBLE PRECISION,
                purway DOUBLE PRECISION,
                distance DOUBLE PRECISION,
                payload JSONB NOT NULL
            )
        `);

        await remoteSql.unsafe(`
            CREATE TABLE IF NOT EXISTS ${latestStateTable} (
                drone_id TEXT PRIMARY KEY,
                topic TEXT NOT NULL,
                ts TIMESTAMPTZ NOT NULL,
                latitude DOUBLE PRECISION,
                longitude DOUBLE PRECISION,
                altitude DOUBLE PRECISION,
                target_latitude DOUBLE PRECISION,
                target_longitude DOUBLE PRECISION,
                methane DOUBLE PRECISION,
                sniffer DOUBLE PRECISION,
                purway DOUBLE PRECISION,
                distance DOUBLE PRECISION,
                payload JSONB NOT NULL
            )
        `);

        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS sniffer DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS purway DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS distance DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS target_latitude DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS target_longitude DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${telemetryTable} ADD COLUMN IF NOT EXISTS source_local_id BIGINT`);
        await remoteSql.unsafe(`ALTER TABLE ${latestStateTable} ADD COLUMN IF NOT EXISTS sniffer DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${latestStateTable} ADD COLUMN IF NOT EXISTS purway DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${latestStateTable} ADD COLUMN IF NOT EXISTS distance DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${latestStateTable} ADD COLUMN IF NOT EXISTS target_latitude DOUBLE PRECISION`);
        await remoteSql.unsafe(`ALTER TABLE ${latestStateTable} ADD COLUMN IF NOT EXISTS target_longitude DOUBLE PRECISION`);
        await remoteSql.unsafe(`CREATE INDEX IF NOT EXISTS idx_${telemetryTable}_drone_ts ON ${telemetryTable} (drone_id, ts DESC)`);
        await remoteSql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${telemetryTable}_source_local_id ON ${telemetryTable} (source_local_id) WHERE source_local_id IS NOT NULL`);
    };

    const persistTelemetry = async (executor, telemetry) => {
        const latestValues = [
            telemetry.droneId,
            telemetry.topic,
            telemetry.ts,
            telemetry.latitude,
            telemetry.longitude,
            telemetry.altitude,
            telemetry.target_latitude,
            telemetry.target_longitude,
            telemetry.methane,
            telemetry.sniffer,
            telemetry.purway,
            telemetry.distance,
            telemetry.payload,
        ];

        const localId = Number(telemetry.localId);

        if (Number.isFinite(localId)) {
            await executor.unsafe(
                `
                INSERT INTO ${telemetryTable} (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload, source_local_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (source_local_id) WHERE source_local_id IS NOT NULL DO UPDATE
                SET
                    drone_id = EXCLUDED.drone_id,
                    topic = EXCLUDED.topic,
                    ts = EXCLUDED.ts,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    altitude = EXCLUDED.altitude,
                    target_latitude = EXCLUDED.target_latitude,
                    target_longitude = EXCLUDED.target_longitude,
                    methane = EXCLUDED.methane,
                    sniffer = EXCLUDED.sniffer,
                    purway = EXCLUDED.purway,
                    distance = EXCLUDED.distance,
                    payload = EXCLUDED.payload
                `,
                [...latestValues, localId],
            );
        } else {
            await executor.unsafe(
                `
                INSERT INTO ${telemetryTable} (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                `,
                latestValues,
            );
        }

        await executor.unsafe(
            `
            INSERT INTO ${latestStateTable} (drone_id, topic, ts, latitude, longitude, altitude, target_latitude, target_longitude, methane, sniffer, purway, distance, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (drone_id) DO UPDATE
            SET
                topic = EXCLUDED.topic,
                ts = EXCLUDED.ts,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                altitude = EXCLUDED.altitude,
                target_latitude = EXCLUDED.target_latitude,
                target_longitude = EXCLUDED.target_longitude,
                methane = EXCLUDED.methane,
                sniffer = EXCLUDED.sniffer,
                purway = EXCLUDED.purway,
                distance = EXCLUDED.distance,
                payload = EXCLUDED.payload
            `,
            latestValues,
        );
    };

    const initialize = async () => {
        if (initialized) {
            return true;
        }

        if (Date.now() < nextRetryAt) {
            return false;
        }

        if (initializationPromise) {
            return initializationPromise;
        }

        initializationPromise = (async () => {
            try {
                await remoteSql`SELECT 1`;
                await ensureRemoteSchema();
                initialized = true;
                markRemoteAvailable();
                return true;
            } catch (error) {
                markRemoteFailure(error, 'init');
                return false;
            } finally {
                initializationPromise = null;
            }
        })();

        return initializationPromise;
    };

    const writeTelemetryRemote = async (telemetry) => {
        await remoteSql.begin(async (transaction) => {
            await persistTelemetry(transaction, telemetry);
        });
    };

    const flushPendingTelemetry = async () => {
        if (pendingQueue.length === 0) {
            return true;
        }

        clearReplayTimer();

        const isReady = await initialize();
        if (!isReady) {
            return false;
        }

        let flushedCount = 0;

        while (pendingQueue.length > 0) {
            const telemetry = pendingQueue[0];

            try {
                await writeTelemetryRemote(telemetry);
                pendingQueue.shift();
                flushedCount += 1;
                markRemoteAvailable();
            } catch (error) {
                markRemoteFailure(error, 'replay');
                break;
            }
        }

        if (flushedCount > 0) {
            console.log(`Replayed ${flushedCount} queued telemetry messages to remote database`);
        }

        return pendingQueue.length === 0;
    };

    const mirrorTelemetryNow = async (telemetry) => {
        const isReady = await initialize();
        if (!isReady) {
            enqueuePendingTelemetry(telemetry);
            return false;
        }

        if (pendingQueue.length > 0) {
            await flushPendingTelemetry();
            if (pendingQueue.length > 0) {
                enqueuePendingTelemetry(telemetry);
                return false;
            }
        }

        try {
            await writeTelemetryRemote(telemetry);
            markRemoteAvailable();
            return true;
        } catch (error) {
            markRemoteFailure(error, 'write');
            enqueuePendingTelemetry(telemetry);
            return false;
        }
    };

    const mirrorTelemetry = async (telemetry) => {
        writeQueue = writeQueue
            .catch(() => false)
            .then(() => mirrorTelemetryNow(telemetry));

        return writeQueue;
    };

    return {
        enabled: true,
        initialize,
        mirrorTelemetry,
        getStatus: () => ({
            enabled: true,
            available,
            initialized,
            lastError,
            pendingCount: pendingQueue.length,
            nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
        }),
    };
};