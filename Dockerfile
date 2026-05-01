FROM node:20-slim

# Install Stockfish binary
RUN apt-get update && apt-get install -y stockfish && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
COPY server.js .

# ── Defaults (all overridable via Railway env vars) ───────────────────────────
ENV PORT=3000
ENV DEPTH=18
ENV HASH=48
ENV THREADS_PER_ENGINE=1
ENV STOCKFISH_PATH=/usr/games/stockfish

# Dynamic engine pool
ENV MIN_ENGINES=1
ENV MAX_ENGINES=4
ENV SCALE_UP_THRESHOLD=4
ENV SCALE_DOWN_IDLE_MS=60000

# Smart keepalive: pause pinging after 15 min of inactivity → Railway can sleep
ENV KEEPALIVE_IDLE_MS=900000

# Queue / rate
ENV MAX_QUEUE=60
ENV RATE_LIMIT_PER_MIN=120

EXPOSE 3000
CMD ["node", "server.js"]
