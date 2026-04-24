import postgres from 'postgres';

export const createRemoteMissionStore = ({ missionsTable }) => {
    const remoteDatabaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '';
    const remoteRetryMs = Math.max(1000, Number(process.env.REMOTE_DB_RETRY_MS || 30000));
    const remoteConnectTimeoutSeconds = Math.max(1, Number(process.env.REMOTE_DB_CONNECT_TIMEOUT_SECONDS || 3));
    const remoteSslMode = (process.env.REMOTE_DB_SSL_MODE || 'require').toLowerCase();
    const resolveSslOption = () => (remoteSslMode === 'disable' ? false : 'require');

    if (!remoteDatabaseUrl) {
        return {
            enabled: false,
            initialize: async () => false,
            upsertMission: async () => false,
            deleteMission: async () => false,
            clearMissions: async () => false,
            fetchAllRemote: async () => null,
            getStatus: () => ({ enabled: false, available: false, initialized: false, lastError: null }),
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

    const markRemoteFailure = (error, context) => {
        initialized = false;
        available = false;
        nextRetryAt = Date.now() + remoteRetryMs;
        lastError = error.message;

        const logKey = `${context}:${error.message}`;
        if (lastLoggedError !== logKey) {
            console.warn(`Remote mission sync unavailable (${context}): ${error.message}`);
            lastLoggedError = logKey;
        }
    };

    const markRemoteAvailable = () => {
        available = true;
        lastError = null;
        lastLoggedError = null;
        nextRetryAt = 0;
    };

    const ensureRemoteSchema = async () => {
        await remoteSql.unsafe(`
            CREATE TABLE IF NOT EXISTS ${missionsTable} (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                elapsed_seconds INTEGER NOT NULL DEFAULT 0,
                results JSONB NOT NULL
            )
        `);

        await remoteSql.unsafe(`CREATE INDEX IF NOT EXISTS idx_${missionsTable}_created_at ON ${missionsTable} (created_at DESC)`);
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

    const runOperation = async (context, operation) => {
        const isReady = await initialize();
        if (!isReady) {
            return false;
        }

        try {
            await operation();
            markRemoteAvailable();
            return true;
        } catch (error) {
            markRemoteFailure(error, context);
            return false;
        }
    };

    const upsertMission = async (mission) => runOperation('upsert', async () => {
        await remoteSql.unsafe(
            `
            INSERT INTO ${missionsTable} (id, name, created_at, elapsed_seconds, results)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE
            SET
                name = EXCLUDED.name,
                created_at = EXCLUDED.created_at,
                elapsed_seconds = EXCLUDED.elapsed_seconds,
                results = EXCLUDED.results
            `,
            [
                mission.id,
                mission.name,
                mission.createdAt,
                mission.elapsedSeconds,
                mission.results,
            ],
        );
    });

    const deleteMission = async (missionId) => runOperation('delete', async () => {
        await remoteSql.unsafe(`DELETE FROM ${missionsTable} WHERE id = $1`, [missionId]);
    });

    const clearMissions = async () => runOperation('clear', async () => {
        await remoteSql.unsafe(`DELETE FROM ${missionsTable}`);
    });

    const fetchAllRemote = async () => {
        const isReady = await initialize();
        if (!isReady) {
            return null;
        }

        try {
            const rows = await remoteSql.unsafe(
                `SELECT id, name, created_at, elapsed_seconds, results FROM ${missionsTable} ORDER BY created_at ASC`,
            );
            markRemoteAvailable();
            return rows;
        } catch (error) {
            markRemoteFailure(error, 'fetch');
            return null;
        }
    };

    return {
        enabled: true,
        initialize,
        upsertMission,
        deleteMission,
        clearMissions,
        fetchAllRemote,
        getStatus: () => ({
            enabled: true,
            available,
            initialized,
            lastError,
            nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
        }),
    };
};