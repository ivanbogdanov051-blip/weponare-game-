'use strict';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const CANVAS_W = 480, CANVAS_H = 270;
const ARENA_X = 8, ARENA_Y = 8;
const ARENA_W = CANVAS_W - 16, ARENA_H = CANVAS_H - 16;

const PAL = {
  bg:'#0a0a14', arena:'#1a1a2e', wall:'#2a2a4a',
  p1:'#4488ff', p2:'#ff6644', monster:'#44cc44',
  xp:'#ffcc00', hp:'#ff3333', hpBg:'#330000',
  text:'#e8e8e8', white:'#ffffff',
  sword:'#c8d8e8', dagger:'#d4e8b0', axe:'#e8a040',
  spear:'#c0c8d0', bow:'#b89060', staff:'#cc66ff',
  hammer:'#aab0b8', wand:'#88ddff', crossbow:'#cc8844',
  flail:'#dd4444', greatsword:'#ddeeff',
  handle:'#6b3a1f', guard:'#8899aa',
};

const WEAPON_COLOR = {
  sword:PAL.sword, dagger:PAL.dagger, axe:PAL.axe, spear:PAL.spear,
  bow:PAL.bow, staff:PAL.staff, hammer:PAL.hammer, wand:PAL.wand,
  crossbow:PAL.crossbow, flail:PAL.flail, greatsword:PAL.greatsword,
};
const WEAPON_DESC = {
  sword:'Balanced blade', dagger:'Fast, low damage', axe:'Slow, heavy hit',
  spear:'Long reach', bow:'Fires arrows', staff:'AoE magic burst',
  hammer:'Crushes with force', wand:'Rapid magic bolts', crossbow:'Piercing shot',
  flail:'360° chain strike', greatsword:'Massive two-hander',
};

// ─── Connection ───────────────────────────────────────────────────────────────

const isLocal = ['localhost', '127.0.0.1', '10.0.2.2'].includes(location.hostname);
const wsUrl = isLocal
  ? `ws://${location.hostname}:${location.port}`
  : `wss://${location.hostname}`;

let ws = null, myNum = null, connected = false;
let prevState = null, currState = null, stateRecvTime = 0;
const SERVER_TICK_MS = 20;

let pendingName = 'PLAYER', pendingMode = 'pvp', pendingPass = '';
let roomWasFull = false;
let welcomeLeaderboard = [];

function joinGame(mode) {
  const raw  = document.getElementById('nameInput').value.trim().toUpperCase();
  const pass = document.getElementById('passInput').value.trim();
  pendingName = raw  || 'PLAYER';
  pendingPass = pass || '';
  pendingMode = mode;
  document.getElementById('startScreen').className = 'overlay hidden';
  setLobbyMsg('Connecting...');
  connect();
}

function connect() {
  roomWasFull = false;
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { connected = true; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      myNum = msg.num;
      if (msg.leaderboard) welcomeLeaderboard = msg.leaderboard;
      ws.send(JSON.stringify({ type: 'join', name: pendingName, mode: pendingMode, password: pendingPass }));
      const modeLabel = pendingMode === 'coop' ? 'CO-OP' : pendingMode === 'waves' ? 'WAVES' : 'PvP';
      if (pendingMode === 'waves') {
        setLobbyMsg(`<span class="p1-color">WAVES MODE</span><br><span style="color:#888">SOLO ENDLESS</span><br>Loading...`);
      } else {
        setLobbyMsg(myNum === 1
          ? `<span class="p1-color">YOU ARE PLAYER 1</span><br><span style="color:#888">${modeLabel} MODE</span><br>Waiting for opponent...`
          : `<span class="p2-color">YOU ARE PLAYER 2</span><br><span style="color:#888">${modeLabel} MODE</span><br>Game starting!`);
      }
      document.getElementById('xpDisplay').textContent = '';
    }
    if (msg.type === 'full') {
      roomWasFull = true;
      setLobbyMsg('Room is full. Try again later.');
      return;
    }
    if (msg.type === 'state') {
      if (currState && msg.gameState === 'GAMEPLAY') detectSlashes(currState, msg);
      prevState = currState;
      currState = msg;
      stateRecvTime = performance.now();
      updateScreens(msg);
    }
  };
  ws.onclose = () => {
    connected = false;
    if (roomWasFull) {
      roomWasFull = false;
      setTimeout(() => showScreen('startScreen'), 2000);
    } else {
      showScreen('disconnectedScreen');
      setTimeout(() => {
        document.getElementById('disconnectedScreen').className = 'overlay hidden';
        document.getElementById('startScreen').className = 'overlay active';
      }, 3000);
    }
  };
  ws.onerror = () => ws.close();
}

// ─── Interpolation ────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function interpState(prev, curr, t) {
  if (!prev || t >= 1) return curr;
  const ip = (a, b) => (!a || !b || b.dead) ? b : { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  return {
    ...curr,
    players: {
      p1: ip(prev.players?.p1, curr.players?.p1),
      p2: ip(prev.players?.p2, curr.players?.p2),
    },
    monsters: curr.monsters.map((m, i) => {
      const pm = prev.monsters?.[i];
      return pm ? { ...m, x: lerp(pm.x, m.x, t), y: lerp(pm.y, m.y, t) } : m;
    }),
    projectiles: curr.projectiles.map((p, i) => {
      const pp = prev.projectiles?.[i];
      return pp ? { ...p, x: lerp(pp.x, p.x, t), y: lerp(pp.y, p.y, t) } : p;
    }),
  };
}

// ─── Slash Effects ────────────────────────────────────────────────────────────

const slashes = [];

function nearestEnemyAngle(cp, state, playerKey) {
  const px = cp.x + cp.w / 2, py = cp.y + cp.h / 2;
  let nearest = null, bestDist = Infinity;
  for (const [k, ep] of Object.entries(state.players || {})) {
    if (k !== playerKey && ep && !ep.dead) {
      const d = Math.hypot(ep.x + ep.w / 2 - px, ep.y + ep.h / 2 - py);
      if (d < bestDist) { bestDist = d; nearest = ep; }
    }
  }
  for (const m of state.monsters || []) {
    const d = Math.hypot(m.x + m.w / 2 - px, m.y + m.h / 2 - py);
    if (d < bestDist) { bestDist = d; nearest = m; }
  }
  if (!nearest) return null;
  return Math.atan2(nearest.y + nearest.h / 2 - py, nearest.x + nearest.w / 2 - px);
}

