'use strict';
/**
 * Dual-mode database layer.
 * - DATABASE_URL set  → PostgreSQL (pg)
 * - DATABASE_URL unset → SQLite (uses DATABASE_PATH or ./grouppool.db)
 *
 * Exports: dbGet, dbAll, dbRun, uid, initDb
 * Interface mirrors SQLite callbacks; queries written in SQLite dialect,
 * toPg() converts them on the fly for PostgreSQL.
 */

const USE_PG = !!process.env.DATABASE_URL;

// ── SQLite mode ───────────────────────────────────────────────────────────────

let _sqlite = null;

function initSqlite() {
  const sqlite3  = require('sqlite3').verbose();
  const fs       = require('fs');
  const pathMod  = require('path');
  const DB_PATH  = process.env.DATABASE_PATH || './grouppool.db';
  // Ensure parent directory exists (needed for Railway /data/ volume)
  const dir = pathMod.dirname(DB_PATH);
  if (dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[DB] Created directory: ${dir}`);
  }
  console.log(`[DB] SQLite mode — ${DB_PATH}`);
  _sqlite = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('[DB] SQLite open error:', err.message);
    else     console.log('[DB] SQLite connected');
  });
  _sqlite.run('PRAGMA journal_mode=WAL');
  return new Promise((res) => {
    _sqlite.serialize(() => {
      _sqlite.run(`CREATE TABLE IF NOT EXISTS pools (
        id TEXT PRIMARY KEY, streamer TEXT NOT NULL, gruppe_name TEXT NOT NULL,
        message TEXT NOT NULL, ziel_betrag REAL NOT NULL, ist_betrag REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      _sqlite.run(`CREATE TABLE IF NOT EXISTS contributions (
        id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, teilnehmer_name TEXT NOT NULL,
        betrag REAL NOT NULL, stripe_session TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (pool_id) REFERENCES pools(id)
      )`);
      _sqlite.run(`CREATE TABLE IF NOT EXISTS platform_status (
        platform TEXT PRIMARY KEY, healthy INTEGER NOT NULL DEFAULT 1,
        last_check TEXT, last_error TEXT, degraded_since TEXT
      )`);
      _sqlite.run(`CREATE TABLE IF NOT EXISTS streamer_links (
        streamer TEXT NOT NULL, platform TEXT NOT NULL, url TEXT NOT NULL,
        last_checked TEXT NOT NULL, PRIMARY KEY (streamer, platform)
      )`);
      _sqlite.run(`CREATE TABLE IF NOT EXISTS bot_logs (
        id TEXT PRIMARY KEY, pool_id TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        platform TEXT, status TEXT, message TEXT
      )`);
      ['streamlabs','tipeeestream','streamelements','twitch'].forEach(p =>
        _sqlite.run(`INSERT OR IGNORE INTO platform_status (platform) VALUES (?)`, [p])
      );
      _sqlite.run('SELECT 1', [], (e) => { if (!e) res(); });
    });
  });
}

// ── PostgreSQL mode ───────────────────────────────────────────────────────────

let _pgPool = null;

function toPg(sql, params) {
  let i = 0;
  let text = sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/datetime\('now'\)/gi, 'NOW()')
    .replace(/INSERT OR IGNORE INTO /gi, 'INSERT INTO ')
    .replace(/INSERT OR REPLACE INTO /gi, 'INSERT INTO ')
    .replace(/\bINTEGER\b/gi, 'INTEGER')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    // ON CONFLICT clause needed per-statement — handled via known patterns below
    ;
  // streamer_links upsert
  if (/INSERT INTO streamer_links/i.test(text) && !/ON CONFLICT/i.test(text)) {
    text = text.replace(/\)$/, ') ON CONFLICT (streamer, platform) DO UPDATE SET url = EXCLUDED.url, last_checked = EXCLUDED.last_checked');
  }
  // platform_status seed
  if (/INSERT INTO platform_status/i.test(text) && !/ON CONFLICT/i.test(text)) {
    text += ' ON CONFLICT (platform) DO NOTHING';
  }
  return { text, values: params };
}

async function initPg() {
  const { Pool } = require('pg');
  _pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('[DB] PostgreSQL mode');
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS pools (
    id TEXT PRIMARY KEY, streamer TEXT NOT NULL, gruppe_name TEXT NOT NULL,
    message TEXT NOT NULL, ziel_betrag DOUBLE PRECISION NOT NULL, ist_betrag DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, teilnehmer_name TEXT NOT NULL,
    betrag DOUBLE PRECISION NOT NULL, stripe_session TEXT, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS platform_status (
    platform TEXT PRIMARY KEY, healthy INTEGER NOT NULL DEFAULT 1,
    last_check TIMESTAMPTZ, last_error TEXT, degraded_since TIMESTAMPTZ
  )`);
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS streamer_links (
    streamer TEXT NOT NULL, platform TEXT NOT NULL, url TEXT NOT NULL,
    last_checked TIMESTAMPTZ NOT NULL, PRIMARY KEY (streamer, platform)
  )`);
  await _pgPool.query(`CREATE TABLE IF NOT EXISTS bot_logs (
    id TEXT PRIMARY KEY, pool_id TEXT, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    platform TEXT, status TEXT, message TEXT
  )`);
  for (const p of ['streamlabs','tipeeestream','streamelements','twitch']) {
    await _pgPool.query(`INSERT INTO platform_status (platform) VALUES ($1) ON CONFLICT (platform) DO NOTHING`, [p]);
  }
  console.log('[DB] PostgreSQL tables ready');
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initDb() {
  if (USE_PG) return initPg();
  return initSqlite();
}

function dbGet(sql, params = []) {
  if (USE_PG) {
    const { text, values } = toPg(sql, params);
    return _pgPool.query(text, values).then(r => r.rows[0]);
  }
  return new Promise((res, rej) => _sqlite.get(sql, params, (e, r) => e ? rej(e) : res(r)));
}

function dbAll(sql, params = []) {
  if (USE_PG) {
    const { text, values } = toPg(sql, params);
    return _pgPool.query(text, values).then(r => r.rows);
  }
  return new Promise((res, rej) => _sqlite.all(sql, params, (e, r) => e ? rej(e) : res(r)));
}

function dbRun(sql, params = []) {
  if (USE_PG) {
    const { text, values } = toPg(sql, params);
    return _pgPool.query(text, values).then(r => ({ lastID: undefined, changes: r.rowCount }));
  }
  return new Promise((res, rej) => _sqlite.run(sql, params, function(e) { e ? rej(e) : res(this); }));
}

function uid() { return Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

module.exports = { initDb, dbGet, dbAll, dbRun, uid };
