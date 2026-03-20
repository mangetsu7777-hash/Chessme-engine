'use strict';
const https = require('https');

const URL      = process.env.PING_URL || 'https://chessme-engine-production.up.railway.app/health';
const INTERVAL = parseInt(process.env.PING_INTERVAL_MS) || 4 * 60 * 1000; // 4 min

function ping() {
  const t = Date.now();
  https.get(URL, res => {
    console.log(`[keepalive] ${new Date().toISOString()} → ${res.statusCode} (${Date.now()-t}ms)`);
    res.resume();
  }).on('error', e => {
    console.warn(`[keepalive] ${new Date().toISOString()} ✗ ${e.message}`);
  });
}

console.log(`[keepalive] pinging ${URL} every ${INTERVAL/1000}s`);
ping();
setInterval(ping, INTERVAL);
```

**2. In Railway dashboard:**
- Open your `Chessme-engine` project
- Click **+ New Service** → **GitHub Repo** → select `mangetsu7777-hash/Chessme-engine`
- In service settings → **Start Command**: `node keepalive.js`
- Add one env var: `PING_URL=https://chessme-engine-production.up.railway.app/health`
- Deploy

That's it. The keepalive service costs almost nothing — it's sleeping between pings — and your engine replicas never cold-start again.

**Verify it's working** — check the keepalive service logs, you should see:
```
[keepalive] pinging https://... every 240s
[keepalive] 2026-03-20T... → 200 (45ms)
[keepalive] 2026-03-20T... → 200 (38ms)
