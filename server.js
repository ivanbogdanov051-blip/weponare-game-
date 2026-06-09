'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const XP_FILE = path.join(__dirname, 'xp.json');

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W = 480, CANVAS_H = 270;
const ARENA_X = 8, ARENA_Y = 8;
const ARENA_W = CANVAS_W - 16, ARENA_H = CANVAS_H - 16;
const TICK_MS = 50;

const WEAPONS = [
  { id: 'sword',  name: 'SWORD',  damage: 20, range: 22, atkSpd: 400, type: 'melee',  unlockXp: 0   },
  { id: 'dagger', name: 'DAGGER', damage: 10, range: 16, atkSpd: 180, type: 'melee',  unlockXp: 0   },
  { id: 'axe',    name: 'AXE',    damage: 38, range: 20, atkSpd: 700, type: 'melee',  unlockXp: 50  },
  { id: 'spear',  name: 'SPEAR',  damage: 18, range: 40, atkSpd: 500, type: 'melee',  unlockXp: 100 },
  { id: 'bow',    name: 'BOW',    damage: 15, range: 200, atkSpd: 600, type: 'ranged', unlockXp: 150 },
  { id: 'staff',  name: 'STAFF',  damage: 25, range: 180, atkSpd: 900, type: 'ranged', unlockXp: 250, aoeRadius: 28 },
];

const WAVE_CONFIG = [
  { monsters: 3, hpMult: 1.0, speedMult: 1.0  },
  { monsters: 5, hpMult: 1.1, speedMult: 1.05 },
  { monsters: 7, hpMult: 1.2, speedMult: 1.1  },
  { monsters: 8, hpMult: 1.4, speedMult: 1.15 },
];

// ─── XP Persistence ───────────────────────────────────────────────────────────

function loadXp() {
  try {
    return JSON.parse(fs.readFileSync(XP_FILE, 'utf8')).xp || 0;
  } catch { return 0; }
}

function saveXp(val) {
  try { fs.writeFileSync(XP_FILE, JSON.stringify({ xp: val })); } catch {}
}

function getUnlockedWeaponIds(xp) {
  return WEAPONS.filter(w => w.unlockXp <= xp).map(w => w.id);
}

function checkNewUnlocks(oldXp, newXp) {
  const was = getUnlockedWeaponIds(oldXp);
  return getUnlockedWeaponIds(newXp).filter(id => !was.includes(id));
}

// ─── Room State ───────────────────────────────────────────────────────────────

function makePlayer(num) {
  const xp = loadXp();
  return {
    num,
    x: num === 1 ? 80 : 388,
    y: 135,
    w: 12, h: 16,
    speed: 1.4,
    hp: 100, maxHp: 100,
    lives: 3,
    facing: num === 1 ? 1 : -1,
    weaponIdx: 0,
    unlockedWeapons: getUnlockedWeaponIds(xp),
    atkCooldown: 0,
    swingTimer: 0,
    invincible: 0,
    hitFlash: 0,
    dead: false,
    respawnTimer: 0,
  };
}

