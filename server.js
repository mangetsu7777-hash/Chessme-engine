//**
 * Chessme Engine Server v3 — Production-ready
 *
 * Optimisations over v2:
 *   - No ucinewgame between positions — hash table persists across batch evals
 *   - Batch Supabase lookup (single query for all FENs in a request)
 *   - Faster timeout: depth*500+3000ms (Stockfish self-limits via movetime cap)
 *   - movetime cap on every `go` command (hard ceiling per position)
 *   - POST /warmup endpoint — pre-loads hash tables before real traffic
 *   - gzip compression for /eval responses when client supports it
 *   - /health includes version and hash fields
 *   - LOCAL_CACHE_SIZE increased to 200,000
 *
 * Environment variables:
 *   PORT, DEPTH (default 18), HASH (default 128MB), THREADS_PER_ENGINE (default 1)
 *   MOVETIME_CAP_MS (default 4000)   — hard per-position time cap passed to Stockfish
 *   SUPABASE_URL, SUPABASE_ANON_KEY  — for eval_cache read/write
 *   REQUIRE_AUTH (true/false)        — reject unauthenticated requests
 *   RAILWAY_PUBLIC_DOMAIN            — set by Railway, used for keepalive
 *   MAX_QUEUE (default 40)           — reject if queue exceeds this
 *   RATE_LIMIT_PER_MIN (default 60)  — positions per IP per minute
 */

'use strict';

const http       = require('http');
const https      = require('https');
const zlib       = require('zlib');
const { spawn }  = require('child_process');
const fs         = require('fs');

const PORT              = process.env.PORT                        || 3000;
const DEFAULT_DEPTH     = parseInt(process.env.DEPTH)             || 18;
const HASH_MB           = parseInt(process.env.HASH)              || 128;
const THREADS_PER_ENG   = parseInt(process.env.THREADS_PER_ENGINE)|| 1;
const MAX_QUEUE         = parseInt(process.env.MAX_QUEUE)         || 40;
const RATE_PER_MIN      = parseInt(process.env.RATE_LIMIT_PER_MIN)|| 60;
const MOVETIME_CAP_MS   = parseInt(process.env.MOVETIME_CAP_MS)   || 4000;
const REQUIRE_AUTH      = process.env.REQUIRE_AUTH === 'true';
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const NUM_ENGINES       = 2;
const LOCAL_CACHE_SIZE  = 200_000;

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

// Batch Supabase lookup — fetches all fenKeys in a single request.
// Returns a Map<fenKey, {cp, mate, depth}> for keys that had cache hits.
async function supabaseBatchGet(fenKeys) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !fenKeys.length) return new Map();
  try {
    const inList = fenKeys.map(k => encodeURIComponent(k)).join(',');
    const url = `${SUPABASE_URL}/rest/v1/eval_cache?fen_key=in.(${inList})&select=fen_key,cp,mate,depth`;
    const data = await httpsGet(url, {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    });
    const map = new Map();
    if (Array.isArray(data)) {
      for (const row of data) map.set(row.fen_key, { cp: row.cp, mate: row.mate, depth: row.depth });
    }
    return map;
  } catch { return new Map(); }
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
      // Timeout is generous but Stockfish self-limits via movetime cap.
      const timer = setTimeout(() => {
        this._send('stop');
        this.current = null; this.busy = false;
        reject(new Error('Engine timeout'));
        pool.drain();
      }, depth * 500 + 3000);

      this.busy    = true;
      this.current = { fen, bestCp: null, bestMate: null,
        resolve: r => { clearTimeout(timer); resolve(r); } };
      // No ucinewgame — preserves hash table across positions in a batch.
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth} movetime ${MOVETIME_CAP_MS}`);
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
      ok: true,
      version: 3,
      engines: NUM_ENGINES,
      ready: pool.engines.filter(e => e.ready).length,
      busy:  pool.engines.filter(e => e.busy).length,
      queue: pool.queueDepth,
      cache: _lru.size,
      depth: DEFAULT_DEPTH,
      hash:  HASH_MB,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/warmup') {
    // Fire-and-forget: run dummy positions on every engine to pre-load hash tables.
    const WARMUP_FENS = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
      'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2',
    ];
    const WARMUP_DEPTH = 8;
    for (const eng of pool.engines) {
      (async () => {
        for (const fen of WARMUP_FENS) {
          try { await eng.eval(fen, WARMUP_DEPTH); } catch {}
        }
        console.log(`[Engine ${eng.id}] warmup complete`);
      })();
    }
    json(res, { ok: true, warming: WARMUP_FENS.length });
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

        // Separate FENs into local-cache hits and misses.
        const keys        = fens.map(fen => cacheKey(fen, depth));
        const localHits   = keys.map(k => lruGet(k));
        const missIndices = keys.reduce((acc, _, i) => { if (!localHits[i]) acc.push(i); return acc; }, []);

        // Single batch Supabase lookup for all local-cache misses.
        const missKeys = missIndices.map(i => keys[i]);
        const dbMap    = await supabaseBatchGet(missKeys);

        // Evaluate positions not found in either cache.
        const results = await Promise.all(fens.map(async (fen, i) => {
          if (localHits[i]) return { ...localHits[i], cached: 'local' };

          const key   = keys[i];
          const dbHit = dbMap.get(key);
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

        // Gzip compress if client supports it and payload is worth compressing.
        const payload = JSON.stringify({ results });
        const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
        if (acceptsGzip) {
          zlib.gzip(payload, (err, compressed) => {
            if (err) {
              res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
              res.end(payload);
            } else {
              res.writeHead(200, {
                ...CORS,
                'Content-Type': 'application/json',
                'Content-Encoding': 'gzip',
                'Vary': 'Accept-Encoding',
              });
              res.end(compressed);
            }
          });
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
  console.log(`[Server] v3 listening on :${PORT}`);
  console.log(`[Server] ${NUM_ENGINES} engines · depth ${DEFAULT_DEPTH} · hash ${HASH_MB}MB · queue limit ${MAX_QUEUE}`);
  console.log(`[Server] Supabase cache: ${SUPABASE_URL ? 'enabled' : 'disabled'}`);
  console.log(`[Server] Auth required: ${REQUIRE_AUTH}`);
});
