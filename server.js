//**
 * Chessme Engine Server v2 — Production-ready
 *
 * Optimisations over v1:
 *   - Dual Stockfish process pool (2× throughput)
 *   - Supabase eval_cache read BEFORE evaluating (zero cost for common positions)
 *   - Global position deduplication (N users requesting same FEN = 1 eval)
 *   - Per-IP rate limiting (max 60 positions/min)
 *   - Queue depth limit (503 when overloaded → client falls back to local)
 *   - JWT auth via Supabase anon key (optional but recommended)
 *   - Aggressive keepalive (ping every 2 min)
 *   - Warmup: engine runs dummy position on startup before accepting requests
 *   - Depth cap: respects requested depth, caps at 20
 *
 * Environment variables:
 *   PORT, DEPTH (default 18), HASH (default 64MB), THREADS_PER_ENGINE (default 1)
 *   SUPABASE_URL, SUPABASE_ANON_KEY  — for eval_cache read/write
 *   REQUIRE_AUTH (true/false)        — reject unauthenticated requests
 *   RAILWAY_PUBLIC_DOMAIN            — set by Railway, used for keepalive
 *   MAX_QUEUE (default 40)           — reject if queue exceeds this
 *   RATE_LIMIT_PER_MIN (default 60)  — positions per IP per minute
 */

'use strict';

const http       = require('http');
const https      = require('https');
const { spawn }  = require('child_process');
const fs         = require('fs');

const PORT              = process.env.PORT                   || 3000;
const DEFAULT_DEPTH     = parseInt(process.env.DEPTH)        || 18;
const HASH_MB           = parseInt(process.env.HASH)         || 64;
const THREADS_PER_ENG   = parseInt(process.env.THREADS_PER_ENGINE) || 1;
const MAX_QUEUE         = parseInt(process.env.MAX_QUEUE)    || 40;
const RATE_PER_MIN      = parseInt(process.env.RATE_LIMIT_PER_MIN) || 60;
const REQUIRE_AUTH      = process.env.REQUIRE_AUTH === 'true';
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const NUM_ENGINES       = 2;
const LOCAL_CACHE_SIZE  = 150_000;

function findStockfish() {
  const paths = [
    process.env.STOCKFISH_PATH,
    './stockfish-bin', '/usr/games/stockfish',
    '/usr/local/bin/stockfish', '/usr/bin/stockfish',
    './stockfish', 'stockfish',
  ].filter(Boolean);
  for (const p of paths) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Stockfish not found. Install: apt-get install stockfish');
}
const SF_PATH = findStockfish();
console.log(`[Engine] Stockfish: ${SF_PATH}`);

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

async function supabaseGet(fenKey) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/eval_cache?fen_key=eq.${encodeURIComponent(fenKey)}&select=cp,mate,depth&limit=1`;
    const data = await httpsGet(url, {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    });
    return data?.[0] || null;
  } catch { return null; }
}

async function supabaseSet(fenKey, cp, mate, depth) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    await httpsPost(`${SUPABASE_URL}/rest/v1/eval_cache`, {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
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
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

class Engine {
  constructor(id) {
    this.id      = id;
    this.ready   = false;
    this.busy    = false;
    this.current = null;
    this._start();
  }

  _start() {
    this.proc = spawn(SF_PATH, [], { stdio: ['pipe','pipe','pipe'] });
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
      console.warn(`[Engine ${this.id}] exited (${code}), restarting in 1s`);
      this.ready = false; this.busy = false;
      setTimeout(() => this._start(), 1000);
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

  eval(fen, depth) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._send('stop');
        this.current = null; this.busy = false;
        reject(new Error('Engine timeout'));
        pool.drain();
      }, depth * 1200 + 4000);

      this.busy    = true;
      this.current = { fen, bestCp: null, bestMate: null,
        resolve: r => { clearTimeout(timer); resolve(r); } };
      this._send('ucinewgame');
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth}`);
    });
  }
}

const pool = {
  engines: Array.from({ length: NUM_ENGINES }, (_, i) => new Engine(i)),
  pending: [],
  inflight: new Map(),

  get queueDepth() {
    return this.pending.length + this.inflight.size;
  },

  eval(fen, depth) {
    const key = cacheKey(fen, depth);
    if (this.inflight.has(key)) {
      const entry = this.inflight.get(key);
      return new Promise((resolve, reject) => {
        entry.resolvers.push({ resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      const resolvers = [{ resolve, reject }];
      this.inflight.set(key, { resolvers });
      this.pending.push({ fen, depth, key, resolvers });
      this.drain();
    });
  },

  drain() {
    if (!this.pending.length) return;
    const eng = this.engines.find(e => e.ready && !e.busy);
    if (!eng) return;
    const job = this.pending.shift();
    eng.eval(job.fen, job.depth).then(result => {
      this.inflight.delete(job.key);
      job.resolvers.forEach(r => r.resolve(result));
    }).catch(err => {
      this.inflight.delete(job.key);
      job.resolvers.forEach(r => r.reject(err));
    });
  },
};

const _rateCounts = new Map();
function checkRate(ip) {
  const now = Date.now();
  const entry = _rateCounts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  _rateCounts.set(ip, entry);
  return entry.count <= RATE_PER_MIN;
}

async function verifyJWT(token) {
  if (!REQUIRE_AUTH || !token) return !REQUIRE_AUTH;
  try {
    const res = await httpsGet(
      `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY }
    );
    return !!res?.id;
  } catch { return false; }
}

const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
if (DOMAIN) {
  setInterval(() => {
    https.get(`https://${DOMAIN}/health`).on('error', () => {});
  }, 2 * 60 * 1000);
  console.log(`[Server] Keepalive pinging https://${DOMAIN}/health every 2 min`);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, {
      ok: true, engines: NUM_ENGINES,
      ready: pool.engines.filter(e => e.ready).length,
      busy:  pool.engines.filter(e => e.busy).length,
      queue: pool.queueDepth,
      cache: _lru.size,
      depth: DEFAULT_DEPTH,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/eval') {
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

        const depth = Math.max(10, Math.min(20, reqDepth || DEFAULT_DEPTH));

        if (pool.queueDepth + fens.length > MAX_QUEUE) {
          return json(res, { error: 'Server overloaded — use local engine', overloaded: true }, 503);
        }

        const results = await Promise.all(fens.map(async fen => {
          const key = cacheKey(fen, depth);

          const hit = lruGet(key);
          if (hit) return { ...hit, cached: 'local' };

          const dbHit = await supabaseGet(key);
          if (dbHit && dbHit.depth >= depth) {
            lruSet(key, dbHit);
            return { ...dbHit, cached: 'db' };
          }

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
  console.log(`[Server] v2 listening on :${PORT}`);
  console.log(`[Server] ${NUM_ENGINES} engines · depth ${DEFAULT_DEPTH} · hash ${HASH_MB}MB · queue limit ${MAX_QUEUE}`);
  console.log(`[Server] Supabase cache: ${SUPABASE_URL ? 'enabled' : 'disabled'}`);
  console.log(`[Server] Auth required: ${REQUIRE_AUTH}`);
});
