import dotenv from "dotenv";
import sql from "./db.js";

dotenv.config();

const TELEMETRY_TABLE = "telemetry_events";

const resetTelemetryTable = async () => {
    await sql.unsafe(`DELETE FROM ${TELEMETRY_TABLE}`);

    await sql.unsafe(
        `DELETE FROM sqlite_sequence WHERE name = ?`,
        [TELEMETRY_TABLE],
    );
};

(async () => {
    try {
        const beforeReset = await sql.unsafe(
            `SELECT COUNT(*) AS total FROM ${TELEMETRY_TABLE}`,
        );

        await resetTelemetryTable();

        console.log(`Deleted rows: ${beforeReset[0]?.total ?? 0}`);
        
        const countRes = await sql.unsafe(
            `SELECT COUNT(*) AS remaining FROM ${TELEMETRY_TABLE}`,
        );
        console.log(`Rows remaining: ${countRes[0]?.remaining ?? 0}`);
        console.log(`Sequence reset for ${TELEMETRY_TABLE}`);
    } catch (err) {
        console.error(err);
    } finally {
        await sql.end();
    }
})();