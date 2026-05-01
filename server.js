/**
 * Chessme Engine Server v3 — Adaptive scaling + cost-optimised
 *
 * Changes over v2:
 *   - Dynamic engine pool: starts at MIN_ENGINES, scales up to MAX_ENGINES on demand,
 *     scales back down after SCALE_DOWN_IDLE_MS of empty queue
 *   - Adaptive movetime: 2000ms at rest → 800ms under load → 400ms when overloaded
 *     (queue-depth aware — trades eval quality for throughput when busy)
 *   - Smart keepalive: only pings Railway while requests are active; stops after
 *     KEEPALIVE_IDLE_MS of no traffic → Railway container sleeps → near-zero idle cost
 *   - Activity tracking: /health now reports lastRequestAgo, engineCount, movetimeMs
 *
 * Environment variables:
 *   PORT, DEPTH (default 18), HASH (default 48MB), THREADS_PER_ENGINE (default 1)
 *   MIN_ENGINES  (default 1)    — engines kept alive at rest
 *   MAX_ENGINES  (default 4)    — ceiling during demand spikes
 *   SCALE_UP_THRESHOLD  (default 4)  — queue depth that triggers an engine spawn
 *   SCALE_DOWN_IDLE_MS  (default 60000) — ms of empty queue before retiring an engine
 *   KEEPALIVE_IDLE_MS   (default 900000) — 15min; stop pinging after this idle window
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   REQUIRE_AUTH (true/false)
 *   RAILWAY_PUBLIC_DOMAIN
 *   MAX_QUEUE (default 60)
 *   RATE_LIMIT_PER_MIN (default 120)
 */

'use strict';

const http      = require('http');
const https     = require('https');
const { spawn } = require('child_process');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT                       || 3000;
const DEFAULT_DEPTH    = parseInt(process.env.DEPTH)            || 18;
const HASH_MB          = parseInt(process.env.HASH)             || 48;
const THREADS_PER_ENG  = parseInt(process.env.THREADS_PER_ENGINE) || 1;
const MAX_QUEUE        = parseInt(process.env.MAX_QUEUE)        || 60;
const RATE_PER_MIN     = parseInt(process.env.RATE_LIMIT_PER_MIN) || 120;
const REQUIRE_AUTH     = process.env.REQUIRE_AUTH === 'true';
const SUPABASE_URL     = process.env.SUPABASE_URL               || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY         || '';
const LOCAL_CACHE_SIZE = 150_000;

// Scaling knobs (all tuneable via Railway env vars)
const MIN_ENGINES          = parseInt(process.env.MIN_ENGINES)          || 1;
const MAX_ENGINES          = parseInt(process.env.MAX_ENGINES)          || 4;
const SCALE_UP_THRESHOLD   = parseInt(process.env.SCALE_UP_THRESHOLD)   || 4;  // queue > N → spawn engine
const SCALE_DOWN_IDLE_MS   = parseInt(process.env.SCALE_DOWN_IDLE_MS)   || 60_000; // 60s idle → retire engine
const KEEPALIVE_IDLE_MS    = parseInt(process.env.KEEPALIVE_IDLE_MS)    || 15 * 60_000; // 15min → stop pinging

// ── Adaptive movetime ─────────────────────────────────────────────────────────
// Returns the movetime cap (ms) based on current queue depth.
// More queue = less time per position = higher throughput at slight quality cost.
function getMovetime(queueDepth) {
  if (queueDepth >= 20) return 400;   // overloaded — blitz mode
  if (queueDepth >= 8)  return 800;   // busy — balanced
  if (queueDepth >= 3)  return 1200;  // moderate — slightly faster
  return 2000;                         // quiet — full quality
}

// ── Stockfish path ────────────────────────────────────────────────────────────
function findStockfish() {
  const paths = [
    process.env.STOCKFISH_PATH, './stockfish-bin',
    '/usr/games/stockfish', '/usr/local/bin/stockfish',
    '/usr/bin/stockfish', './stockfish', 'stockfish',
  ].filter(Boolean);
  for (const p of paths) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Stockfish not found. Install: apt-get install stockfish');
}
const SF_PATH = findStockfish();
console.log(`[Engine] Stockfish: ${SF_PATH}`);

