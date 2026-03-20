/**
 * Chessme Engine Server v3.1 — Railway Hobby ($5 plan)
 *
 * Hobby plan: 8 vCPUs, 8GB RAM — full utilisation
 *   - 4 Stockfish engines (was 2) — 4× parallel throughput
 *   - 2 threads per engine (was 1) — each position searched faster
 *   - 512MB hash (was 128MB) — massive position cache in memory
 *   - Rate limiting removed — single-user deployment, no need
 *   - movetime 2000ms (was 4000ms) — faster responses, depth 18 still accurate
 *   - MAX_QUEUE 200 — handles large burst analysis sessions
 *   - Keepalive every 30s (was 2min) — prevents Railway sleep on hobby
 */

'use strict';

const http    = require('http');
const https   = require('https');
const zlib    = require('zlib');
const { spawn } = require('child_process');
const fs      = require('fs');

const PORT            = process.env.PORT                      || 3000;
const DEFAULT_DEPTH   = parseInt(process.env.DEPTH)           || 18;
const HASH_MB         = parseInt(process.env.HASH)            || 256;  // 3×256MB = 768MB total
const THREADS_PER_ENG = parseInt(process.env.THREADS_PER_ENGINE) || 2;
const MAX_QUEUE       = parseInt(process.env.MAX_QUEUE)       || 100;
const MOVETIME_CAP    = parseInt(process.env.MOVETIME_CAP_MS) || 2000;
const REQUIRE_AUTH    = process.env.REQUIRE_AUTH === 'true';
const SUPABASE_URL    = process.env.SUPABASE_URL      || '';
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY || '';
const NUM_ENGINES     = parseInt(process.env.NUM_ENGINES) || 2; // 2 per replica × 3 replicas = 6 total
const LOCAL_CACHE     = 300_000;

// ── Stockfish path ─────────────────────────────────────────────────────────────
function findStockfish() {
  for (const p of [
    process.env.STOCKFISH_PATH,
    './stockfish-bin', '/usr/games/stockfish',
    '/usr/local/bin/stockfish', '/usr/bin/stockfish',
    './stockfish', 'stockfish',
  ].filter(Boolean)) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Stockfish not found');
}
const SF_PATH = findStockfish();
console.log(`[Engine] Stockfish: ${SF_PATH}`);

// ── Local LRU cache ────────────────────────────────────────────────────────────
const _lru = new Map();
function lruGet(k) {
  if (!_lru.has(k)) return null;
  const v = _lru.get(k); _lru.delete(k); _lru.set(k, v); return v;
}
function lruSet(k, v) {
  if (_lru.size >= LOCAL_CACHE) _lru.delete(_lru.keys().next().value);
  _lru.set(k, v);
}
function cacheKey(fen, depth) {
  // Strip half-move and full-move counters — same position = same eval
  return fen.split(' ').slice(0, 4).join(' ') + `@d${depth}`;
}

// ── Supabase eval_cache (BATCH read, fire-and-forget write) ───────────────────
// KEY OPTIMISATION: fetch ALL needed FENs in one query instead of N queries
async function supabaseBatchGet(fenKeys) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !fenKeys.length) return {};
  try {
    const inClause = fenKeys.map(k => `"${k.replace(/"/g, '\\"')}"`).join(',');
    const url = `${SUPABASE_URL}/rest/v1/eval_cache?fen_key=in.(${encodeURIComponent(inClause)})&select=fen_key,cp,mate,depth`;
    const data = await httpsGet(url, {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    });
    const map = {};
    if (Array.isArray(data)) {
      for (const row of data) map[row.fen_key] = row;
    }
    return map;
  } catch { return {}; }
}

function supabaseSet(fenKey, cp, mate, depth) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  httpsPost(`${SUPABASE_URL}/rest/v1/eval_cache`, {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'resolution=merge-duplicates',
  }, { fen_key: fenKey, cp, mate, depth, updated_at: new Date().toISOString() }).catch(() => {});
}

// Batch write to Supabase — one request for all new evals
function supabaseBatchSet(rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !rows.length) return;
  httpsPost(`${SUPABASE_URL}/rest/v1/eval_cache`, {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'resolution=merge-duplicates',
  }, rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))).catch(() => {});
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
    const u    = new URL(url);
    const req  = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

