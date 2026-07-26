// ============================================================================
// Surekha BMS Pro — Backend Server (Node/Express + Neon PostgreSQL)
// Reconstructed to match the sync API the frontend (bms-pro-online.html)
// already calls: /api/login, /api/state, /api/bootstrap, /api/backups,
// /api/backups/:date/restore, /api/health, /api/public-info.
//
// Storage model: the entire client-side `db` object is synced as ONE JSON
// blob (see SYNC.* in the frontend) with a version counter for optimistic
// concurrency. This mirrors the "localStorage-first, background server
// sync" design already in place — the server does not need to understand
// individual records, just store/version/backup the whole blob.
//
// Env vars required:
//   DATABASE_URL   - Neon Postgres connection string
//   JWT_SECRET     - secret used to sign login tokens
//   PORT           - optional, defaults to 3000
// ============================================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // whole-db payloads can be large

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-render-env-vars';
const STATE_ROW_ID = 'main'; // single-tenant: one org, one state row

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------------------------------------------------------------------
// Bootstrap tables (safe to run every start — IF NOT EXISTS everywhere,
// matches the style already used in neon-ledger-schema.sql)
// ----------------------------------------------------------------------------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      updated_at  BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_backups (
      backup_date DATE PRIMARY KEY,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// ----------------------------------------------------------------------------
// Password hashing — MUST match the client's hashPw(): sha256(password + salt)
// (see bms-pro-online.html: crypto.subtle.digest('SHA-256', enc.encode(pw+s)))
// Each user record in the synced data is expected to carry { passwordHash, salt }.
// ----------------------------------------------------------------------------
function hashPw(pw, salt) {
  return crypto.createHash('sha256').update(String(pw) + String(salt)).digest('hex');
}

// ----------------------------------------------------------------------------
// Auth middleware
// ----------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
async function getState() {
  const { rows } = await pool.query('SELECT data, version, updated_at FROM app_state WHERE id = $1', [STATE_ROW_ID]);
  return rows[0] || null;
}

// Snapshot today's data into daily_backups exactly once per day, the first
// time anyone touches the server that day (matches the UI copy in the
// frontend's sync-setup modal: "once per day, the first time anyone uses
// the app that day").
async function ensureDailyBackup(currentData) {
  if (!currentData) return;
  try {
    await pool.query(
      `INSERT INTO daily_backups (backup_date, data)
       VALUES (CURRENT_DATE, $1)
       ON CONFLICT (backup_date) DO NOTHING`,
      [currentData]
    );
    // Keep only the last 60 days, per the "restore any of the last 60 days" copy.
    await pool.query(
      `DELETE FROM daily_backups WHERE backup_date < CURRENT_DATE - INTERVAL '60 days'`
    );
  } catch (e) {
    console.error('Daily backup snapshot failed:', e.message);
  }
}