function detectSlashes(prev, curr) {
  for (const key of ['p1', 'p2']) {
    const cp = curr.players?.[key], pp = prev.players?.[key];
    if (!cp || cp.dead) continue;
    const fresh = cp.swingTimer > 0 && (!pp || pp.swingTimer <= 0 || cp.swingTimer > pp.swingTimer);
    if (fresh) {
      const angle = nearestEnemyAngle(cp, curr, key) ?? (cp.facing === 1 ? 0 : Math.PI);
      const r = cp.w + 10;
      slashes.push({
        x: cp.x + cp.w / 2 + Math.cos(angle) * r,
        y: cp.y + cp.h / 2 + Math.sin(angle) * r,
        angle,
        facing: cp.facing,
        weaponId: cp.weaponId,
        timer: 220, maxTimer: 220,
        color: WEAPON_COLOR[cp.weaponId] || PAL.white,
      });
    }
  }
}

function tickSlashes(dt) {
  for (let i = slashes.length - 1; i >= 0; i--) {
    slashes[i].timer -= dt;
    if (slashes[i].timer <= 0) slashes.splice(i, 1);
  }
}

function drawSlashes() {
  for (const sl of slashes) {
    const alpha = sl.timer / sl.maxTimer;
    const prog = 1 - alpha;
    const cx = Math.round(sl.x), cy = Math.round(sl.y);
    const isRanged = ['bow', 'staff', 'wand', 'crossbow'].includes(sl.weaponId);
    ctx.save();
    ctx.lineCap = 'round';
    if (!isRanged) {
      const r = 12 + prog * 6;
      const aim = sl.angle ?? (sl.facing === 1 ? 0 : Math.PI);
      const span = Math.PI * 0.85;
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = sl.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, r, aim - span / 2, aim + span / 2, false); ctx.stroke();
      if (alpha > 0.5) {
        ctx.globalAlpha = ((alpha - 0.5) / 0.5) * 0.6;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, r - 4, aim - span / 2, aim + span / 2, false); ctx.stroke();
      }
    } else {
      ctx.globalAlpha = alpha * 0.75;
      ctx.strokeStyle = sl.color;
      ctx.lineWidth = 1.5;
      const steps = sl.weaponId === 'staff' ? 8 : 6;
      for (let a = 0; a < Math.PI * 2; a += Math.PI * 2 / steps) {
        const len = 3 + prog * 6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3);
        ctx.lineTo(cx + Math.cos(a) * (3 + len), cy + Math.sin(a) * (3 + len));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────

const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const keys = {};
const touchKeys = { up: false, down: false, left: false, right: false, attack: false, swap: false };

window.addEventListener('keydown', (e) => {
  if (!keys[e.code]) { keys[e.code] = true; sendInput(); }
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space' && currState && currState.gameState === 'WEAPON_UNLOCK' && currState.pendingUnlock) sendAckUnlock();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; sendInput(); });

function sendInput() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type:'input', keys:{
    up:    !!keys['ArrowUp']    || touchKeys.up,
    down:  !!keys['ArrowDown']  || touchKeys.down,
    left:  !!keys['ArrowLeft']  || touchKeys.left,
    right: !!keys['ArrowRight'] || touchKeys.right,
    attack:!!keys['Space']      || touchKeys.attack,
    swap:  !!keys['Enter']      || touchKeys.swap,
  }}));
}
function sendAckUnlock() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'ack_unlock' })); }

// ─── Touch Controls ───────────────────────────────────────────────────────────

function setupTouchControls() {
  if (!isTouchDevice) return;
  const tc = document.getElementById('touchControls');
  if (tc) tc.classList.add('visible');

  const btnMap = [
    ['btn-up','up'], ['btn-down','down'], ['btn-left','left'],
    ['btn-right','right'], ['btn-attack','attack'], ['btn-swap','swap'],
  ];
  for (const [id, key] of btnMap) {
    const el = document.getElementById(id);
    if (!el) continue;
    const press = (e) => { e.preventDefault(); touchKeys[key] = true; sendInput(); };
    const release = (e) => { e.preventDefault(); touchKeys[key] = false; sendInput(); };
    el.addEventListener('touchstart', press, { passive: false });
    el.addEventListener('touchend',   release, { passive: false });
    el.addEventListener('touchcancel',release, { passive: false });
  }

  // Tap unlock screen to continue
  const unlockOverlay = document.getElementById('unlockScreen');
  if (unlockOverlay) {
    unlockOverlay.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (currState && currState.gameState === 'WEAPON_UNLOCK' && currState.pendingUnlock) sendAckUnlock();
    }, { passive: false });
  }
}
setupTouchControls();

// ─── Screens ──────────────────────────────────────────────────────────────────

const SCREENS = ['startScreen','lobbyScreen','unlockScreen','roundScreen','disconnectedScreen'];
function showScreen(id) { SCREENS.forEach(s => { const el=document.getElementById(s); if(el) el.className='overlay '+(s===id?'active':'hidden'); }); }
function hideAllScreens() { SCREENS.forEach(s => { const el=document.getElementById(s); if(el) el.className='overlay hidden'; }); }
function setLobbyMsg(html) { showScreen('lobbyScreen'); document.getElementById('lobbyMsg').innerHTML = html; }