// ── Local LRU eval cache ──────────────────────────────────────────────────────
const _lru = new Map();
function lruGet(k) {
  if (!_lru.has(k)) return null;
  const v = _lru.get(k); _lru.delete(k); _lru.set(k, v); return v;
}
function lruSet(k, v) {
  if (_lru.size >= LOCAL_CACHE_SIZE) _lru.delete(_lru.keys().next().value);
  _lru.set(k, v);
}
function cacheKey(fen, depth) {
  return fen.split(' ').slice(0, 4).join(' ') + `@d${depth}`;
}

// ── Supabase eval_cache ───────────────────────────────────────────────────────
async function supabaseGet(fenKey) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/eval_cache?fen_key=eq.${encodeURIComponent(fenKey)}&select=cp,mate,depth&limit=1`;
    const data = await httpsGet(url, {
      'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    });
    return data?.[0] || null;
  } catch { return null; }
}

async function supabaseSet(fenKey, cp, mate, depth) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    await httpsPost(`${SUPABASE_URL}/rest/v1/eval_cache`, {
      'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'resolution=merge-duplicates',
    }, { fen_key: fenKey, cp, mate, depth, updated_at: new Date().toISOString() });
  } catch {}
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

// ── Stockfish engine instance ─────────────────────────────────────────────────
class Engine {
  constructor(id) {
    this.id    = id;
    this.ready = false;
    this.busy  = false;
    this.alive = true;
    this._preventRestart = false;
    this.current = null;
    this._start();
  }

  _start() {
    this.proc = spawn(SF_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    let buf = '';
    this.proc.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        this._onLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    });
    this.proc.on('exit', code => {
      if (this._preventRestart) return; // intentional kill
      console.warn(`[Engine ${this.id}] exited (${code}), restarting in 1s`);
      this.ready = false; this.busy = false;
      setTimeout(() => { if (!this._preventRestart) this._start(); }, 1000);
    });
    this._send('uci');
    this._send(`setoption name Hash value ${HASH_MB}`);
    this._send(`setoption name Threads value ${THREADS_PER_ENG}`);
    this._send('isready');
  }

  _send(cmd) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  _onLine(line) {
    if (line === 'readyok' && !this.ready) {
      this.ready = true;
      console.log(`[Engine ${this.id}] ready`);
      // Warmup: run a quick depth-8 search to pre-heat the hash table
      this._send('position startpos');
      this._send('go depth 8');
      return;
    }
    if (!this.current) return;
    if (line.startsWith('info')) {
      const cpM = line.match(/score cp (-?\d+)/);
      const mM  = line.match(/score mate (-?\d+)/);
      if (cpM) this.current.bestCp   = parseInt(cpM[1]);
      if (mM)  this.current.bestMate = parseInt(mM[1]);
    }
    if (line.startsWith('bestmove')) {
      const { fen, bestCp, bestMate, resolve } = this.current;
      const isBlack = fen.includes(' b ');
      const cp      = bestCp   !== null ? (isBlack ? -bestCp   : bestCp)   : 0;
      const mate    = bestMate !== null ? (isBlack ? -bestMate : bestMate) : null;
      this.current = null;
      this.busy    = false;
      resolve({ cp, mate });
      pool.drain();
    }
  }

  eval(fen, depth, movetime) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._send('stop');
        this.current = null; this.busy = false;
        reject(new Error('Engine timeout'));
        pool.drain();
      }, movetime + 3000);

      this.busy    = true;
      this.current = {
        fen, bestCp: null, bestMate: null,
        resolve: r => { clearTimeout(timer); resolve(r); },
      };
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth} movetime ${movetime}`);
    });
  }

  /** Gracefully retire this engine — finish current job then kill. */
  kill() {
    this._preventRestart = true;
    this.alive = false;
    if (!this.busy) {
      try { this.proc?.kill(); } catch {}
    }
    // If busy, it will die after its current job via the exit handler
    // (we set _preventRestart so it won't restart)
  }
}

