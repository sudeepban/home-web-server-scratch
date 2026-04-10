const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// --- HTTP server (serves static files from /public) ---

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- Game state ---

let nextId = 1;
const players = {}; // id -> { id, x, y, color, name }

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  });
}

// --- WebSocket server (shares the same HTTP server/port) ---

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

wss.on('connection', (ws) => {
  const id = nextId++;
  players[id] = {
    id,
    x: 400 + Math.random() * 200 - 100,
    y: 300 + Math.random() * 200 - 100,
    color: randomColor(),
    name: `Player ${id}`,
  };

  // Send this client their own ID + full player list
  ws.send(JSON.stringify({ type: 'init', id, players }));

  // Tell everyone else a new player joined
  broadcast({ type: 'playerJoined', player: players[id] });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'move') {
      const p = players[id];
      if (!p) return;
      p.x = Math.max(0, Math.min(800, msg.x));
      p.y = Math.max(0, Math.min(600, msg.y));
      broadcast({ type: 'playerMoved', id, x: p.x, y: p.y });
    }
  });

  ws.on('close', () => {
    delete players[id];
    broadcast({ type: 'playerLeft', id });
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        localIp = addr.address;
        break;
      }
    }
  }
  console.log(`Server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIp}:${PORT}`);
});