function updateScreens(state) {
  if (state.gameState === 'LOBBY') {
    if (state.gameMode === 'waves') {
      setLobbyMsg(`<span style="color:#ffcc00">WAVES MODE</span><br><span style="color:#888">SOLO ENDLESS</span><br>Loading...`);
    } else {
      const modeStr = state.gameMode === 'coop' ? 'CO-OP MODE' : 'PvP MODE';
      setLobbyMsg(myNum
        ? (myNum===1
            ? `<span class="p1-color">${state.playerNames?.p1||'PLAYER 1'}</span> &nbsp;[${modeStr}]<br>Waiting for opponent...`
            : `<span class="p2-color">${state.playerNames?.p2||'PLAYER 2'}</span> &nbsp;[${modeStr}]<br>Waiting...`)
        : 'Waiting...');
    }
    document.getElementById('xpDisplay').textContent = 'XP: ' + (state.xp || 0);
    return;
  }
  if (state.gameState === 'WEAPON_UNLOCK') {
    showScreen('unlockScreen');
    const w = state.pendingUnlock;
    if (w) {
      document.getElementById('unlockName').textContent = w.toUpperCase();
      document.getElementById('unlockDesc').textContent = WEAPON_DESC[w]||'';
      document.getElementById('unlockHint').textContent = isTouchDevice ? 'TAP TO CONTINUE' : 'PRESS SPACE TO CONTINUE';
      drawUnlockPreview(w);
    } else if (state.otherHasUnlocks) {
      document.getElementById('unlockName').textContent = '';
      document.getElementById('unlockDesc').textContent = 'Waiting for other player...';
      document.getElementById('unlockHint').textContent = '';
      const uc = document.getElementById('unlockCanvas');
      const ux = uc.getContext('2d');
      ux.clearRect(0,0,120,80);
      ux.fillStyle='#1a1a2e'; ux.fillRect(0,0,120,80);
    }
    return;
  }
  if (state.gameState === 'ROUND_OVER') {
    showScreen('roundScreen');
    const r = state.round;
    const lb = document.getElementById('leaderboardBox');
    if (state.gameMode === 'waves') {
      document.getElementById('roundTitle').innerHTML = '<span style="color:#ffcc00">WAVES OVER</span>';
      document.getElementById('roundStats').innerHTML =
        `WAVE <span style="color:#ffcc00">${state.wave?.num||0}</span> REACHED<br>XP EARNED: ${state.xp}`;
      if (state.leaderboard && state.leaderboard.length > 0) {
        lb.classList.remove('hidden');
        lb.innerHTML = '<div class="leaderboard-title">TOP SCORES</div>' +
          state.leaderboard.map((e,i) =>
            `<div class="lb-row${i===0?' lb-top':''}">`+
            `<span>${i+1}. ${e.name}</span>`+
            `<span>${e.waves} waves</span>`+
            `<span style="color:#555">${e.date}</span></div>`
          ).join('');
      } else {
        lb.classList.add('hidden');
      }
    } else if (state.gameMode === 'coop') {
      lb.classList.add('hidden');
      document.getElementById('roundTitle').innerHTML = '<span style="color:#ffcc00">GAME OVER</span>';
      document.getElementById('roundStats').innerHTML = `WAVE ${state.wave?.num||0} REACHED<br>XP: ${state.xp}`;
    } else {
      lb.classList.add('hidden');
      const p2 = state.players.p2;
      const wn = (p2 && p2.lives <= 0) ? 1 : 2;
      const wname = wn===1 ? (state.playerNames?.p1||'P1') : (state.playerNames?.p2||'P2');
      document.getElementById('roundTitle').innerHTML = `<span class="${wn===1?'p1-color':'p2-color'}">${wname} WINS!</span>`;
      document.getElementById('roundStats').innerHTML =
        `${state.playerNames?.p1||'P1'}: ${r.p1Wins} wins &nbsp; ${state.playerNames?.p2||'P2'}: ${r.p2Wins} wins<br>XP: ${state.xp}`;
    }
    return;
  }
  if (state.gameState === 'GAMEPLAY') { hideAllScreens(); return; }
}

// ─── Render Loop ──────────────────────────────────────────────────────────────