// ── Dynamic engine pool ───────────────────────────────────────────────────────
const pool = {
  engines: [],
  pending: [],
  inflight: new Map(),
  _lastQueueEmptyAt: Date.now(),

  init() {
    for (let i = 0; i < MIN_ENGINES; i++) this.engines.push(new Engine(i));
    console.log(`[Pool] Started with ${MIN_ENGINES} engine(s). Range: ${MIN_ENGINES}–${MAX_ENGINES}`);
  },

  get queueDepth() { return this.pending.length + this.inflight.size; },
  get readyCount()  { return this.engines.filter(e => e.alive && e.ready && !e.busy).length; },
  get activeCount() { return this.engines.filter(e => e.alive).length; },

  /** Spawn a new engine if under load and below MAX. */
  _maybeScaleUp() {
    const q = this.queueDepth;
    if (q > SCALE_UP_THRESHOLD && this.activeCount < MAX_ENGINES) {
      const id = this.engines.reduce((mx, e) => Math.max(mx, e.id), -1) + 1;
      const eng = new Engine(id);
      this.engines.push(eng);
      console.log(`[Pool] Scale UP → ${this.activeCount} engines (queue=${q})`);
    }
    if (q > 0) this._lastQueueEmptyAt = Date.now(); // reset idle timer
  },

  /** Retire one idle engine if we've been over-provisioned for a while. */
  _maybeScaleDown() {
    if (this.queueDepth === 0) {
      if (!this._lastQueueEmptyAt) this._lastQueueEmptyAt = Date.now();
    }
    const idleMs = Date.now() - (this._lastQueueEmptyAt || Date.now());
    if (this.activeCount <= MIN_ENGINES) return;
    if (idleMs < SCALE_DOWN_IDLE_MS) return;

    // Find the highest-numbered idle engine and retire it
    const idle = this.engines.slice().reverse().find(e => e.alive && e.ready && !e.busy);
    if (idle) {
      idle.kill();
      this.engines = this.engines.filter(e => e !== idle);
      this._lastQueueEmptyAt = Date.now(); // reset so we don't cascade
      console.log(`[Pool] Scale DOWN → ${this.activeCount} engines (idle ${Math.round(idleMs / 1000)}s)`);
    }
  },

  eval(fen, depth) {
    this._maybeScaleUp();
    const movetime = getMovetime(this.queueDepth);
    const key = cacheKey(fen, depth);

    if (this.inflight.has(key)) {
      const entry = this.inflight.get(key);
      return new Promise((resolve, reject) => entry.resolvers.push({ resolve, reject }));
    }

    return new Promise((resolve, reject) => {
      const resolvers = [{ resolve, reject }];
      this.inflight.set(key, { resolvers, movetime });
      this.pending.push({ fen, depth, movetime, key, resolvers });
      this.drain();
    });
  },

  drain() {
    if (!this.pending.length) return;
    const eng = this.engines.find(e => e.alive && e.ready && !e.busy);
    if (!eng) return;
    const job = this.pending.shift();
    eng.eval(job.fen, job.depth, job.movetime).then(result => {
      this.inflight.delete(job.key);
      job.resolvers.forEach(r => r.resolve(result));
    }).catch(err => {
      this.inflight.delete(job.key);
      job.resolvers.forEach(r => r.reject(err));
    });
  },

  status() {
    return {
      engines:   this.activeCount,
      min:       MIN_ENGINES,
      max:       MAX_ENGINES,
      ready:     this.readyCount,
      busy:      this.engines.filter(e => e.busy).length,
      queue:     this.queueDepth,
      movetime:  getMovetime(this.queueDepth),
      scaleUpAt: SCALE_UP_THRESHOLD,
    };
  },
};

pool.init();

// Periodic scale-down check (every 30s)
setInterval(() => pool._maybeScaleDown(), 30_000);

// ── Activity tracking ─────────────────────────────────────────────────────────
let lastRequestAt = 0; // epoch ms of last /eval POST

