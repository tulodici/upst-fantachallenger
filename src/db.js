// Adattatore DB: PostgreSQL (produzione, RT-01) o SQLite integrato di Node (sviluppo/test).
// Le query usano placeholder `?` e SQL portabile; l'adattatore PG li converte in $1, $2...

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
    id {{PK}},
    telegram_id TEXT NOT NULL UNIQUE,
    team_name TEXT NOT NULL,
    captain_id TEXT NOT NULL,
    reg_week TEXT NOT NULL,
    registered_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT)`,
  `CREATE TABLE IF NOT EXISTS rankings (
    week_start TEXT NOT NULL, player_id TEXT NOT NULL, pos INTEGER NOT NULL,
    PRIMARY KEY (week_start, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rankings_pos ON rankings (week_start, pos)`,
  `CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, week_start TEXT NOT NULL,
    status TEXT NOT NULL, location TEXT, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tournaments_week ON tournaments (week_start)`,
  `CREATE TABLE IF NOT EXISTS draw_entries (
    tournament_id TEXT NOT NULL, player_id TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (tournament_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_draw_player ON draw_entries (player_id)`,
  `CREATE TABLE IF NOT EXISTS tournament_results (
    tournament_id TEXT NOT NULL, player_id TEXT NOT NULL, reached TEXT NOT NULL,
    PRIMARY KEY (tournament_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rosters (
    user_id INTEGER NOT NULL, week_start TEXT NOT NULL, player_ids TEXT NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, week_start)
  )`,
  `CREATE TABLE IF NOT EXISTS roster_snapshots (
    user_id INTEGER NOT NULL, week_start TEXT NOT NULL, player_id TEXT NOT NULL, ref_pos INTEGER,
    PRIMARY KEY (user_id, week_start, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS snapshot_weeks (week_start TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS points (
    user_id INTEGER NOT NULL, week_start TEXT NOT NULL, tournament_id TEXT NOT NULL,
    player_id TEXT NOT NULL, points INTEGER NOT NULL, is_captain INTEGER NOT NULL,
    PRIMARY KEY (user_id, tournament_id, player_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_points_user ON points (user_id)`,
  `CREATE TABLE IF NOT EXISTS api_calls (
    id {{PK}}, created_at TEXT NOT NULL, ym TEXT NOT NULL, endpoint TEXT NOT NULL, ok INTEGER NOT NULL, note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_calls_ym ON api_calls (ym)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id {{PK}}, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    job TEXT NOT NULL, run_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
    last_attempt_at TEXT, message TEXT,
    PRIMARY KEY (job, run_key)
  )`,
];

export async function openDb({ databaseUrl, sqlitePath = ':memory:' } = {}) {
  const db = databaseUrl ? await openPg(databaseUrl) : await openSqlite(sqlitePath);
  const pk = db.dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  for (const stmt of SCHEMA) await db.run(stmt.replaceAll('{{PK}}', pk));
  return db;
}

async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  let chain = Promise.resolve(); // serializza le transazioni (SQLite e' sincrono)
  const make = () => ({
    dialect: 'sqlite',
    async all(sql, p = []) { return raw.prepare(sql).all(...p); },
    async get(sql, p = []) { return raw.prepare(sql).get(...p); },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
  });
  const db = make();
  db.tx = (fn) => {
    const result = chain.then(async () => {
      raw.exec('BEGIN');
      try {
        const out = await fn(make());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    });
    chain = result.catch(() => {});
    return result;
  };
  db.close = async () => raw.close();
  return db;
}

async function openPg(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT/SUM (int8) come numeri
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: process.env.PGSSL === 'disable' || /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false },
  });
  const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const make = (client) => ({
    dialect: 'pg',
    async all(sql, p = []) { return (await client.query(conv(sql), p)).rows; },
    async get(sql, p = []) { return (await client.query(conv(sql), p)).rows[0]; },
    async run(sql, p = []) { const r = await client.query(conv(sql), p); return { changes: r.rowCount }; },
  });
  const db = make(pool);
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(make(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  return db;
}
