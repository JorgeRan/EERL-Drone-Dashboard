import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres@localhost/mqtt_drone_data';

const sql = postgres(connectionString, {
    ssl: connectionString.includes('supabase.co') ? 'require' : false,
});

export default sql;