// ── Stockfish engine ───────────────────────────────────────────────────────────
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
    this._send(`setoption name Hash value ${HASH_MB}`);     // 128MB — warm hash
    this._send(`setoption name Threads value ${THREADS_PER_ENG}`);
    this._send('setoption name UCI_AnalyseMode value true'); // better analysis evals
    this._send('isready');
  }

  _send(cmd) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  _onLine(line) {
    if (line === 'readyok' && !this.ready) {
      this.ready = true;
      console.log(`[Engine ${this.id}] ready`);
      // Warmup: evaluate start position at shallow depth to load hash tables
      this._send('position startpos');
      this._send('go depth 10');
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
      this.current  = null;
      this.busy     = false;
      resolve({ cp, mate });
      pool.drain();
    }
  }

  eval(fen, depth) {
    return new Promise((resolve, reject) => {
      // KEY OPTIMISATION: realistic timeout instead of depth*1200+4000
      // depth 18 typical: 0.5–2s. Give it 3× max + fixed buffer.
      const timeout = depth * 500 + 3000;
      const timer   = setTimeout(() => {
        this._send('stop');
        this.current = null; this.busy = false;
        reject(new Error(`Timeout (${timeout}ms)`));
        pool.drain();
      }, timeout);

      this.busy    = true;
      this.current = { fen, bestCp: null, bestMate: null,
        resolve: r => { clearTimeout(timer); resolve(r); } };

      // KEY OPTIMISATION: no ucinewgame — keeps hash table warm across positions
      // ucinewgame was flushing the 128MB hash on every single eval.
      // Only send it when switching to a completely unrelated position sequence
      // (we don't track that here — omitting it is safe and much faster).
      this._send(`position fen ${fen}`);
      // KEY OPTIMISATION: movetime cap prevents runaway tactical positions
      this._send(`go depth ${depth} movetime ${MOVETIME_CAP}`);
    });
  }
}

