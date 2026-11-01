// ZOMBIE RUN — realtime GPS zombie tag server
// Run: npm install && npm start   (env: PORT, CATCH_RADIUS, GAME_SECONDS, HIDE_SECONDS, MIN_PLAYERS)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CFG = {
  maxPlayers: 7,
  minPlayers: +process.env.MIN_PLAYERS || 2,
  gameSeconds: +process.env.GAME_SECONDS || 600, // total round length (10 min)
  hideSeconds: +process.env.HIDE_SECONDS || 30, // head start before zombie can infect
  catchRadius: +process.env.CATCH_RADIUS || 6, // metres. Phone GPS is ~3-10 m accurate, so 2-3 ft is not reliable
  staleMs: 20000, // ignore positions older than this
};

// ---------- static file server ----------
// Find the folder that holds index.html. Normally ./public, but be forgiving if the files were
// uploaded flat or inside an extra folder (a common mistake when uploading to GitHub by hand).
const CANDIDATES = [
  path.join(__dirname, 'public'),
  __dirname,
  path.join(__dirname, 'zombie-game', 'public'),
  path.join(__dirname, 'zombie-game'),
];
const PUBLIC = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'index.html'))) || CANDIDATES[0];
console.log('Serving web files from:', PUBLIC, fs.existsSync(path.join(PUBLIC, 'index.html')) ? '(index.html found)' : '(index.html MISSING)');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC) || !MIME[path.extname(file)] || path.basename(file) === 'server.js') { res.writeHead(404); return res.end('Not found'); } // only serve known web file types (never server.js etc.)
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (p === '/index.html') {
        let seen = [];
        try { seen = fs.readdirSync(__dirname).filter((n) => n !== 'node_modules'); } catch {}
        return res.end(`ZOMBIE RUN server is running, but index.html was not found.\nLooked in: ${PUBLIC}\nFiles next to server.js: ${seen.join(', ')}\nFix: make sure the "public" folder (with index.html inside) was uploaded to the repository next to server.js.`);
      }
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Permissions-Policy': 'geolocation=(self)',
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

// ---------- game state ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let s;
  do {
    s = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(s));
  return s;
}
const newId = () => crypto.randomBytes(6).toString('hex');
const cleanName = (n) => String(n || 'Survivor').replace(/[<>]/g, '').trim().slice(0, 14) || 'Survivor';

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
const err = (ws, msg) => send(ws, { t: 'error', msg });

function newRoom() {
  const room = {
    code: genCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby', // lobby | hide | hunt | over
    hideEndsAt: 0,
    endsAt: 0,
    winner: null,
  };
  rooms.set(room.code, room);
  return room;
}

function joinRoom(ws, room, name, playerId) {
  let p = playerId && room.players.get(playerId);
  if (p) {
    // reconnect
    p.ws = ws; p.connected = true;
    if (name) p.name = name;
  } else {
    if (room.phase !== 'lobby') return err(ws, 'That game has already started.');
    if (room.players.size >= CFG.maxPlayers) return err(ws, `Room is full (${CFG.maxPlayers} players max).`);
    p = { id: newId(), name, ws, role: null, lat: null, lng: null, acc: null, lastSeen: 0, connected: true };
    room.players.set(p.id, p);
    if (!room.hostId) room.hostId = p.id;
  }
  ws.ctx = { room, id: p.id };
  send(ws, { t: 'joined', id: p.id, code: room.code });
  broadcast(room);
}

function removePlayer(room, id) {
  room.players.delete(id);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === id) {
    const next = [...room.players.values()].find((q) => q.connected) || [...room.players.values()][0];
    room.hostId = next.id;
  }
  broadcast(room);
}

function onClose(ws) {
  const c = ws.ctx;
  if (!c || !c.room) return;
  const p = c.room.players.get(c.id);
  if (!p || p.ws !== ws) return; // replaced by a newer connection
  p.connected = false;
  if (c.room.phase === 'lobby') removePlayer(c.room, p.id);
  else broadcast(c.room);
}

