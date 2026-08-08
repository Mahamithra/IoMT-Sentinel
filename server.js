const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// ── Config — works locally AND on Render ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// On Render the filesystem is ephemeral, so /tmp survives restarts within a
// session. For a hackathon demo this is fine; production would use Postgres.
const IS_CLOUD = !!process.env.RENDER;
const DATA_DIR = IS_CLOUD ? '/tmp' : path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'sentinel.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
let db;

async function initDb() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS baselines (
      userId TEXT PRIMARY KEY,
      intervals TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now')),
      layer TEXT,
      severity TEXT,
      title TEXT,
      detail TEXT,
      priority TEXT,
      recommendation TEXT
    );
  `);
  console.log('✅ Database ready:', DB_PATH);
}
initDb().catch(console.error);

// ── Behavioral Matching Algorithm ─────────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function stdev(arr) {
  const m = mean(arr);
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  const am = mean(a.slice(0, n)), bm = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - am) * (b[i] - bm);
    da  += (a[i] - am) ** 2;
    db  += (b[i] - bm) ** 2;
  }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

function matchTyping(baselineIntervals, sampleIntervals) {
  if (!baselineIntervals || !sampleIntervals || sampleIntervals.length === 0)
    return { score: 0, confidence: 'NO_DATA' };

  const b = baselineIntervals.slice(-15);
  const l = sampleIntervals.slice(-15);
  const bm = mean(b), lm = mean(l);

  // Speed ratio (0–1, 1 = same WPM)
  const speedRatio = Math.min(bm, lm) / Math.max(bm, lm);
  // Pearson rhythm correlation (normalised to 0–1)
  const corr = (pearson(b, l) + 1) / 2;
  // CV similarity (variance pattern)
  const bcv = stdev(b) / Math.max(bm, 1);
  const lcv = stdev(l) / Math.max(lm, 1);
  const cvSim = 1 - Math.min(Math.abs(bcv - lcv) / Math.max(bcv, lcv, 0.1), 1);
  // Hard penalty for very different speed (catches robotic/scripted typing)
  const speedPenalty = speedRatio < 0.6 ? 30 : 0;

  const score = Math.max(0, Math.round(speedRatio * 35 + corr * 45 + cvSim * 20 - speedPenalty));

  let confidence = 'MONITOR';
  if (score >= 70) confidence = 'MATCH';
  else if (score < 45) confidence = 'MISMATCH';

  return { score, confidence };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API ─────────────────────────────────────────────────────────────────────

  if (pathname === '/api/health' && method === 'GET') {
    json(res, 200, { status: 'ok', db: !!db, env: IS_CLOUD ? 'render' : 'local', version: '2.1.0' });
    return;
  }

  if (pathname === '/api/baseline' && method === 'POST') {
    const { userId, intervals } = await readBody(req);
    if (!userId || !Array.isArray(intervals) || intervals.length < 3) {
      json(res, 400, { error: 'Invalid baseline — need userId and intervals[] (min 3)' }); return;
    }
    await db.run('INSERT OR REPLACE INTO baselines (userId, intervals) VALUES (?, ?)',
      userId, JSON.stringify(intervals));
    json(res, 200, { ok: true, samplesStored: intervals.length });
    return;
  }

  if (pathname.startsWith('/api/baseline/') && method === 'GET') {
    const userId = decodeURIComponent(pathname.split('/api/baseline/')[1]);
    const row = await db.get('SELECT intervals FROM baselines WHERE userId = ?', userId);
    if (!row) { json(res, 404, { error: 'No baseline found' }); return; }
    json(res, 200, { userId, intervals: JSON.parse(row.intervals) });
    return;
  }

  if (pathname === '/api/auth-check' && method === 'POST') {
    const { userId, liveIntervals } = await readBody(req);
    if (!userId || !Array.isArray(liveIntervals) || !liveIntervals.length) {
      json(res, 400, { error: 'Need userId and liveIntervals[]' }); return;
    }
    const row = await db.get('SELECT intervals FROM baselines WHERE userId = ?', userId);
    if (!row) { json(res, 404, { error: 'No baseline for user' }); return; }
    const result = matchTyping(JSON.parse(row.intervals), liveIntervals);
    json(res, 200, result);
    return;
  }

  if (pathname === '/api/incidents' && method === 'GET') {
    const rows = await db.all('SELECT * FROM incidents ORDER BY timestamp DESC LIMIT 200');
    json(res, 200, { incidents: rows });
    return;
  }

  if (pathname === '/api/incidents' && method === 'POST') {
    const { layer, severity, title, detail, priority, recommendation } = await readBody(req);
    if (!title || !severity) { json(res, 400, { error: 'Need title and severity' }); return; }
    const result = await db.run(
      'INSERT INTO incidents (layer, severity, title, detail, priority, recommendation) VALUES (?, ?, ?, ?, ?, ?)',
      layer || 'system', severity, title, detail || '', priority || 'medium', recommendation || ''
    );
    json(res, 201, { id: result.lastID });
    return;
  }

  if (pathname === '/api/incidents' && method === 'DELETE') {
    await db.run('DELETE FROM incidents');
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const total    = (await db.get('SELECT COUNT(*) as c FROM incidents')).c;
    const critical = (await db.get("SELECT COUNT(*) as c FROM incidents WHERE severity='critical'")).c;
    const baselines= (await db.get('SELECT COUNT(*) as c FROM baselines')).c;
    json(res, 200, { total, critical, baselines });
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = {
      '.html': 'text/html', '.css': 'text/css',
      '.js': 'application/javascript', '.json': 'application/json',
      '.png': 'image/png', '.svg': 'image/svg+xml',
    }[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.on('error', err => console.error('❌ Server error:', err));
server.listen(PORT, () => {
  console.log(`🛡️  IoMT Sentinel v2.1 running on port ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Env: ${IS_CLOUD ? 'Render (cloud)' : 'Local'}`);
});