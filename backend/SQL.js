import dotenv from "dotenv";
import sql from "./db.js";

dotenv.config();

const droneName = process.env.DRONE_NAME || "M400-1";

const query = `
    SELECT
        COALESCE(d.name, t.drone_id) AS name,
        t.ts AS timestamp,
        t.latitude,
        t.longitude,
        t.altitude,
        (t.payload->>'sniffer_ppm')::double precision AS sniffer_ppm,
        (t.payload->>'purway_ppn')::double precision AS purway_ppn,
        (t.payload->>'wind_u')::double precision AS wind_u,
        (t.payload->>'wind_v')::double precision AS wind_v,
        (t.payload->>'wind_w')::double precision AS wind_w
    FROM telemetry_events t
    LEFT JOIN drones d
        ON d.name = t.drone_id
        OR d.id::text = t.drone_id
    WHERE COALESCE(d.name, t.drone_id) = $1
    ORDER BY t.ts DESC
    LIMIT 100;
`;

const deleteQuery = `
    DELETE FROM telemetry_events
    WHERE id IN (
        SELECT id
        FROM telemetry_events
        ORDER BY ts DESC, id DESC
        OFFSET 10
    );
`;

(async () => {
    try {
        const deleteRes = await sql.unsafe(deleteQuery);
        console.log(`Deleted rows: ${deleteRes === undefined ? 0 : deleteRes.length}`);
        
        const countRes = await sql`SELECT COUNT(*)::int AS remaining FROM telemetry_events`;
        console.log(`Rows remaining: ${countRes[0].remaining}`);
    } catch (err) {
        console.error(err);
    } finally {
        await sql.end();
    }
})();

// db.query("select * from public.telemetry", (err, res) => {
//   if (err) {
//     console.error("Error executing query", err.stack);
//   } else {
//     console.log(res.rows);
//   }
//   db.end();
// });

// INSERT INTO telemetry
// (drone_id, timestamp, latitude, longitude, altitude, sniffer_ppm, purway_ppn)
// VALUES
// (2, NOW(), 45.4215, -75.6972, 120.5, 2.3, 87);