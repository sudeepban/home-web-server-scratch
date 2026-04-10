const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');

const W = canvas.width;
const H = canvas.height;
const SPEED = 3;
const RADIUS = 18;
const SEND_RATE_MS = 50;  // send at ~20/sec
const BUFFER_DELAY = 200; // render remote players this many ms behind real-time
const BUFFER_SIZE = 30;   // max position history entries per player

let myId = null;
let players = {};

// --- Input ---

const keys = {};
document.addEventListener('keydown', e => { keys[e.key] = true; });
document.addEventListener('keyup',   e => { keys[e.key] = false; });

// Virtual joystick (touch)
const joystick = {
  active: false,
  baseX: 0, baseY: 0,
  stickX: 0, stickY: 0,
  BASE_R: 50, STICK_R: 28, MAX_DIST: 42,
};

function touchPos(touch) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (touch.clientX - rect.left) * (W / rect.width),
    y: (touch.clientY - rect.top)  * (H / rect.height),
  };
}

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const { x, y } = touchPos(e.changedTouches[0]);
  joystick.active = true;
  joystick.baseX  = x; joystick.baseY  = y;
  joystick.stickX = x; joystick.stickY = y;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const { x, y } = touchPos(e.changedTouches[0]);
  const dx = x - joystick.baseX, dy = y - joystick.baseY;
  const dist = Math.hypot(dx, dy);
  if (dist > joystick.MAX_DIST) {
    joystick.stickX = joystick.baseX + (dx / dist) * joystick.MAX_DIST;
    joystick.stickY = joystick.baseY + (dy / dist) * joystick.MAX_DIST;
  } else {
    joystick.stickX = x; joystick.stickY = y;
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  joystick.active = false;
}, { passive: false });

// --- Player helpers ---

function initPlayer(p) {
  p.renderX = p.x;
  p.renderY = p.y;
  const now = performance.now();
  p.buffer = [
    { t: now - BUFFER_DELAY * 2, x: p.x, y: p.y },
    { t: now - BUFFER_DELAY,     x: p.x, y: p.y },
  ];
  return p;
}

function pushBuffer(p, x, y) {
  p.buffer.push({ t: performance.now(), x, y });
  if (p.buffer.length > BUFFER_SIZE) p.buffer.shift();
}

function interpolateAt(p, renderTime) {
  const buf = p.buffer;

  // Find the two entries straddling renderTime
  let prev = null, next = null;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i].t <= renderTime) {
      prev = buf[i];
    } else {
      next = buf[i];
      break;
    }
  }

  if (prev && next) {
    // Normal interpolation between two known positions
    const t = (renderTime - prev.t) / (next.t - prev.t);
    p.renderX = prev.x + (next.x - prev.x) * t;
    p.renderY = prev.y + (next.y - prev.y) * t;
  } else if (prev) {
    // Buffer ran dry — hold at last known position
    p.renderX = prev.x;
    p.renderY = prev.y;
  } else {
    // renderTime is before all buffer entries — hold at oldest known position
    p.renderX = buf[0].x;
    p.renderY = buf[0].y;
  }
}

// --- WebSocket ---

const ws = new WebSocket(`ws://${location.host}`);

ws.addEventListener('open', () => {
  status.textContent = 'Connected — use WASD or arrow keys to move';
});

ws.addEventListener('close', () => {
  status.textContent = 'Disconnected';
});

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);

  switch (msg.type) {
    case 'init':
      myId = msg.id;
      for (const p of Object.values(msg.players)) initPlayer(p);
      players = msg.players;
      break;

    case 'playerJoined':
      players[msg.player.id] = initPlayer(msg.player);
      break;

    case 'playerMoved': {
      const p = players[msg.id];
      if (!p || msg.id === myId) break;
      pushBuffer(p, msg.x, msg.y);
      break;
    }

    case 'playerLeft':
      delete players[msg.id];
      break;
  }
});

// --- Game loop ---

let lastSent = { x: null, y: null, time: 0 };
let wasMoving = false;

function update() {
  const now = performance.now();
  const me = players[myId];
  if (!me) return;

  // Local player: direct input, no interpolation
  let dx = 0, dy = 0;
  if (keys['ArrowLeft']  || keys['a'] || keys['A']) dx -= SPEED;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) dx += SPEED;
  if (keys['ArrowUp']    || keys['w'] || keys['W']) dy -= SPEED;
  if (keys['ArrowDown']  || keys['s'] || keys['S']) dy += SPEED;

  if (joystick.active) {
    const jdx = joystick.stickX - joystick.baseX;
    const jdy = joystick.stickY - joystick.baseY;
    const dist = Math.hypot(jdx, jdy);
    if (dist > 4) { // small deadzone
      dx += (jdx / joystick.MAX_DIST) * SPEED;
      dy += (jdy / joystick.MAX_DIST) * SPEED;
    }
  }

  const isMoving = dx !== 0 || dy !== 0;

  if (isMoving) {
    me.x = Math.max(RADIUS, Math.min(W - RADIUS, me.x + dx));
    me.y = Math.max(RADIUS, Math.min(H - RADIUS, me.y + dy));

    if (ws.readyState === WebSocket.OPEN &&
        now - lastSent.time >= SEND_RATE_MS &&
        (me.x !== lastSent.x || me.y !== lastSent.y)) {
      ws.send(JSON.stringify({ type: 'move', x: me.x, y: me.y }));
      lastSent = { x: me.x, y: me.y, time: now };
    }
  } else if (wasMoving && ws.readyState === WebSocket.OPEN) {
    // Player just stopped — send final position immediately so remotes snap to a halt
    ws.send(JSON.stringify({ type: 'move', x: me.x, y: me.y }));
    lastSent = { x: me.x, y: me.y, time: now };
  }
  wasMoving = isMoving;
  me.renderX = me.x;
  me.renderY = me.y;

  // Remote players: jitter buffer + dead reckoning fallback
  const renderTime = now - BUFFER_DELAY;
  for (const p of Object.values(players)) {
    if (p.id !== myId) interpolateAt(p, renderTime);
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#1e2d50';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Players
  for (const p of Object.values(players)) {
    const isMe = p.id === myId;
    const rx = p.renderX ?? p.x;
    const ry = p.renderY ?? p.y;

    if (isMe) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 15;
    }

    ctx.beginPath();
    ctx.arc(rx, ry, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();

    ctx.shadowBlur = 0;

    if (isMe) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = '#fff';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, rx, ry - RADIUS - 5);
  }

  const count = Object.keys(players).length;
  ctx.fillStyle = '#444';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`Players: ${count}`, 8, 16);

  // Virtual joystick
  if (joystick.active) {
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(joystick.baseX, joystick.baseY, joystick.BASE_R, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(joystick.stickX, joystick.stickY, joystick.STICK_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

loop();
