FROM node:20-slim

# Install Stockfish binary
RUN apt-get update && apt-get install -y stockfish && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
COPY server.js .

ENV PORT=3000
ENV DEPTH=18
ENV STOCKFISH_PATH=/usr/games/stockfish

EXPOSE 3000
CMD ["node", "server.js"]