const room = {
  p1: null,
  p2: null,
  gameState: 'LOBBY',
  gameMode: 'pvp',
  playerNames: { p1: 'PLAYER 1', p2: 'PLAYER 2' },
  p1Joined: false,
  p2Joined: false,
  players: { p1: null, p2: null },
  inputs: {
    p1: { up: false, down: false, left: false, right: false, attack: false, swap: false },
    p2: { up: false, down: false, left: false, right: false, attack: false, swap: false },
  },
  monsters: [],
  projectiles: [],
  particles: [],
  wave: { num: 0, monstersLeft: 0, spawnQueue: 0, spawnTimer: 0, betweenTimer: 0 },
  waveHpMult: 1,
  waveSpeedMult: 1,
  pendingUnlocks: [],
  xp: 0,
  round: { p1Wins: 0, p2Wins: 0, maxWins: 3 },
  roundOverTimer: 0,
  unlockQueue: [],
  attackJustPressed: { p1: false, p2: false },
  swapJustPressed: { p1: false, p2: false },
  prevInputs: {
    p1: { attack: false, swap: false },
    p2: { attack: false, swap: false },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x
      && a.y < b.y + b.h && a.y + a.h > b.y;
}

function weapon(p) {
  return WEAPONS.find(w => w.id === p.unlockedWeapons[p.weaponIdx]) || WEAPONS[0];
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  if (room.p1 && room.p1.readyState === 1) room.p1.send(str);
  if (room.p2 && room.p2.readyState === 1) room.p2.send(str);
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function spawnMonster() {
  const edge = Math.floor(Math.random() * 4);
  let mx, my;
  if (edge === 0) { mx = ARENA_X + Math.random() * ARENA_W; my = ARENA_Y + 4; }
  else if (edge === 1) { mx = ARENA_X + Math.random() * ARENA_W; my = ARENA_Y + ARENA_H - 16; }
  else if (edge === 2) { mx = ARENA_X + 4; my = ARENA_Y + Math.random() * ARENA_H; }
  else { mx = ARENA_X + ARENA_W - 14; my = ARENA_Y + Math.random() * ARENA_H; }

  const hp = Math.round(30 * room.waveHpMult);
  room.monsters.push({
    id: Math.random().toString(36).slice(2),
    x: mx, y: my, w: 10, h: 12,
    hp, maxHp: hp,
    speed: 0.55 * room.waveSpeedMult,
    atkCooldown: 0,
    atkRange: 12,
    atkDamage: 8,
    hitFlash: 0,
    invincible: 0,
  });
}

function startWave(num) {
  const cfg = WAVE_CONFIG[Math.min(num - 1, WAVE_CONFIG.length - 1)];
  room.wave = { num, monstersLeft: cfg.monsters, spawnQueue: cfg.monsters, spawnTimer: 500, betweenTimer: 0 };
  room.waveHpMult = cfg.hpMult;
  room.waveSpeedMult = cfg.speedMult;
}

function startGame() {
  const xp = loadXp();
  room.xp = xp;
  room.players.p1 = makePlayer(1);
  room.players.p2 = makePlayer(2);
  room.monsters = [];
  room.projectiles = [];
  room.particles = [];
  room.pendingUnlocks = [];
  room.unlockQueue = [];
  room.gameState = 'GAMEPLAY';
  startWave(1);
}

function applyDamage(target, dmg, attackerKey) {
  if (target.invincible > 0) return;
  if (room.gameMode === 'coop' && target.num && (attackerKey === 'p1' || attackerKey === 'p2')) return;
  target.hp -= dmg;
  target.hitFlash = 200;
  target.invincible = target.num ? 500 : 300;
  if (target.hp <= 0) handleKill(target, attackerKey);
}

function handleKill(target, attackerKey) {
  const isPlayer = !!target.num;
  const xpGain = isPlayer ? 25 : 10;
  const oldXp = room.xp;
  room.xp += xpGain;
  saveXp(room.xp);

  const newUnlocks = checkNewUnlocks(oldXp, room.xp);
  room.unlockQueue.push(...newUnlocks);
  const unlocked = getUnlockedWeaponIds(room.xp);
  room.players.p1.unlockedWeapons = unlocked;
  room.players.p2.unlockedWeapons = unlocked;

  room.particles.push({
    type: 'xp', x: target.x + target.w / 2, y: target.y,
    text: '+' + xpGain, timer: 900,
  });

  if (isPlayer) {
    target.dead = true;
    target.lives--;
    target.hp = 0;
    if (target.lives > 0) {
      target.respawnTimer = 2000;
    }
  } else {
    room.monsters = room.monsters.filter(m => m !== target);
    room.wave.monstersLeft--;
  }
}

function respawnPlayer(p) {
  p.hp = p.maxHp;
  p.x = p.num === 1 ? 80 : 388;
  p.y = CANVAS_H / 2;
  p.dead = false;
  p.invincible = 2000;
  p.hitFlash = 0;
}

function checkRoundEnd() {
  const p1 = room.players.p1;
  const p2 = room.players.p2;
  if (room.gameMode === 'coop') {
    if ((p1.dead && p1.lives <= 0) && (p2.dead && p2.lives <= 0)) {
      room.gameState = 'ROUND_OVER';
      room.roundOverTimer = 4000;
    }
  } else {
    if ((p1.dead && p1.lives <= 0) || (p2.dead && p2.lives <= 0)) {
      if (p2.dead && p2.lives <= 0) room.round.p1Wins++;
      if (p1.dead && p1.lives <= 0) room.round.p2Wins++;
      room.gameState = 'ROUND_OVER';
      room.roundOverTimer = 4000;
    }
  }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (room.gameState !== 'GAMEPLAY') {
    if (room.gameState === 'ROUND_OVER') {
      room.roundOverTimer -= TICK_MS;
      if (room.roundOverTimer <= 0) {
        if (room.unlockQueue.length > 0) {
          room.gameState = 'WEAPON_UNLOCK';
        } else {
          startGame();
        }
      }
    }
    if (room.gameState === 'WEAPON_UNLOCK') {
      // Wait for client to ACK unlock, then start new game
    }
    broadcastState();
    return;
  }

  const dt = TICK_MS;
  const factor = dt / 16.67;

  // Detect just-pressed for attack/swap
  for (const key of ['p1', 'p2']) {
    const inp = room.inputs[key];
    const prev = room.prevInputs[key];
    room.attackJustPressed[key] = inp.attack && !prev.attack;
    room.swapJustPressed[key] = inp.swap && !prev.swap;
    room.prevInputs[key] = { attack: inp.attack, swap: inp.swap };
  }

  // ── Move players ──
  for (const key of ['p1', 'p2']) {
    const p = room.players[key];
    if (!p || p.dead) {
      if (p && p.respawnTimer > 0) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) respawnPlayer(p);
      }
      continue;
    }
    const inp = room.inputs[key];
    let vx = 0, vy = 0;
    if (inp.left)  { vx = -p.speed; p.facing = -1; }
    if (inp.right) { vx =  p.speed; p.facing =  1; }
    if (inp.up)    vy = -p.speed;
    if (inp.down)  vy =  p.speed;
    if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }

    p.x = Math.max(ARENA_X + 2, Math.min(ARENA_X + ARENA_W - p.w - 2, p.x + vx * factor));
    p.y = Math.max(ARENA_Y + 2, Math.min(ARENA_Y + ARENA_H - p.h - 2, p.y + vy * factor));

    if (p.atkCooldown > 0)  p.atkCooldown  -= dt;
    if (p.invincible > 0)   p.invincible   -= dt;
    if (p.hitFlash > 0)     p.hitFlash     -= dt;
    if (p.swingTimer > 0)   p.swingTimer   -= dt;

    // Swap weapon
    if (room.swapJustPressed[key]) {
      p.weaponIdx = (p.weaponIdx + 1) % p.unlockedWeapons.length;
    }

    // Attack
    if (room.attackJustPressed[key] && p.atkCooldown <= 0) {
      doAttack(p, key);
    }
  }

  // ── Monsters ──
  for (const m of room.monsters) {
    let nearest = null, bestDist = Infinity;
    for (const p of [room.players.p1, room.players.p2]) {
      if (!p || p.dead) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bestDist) { bestDist = d; nearest = p; }
    }
    if (!nearest) continue;

    const dx = nearest.x - m.x, dy = nearest.y - m.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist > m.atkRange) {
      m.x += (dx / dist) * m.speed * factor;
      m.y += (dy / dist) * m.speed * factor;
      m.x = Math.max(ARENA_X + 1, Math.min(ARENA_X + ARENA_W - m.w - 1, m.x));
      m.y = Math.max(ARENA_Y + 1, Math.min(ARENA_Y + ARENA_H - m.h - 1, m.y));
    }

    if (dist <= m.atkRange + 4 && m.atkCooldown <= 0) {
      applyDamage(nearest, m.atkDamage, 'monster');
      m.atkCooldown = 1200;
    }
    if (m.atkCooldown > 0)  m.atkCooldown -= dt;
    if (m.hitFlash > 0)     m.hitFlash    -= dt;
    if (m.invincible > 0)   m.invincible  -= dt;
  }

  // ── Projectiles ──
  room.projectiles = room.projectiles.filter(proj => {
    const speed = 3.5;
    proj.x += proj.dx * factor;
    proj.y += proj.dy * factor;
    proj.traveled += Math.hypot(proj.dx, proj.dy) * factor;

    // Wall collision
    if (proj.x < ARENA_X || proj.x > ARENA_X + ARENA_W || proj.y < ARENA_Y || proj.y > ARENA_Y + ARENA_H) {
      if (proj.isAoe) detonateAoe(proj);
      return false;
    }
    if (proj.traveled >= proj.maxRange) {
      if (proj.isAoe) detonateAoe(proj);
      return false;
    }

    // Hit detection
    const targets = [
      ...(proj.owner !== 'p1' ? [room.players.p1] : []),
      ...(proj.owner !== 'p2' ? [room.players.p2] : []),
      ...room.monsters,
    ].filter(t => t && !t.dead);

    for (const t of targets) {
      if (aabb({ x: proj.x - 3, y: proj.y - 3, w: 6, h: 6 }, t)) {
        if (proj.isAoe) {
          detonateAoe(proj);
        } else {
          const key = t === room.players.p1 ? 'p1' : t === room.players.p2 ? 'p2' : null;
          applyDamage(t, proj.damage, proj.owner);
        }
        return false;
      }
    }
    return true;
  });

  // ── Wave spawner ──
  if (room.wave.betweenTimer > 0) {
    room.wave.betweenTimer -= dt;
    if (room.wave.betweenTimer <= 0) {
      startWave(room.wave.num + 1);
    }
  } else if (room.wave.spawnQueue > 0) {
    room.wave.spawnTimer -= dt;
    if (room.wave.spawnTimer <= 0) {
      spawnMonster();
      room.wave.spawnQueue--;
      room.wave.spawnTimer = 1200;
    }
  } else if (room.wave.monstersLeft <= 0 && room.monsters.length === 0) {
    room.wave.betweenTimer = 3000;
    room.particles.push({ type: 'waveclear', x: CANVAS_W / 2, y: CANVAS_H / 2 - 10, text: 'WAVE ' + room.wave.num + ' CLEAR!', timer: 2500 });
  }

  // ── Particles ──
  room.particles = room.particles.filter(p => { p.timer -= dt; return p.timer > 0; });

  checkRoundEnd();
  broadcastState();
}, TICK_MS);