// ----------------------------------------------------------------------------
// GET /api/health — used by the Sync Setup screen to test reachability
// ----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// GET /api/public-info — unauthenticated; just enough for the login screen
// to show the real business name/branding before anyone signs in.
// ----------------------------------------------------------------------------
app.get('/api/public-info', async (req, res) => {
  try {
    const state = await getState();
    const settings = state?.data?.settings || {};
    res.json({
      orgName: settings.orgName || null,
      accentColor: settings.accentColor || settings.themeColor || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load public info' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/login — fallback path for a device with no local copy of this
// user yet. Validates against the users embedded in the synced state blob
// using the same sha256(pw+salt) scheme the client uses.
// ----------------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const state = await getState();
    const users = state?.data?.users || [];
    const user = users.find(
      (u) => u.username && u.username.toLowerCase() === String(username).toLowerCase() && u.status === 'active'
    );
    if (!user || !user.passwordHash || !user.salt) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const computed = hashPw(password, user.salt);
    if (computed !== user.passwordHash) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const token = jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: '30d',
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.fullName,
        avatarColor: user.avatarColor,
      },
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/state — pull the latest full db blob
// ----------------------------------------------------------------------------
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const state = await getState();
    if (!state) return res.status(404).json({ error: 'No data on server yet — bootstrap required' });

    await ensureDailyBackup(state.data);

    res.json({
      data: state.data,
      version: state.version,
      updatedAt: Number(state.updated_at),
    });
  } catch (e) {
    console.error('GET /api/state error:', e.message);
    res.status(500).json({ error: 'Could not load state' });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/state — push the full db blob. Optimistic concurrency: the
// client sends the version it last pulled; if the server's current version
// has since moved on, reject with 409 so the client re-pulls before retrying
// (see syncPush()'s handling of resp.status === 409 in the frontend).
// ----------------------------------------------------------------------------
app.put('/api/state', requireAuth, async (req, res) => {
  const { data, version } = req.body || {};
  if (data === undefined) return res.status(400).json({ error: 'Missing data' });

  try {
    const current = await getState();
    const now = Date.now();

    if (!current) {
      // No state yet — treat first authenticated push as establishing it.
      await pool.query(
        `INSERT INTO app_state (id, data, version, updated_at) VALUES ($1, $2, 1, $3)`,
        [STATE_ROW_ID, data, now]
      );
      return res.json({ version: 1, updatedAt: now });
    }

    if (typeof version === 'number' && version !== current.version) {
      return res.status(409).json({ error: 'Version conflict — server has newer data', version: current.version });
    }

    await ensureDailyBackup(current.data);

    const newVersion = current.version + 1;
    await pool.query(
      `UPDATE app_state SET data = $1, version = $2, updated_at = $3 WHERE id = $4`,
      [data, newVersion, now, STATE_ROW_ID]
    );

    res.json({ version: newVersion, updatedAt: now });
  } catch (e) {
    console.error('PUT /api/state error:', e.message);
    res.status(500).json({ error: 'Could not save state' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/bootstrap — one-time upload of an existing offline system into
// a brand-new empty server. Refuses if data already exists, to avoid
// accidentally clobbering a live server (see syncBootstrap() in frontend).
// ----------------------------------------------------------------------------
app.post('/api/bootstrap', async (req, res) => {
  const { data } = req.body || {};
  if (data === undefined) return res.status(400).json({ error: 'Missing data' });

  try {
    const current = await getState();
    if (current) {
      return res.status(409).json({ error: 'Server already has data — bootstrap is for brand-new servers only' });
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO app_state (id, data, version, updated_at) VALUES ($1, $2, 1, $3)`,
      [STATE_ROW_ID, data, now]
    );
    res.json({ ok: true, version: 1, updatedAt: now });
  } catch (e) {
    console.error('POST /api/bootstrap error:', e.message);
    res.status(500).json({ error: 'Could not bootstrap server' });
  }
});

// ----------------------------------------------------------------------------
// GET /api/backups — list available daily snapshots (last 60 days)
// ----------------------------------------------------------------------------
app.get('/api/backups', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT backup_date FROM daily_backups ORDER BY backup_date DESC LIMIT 60`
    );
    res.json({ backups: rows });
  } catch (e) {
    console.error('GET /api/backups error:', e.message);
    res.status(500).json({ error: 'Could not load backups' });
  }
});

// ----------------------------------------------------------------------------
// POST /api/backups/:date/restore — replace current state with that day's
// snapshot for everyone. Restricted to admins, matching the frontend, which
// only ever shows this control in the admin-only Sync Setup panel.
// ----------------------------------------------------------------------------
app.post('/api/backups/:date/restore', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  try {
    const { rows } = await pool.query('SELECT data FROM daily_backups WHERE backup_date = $1', [req.params.date]);
    if (!rows.length) return res.status(404).json({ error: 'Backup not found for that date' });

    const current = await getState();
    const now = Date.now();
    const newVersion = current ? current.version + 1 : 1;

    await pool.query(
      `INSERT INTO app_state (id, data, version, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = $2, version = $3, updated_at = $4`,
      [STATE_ROW_ID, rows[0].data, newVersion, now]
    );

    res.json({ ok: true, version: newVersion, updatedAt: now });
  } catch (e) {
    console.error('POST /api/backups/:date/restore error:', e.message);
    res.status(500).json({ error: 'Could not restore backup' });
  }
});

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
ensureTables()
  .then(() => {
    app.listen(PORT, () => console.log(`Surekha BMS Pro backend listening on port ${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database tables:', e.message);
    process.exit(1);
  });