// ── Engine pool ────────────────────────────────────────────────────────────────
const pool = {
  engines: Array.from({ length: NUM_ENGINES }, (_, i) => new Engine(i)),
  pending: [],
  inflight: new Map(), // key → resolvers[] — dedup same FEN

  get queueDepth() { return this.pending.length + this.inflight.size; },

  eval(fen, depth) {
    const key = cacheKey(fen, depth);
    if (this.inflight.has(key)) {
      return new Promise((resolve, reject) => {
        this.inflight.get(key).push({ resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      const resolvers = [{ resolve, reject }];
      this.inflight.set(key, resolvers);
      this.pending.push({ fen, depth, key, resolvers });
      this.drain();
    });
  },

  drain() {
    while (this.pending.length) {
      const eng = this.engines.find(e => e.ready && !e.busy);
      if (!eng) break;
      const job = this.pending.shift();
      eng.eval(job.fen, job.depth).then(result => {
        this.inflight.delete(job.key);
        job.resolvers.forEach(r => r.resolve(result));
      }).catch(err => {
        this.inflight.delete(job.key);
        job.resolvers.forEach(r => r.reject(err));
      });
    }
  },
};

// ── Rate limiter ── REMOVED (Hobby plan, single-user deployment) ──────────────
function checkRate(_ip) { return true; } // always allow

// ── JWT auth ───────────────────────────────────────────────────────────────────
async function verifyJWT(token) {
  if (!REQUIRE_AUTH || !token) return !REQUIRE_AUTH;
  try {
    const res = await httpsGet(
      `${SUPABASE_URL}/auth/v1/user`,
      { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_KEY }
    );
    return !!res?.id;
  } catch { return false; }
}

// ── Keepalive — ping every 30s to prevent Railway Hobby sleep ─────────────────
const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
if (DOMAIN) {
  setInterval(() => {
    https.get(`https://${DOMAIN}/health`).on('error', () => {});
  }, 30 * 1000); // 30s — Hobby plan sleeps faster than Starter
  console.log(`[Server] Keepalive → https://${DOMAIN}/health every 30s`);
}

// ── Gzip helper ────────────────────────────────────────────────────────────────
function gzipJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  zlib.gzip(json, (err, buf) => {
    if (err) {
      res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
      res.end(json);
      return;
    }
    res.writeHead(status, {
      ...CORS,
      'Content-Type':     'application/json',
      'Content-Encoding': 'gzip',
    });
    res.end(buf);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// ── HTTP server ────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    json(res, {
      ok: true, version: '3.1-hobby',
      engines: NUM_ENGINES,
      ready:   pool.engines.filter(e => e.ready).length,
      busy:    pool.engines.filter(e => e.busy).length,
      queue:   pool.queueDepth,
      cache:   _lru.size,
      depth:   DEFAULT_DEPTH,
      hash:    HASH_MB,
      threads: THREADS_PER_ENG,
      rateLimit: 'off',
    });
    return;
  }

  // Warmup endpoint — call once after deploy to pre-evaluate common positions
  if (req.method === 'POST' && req.url === '/warmup') {
    const WARMUP_FENS = [
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', // 1.e4
      'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1', // 1.d4
      'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2', // Sicilian
    ];
    // Evaluate warmup positions asynchronously — don't block response
    Promise.all(WARMUP_FENS.map(f => pool.eval(f, Math.min(DEFAULT_DEPTH, 14)))).catch(() => {});
    json(res, { ok: true, warming: WARMUP_FENS.length });
    return;
  }

  // Main eval endpoint
  if (req.method === 'POST' && req.url === '/eval') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!checkRate(ip)) {
      return json(res, { error: 'Rate limit exceeded' }, 429);
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
        if (fens.length > 50) {
          return json(res, { error: 'Max 50 FENs per request' }, 400);
        }

        const depth = Math.max(10, Math.min(20, reqDepth || DEFAULT_DEPTH));

        if (pool.queueDepth + fens.length > MAX_QUEUE) {
          return json(res, { error: 'Server overloaded', overloaded: true }, 503);
        }

        // ── KEY OPTIMISATION: batch Supabase lookup before any eval ──────────
        // Build all cache keys upfront
        const keys    = fens.map(f => cacheKey(f, depth));
        const results = new Array(fens.length).fill(null);
        const toEval  = []; // indices not found in any cache

        // 1. Local LRU (instant, no I/O)
        for (let i = 0; i < fens.length; i++) {
          const hit = lruGet(keys[i]);
          if (hit) results[i] = { ...hit, cached: 'local' };
          else     toEval.push(i);
        }

        // 2. Supabase batch read for all cache misses — ONE HTTP call
        if (toEval.length && SUPABASE_URL) {
          const missKeys  = toEval.map(i => keys[i]);
          const dbMap     = await supabaseBatchGet(missKeys);
          const stillMiss = [];
          for (const i of toEval) {
            const row = dbMap[keys[i]];
            if (row && row.depth >= depth) {
              results[i] = { cp: row.cp, mate: row.mate, depth: row.depth, cached: 'db' };
              lruSet(keys[i], { cp: row.cp, mate: row.mate, depth: row.depth });
            } else {
              stillMiss.push(i);
            }
          }

          // 3. Evaluate remaining positions in parallel across engine pool
          const newRows = [];
          await Promise.all(stillMiss.map(async i => {
            try {
              const { cp, mate } = await pool.eval(fens[i], depth);
              results[i] = { cp, mate, depth, cached: false };
              lruSet(keys[i], { cp, mate, depth });
              newRows.push({ fen_key: keys[i], cp, mate, depth });
            } catch (e) {
              results[i] = { cp: null, mate: null, depth: 0, cached: false, error: e.message };
            }
          }));

          // Batch write all new evals to Supabase — one call instead of N
          supabaseBatchSet(newRows);

        } else if (toEval.length) {
          // No Supabase — evaluate directly
          await Promise.all(toEval.map(async i => {
            try {
              const { cp, mate } = await pool.eval(fens[i], depth);
              results[i] = { cp, mate, depth, cached: false };
              lruSet(keys[i], { cp, mate, depth });
            } catch (e) {
              results[i] = { cp: null, mate: null, depth: 0, cached: false, error: e.message };
            }
          }));
        }

        // Use gzip for large responses (>20 positions)
        if (fens.length > 20 && req.headers['accept-encoding']?.includes('gzip')) {
          gzipJson(res, { results });
        } else {
          json(res, { results });
        }

      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  json(res, { error: 'Not found' }, 404);

}).listen(PORT, () => {
  console.log(`[Server] v3.1 (replica) listening on :${PORT}`);
  console.log(`[Server] ${NUM_ENGINES} engines × ${THREADS_PER_ENG} threads · depth ${DEFAULT_DEPTH} · hash ${HASH_MB}MB`);
  console.log(`[Server] queue limit ${MAX_QUEUE} · movetime cap ${MOVETIME_CAP}ms · rate limit OFF`);
  console.log(`[Server] Supabase cache: ${SUPABASE_URL ? 'enabled (batch mode)' : 'disabled'}`);
});
