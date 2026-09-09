import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import postgres from 'postgres';

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/eerl_dashboard';
const forceSqliteFallback =
  String(process.env.DB_FORCE_SQLITE || '').toLowerCase() === 'true';
const connectTimeoutSeconds = Math.max(
  1,
  Number(process.env.DB_CONNECT_TIMEOUT_SECONDS || 10),
);
const sslMode = (process.env.DB_SSL_MODE || 'prefer').toLowerCase();
const resolveSslOption = () => {
  if (sslMode === 'disable') {
    return false;
  }

  if (sslMode === 'require') {
    return 'require';
  }

  return process.env.NODE_ENV === 'production' ? 'require' : false;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runtimeDataRoot = (process.env.APP_DATA_DIR || '').trim();
const dataDirectory = runtimeDataRoot
  ? path.join(runtimeDataRoot, 'data')
  : path.join(__dirname, 'data');
const sqliteDatabasePath = path.join(dataDirectory, 'telemetry_events.db');

let dbPromise;
let activeDriver = null;
let lastInsertId = null;
let lastAffectedRows = 0;

const normalizeSqliteCreateTable = (queryText) =>
  queryText
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi, 'BIGINT PRIMARY KEY')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/DEFAULT\s+CURRENT_TIMESTAMP\b/gi, 'DEFAULT (NOW()::text)');

const convertQuestionMarkPlaceholders = (queryText, params) => {
  let paramIndex = 0;
  const convertedQuery = queryText.replace(/\?/g, () => {
    paramIndex += 1;
    return `$${paramIndex}`;
  });

  return {
    query: convertedQuery,
    values: params,
  };
};

const reorderDollarPlaceholders = (queryText, params) => {
  const orderedIndexes = [];
  const convertedQuery = queryText.replace(/\$(\d+)/g, (_match, oneBasedIndex) => {
    orderedIndexes.push(Number(oneBasedIndex) - 1);
    return `$${orderedIndexes.length}`;
  });

  if (!orderedIndexes.length) {
    return { query: convertedQuery, values: params };
  }

  return {
    query: convertedQuery,
    values: orderedIndexes.map((index) => params[index]),
  };
};