let lastFrameTime = 0;
function renderLoop(now) {
  const dt = lastFrameTime ? Math.min(now - lastFrameTime, 100) : 16;
  lastFrameTime = now;
  tickSlashes(dt);
  if (currState && currState.gameState === 'GAMEPLAY') {
    const t = Math.min(1, (now - stateRecvTime) / SERVER_TICK_MS);
    draw(interpState(prevState, currState, t));
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ─── Draw ─────────────────────────────────────────────────────────────────────

function draw(state) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawArena();
  drawSlashes();
  drawProjectiles(state.projectiles || []);
  drawMonsters(state.monsters || []);
  const names = state.playerNames || {};
  if (state.players.p1) drawPlayer(state.players.p1, PAL.p1, names.p1 || 'P1');
  if (state.players.p2) drawPlayer(state.players.p2, PAL.p2, names.p2 || 'P2');
  drawParticles(state.particles || []);
  drawHUD(state);
  drawWeaponPanel(state);
}

function drawArena() {
  ctx.fillStyle = PAL.arena; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
  ctx.fillStyle = PAL.wall;
  ctx.fillRect(0,0,CANVAS_W,ARENA_Y); ctx.fillRect(0,CANVAS_H-ARENA_Y,CANVAS_W,ARENA_Y);
  ctx.fillRect(0,0,ARENA_X,CANVAS_H); ctx.fillRect(CANVAS_W-ARENA_X,0,ARENA_X,CANVAS_H);
  ctx.fillStyle = 'rgba(170,170,255,0.08)';
  ctx.fillRect(ARENA_X,ARENA_Y,ARENA_W,1); ctx.fillRect(ARENA_X,ARENA_Y,1,ARENA_H);
  ctx.strokeStyle='rgba(255,255,255,0.03)'; ctx.lineWidth=1;
  for(let x=ARENA_X;x<ARENA_X+ARENA_W;x+=16){ctx.beginPath();ctx.moveTo(x,ARENA_Y);ctx.lineTo(x,ARENA_Y+ARENA_H);ctx.stroke();}
  for(let y=ARENA_Y;y<ARENA_Y+ARENA_H;y+=16){ctx.beginPath();ctx.moveTo(ARENA_X,y);ctx.lineTo(ARENA_X+ARENA_W,y);ctx.stroke();}
}

function drawPlayer(p, baseColor, label) {
  if (p.dead) return;
  const c = p.hitFlash > 0 ? PAL.white : baseColor;
  const x = Math.round(p.x), y = Math.round(p.y);
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(x+1,y+p.h,p.w-2,2);
  // Legs
  ctx.fillStyle = c; ctx.fillRect(x+1,y+11,4,5); ctx.fillRect(x+7,y+11,4,5);
  // Torso
  ctx.fillRect(x,y+5,p.w,7);
  ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fillRect(x,y+5,p.w,2);
  // Head
  ctx.fillStyle=c; ctx.fillRect(x+1,y,p.w-2,5);
  // Eye
  ctx.fillStyle=PAL.white; ctx.fillRect(p.facing===1?x+8:x+2,y+1,2,2);
  // Nametag
  drawNametag(x+p.w/2, y-2, label, baseColor);
  // Weapon
  drawWeaponSprite(p, x, y);
}

function drawNametag(cx, bottomY, label, color) {
  const isMe = myNum && ((label===currState?.playerNames?.p1 && myNum===1)||(label===currState?.playerNames?.p2 && myNum===2));
  ctx.save();
  ctx.font = '5px "Courier New",monospace';
  ctx.textBaseline='bottom'; ctx.textAlign='center';
  const rx = Math.round(cx);
  // backdrop
  const tw = ctx.measureText(label).width;
  ctx.fillStyle='rgba(0,0,0,0.6)';
  ctx.fillRect(rx - tw/2 - 2, bottomY - 6, tw + 4, 7);
  // shadow
  ctx.fillStyle='rgba(0,0,0,0.8)'; ctx.fillText(label, rx+1, bottomY+1);
  // text
  ctx.fillStyle = isMe ? PAL.white : color;
  ctx.fillText(label, rx, bottomY);
  ctx.restore();
}

// ─── Weapon Sprites ───────────────────────────────────────────────────────────

function drawWeaponSprite(p, px, py) {
  const wId = p.weaponId;
  const wc = WEAPON_COLOR[wId] || PAL.white;
  const d = p.facing;
  const hx = d === 1 ? px + p.w : px; // hand attachment x
  const hy = py + 7;                    // hand attachment y
  const t = p.swingTimer > 0 ? p.swingTimer / 200 : 0;
  const swingAngle = t > 0 ? d * Math.sin(t * Math.PI) * 0.75 : 0;

  ctx.save();
  if (swingAngle !== 0) {
    ctx.translate(hx, hy); ctx.rotate(swingAngle); ctx.translate(-hx, -hy);
  }

  if (wId === 'sword') {
    // Handle
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-4, hy-1, 4, 2);
    // Pommel
    ctx.fillStyle = PAL.guard;
    ctx.fillRect(d===1?hx-1:hx+3, hy-2, 2, 4);
    // Guard crosspiece
    ctx.fillStyle = PAL.guard;
    ctx.fillRect(d===1?hx+4:hx-6, hy-3, 2, 6);
    // Blade (wide)
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+6:hx-14, hy-1, 8, 2);
    // Blade shine
    ctx.fillStyle = '#ddeeff';
    ctx.fillRect(d===1?hx+6:hx-14, hy-1, 7, 1);
    // Tip (taper)
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+14:hx-16, hy, 2, 1);
    ctx.fillRect(d===1?hx+16:hx-18, hy, 1, 1);

  } else if (wId === 'dagger') {
    // Handle
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-3, hy-1, 3, 2);
    ctx.fillStyle = '#4a2a10'; // wrapped grip
    ctx.fillRect(d===1?hx+1:hx-2, hy-1, 2, 2);
    // Guard
    ctx.fillStyle = PAL.guard;
    ctx.fillRect(d===1?hx+3:hx-5, hy-3, 2, 6);
    // Blade
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+5:hx-11, hy-1, 6, 2);
    // Blade shine
    ctx.fillStyle = '#ddeeff';
    ctx.fillRect(d===1?hx+5:hx-11, hy-1, 5, 1);
    // Sharp tip
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+11:hx-13, hy, 2, 1);
    ctx.fillRect(d===1?hx+13:hx-14, hy, 1, 1);

  } else if (wId === 'axe') {
    // Handle (long)
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-6, hy-1, 6, 2);
    // Axe head socket
    ctx.fillStyle = '#555566';
    ctx.fillRect(d===1?hx+6:hx-8, hy-2, 2, 4);
    // Axe blade body
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+7:hx-11, hy-6, 4, 12);
    // Blade edge (wider, sharper)
    ctx.fillRect(d===1?hx+10:hx-12, hy-8, 3, 16);
    ctx.fillRect(d===1?hx+12:hx-14, hy-6, 2, 12);
    // Blade shine
    ctx.fillStyle = '#ffcc88';
    ctx.fillRect(d===1?hx+10:hx-11, hy-7, 1, 14);

  } else if (wId === 'spear') {
    // Shaft
    ctx.fillStyle = '#7a4a20';
    ctx.fillRect(d===1?hx:hx-14, hy, 14, 1);
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-14, hy-1, 14, 2);
    // Socket
    ctx.fillStyle = '#555566';
    ctx.fillRect(d===1?hx+14:hx-16, hy-1, 2, 2);
    // Spearhead base
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+16:hx-20, hy-1, 4, 2);
    // Spearhead point
    ctx.beginPath();
    if (d===1) { ctx.moveTo(hx+20,hy-3); ctx.lineTo(hx+25,hy); ctx.lineTo(hx+20,hy+3); }
    else       { ctx.moveTo(hx-20,hy-3); ctx.lineTo(hx-25,hy); ctx.lineTo(hx-20,hy+3); }
    ctx.fill();
    // Shine
    ctx.fillStyle = '#ddeeff';
    ctx.fillRect(d===1?hx+16:hx-20, hy-1, 3, 1);

  } else if (wId === 'bow') {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8B5E3C';
    ctx.beginPath();
    ctx.arc(d===1?hx+2:hx-2, hy, 7, Math.PI*0.2, Math.PI*1.8, d===1);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ccbb88';
    ctx.beginPath(); ctx.moveTo(d===1?hx+2:hx-2, hy-7); ctx.lineTo(d===1?hx+2:hx-2, hy+7); ctx.stroke();
    // Arrow nocked
    ctx.fillStyle = '#ccaa44';
    ctx.fillRect(d===1?hx+2:hx-8, hy, 6, 1);
    ctx.fillStyle = '#aaddff';
    ctx.fillRect(d===1?hx+8:hx-9, hy-1, 2, 3);

  } else if (wId === 'staff') {
    ctx.fillStyle = '#3a1860';
    ctx.fillRect(d===1?hx:hx-11, hy-1, 11, 2);
    ctx.fillStyle = '#5a2888';
    ctx.fillRect(d===1?hx:hx-11, hy-1, 10, 1);
    ctx.fillStyle = '#aa44ff';
    ctx.fillRect(d===1?hx+11:hx-13, hy-1, 2, 2);
    const ox = d===1?hx+15:hx-15;
    ctx.fillStyle = '#dd88ff';
    ctx.beginPath(); ctx.arc(ox, hy, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffccff';
    ctx.beginPath(); ctx.arc(ox-1, hy-1, 1.5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(221,136,255,0.3)';
    ctx.beginPath(); ctx.arc(ox, hy, 7, 0, Math.PI*2); ctx.fill();

  } else if (wId === 'hammer') {
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-8, hy-1, 8, 2);
    ctx.fillStyle = '#555566';
    ctx.fillRect(d===1?hx+8:hx-10, hy-2, 2, 4);
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+10:hx-18, hy-5, 8, 10);
    ctx.fillStyle = '#dde0e8';
    ctx.fillRect(d===1?hx+10:hx-18, hy-5, 2, 10);

  } else if (wId === 'wand') {
    ctx.fillStyle = '#6a3010';
    ctx.fillRect(d===1?hx:hx-9, hy, 9, 1);
    ctx.fillStyle = '#9a5020';
    ctx.fillRect(d===1?hx:hx-9, hy-1, 9, 1);
    const tx = d===1?hx+11:hx-11;
    ctx.fillStyle = wc;
    ctx.fillRect(tx-1, hy-2, 3, 5); ctx.fillRect(tx-2, hy-1, 5, 3);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(tx, hy, 1, 1);
    ctx.fillStyle = 'rgba(136,221,255,0.4)';
    ctx.beginPath(); ctx.arc(tx, hy, 5, 0, Math.PI*2); ctx.fill();

  } else if (wId === 'crossbow') {
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-9, hy-1, 9, 3);
    ctx.lineWidth = 2; ctx.strokeStyle = '#8B5E3C';
    ctx.beginPath(); ctx.arc(d===1?hx+3:hx-3, hy, 8, Math.PI*0.2, Math.PI*1.8, d===1); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#ccbb88';
    ctx.beginPath(); ctx.moveTo(d===1?hx+3:hx-3, hy-8); ctx.lineTo(d===1?hx+3:hx-3, hy+8); ctx.stroke();
    ctx.fillStyle = '#cc9933';
    ctx.fillRect(d===1?hx+3:hx-9, hy-1, 6, 2);
    ctx.fillStyle = '#aaddff';
    ctx.fillRect(d===1?hx+9:hx-10, hy-1, 3, 2);

  } else if (wId === 'flail') {
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-7, hy-1, 7, 2);
    ctx.fillStyle = '#999aaa';
    for (let ci = 0; ci < 3; ci++) {
      ctx.fillRect(d===1?hx+7+ci*3:hx-10-ci*3, hy, 2, 1);
    }
    const bx = d===1?hx+18:hx-18;
    ctx.fillStyle = '#882222';
    ctx.beginPath(); ctx.arc(bx, hy, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = wc;
    ctx.fillRect(bx-5, hy, 2, 1); ctx.fillRect(bx+3, hy, 2, 1);
    ctx.fillRect(bx, hy-5, 1, 2); ctx.fillRect(bx, hy+3, 1, 2);

  } else if (wId === 'greatsword') {
    ctx.fillStyle = PAL.handle;
    ctx.fillRect(d===1?hx:hx-7, hy-1, 7, 3);
    ctx.fillStyle = PAL.guard;
    ctx.fillRect(d===1?hx-2:hx+5, hy-2, 3, 5);
    ctx.fillRect(d===1?hx+7:hx-10, hy-5, 3, 10);
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+10:hx-22, hy-1, 12, 3);
    ctx.fillStyle = '#eef4ff';
    ctx.fillRect(d===1?hx+10:hx-22, hy-1, 11, 1);
    ctx.fillStyle = wc;
    ctx.fillRect(d===1?hx+22:hx-24, hy, 2, 1);
    ctx.fillRect(d===1?hx+24:hx-25, hy+1, 1, 1);
  }

  ctx.restore();
}

