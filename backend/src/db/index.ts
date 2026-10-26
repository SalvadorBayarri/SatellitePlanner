import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';

let pool: Pool;
let dbMode: 'postgres' | 'pg-mem-fallback' = 'postgres';

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool has not been initialized yet.');
  }
  return pool;
}

export function getDbMode(): string {
  return dbMode;
}

export async function initDatabase(): Promise<void> {
  const candidatePool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3000,
    max: 10,
  });

  try {
    const client = await candidatePool.connect();
    client.release();
    pool = candidatePool;
    dbMode = 'postgres';
    console.log('[DB] Connected to PostgreSQL instance successfully.');
  } catch (err) {
    console.warn('[DB] PostgreSQL server unreachable at', config.databaseUrl, '- activating pg-mem in-memory PostgreSQL fallback.');
    await candidatePool.end().catch(() => {});

    const mem = newDb();
    mem.public.registerFunction({
      name: 'gen_random_uuid',
      returns: mem.public.getType('uuid' as any),
      implementation: () => uuidv4(),
      impure: true,
    });

    const pgAdapter = mem.adapters.createPg();
    pool = new pgAdapter.Pool() as unknown as Pool;
    dbMode = 'pg-mem-fallback';
  }

  await runMigrations();
}

async function runMigrations(): Promise<void> {
  const candidatePaths = [
    path.join(__dirname, 'init.sql'),
    path.join(__dirname, '../../src/db/init.sql'),
    path.resolve(process.cwd(), 'src/db/init.sql'),
    path.resolve(process.cwd(), 'backend/src/db/init.sql'),
  ];
  const sqlPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!sqlPath) {
    throw new Error('Could not locate init.sql in any expected path.');
  }
  const rawSql = fs.readFileSync(sqlPath, 'utf-8');

  if (dbMode === 'postgres') {
    await pool.query(rawSql);
    console.log('[DB] Executed init.sql schema and seed data on PostgreSQL.');
  } else {
    // Normalize DECIMAL(9, 6) and INTERVAL expressions for pg-mem compatibility while keeping identical schema and seed records
    const nowIso = new Date().toISOString();
    const normalizedSql = rawSql
      .replace(/DECIMAL\(\d+,\s*\d+\)/gi, 'DECIMAL')
      .replace(/CURRENT_TIMESTAMP - INTERVAL '(\d+) minutes'/g, (_match, mins) => {
        const ts = new Date(Date.now() - Number(mins) * 60_000).toISOString();
        return `'${ts}'`;
      })
      .replace(/,\s*CURRENT_TIMESTAMP\)/g, `, '${nowIso}')`);
    await pool.query(normalizedSql);
    console.log('[DB] Executed init.sql schema and seed data on pg-mem PostgreSQL engine.');
  }
}

export async function checkDbHealth(): Promise<{
  connected: boolean;
  mode: string;
  totalSatellites?: number;
}> {
  try {
    const satRes = await pool.query('SELECT COUNT(*)::int AS count FROM satellite_fleet');
    return {
      connected: true,
      mode: dbMode,
      totalSatellites: satRes.rows[0]?.count ?? 0,
    };
  } catch (error) {
    return {
      connected: false,
      mode: dbMode,
    };
  }
}
