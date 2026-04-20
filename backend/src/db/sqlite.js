import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runtimeDataRoot = (process.env.APP_DATA_DIR || '').trim();
const dataDirectory = runtimeDataRoot
  ? path.join(runtimeDataRoot, 'data')
  : path.join(__dirname, '..', 'data');
const databasePath = path.join(dataDirectory, 'telemetry_events.db');

let dbPromise;

const initializeDatabase = async () => {
  if (!dbPromise) {
    dbPromise = (async () => {
      await fs.mkdir(dataDirectory, { recursive: true });

      const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
      });

      await db.exec('PRAGMA journal_mode = WAL;');
      await db.exec('PRAGMA foreign_keys = ON;');

      return db;
    })();
  }

  return dbPromise;
};

const convertPostgresPlaceholders = (queryText, params) => {
  const orderedIndexes = [];
  const convertedQuery = queryText.replace(/\$(\d+)/g, (_match, oneBasedIndex) => {
    orderedIndexes.push(Number(oneBasedIndex) - 1);
    return '?';
  });

  if (!orderedIndexes.length) {
    return { query: convertedQuery, values: params };
  }

  const values = orderedIndexes.map((index) => params[index]);
  return { query: convertedQuery, values };
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

const execute = async (queryText, params = []) => {
  const db = await initializeDatabase();
  const { query, values } = convertPostgresPlaceholders(queryText, params);
  const normalizedValues = values.map(normalizeBoundValue);

  if (isReadQuery(query)) {
    return db.all(query, normalizedValues);
  }

  await db.run(query, normalizedValues);
  return [];
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
  await db.close();
  dbPromise = undefined;
};

export default sql;

