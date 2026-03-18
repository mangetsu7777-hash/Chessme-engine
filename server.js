/**
 * Chessme Engine Server v2
 * Native Stockfish via UCI — optimised for Railway free tier (512MB RAM, shared CPU)
 */

const http      = require('http');
const https     = require('https');
const { spawn } = require('child_process');
const fs        = require('fs');

const PORT       = process.env.PORT || 3000;
const DEPTH      = parseInt(process.env.DEPTH) || 18;
const THREADS    = 1;          // 1 thread — safer on shared CPU
const HASH_MB    = 32;         // 32MB hash — well within 512MB container limit
const CACHE_SIZE = 100_000;
const KEEPALIVE_MS = 4 * 60 * 1000; // ping every 4min to prevent sleep

// ── Find Stockfish ────────────────────────────────────────────────────────────
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
    try { fs.accessSync(p, fs.constants.X_OK); console.log(`[Engine] Stockfish: ${p}`); return p; }
    catch {}
  }
  throw new Error('Stockfish not found');
}

const SF_PATH = findStockfish();

// ── LRU cache ─────────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(k) {
  if (!_cache.has(k)) return null;
  const v = _cache.get(k); _cache.delete(k); _cache.set(k, v); return v;
}
function cacheSet(k, v) {
  if (_cache.size >= CACHE_SIZE) _cache.delete(_cache.keys().next().value);
  _cache.set(k, v);
}

// ── Stockfish engine ──────────────────────────────────────────────────────────
class Engine {
  constructor() {
    this.proc    = null;
    this.ready   = false;
    this.queue   = [];
    this.current = null;
    this._restartPending = false;
    this._start();
  }

  _start() {
    this._restartPending = false;
    this.ready   = false;
    this.current = null;

    this.proc = spawn(SF_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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

    this.proc.stderr.on('data', () => {}); // suppress stderr noise

    this.proc.on('exit', (code, signal) => {
      console.warn(`[Engine] Stockfish exited (code=${code} signal=${signal}), restarting in 2s…`);
      this.ready = false;

      // Reject any in-flight job immediately so HTTP response is sent
      if (this.current) {
        this.current.reject(new Error('Engine restarted'));
        this.current = null;
      }
      // Reject all queued jobs too
      while (this.queue.length) {
        this.queue.shift().reject(new Error('Engine restarted'));
      }

      if (!this._restartPending) {
        this._restartPending = true;
        setTimeout(() => this._start(), 2000);
      }
    });

    this._send('uci');
    this._send(`setoption name Hash value ${HASH_MB}`);
    this._send(`setoption name Threads value ${THREADS}`);
    this._send('setoption name Move Overhead value 0');
    this._send('isready');
  }

  _send(cmd) {
    try { if (this.proc?.stdin?.writable) this.proc.stdin.write(cmd + '\n'); }
    catch {}
  }

  _onLine(line) {
    if (line === 'readyok' && !this.ready) {
      this.ready = true;
      console.log('[Engine] Ready');
      this._next();
      return;
    }
    if (!this.current) return;

    if (line.startsWith('info')) {
      const cp   = line.match(/score cp (-?\d+)/);
      const mate = line.match(/score mate (-?\d+)/);
      if (cp)   this.current.bestCp   = parseInt(cp[1]);
      if (mate) this.current.bestMate = parseInt(mate[1]);
    }

    if (line.startsWith('bestmove')) {
      const { bestCp, bestMate, fen, resolve } = this.current;
      const isBlack = fen.includes(' b ');
      resolve({
        cp:   bestCp   !== null ? (isBlack ? -bestCp   : bestCp)   : null,
        mate: bestMate !== null ? (isBlack ? -bestMate : bestMate) : null,
      });
      this.current = null;
      this._next();
    }
  }

  _next() {
    if (!this.ready || this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = { ...job, bestCp: null, bestMate: null };
    this._send('ucinewgame');
    this._send(`position fen ${job.fen}`);
    this._send(`go depth ${job.depth}`);
  }

  evalFen(fen, depth) {
    return new Promise((resolve, reject) => {
      // Per-position timeout: depth * 500ms + 3s buffer
      const ms = depth * 500 + 3000;
      const timer = setTimeout(() => {
        if (this.current?.fen === fen) {
          this._send('stop');
          // bestmove will arrive and resolve normally after stop
        }
        // Hard resolve after extra buffer if bestmove never came
        setTimeout(() => {
          reject(new Error(`evalFen timeout after ${ms}ms`));
        }, 2000);
      }, ms);

      this.queue.push({
        fen, depth,
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject:  err    => { clearTimeout(timer); reject(err); },
      });
      this._next();
    });
  }
}

const engine = new Engine();

// ── Keepalive self-ping ───────────────────────────────────────────────────────
function startKeepalive() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) { console.log('[Keepalive] No RAILWAY_PUBLIC_DOMAIN — skipping'); return; }
  const url = `https://${domain}/health`;
  setInterval(() => {
    https.get(url, res => res.resume()).on('error', () => {});
  }, KEEPALIVE_MS);
  console.log(`[Keepalive] Pinging ${url} every ${KEEPALIVE_MS / 60000}min`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(res, data, status = 200) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, { ok: true, engine: 'stockfish', depth: DEPTH, threads: THREADS, cacheSize: _cache.size });
    return;
  }

  if (req.method === 'POST' && req.url === '/eval') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { fens, depth: reqDepth } = JSON.parse(body);
        if (!Array.isArray(fens) || !fens.length) return json(res, { error: 'fens required' }, 400);

        const depth   = Math.max(8, Math.min(20, reqDepth || DEPTH));
        const results = [];

        for (const fen of fens) {
          const key = fen.split(' ').slice(0, 4).join(' ') + `@d${depth}`;
          const hit = cacheGet(key);
          if (hit) { results.push({ ...hit, cached: true }); continue; }
          try {
            const { cp, mate } = await engine.evalFen(fen, depth);
            const r = { cp, mate, depth, cached: false };
            cacheSet(key, { cp, mate, depth });
            results.push(r);
          } catch (e) {
            results.push({ cp: null, mate: null, depth: 0, cached: false, error: e.message });
          }
        }

        json(res, { results });
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  json(res, { error: 'Not found' }, 404);

}).listen(PORT, () => {
  console.log(`[Server] Port ${PORT} | Depth ${DEPTH} | Hash ${HASH_MB}MB | Threads ${THREADS}`);
  startKeepalive();
});