// ─── Attack Logic ─────────────────────────────────────────────────────────────

function doAttack(p, pKey) {
  const w = weapon(p);
  p.atkCooldown = w.atkSpd;
  p.swingTimer = Math.min(w.atkSpd, 200);

  if (w.type === 'melee') {
    const hx = p.facing === 1 ? p.x + p.w : p.x - w.range;
    const hitRect = { x: hx, y: p.y - 4, w: w.range, h: p.h + 8 };

    const targets = [
      ...(pKey !== 'p1' ? [room.players.p1] : []),
      ...(pKey !== 'p2' ? [room.players.p2] : []),
      ...room.monsters,
    ].filter(t => t && !t.dead);

    for (const t of targets) {
      if (aabb(hitRect, t)) applyDamage(t, w.damage, pKey);
    }
  } else {
    room.projectiles.push({
      x: p.x + p.w / 2,
      y: p.y + p.h / 2,
      dx: p.facing * 3.5,
      dy: 0,
      damage: w.damage,
      owner: pKey,
      traveled: 0,
      maxRange: w.range,
      weaponId: w.id,
      isAoe: !!w.aoeRadius,
      aoeRadius: w.aoeRadius || 0,
    });
  }
}

function detonateAoe(proj) {
  const targets = [room.players.p1, room.players.p2, ...room.monsters]
    .filter(t => t && !t.dead && (t !== room.players[proj.owner === 'p1' ? 'p1' : 'p2']));

  for (const t of targets) {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    if (Math.hypot(cx - proj.x, cy - proj.y) < proj.aoeRadius) {
      applyDamage(t, proj.damage, proj.owner);
    }
  }
  room.particles.push({ type: 'aoe', x: proj.x, y: proj.y, maxR: proj.aoeRadius, radius: 2, timer: 300, color: '#aa44ff' });
}