// ─── Monster ──────────────────────────────────────────────────────────────────

function drawMonster(m) {
  const c = m.hitFlash > 0 ? PAL.white : PAL.monster;
  const x = Math.round(m.x), y = Math.round(m.y);
  ctx.fillStyle=c;
  ctx.fillRect(x+1,y+4,m.w-2,m.h-4); ctx.fillRect(x,y,m.w,5);
  ctx.fillRect(x-1,y+1,2,3); ctx.fillRect(x+m.w-1,y+1,2,3);
  ctx.fillStyle='#ff2222'; ctx.fillRect(x+2,y+1,2,2); ctx.fillRect(x+6,y+1,2,2);
  drawHpBar(x-1,y-5,m.w+2,2,m.hp/m.maxHp,'#44ff44','#003300');
}
function drawMonsters(ms) { for(const m of ms) drawMonster(m); }

function drawProjectiles(projs) {
  for(const pr of projs) {
    if(pr.weaponId==='bow') {
      ctx.strokeStyle=PAL.bow; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(pr.x,pr.y); ctx.lineTo(pr.x-pr.dx*4,pr.y-pr.dy*4); ctx.stroke();
      ctx.fillStyle='#ffeeaa'; ctx.fillRect(Math.round(pr.x)-1,Math.round(pr.y)-1,2,2);
    } else if(pr.weaponId==='staff') {
      ctx.strokeStyle=PAL.staff; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(pr.x,pr.y,4,0,Math.PI*2); ctx.stroke();
      ctx.fillStyle='rgba(170,68,255,0.5)';
      ctx.beginPath(); ctx.arc(pr.x,pr.y,6,0,Math.PI*2); ctx.fill();
    } else if(pr.weaponId==='wand') {
      ctx.fillStyle=PAL.wand;
      ctx.beginPath(); ctx.arc(pr.x,pr.y,2,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(136,221,255,0.45)';
      ctx.beginPath(); ctx.arc(pr.x,pr.y,4,0,Math.PI*2); ctx.fill();
    } else if(pr.weaponId==='crossbow') {
      ctx.strokeStyle=PAL.crossbow; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(pr.x,pr.y); ctx.lineTo(pr.x-pr.dx*5,pr.y-pr.dy*5); ctx.stroke();
      ctx.fillStyle='#ddaa55'; ctx.fillRect(Math.round(pr.x)-1,Math.round(pr.y)-1,3,2);
      ctx.fillStyle='#aaddff'; ctx.fillRect(Math.round(pr.x)+1,Math.round(pr.y)-1,2,2);
    }
  }
}

function drawParticles(particles) {
  for(const p of particles) {
    if(p.type==='xp') {
      const alpha=Math.max(0,p.timer/900), rise=(1-p.timer/900)*12;
      ctx.globalAlpha=alpha; ctx.fillStyle=PAL.xp;
      pixelText(p.text,Math.round(p.x),Math.round(p.y-rise));
      ctx.globalAlpha=1;
    } else if(p.type==='aoe') {
      ctx.globalAlpha=Math.max(0,p.timer/300);
      ctx.strokeStyle=p.color||PAL.staff; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.radius||4,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=1;
    } else if(p.type==='waveclear') {
      ctx.globalAlpha=Math.min(1,p.timer/2500*3);
      ctx.fillStyle=PAL.xp; ctx.font='10px "Courier New",monospace';
      ctx.textBaseline='middle'; ctx.textAlign='center';
      ctx.fillText(p.text,p.x,p.y); ctx.textAlign='left'; ctx.globalAlpha=1;
    }
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function drawHUD(state) {
  const p1=state.players.p1, p2=state.players.p2;
  const names=state.playerNames||{};
  if(p1) {
    ctx.fillStyle=PAL.p1; pixelText(names.p1||'P1',10,6);
    drawHpBar(22,5,60,5,p1.hp/p1.maxHp,PAL.p1,'#330000');
    for(let i=0;i<(p1.lives||0);i++){ctx.fillStyle=PAL.p1;ctx.fillRect(10+i*5,13,3,3);}
  }
  if(p2) {
    const label=names.p2||'P2';
    ctx.fillStyle=PAL.p2; pixelText(label,CANVAS_W-10-label.length*4,6);
    drawHpBar(CANVAS_W-84,5,60,5,p2.hp/p2.maxHp,PAL.p2,'#330000');
    for(let i=0;i<(p2.lives||0);i++){ctx.fillStyle=PAL.p2;ctx.fillRect(CANVAS_W-12-i*5,13,3,3);}
  }
  const w=state.wave;
  if(w) {
    const wt='WAVE '+w.num, mt=w.monstersLeft+' LEFT';
    ctx.fillStyle=PAL.text; pixelText(wt,Math.round(CANVAS_W/2-wt.length*3),6);
    ctx.fillStyle='#888'; pixelText(mt,Math.round(CANVAS_W/2-mt.length*3),13);
  }
  // Mode badge
  if(state.gameMode==='coop') {
    ctx.fillStyle='rgba(0,180,80,0.25)'; ctx.fillRect(CANVAS_W/2-16,0,32,8);
    ctx.fillStyle='#44ff88'; pixelText('COOP',CANVAS_W/2-12,1);
  } else if(state.gameMode==='waves') {
    ctx.fillStyle='rgba(200,150,0,0.2)'; ctx.fillRect(CANVAS_W/2-20,0,40,8);
    ctx.fillStyle='#ffcc00'; pixelText('WAVES',CANVAS_W/2-15,1);
  }
  ctx.fillStyle=PAL.xp; pixelText('XP:'+state.xp,10,CANVAS_H-10);
}

// ─── Weapon Panel ─────────────────────────────────────────────────────────────

function drawWeaponPanel(state) {
  if(!myNum) return;
  const mp = myNum===1 ? state.players?.p1 : state.players?.p2;
  if(!mp||!mp.unlockedWeapons) return;
  const weapons=mp.unlockedWeapons;
  const slotW=26, slotH=22, gap=2;
  const totalW=weapons.length*(slotW+gap)-gap;
  const panelX=Math.round((CANVAS_W-totalW)/2);
  const panelY=CANVAS_H-slotH-4;

  ctx.fillStyle='rgba(0,0,0,0.72)';
  ctx.fillRect(panelX-4,panelY-3,totalW+8,slotH+6);

  if (!isTouchDevice) {
    const hx=panelX+totalW+10, hy=panelY;
    ctx.save();
    ctx.font='5px "Courier New",monospace'; ctx.textBaseline='top'; ctx.textAlign='left';
    ctx.fillStyle='#505060'; ctx.fillText('ARROWS MOVE',hx,hy);
    ctx.fillStyle='#505060'; ctx.fillText('SPACE  ATK', hx,hy+7);
    ctx.fillStyle='#505060'; ctx.fillText('ENTER  SWAP',hx,hy+14);
    ctx.restore();
  }

  for(let i=0;i<weapons.length;i++) {
    const wId=weapons[i], sel=wId===mp.weaponId;
    const sx=panelX+i*(slotW+gap), sy=panelY;
    const wc=WEAPON_COLOR[wId]||PAL.white;
    ctx.fillStyle=sel?'rgba(255,255,255,0.1)':'rgba(5,5,15,0.8)';
    ctx.fillRect(sx,sy,slotW,slotH);
    ctx.strokeStyle=sel?wc:'#2a2a3a'; ctx.lineWidth=1;
    ctx.strokeRect(sx+0.5,sy+0.5,slotW-1,slotH-1);
    if(sel) {
      ctx.save(); ctx.globalAlpha=0.35; ctx.strokeStyle=wc; ctx.lineWidth=1;
      ctx.strokeRect(sx-0.5,sy-0.5,slotW+1,slotH+1); ctx.restore();
    }
    drawWeaponIconMini(wId,sx+slotW/2,sy+9,wc,sel);
    ctx.save();
    ctx.font='4px "Courier New",monospace'; ctx.textBaseline='bottom'; ctx.textAlign='center';
    ctx.fillStyle=sel?wc:'#444';
    ctx.fillText(wId.slice(0,4).toUpperCase(),sx+slotW/2,sy+slotH-1);
    ctx.restore();
  }
}

function drawWeaponIconMini(wId, cx, cy, color, bright) {
  const c=bright?color:'#404050', h=bright?PAL.handle:'#303030';
  const icx=Math.round(cx), icy=Math.round(cy);
  ctx.fillStyle=c; ctx.strokeStyle=c; ctx.lineWidth=1;
  if(wId==='sword') {
    ctx.fillStyle=h; ctx.fillRect(icx-6,icy-1,4,2);
    ctx.fillStyle=PAL.guard; ctx.fillRect(icx-2,icy-3,2,6);
    ctx.fillStyle=c; ctx.fillRect(icx,icy-1,7,2); ctx.fillRect(icx+7,icy,1,1);
  } else if(wId==='dagger') {
    ctx.fillStyle=h; ctx.fillRect(icx-5,icy-1,3,2);
    ctx.fillStyle=PAL.guard; ctx.fillRect(icx-2,icy-2,2,4);
    ctx.fillStyle=c; ctx.fillRect(icx,icy-1,5,2); ctx.fillRect(icx+5,icy,2,1);
  } else if(wId==='axe') {
    ctx.fillStyle=h; ctx.fillRect(icx-5,icy-1,5,2);
    ctx.fillStyle=c;
    ctx.fillRect(icx,icy-4,3,8); ctx.fillRect(icx+3,icy-5,3,10);
  } else if(wId==='spear') {
    ctx.fillStyle=h; ctx.fillRect(icx-8,icy,16,1); ctx.fillRect(icx-8,icy-1,14,2);
    ctx.fillStyle=c;
    ctx.beginPath(); ctx.moveTo(icx+6,icy-3); ctx.lineTo(icx+11,icy); ctx.lineTo(icx+6,icy+3); ctx.fill();
  } else if(wId==='bow') {
    ctx.lineWidth=1.5; ctx.strokeStyle=bright?'#8B5E3C':'#333';
    ctx.beginPath(); ctx.arc(icx,icy,6,Math.PI*0.3,Math.PI*1.7); ctx.stroke();
    ctx.lineWidth=1; ctx.strokeStyle=bright?'#ccbb88':'#333';
    ctx.beginPath(); ctx.moveTo(icx,icy-6); ctx.lineTo(icx,icy+6); ctx.stroke();
  } else if(wId==='staff') {
    ctx.fillStyle=bright?'#5a2888':'#303030'; ctx.fillRect(icx-6,icy-1,10,2);
    ctx.fillStyle=bright?'#dd88ff':'#404050';
    ctx.beginPath(); ctx.arc(icx+6,icy,3,0,Math.PI*2); ctx.fill();
  } else if(wId==='hammer') {
    ctx.fillStyle=h; ctx.fillRect(icx-6,icy-1,6,2);
    ctx.fillStyle=c;
    ctx.fillRect(icx,icy-4,3,8); ctx.fillRect(icx+3,icy-5,3,10);
    ctx.fillStyle='#dde0e8'; ctx.fillRect(icx,icy-4,1,8);
  } else if(wId==='wand') {
    ctx.fillStyle=h; ctx.fillRect(icx-6,icy-1,10,2);
    ctx.fillStyle=c; ctx.fillRect(icx+4,icy-2,3,5); ctx.fillRect(icx+3,icy-1,5,3);
    ctx.fillStyle=bright?'rgba(136,221,255,0.6)':'rgba(136,221,255,0.2)';
    ctx.beginPath(); ctx.arc(icx+6,icy,4,0,Math.PI*2); ctx.fill();
  } else if(wId==='crossbow') {
    ctx.fillStyle=h; ctx.fillRect(icx-6,icy-1,8,2);
    ctx.lineWidth=1.5; ctx.strokeStyle=bright?'#8B5E3C':'#333';
    ctx.beginPath(); ctx.arc(icx+2,icy,5,Math.PI*0.2,Math.PI*1.8,true); ctx.stroke();
    ctx.lineWidth=1; ctx.strokeStyle=bright?'#ccbb88':'#333';
    ctx.beginPath(); ctx.moveTo(icx+2,icy-5); ctx.lineTo(icx+2,icy+5); ctx.stroke();
  } else if(wId==='flail') {
    ctx.fillStyle=h; ctx.fillRect(icx-6,icy-1,5,2);
    ctx.fillStyle='#888';
    for(let i=0;i<3;i++) ctx.fillRect(icx-1+i*3,icy,2,1);
    ctx.fillStyle=bright?'#882222':'#333';
    ctx.beginPath(); ctx.arc(icx+8,icy,4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=c;
    ctx.fillRect(icx+3,icy,2,1); ctx.fillRect(icx+13,icy,2,1);
    ctx.fillRect(icx+8,icy-5,1,2); ctx.fillRect(icx+8,icy+3,1,2);
  } else if(wId==='greatsword') {
    ctx.fillStyle=h; ctx.fillRect(icx-7,icy-1,5,3);
    ctx.fillStyle=PAL.guard; ctx.fillRect(icx-2,icy-4,2,8);
    ctx.fillStyle=c; ctx.fillRect(icx,icy-1,9,3); ctx.fillRect(icx+9,icy,1,1);
    ctx.fillStyle='#eef4ff'; ctx.fillRect(icx,icy-1,8,1);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function drawHpBar(x,y,w,h,ratio,fg,bg) {
  ctx.fillStyle=bg; ctx.fillRect(x,y,w,h);
  ctx.fillStyle=fg; ctx.fillRect(x,y,Math.round(w*Math.max(0,ratio)),h);
  ctx.strokeStyle='#000'; ctx.lineWidth=1; ctx.strokeRect(x,y,w,h);
}

function pixelText(text,x,y) {
  const saved=ctx.fillStyle;
  ctx.font='6px "Courier New",monospace'; ctx.textBaseline='top'; ctx.textAlign='left';
  ctx.fillStyle='rgba(0,0,0,0.75)'; ctx.fillText(text,x+1,y+1);
  ctx.fillStyle=saved; ctx.fillText(text,x,y);
}

// ─── Unlock Preview ───────────────────────────────────────────────────────────

function drawUnlockPreview(weaponId) {
  const uc=document.getElementById('unlockCanvas');
  const ux=uc.getContext('2d');
  ux.imageSmoothingEnabled=false;
  ux.clearRect(0,0,120,80);
  const wc=WEAPON_COLOR[weaponId]||'#ffffff';
  const cx=60,cy=40;
  ux.fillStyle='#1a1a2e'; ux.fillRect(0,0,120,80);
  ux.strokeStyle=wc; ux.lineWidth=1; ux.strokeRect(2,2,116,76);
  ux.fillStyle=wc; ux.strokeStyle=wc;
  if(weaponId==='sword'){ux.fillRect(cx-20,cy-2,40,4);ux.fillRect(cx+17,cy-8,4,16);ux.fillRect(cx-8,cy-1,6,2);}
  else if(weaponId==='dagger'){ux.fillRect(cx-14,cy-2,28,4);ux.beginPath();ux.moveTo(cx+14,cy-4);ux.lineTo(cx+22,cy);ux.lineTo(cx+14,cy+4);ux.fill();}
  else if(weaponId==='axe'){ux.fillRect(cx-5,cy-22,10,44);ux.fillRect(cx+4,cy-18,16,36);}
  else if(weaponId==='spear'){ux.fillRect(cx-28,cy-1,50,2);ux.beginPath();ux.moveTo(cx+22,cy-6);ux.lineTo(cx+34,cy);ux.lineTo(cx+22,cy+6);ux.fill();}
  else if(weaponId==='bow'){ux.lineWidth=3;ux.beginPath();ux.arc(cx,cy,20,Math.PI*0.3,Math.PI*1.7);ux.stroke();ux.lineWidth=1;ux.strokeStyle='#886633';ux.beginPath();ux.moveTo(cx,cy-20);ux.lineTo(cx,cy+20);ux.stroke();}
  else if(weaponId==='staff'){ux.fillRect(cx-30,cy-2,50,4);ux.fillStyle='#dd88ff';ux.beginPath();ux.arc(cx+26,cy,10,0,Math.PI*2);ux.fill();ux.fillStyle='rgba(221,136,255,0.4)';ux.beginPath();ux.arc(cx+26,cy,16,0,Math.PI*2);ux.fill();}
  else if(weaponId==='hammer'){
    ux.fillRect(cx-26,cy-2,26,4);
    ux.fillStyle='#555566'; ux.fillRect(cx,cy-4,4,8);
    ux.fillStyle=wc; ux.fillRect(cx+4,cy-16,14,32);
    ux.fillStyle='#dde0e8'; ux.fillRect(cx+4,cy-16,4,32);
  }
  else if(weaponId==='wand'){
    ux.fillRect(cx-28,cy-2,36,4);
    const tx=cx+12;
    ux.fillStyle=wc; ux.fillRect(tx-4,cy-8,9,16); ux.fillRect(tx-8,cy-4,17,8);
    ux.fillStyle='#ffffff'; ux.fillRect(tx-1,cy-1,3,3);
    ux.fillStyle='rgba(136,221,255,0.5)'; ux.beginPath(); ux.arc(tx,cy,14,0,Math.PI*2); ux.fill();
  }
  else if(weaponId==='crossbow'){
    ux.fillRect(cx-28,cy-3,34,6);
    ux.lineWidth=4; ux.beginPath(); ux.arc(cx+8,cy,20,Math.PI*0.25,Math.PI*1.75); ux.stroke();
    ux.lineWidth=1; ux.strokeStyle='#886633'; ux.beginPath(); ux.moveTo(cx+8,cy-20); ux.lineTo(cx+8,cy+20); ux.stroke();
    ux.fillStyle='#cc9933'; ux.fillRect(cx+8,cy-2,18,4);
    ux.fillStyle='#aaddff'; ux.fillRect(cx+22,cy-2,8,4);
  }
  else if(weaponId==='flail'){
    ux.fillRect(cx-26,cy-3,18,6);
    ux.fillStyle='#999aaa';
    for(let i=0;i<5;i++) ux.fillRect(cx-8+i*7,cy-2,5,4);
    ux.fillStyle='#882222'; ux.beginPath(); ux.arc(cx+26,cy,12,0,Math.PI*2); ux.fill();
    ux.fillStyle=wc;
    ux.fillRect(cx+12,cy-2,4,4); ux.fillRect(cx+36,cy-2,4,4);
    ux.fillRect(cx+24,cy-14,4,4); ux.fillRect(cx+24,cy+10,4,4);
  }
  else if(weaponId==='greatsword'){
    ux.fillRect(cx-34,cy-3,70,7);
    ux.fillRect(cx-34,cy-5,66,11);
    ux.fillStyle='#eef4ff'; ux.fillRect(cx-34,cy-4,64,3);
    ux.fillStyle=wc; ux.fillRect(cx+28,cy-12,8,26);
    ux.fillStyle='#8899aa'; ux.fillRect(cx-14,cy-2,8,5);
  }
}