const normalizeBoundValue = (value) => {
  if (value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return value;
};

const isReadQuery = (queryText) => /^\s*(select|pragma|with)\b/i.test(queryText);

const convertPostgresPlaceholdersForSqlite = (queryText, params) => {
  const orderedIndexes = [];
  const convertedQuery = queryText.replace(/\$(\d+)/g, (_match, oneBasedIndex) => {
    orderedIndexes.push(Number(oneBasedIndex) - 1);
    return '?';
  });

  if (!orderedIndexes.length) {
    return { query: convertedQuery, values: params };
  }

  return {
    query: convertedQuery,
    values: orderedIndexes.map((index) => params[index]),
  };
};

const parseTableNameFromPragma = (queryText) => {
  const match = queryText.match(/^\s*PRAGMA\s+table_info\(([^)]+)\)/i);
  if (!match) {
    return null;
  }

  return match[1].trim().replace(/^['"]|['"]$/g, '');
};

const convertInsertOrReplace = (queryText) => {
  const match = queryText.match(
    /^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*$/i,
  );

  if (!match) {
    return queryText;
  }

  const tableName = match[1].trim();
  const columns = match[2].split(',').map((column) => column.trim());
  const values = match[3].trim();
  const conflictColumn = columns[0];
  const updateColumns = columns.slice(1);

  const updateAssignments = updateColumns
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', ');

  return `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${values})
    ON CONFLICT (${conflictColumn}) DO UPDATE
    SET ${updateAssignments}
  `;
};

const ensurePostgresDatabase = async () => {
  const db = postgres(databaseUrl, {
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: 30,
    max: 1,
    prepare: false,
    ssl: resolveSslOption(),
  });

  try {
    await db`SELECT 1`;
  } catch (error) {
    const hint =
      "PostgreSQL connection failed. Verify DATABASE_URL/SUPABASE_DATABASE_URL and ensure the DB server is running and reachable.";
    throw new Error(`${hint} Original error: ${error?.message || error}`);
  }

  try {
    await db.unsafe('CREATE EXTENSION IF NOT EXISTS postgis');
  } catch (error) {
    console.warn(`PostGIS extension check skipped: ${error.message}`);
  }
  return db;
};

const ensureSqliteDatabase = async () => {
  await fs.mkdir(dataDirectory, { recursive: true });

  const db = await open({
    filename: sqliteDatabasePath,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA foreign_keys = ON;');
  return db;
};

const initializeDatabase = async () => {
  if (!dbPromise) {
    dbPromise = (async () => {
      if (forceSqliteFallback) {
        const sqliteDb = await ensureSqliteDatabase();
        activeDriver = 'sqlite';
        console.warn('DB_FORCE_SQLITE=true; using SQLite backend.');
        return sqliteDb;
      }

      try {
        const pgDb = await ensurePostgresDatabase();
        activeDriver = 'postgres';
        return pgDb;
      } catch (error) {
        console.warn(
          `PostgreSQL unavailable, falling back to SQLite at ${sqliteDatabasePath}. Reason: ${error?.message || error}`,
        );
        const sqliteDb = await ensureSqliteDatabase();
        activeDriver = 'sqlite';
        return sqliteDb;
      }
    })();
  }

  return dbPromise;
};

const execute = async (queryText, params = []) => {
  const db = await initializeDatabase();

  if (activeDriver === 'sqlite') {
    const { query, values } = convertPostgresPlaceholdersForSqlite(queryText, params);
    const normalizedValues = values.map(normalizeBoundValue);

    if (isReadQuery(query)) {
      return db.all(query, normalizedValues);
    }

    const writeResult = await db.run(query, normalizedValues);
    if (Number.isFinite(Number(writeResult?.changes))) {
      lastAffectedRows = Number(writeResult.changes);
    }
    if (Number.isFinite(Number(writeResult?.lastID))) {
      lastInsertId = Number(writeResult.lastID);
    }
    return [];
  }

  const pragmaTable = parseTableNameFromPragma(queryText);

  if (pragmaTable) {
    const rows = await db.unsafe(
      `
        SELECT
          column_name AS name,
          data_type AS type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `,
      [pragmaTable],
    );
    return rows;
  }

  if (/^\s*SELECT\s+last_insert_rowid\(\)\s+AS\s+id\s*;?\s*$/i.test(queryText)) {
    return [{ id: lastInsertId }];
  }

  if (/^\s*SELECT\s+changes\(\)\s+AS\s+count\s*;?\s*$/i.test(queryText)) {
    return [{ count: lastAffectedRows }];
  }

  if (/sqlite_sequence/i.test(queryText)) {
    return [];
  }

  let normalizedQuery = convertInsertOrReplace(queryText);
  normalizedQuery = normalizeSqliteCreateTable(normalizedQuery);

  const usesQuestionMarks = normalizedQuery.includes('?');
  const converted = usesQuestionMarks
    ? convertQuestionMarkPlaceholders(normalizedQuery, params)
    : reorderDollarPlaceholders(normalizedQuery, params);

  let finalQuery = converted.query;
  const finalValues = converted.values.map(normalizeBoundValue);

  const insertMatch = finalQuery.match(/^\s*INSERT\s+INTO\s+([^\s(]+)/i);
  const hasReturning = /\bRETURNING\b/i.test(finalQuery);
  const isTelemetryInsert = insertMatch?.[1] === 'telemetry_events';
  if (isTelemetryInsert && !hasReturning) {
    finalQuery = `${finalQuery.trim()} RETURNING id`;
  }

  const result = await db.unsafe(finalQuery, finalValues);
  lastAffectedRows = Number(result?.count || 0);

  if (isTelemetryInsert) {
    const insertedRow = Array.isArray(result) ? result[0] : null;
    lastInsertId = insertedRow?.id ?? lastInsertId;
  }

  return result;
};

const buildTemplateQuery = (strings, values) => {
  let queryText = '';
  const params = [];

  for (let index = 0; index < strings.length; index += 1) {
    queryText += strings[index];

    if (index < values.length) {
      queryText += '?';
      params.push(values[index]);
    }
  }

  return { queryText, params };
};

const sql = async (strings, ...values) => {
  const { queryText, params } = buildTemplateQuery(strings, values);
  return execute(queryText, params);
};

sql.unsafe = async (queryText, params = []) => execute(queryText, params);

sql.end = async () => {
  if (!dbPromise) {
    return;
  }

  const db = await dbPromise;
  if (activeDriver === 'sqlite') {
    await db.close();
  } else {
    await db.end({ timeout: 5 });
  }
  dbPromise = undefined;
  activeDriver = null;
};

export default sql;