// ─── State Broadcast ──────────────────────────────────────────────────────────

function buildStateMsg(playerNum) {
  const p1 = room.players.p1;
  const p2 = room.players.p2;
  return {
    type: 'state',
    myNum: playerNum,
    gameState: room.gameState,
    gameMode: room.gameMode,
    playerNames: room.playerNames,
    players: {
      p1: p1 ? { x: p1.x, y: p1.y, w: p1.w, h: p1.h, hp: p1.hp, maxHp: p1.maxHp,
                  lives: p1.lives, facing: p1.facing, weaponId: weapon(p1).id,
                  hitFlash: p1.hitFlash, dead: p1.dead, swingTimer: p1.swingTimer,
                  unlockedWeapons: p1.unlockedWeapons } : null,
      p2: p2 ? { x: p2.x, y: p2.y, w: p2.w, h: p2.h, hp: p2.hp, maxHp: p2.maxHp,
                  lives: p2.lives, facing: p2.facing, weaponId: weapon(p2).id,
                  hitFlash: p2.hitFlash, dead: p2.dead, swingTimer: p2.swingTimer,
                  unlockedWeapons: p2.unlockedWeapons } : null,
    },
    monsters: room.monsters.map(m => ({ x: m.x, y: m.y, w: m.w, h: m.h, hp: m.hp, maxHp: m.maxHp, hitFlash: m.hitFlash })),
    projectiles: room.projectiles.map(pr => ({ x: pr.x, y: pr.y, dx: pr.dx, dy: pr.dy, weaponId: pr.weaponId, isAoe: pr.isAoe })),
    particles: room.particles,
    wave: room.wave,
    xp: room.xp,
    round: room.round,
    pendingUnlock: room.unlockQueue[0] || null,
  };
}