function handle(ws, m) {
  const c = ws.ctx || {};
  if (m.t === 'create') {
    if (c.room) return;
    return joinRoom(ws, newRoom(), cleanName(m.name), null);
  }
  if (m.t === 'join') {
    if (c.room && rooms.has(c.room.code) && c.room.players.has(c.id)) return;
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return err(ws, 'Room not found. Check the code.');
    return joinRoom(ws, room, cleanName(m.name), m.playerId);
  }
  const room = c.room;
  if (!room) return;
  const p = room.players.get(c.id);
  if (!p) return;

  if (m.t === 'loc') {
    const lat = +m.lat, lng = +m.lng;
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    p.lat = lat; p.lng = lng; p.acc = isFinite(+m.acc) ? +m.acc : null; p.lastSeen = Date.now();
    return;
  }
  if (m.t === 'start') {
    if (room.hostId !== p.id || room.phase !== 'lobby') return;
    if (room.players.size < CFG.minPlayers) return err(ws, `Need at least ${CFG.minPlayers} players to start.`);
    const all = [...room.players.values()];
    for (const q of all) q.role = 'human';
    all[crypto.randomInt(all.length)].role = 'zombie'; // secret zombie
    const now = Date.now();
    room.phase = 'hide';
    room.hideEndsAt = now + CFG.hideSeconds * 1000;
    room.endsAt = now + CFG.gameSeconds * 1000;
    room.winner = null;
    return broadcast(room);
  }
  if (m.t === 'again') {
    if (room.hostId !== p.id || room.phase !== 'over') return;
    room.phase = 'lobby'; room.winner = null;
    for (const [id, q] of room.players) { q.role = null; if (!q.connected) room.players.delete(id); }
    return broadcast(room);
  }
  if (m.t === 'leave') {
    ws.ctx = {};
    return removePlayer(room, p.id);
  }
}

// ---------- game loop ----------
const fresh = (p, now) => p.lat != null && now - p.lastSeen < CFG.staleMs;

function infect(room, victim, by) {
  victim.role = 'zombie';
  const ev = { t: 'event', kind: 'infect', victim: victim.id, victimName: victim.name, by: by.id, byName: by.name };
  for (const q of room.players.values()) send(q.ws, ev);
}

function endGame(room, winner, now) {
  room.phase = 'over';
  room.winner = winner;
  room.endsAt = Math.min(room.endsAt, now);
}

function tick(room) {
  const now = Date.now();
  if (room.phase === 'hide' && now >= room.hideEndsAt) room.phase = 'hunt';
  if (room.phase === 'hunt') {
    const all = [...room.players.values()];
    const zombies = all.filter((p) => p.role === 'zombie' && fresh(p, now));
    for (const h of all) {
      if (h.role !== 'human' || !fresh(h, now)) continue;
      for (const z of zombies) {
        if (z.role === 'zombie' && haversine(h, z) <= CFG.catchRadius) {
          infect(room, h, z);
          zombies.push(h); // newly turned zombies can infect too
          break;
        }
      }
    }
    if (!all.some((p) => p.role === 'human')) endGame(room, 'zombies', now);
  }
  if ((room.phase === 'hide' || room.phase === 'hunt') && now >= room.endsAt) {
    const humansLeft = [...room.players.values()].some((p) => p.role === 'human');
    endGame(room, humansLeft ? 'humans' : 'zombies', now);
  }
  if (room.phase !== 'lobby') broadcast(room);
}
setInterval(() => { for (const room of rooms.values()) tick(room); }, 1000);

// ---------- broadcasting (per-player views keep the zombie secret) ----------
function viewFor(room, me) {
  const reveal = room.phase === 'hunt' || room.phase === 'over';
  return {
    t: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    hideEndsAt: room.hideEndsAt,
    endsAt: room.endsAt,
    hostId: room.hostId,
    winner: room.winner,
    me: me.id,
    cfg: { radius: CFG.catchRadius, max: CFG.maxPlayers, min: CFG.minPlayers },
    players: [...room.players.values()].map((q) => ({
      id: q.id,
      name: q.name,
      connected: q.connected,
      lat: q.lat,
      lng: q.lng,
      acc: q.acc,
      role: room.phase === 'lobby' ? null : reveal || q.id === me.id ? q.role : 'unknown',
    })),
  };
}
function broadcast(room) {
  for (const p of room.players.values()) send(p.ws, viewFor(room, p));
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.ctx = {};
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && typeof m === 'object') handle(ws, m);
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`ZOMBIE RUN listening on http://localhost:${PORT}`));