// ── Smart keepalive ───────────────────────────────────────────────────────────
// Only ping Railway while the server has seen recent traffic.
// Once idle for KEEPALIVE_IDLE_MS, stop pinging → Railway can sleep the container.
// When a new request arrives after a sleep, Railway cold-starts it automatically.
const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
if (DOMAIN) {
  setInterval(() => {
    const idleMs = Date.now() - lastRequestAt;
    if (lastRequestAt === 0 || idleMs >= KEEPALIVE_IDLE_MS) {
      // No recent traffic — don't ping, let Railway sleep
      if (lastRequestAt > 0) {
        console.log(`[Keepalive] Idle ${Math.round(idleMs / 60000)}min — pausing pings (container may sleep)`);
        lastRequestAt = 0; // suppress repeated log lines
      }
      return;
    }
    https.get(`https://${DOMAIN}/health`).on('error', () => {});
  }, 2 * 60_000); // check every 2 min
  console.log(`[Server] Smart keepalive: active while requests within last ${KEEPALIVE_IDLE_MS / 60000}min`);
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const _rateCounts = new Map();
function checkRate(ip) {
  const now   = Date.now();
  const entry = _rateCounts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  _rateCounts.set(ip, entry);
  return entry.count <= RATE_PER_MIN;
}

// ── JWT auth (Supabase) — optional ───────────────────────────────────────────
async function verifyJWT(token) {
  if (!REQUIRE_AUTH || !token) return !REQUIRE_AUTH;
  try {
    const res = await httpsGet(
      `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
    );
    return !!res?.id;
  } catch { return false; }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    const ps = pool.status();
    json(res, {
      ok:             true,
      ...ps,
      cache:          _lru.size,
      depth:          DEFAULT_DEPTH,
      lastRequestAgo: lastRequestAt ? Math.round((Date.now() - lastRequestAt) / 1000) + 's' : 'never',
      keepaliveActive: lastRequestAt > 0 && (Date.now() - lastRequestAt) < KEEPALIVE_IDLE_MS,
    });
    return;
  }

  // ── POST /eval ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/eval') {
    lastRequestAt = Date.now(); // mark activity

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!checkRate(ip)) {
      return json(res, { error: 'Rate limit exceeded — try again in 60s' }, 429);
    }

    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (REQUIRE_AUTH && !(await verifyJWT(token))) {
      return json(res, { error: 'Unauthorized' }, 401);
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { fens, depth: reqDepth } = JSON.parse(body);
        if (!Array.isArray(fens) || !fens.length) {
          return json(res, { error: 'fens[] required' }, 400);
        }

        // Adaptive depth cap: respect requested depth but cap lower under load
        const queueNow = pool.queueDepth;
        const depthCap = queueNow >= 20 ? 14 : queueNow >= 8 ? 16 : 20;
        const depth    = Math.max(10, Math.min(depthCap, reqDepth || DEFAULT_DEPTH));

        if (pool.queueDepth + fens.length > MAX_QUEUE) {
          return json(res, { error: 'Server overloaded — use local engine', overloaded: true }, 503);
        }

        const results = await Promise.all(fens.map(async fen => {
          const key = cacheKey(fen, depth);

          // 1. Local LRU
          const hit = lruGet(key);
          if (hit) return { ...hit, cached: 'local' };

          // 2. Supabase
          const dbHit = await supabaseGet(key);
          if (dbHit && dbHit.depth >= depth) {
            lruSet(key, dbHit);
            return { ...dbHit, cached: 'db' };
          }

          // 3. Evaluate
          try {
            const { cp, mate } = await pool.eval(fen, depth);
            const result = { cp, mate, depth, cached: false };
            lruSet(key, { cp, mate, depth });
            supabaseSet(key, cp, mate, depth).catch(() => {});
            return result;
          } catch (e) {
            return { cp: null, mate: null, depth: 0, cached: false, error: e.message };
          }
        }));

        json(res, { results });
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  json(res, { error: 'Not found' }, 404);
}).listen(PORT, () => {
  console.log(`[Server] v3 listening on :${PORT}`);
  console.log(`[Server] Engines: ${MIN_ENGINES}–${MAX_ENGINES} dynamic · depth cap ${DEFAULT_DEPTH} · hash ${HASH_MB}MB × engine`);
  console.log(`[Server] Queue limit ${MAX_QUEUE} · rate ${RATE_PER_MIN}/min/ip`);
  console.log(`[Server] Scale-up threshold: queue > ${SCALE_UP_THRESHOLD} · Scale-down idle: ${SCALE_DOWN_IDLE_MS / 1000}s`);
  console.log(`[Server] Keepalive idle window: ${KEEPALIVE_IDLE_MS / 60000}min`);
  console.log(`[Server] Supabase cache: ${SUPABASE_URL ? 'enabled' : 'disabled'}`);
});
