/**
 * Chessme Engine Server
 * Runs real Stockfish binary, exposes HTTP API for batch FEN evaluation
 * Deploy on any free VM: Oracle Cloud, Render, Fly.io, Railway
 *
 * Endpoints:
 *   POST /eval  { fens: string[], depth: number }
 *            → { results: [{cp, mate, depth, cached}] }
 *   GET  /health → { ok: true, engine: 'stockfish' }
 */

const http       = require('http');
const { spawn }  = require('child_process');
const { execSync } = require('child_process');

const PORT       = process.env.PORT || 3000;
const DEPTH      = parseInt(process.env.DEPTH) || 18;
const CACHE_SIZE = 200_000; // in-memory LRU cache

// ── Find Stockfish binary ─────────────────────────────────────────────────────
function findStockfish() {
  const candidates = [
    process.env.STOCKFISH_PATH,
    '/usr/games/stockfish',
    '/usr/local/bin/stockfish',
    '/usr/bin/stockfish',
    './stockfish',
    'stockfish',
  ].filter(Boolean);

  for (const p of candidates) {
    try { execSync(`${p} quit`, { timeout: 2000, stdio: 'pipe' }); return p; }
    catch {}
  }
  throw new Error('Stockfish binary not found. Install with: apt-get install stockfish');
}

const SF_PATH = findStockfish();
console.log(`[Engine] Using Stockfish: ${SF_PATH}`);

// ── Eval cache (LRU) ──────────────────────────────────────────────────────────
const _cache = new Map(); // fen_key → {cp, mate, depth}

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  const v = _cache.get(key);
  // LRU: re-insert to mark as recently used
  _cache.delete(key); _cache.set(key, v);
  return v;
}

function cacheSet(key, val) {
  if (_cache.size >= CACHE_SIZE) {
    // Evict oldest (first inserted)
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, val);
}

// ── Stockfish UCI wrapper ─────────────────────────────────────────────────────
class StockfishEngine {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.queue = [];
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
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        this._onLine(line);
      }
    });

    this.proc.on('exit', (code) => {
      console.warn(`[Engine] Stockfish exited (${code}), restarting...`);
      setTimeout(() => this._start(), 1000);
    });

    this._send('uci');
    this._send('setoption name Hash value 128');
    this._send('setoption name Threads value 1');
    this._send('isready');
  }

  _send(cmd) {
    if (this.proc?.stdin.writable) {
      this.proc.stdin.write(cmd + '\n');
    }
  }

  _onLine(line) {
    if (line === 'readyok' && !this.ready) {
      this.ready = true;
      console.log('[Engine] Stockfish ready');
      this._next();
      return;
    }

    if (!this.current) return;
    const { resolve, bestCp, bestMate } = this.current;

    if (line.startsWith('info')) {
      const cpM   = line.match(/score cp (-?\d+)/);
      const mateM = line.match(/score mate (-?\d+)/);
      if (cpM)   this.current.bestCp   = parseInt(cpM[1]);
      if (mateM) this.current.bestMate = parseInt(mateM[1]);
    }

    if (line.startsWith('bestmove')) {
      const cp   = this.current.bestCp;
      const mate = this.current.bestMate;
      const fen  = this.current.fen;

      // Stockfish returns eval from side-to-move's perspective → normalise to White POV
      const isBlack = fen.includes(' b ');
      const cpWhite = isBlack ? -(cp ?? 0) : (cp ?? 0);
      const mateOut = mate !== null
        ? (isBlack ? -mate : mate)
        : null;

      resolve({ cp: cpWhite, mate: mateOut });
      this.current = null;
      this._next();
    }
  }

  _next() {
    if (!this.ready || this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = { ...job, bestCp: null, bestMate: null };
    this._send(`position fen ${job.fen}`);
    this._send(`go depth ${job.depth}`);
  }

  evalFen(fen, depth) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.current?.fen === fen) {
          this._send('stop');
        }
        reject(new Error('Timeout'));
      }, 10_000);

      this.queue.push({
        fen, depth,
        resolve: (result) => { clearTimeout(timeout); resolve(result); }
      });
      this._next();
    });
  }
}

const engine = new StockfishEngine();

// ── HTTP Server ───────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    jsonRes(res, { ok: true, engine: 'stockfish', depth: DEPTH, cacheSize: _cache.size });
    return;
  }

  // Eval endpoint
  if (req.method === 'POST' && req.url === '/eval') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { fens, depth: reqDepth } = JSON.parse(body);
        if (!Array.isArray(fens) || !fens.length) {
          return jsonRes(res, { error: 'fens array required' }, 400);
        }

        const depth = Math.max(10, Math.min(22, reqDepth || DEPTH));
        const results = [];

        // Process sequentially (Stockfish is single-threaded per position)
        for (const fen of fens) {
          const key = fen.split(' ').slice(0, 4).join(' ') + `@d${depth}`;
          const hit = cacheGet(key);
          if (hit) {
            results.push({ ...hit, cached: true });
            continue;
          }

          try {
            const { cp, mate } = await engine.evalFen(fen, depth);
            const result = { cp, mate, depth, cached: false };
            cacheSet(key, { cp, mate, depth });
            results.push(result);
          } catch (e) {
            // Timeout or error — return null so extension falls back to local
            results.push({ cp: null, mate: null, depth: 0, cached: false, error: e.message });
          }
        }

        jsonRes(res, { results });
      } catch (e) {
        jsonRes(res, { error: e.message }, 500);
      }
    });
    return;
  }

  jsonRes(res, { error: 'Not found' }, 404);
}).listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Default depth: ${DEPTH}`);
  console.log(`[Server] Cache size: ${CACHE_SIZE} positions`);
});