function broadcastState() {
  if (room.p1 && room.p1.readyState === 1) room.p1.send(JSON.stringify(buildStateMsg(1)));
  if (room.p2 && room.p2.readyState === 1) room.p2.send(JSON.stringify(buildStateMsg(2)));
}

// ─── WebSocket Connections ────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  // Clear stale sockets so dead connections don't block new players
  if (room.p1 && room.p1.readyState !== 1) { room.p1 = null; room.p1Joined = false; room.playerNames.p1 = 'PLAYER 1'; }
  if (room.p2 && room.p2.readyState !== 1) { room.p2 = null; room.p2Joined = false; room.playerNames.p2 = 'PLAYER 2'; }

  if (room.p1 && room.p2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const isP1 = !room.p1;
  if (isP1) room.p1 = ws;
  else room.p2 = ws;

  const myKey = isP1 ? 'p1' : 'p2';
  ws.send(JSON.stringify({ type: 'welcome', num: isP1 ? 1 : 2 }));

  broadcastState();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'join') {
        const rawName = String(msg.name || '').trim().replace(/[<>&"']/g, '').slice(0, 12);
        room.playerNames[myKey] = rawName || (isP1 ? 'PLAYER 1' : 'PLAYER 2');
        if (isP1 && msg.mode) room.gameMode = msg.mode === 'coop' ? 'coop' : 'pvp';
        if (myKey === 'p1') room.p1Joined = true; else room.p2Joined = true;
        if (room.p1Joined && room.p2Joined && room.gameState === 'LOBBY') startGame();
        broadcastState();
      }
      if (msg.type === 'input') {
        room.inputs[myKey] = msg.keys;
      }
      if (msg.type === 'ack_unlock') {
        room.unlockQueue.shift();
        if (room.unlockQueue.length === 0) {
          startGame();
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    if (room.p1 === ws) { room.p1 = null; room.p1Joined = false; room.playerNames.p1 = 'PLAYER 1'; }
    if (room.p2 === ws) { room.p2 = null; room.p2Joined = false; room.playerNames.p2 = 'PLAYER 2'; }
    room.gameState = 'LOBBY';
    room.gameMode = 'pvp';
    room.players = { p1: null, p2: null };
    broadcastState();
  });
});

// ─── Static Files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => console.log('Weponare running on port', PORT));
