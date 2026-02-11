const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = 3000;
const TICK_RATE = 15; // 15 ticks per second
const TICK_MS = 1000 / TICK_RATE;
const ROOM_WIDTH = 720;
const ROOM_HEIGHT = 1280;

// Ball type definitions: { hp, speed, spawnRate, waveWeight }
const BALL_TYPES = {
  normal: { hp: 20, speed: 7, spawnRate: 3, waveWeight: 0.5 },
  fast: { hp: 14, speed: 10, spawnRate: 2, waveWeight: 1 },
  big: { hp: 160, speed: 3, spawnRate: 1, waveWeight: 2 },
};
const BALL_TYPE_KEYS = Object.keys(BALL_TYPES);

// Card types - pick 3 random after each wave
const CARD_TYPES = [
  { id: 'critical', name: 'Critical +10%', desc: '10% chance for 2x damage' },
  { id: 'piercing', name: 'Piercing +10%', desc: '10% chance bullet pierces' },
  { id: 'areaDamage', name: 'Area Damage', desc: '100px radius, +10% dmg per level' },
  { id: 'bulletCount', name: '+1 Bullet', desc: 'Double, triple, quad shoot...' },
  { id: 'pusher', name: 'Pusher +5%', desc: '5% chance to push enemy 5px up' },
  { id: 'extraLife', name: '+1 Life', desc: 'Add 1 shared life' },
  { id: 'ignition', name: 'Ignition Bullets', desc: '1% chance to burn ball 5s (1 dmg/tick), +1% per level' },
  { id: 'melee', name: 'Melee Damage', desc: 'Ball within 200px: shoot homing bullet every 4 ticks, +1 dmg per level' },
  { id: 'bouncyBullets', name: 'Bouncy Bullets', desc: 'Bullets bounce off screen edges, +1 bounce per level' },
];

// Player settings
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 16; // 2x faster (was 8)
const BULLET_DAMAGE = 1;
const BULLET_RADIUS = 6;
const BULLET_SPEED = 75; // 5x faster (was 15)
const INACTIVITY_TIMEOUT_MS = 30000; // 30 seconds

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game state
const players = new Map();
const bullets = new Map();
const balls = new Map();
let nextPlayerId = 1;
let nextBulletId = 1;
let nextBallId = 1;
let tickCount = 0;
let gameStarted = false;
let gamePhase = 'playing'; // 'playing' | 'cardSelection'
let wave = 1;
let waveWeightSpawned = 0;
let lastSpawnTick = 0;
let cardSelectionEndTime = 0;
let lives = 10;
const CARD_SELECTION_MS = 15000;
const INITIAL_LIVES = 10;
const AREA_DAMAGE_RADIUS = 100;
const PUSHER_STRENGTH = 5;
const BURN_DURATION_TICKS = 5 * TICK_RATE; // 5 seconds
const MELEE_RANGE = 200;
const MELEE_BULLET_INTERVAL = 4;

// Weighted random: normal rate 3, fast 2, big 1
function pickBallType() {
  const total = BALL_TYPE_KEYS.reduce((s, k) => s + BALL_TYPES[k].spawnRate, 0);
  let r = Math.random() * total;
  for (const type of BALL_TYPE_KEYS) {
    r -= BALL_TYPES[type].spawnRate;
    if (r <= 0) return type;
  }
  return BALL_TYPE_KEYS[0];
}

// Spawn ball at top of screen, returns type for weight tracking
function spawnBall(type) {
  if (!type) type = pickBallType();
  const def = BALL_TYPES[type];
  const radius = type === 'big' ? 70 : type === 'fast' ? 30 : 44; // 2x bigger (was 35, 15, 22)
  const ball = {
    id: nextBallId++,
    x: Math.random() * (ROOM_WIDTH - radius * 2) + radius,
    y: -radius - 10,
    type,
    hp: def.hp,
    maxHp: def.hp,
    speed: def.speed,
    radius,
  };
  balls.set(ball.id, ball);
  return type;
}

// Distance from point (px, py) to line segment from (x1,y1) to (x2,y2)
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;
  return Math.hypot(px - nearestX, py - nearestY);
}

// Swept collision: bullet path (this tick) vs ball circle - no tunneling through fast bullets
// moveX, moveY = bullet movement this tick (default: straight up for normal bullets)
function bulletHitsBall(bullet, ball, moveX = 0, moveY = -BULLET_SPEED) {
  const nextX = bullet.x + moveX;
  const nextY = bullet.y + moveY;
  const dist = pointToSegmentDist(ball.x, ball.y, bullet.x, bullet.y, nextX, nextY);
  return dist <= bullet.radius + ball.radius;
}

function resetGame() {
  bullets.clear();
  balls.clear();
  nextBulletId = 1;
  nextBallId = 1;
  tickCount = 0;
  wave = 1;
  waveWeightSpawned = 0;
  lastSpawnTick = 0;
  lives = INITIAL_LIVES;
  players.forEach((p) => {
    p.x = ROOM_WIDTH / 2;
    p.y = ROOM_HEIGHT - 80;
    p.criticalChance = 0;
    p.pierceChance = 0;
    p.areaDamageLevel = 0;
    p.bulletCount = 1;
    p.pusherChance = 0;
    p.ignitionChance = 0;
    p.meleeDamage = 0;
    p.bounceCount = 0;
    p.offeredCards = null;
    p.cardSelected = false;
  });
  gamePhase = 'playing';
}

function gameTick() {
  tickCount++;

  if (lives <= 0 && gamePhase === 'playing') gamePhase = 'gameOver';
  if (gameStarted && gamePhase === 'playing' && lives > 0) {
    const maxWeight = 20 * Math.pow(1.1, wave - 1);
    const spawnIntervalTicks = Math.max(1, Math.floor(TICK_RATE * Math.pow(0.9, wave - 1)));
    const canSpawn = waveWeightSpawned < maxWeight;
    const timeToSpawn = tickCount - lastSpawnTick >= spawnIntervalTicks;
    if (canSpawn && timeToSpawn) {
      const type = spawnBall();
      waveWeightSpawned += BALL_TYPES[type].waveWeight;
      lastSpawnTick = tickCount;
    }
    // Enter card selection when wave complete
    if (waveWeightSpawned >= maxWeight && balls.size === 0 && gamePhase === 'playing') {
      gamePhase = 'cardSelection';
      cardSelectionEndTime = Date.now() + CARD_SELECTION_MS;
      players.forEach((p) => {
        p.offeredCards = [];
        for (let i = 0; i < 3; i++) {
          p.offeredCards.push(CARD_TYPES[Math.floor(Math.random() * CARD_TYPES.length)]);
        }
        p.cardSelected = false;
      });
    }
  }
  // End card selection on timeout or all selected
  if (gamePhase === 'cardSelection') {
    const allSelected = Array.from(players.values()).every((p) => p.cardSelected);
    const timeout = Date.now() >= cardSelectionEndTime;
    if (allSelected || timeout) {
      gamePhase = 'playing';
      wave++;
      waveWeightSpawned = 0;
      players.forEach((p) => {
        p.offeredCards = null;
        p.cardSelected = false;
      });
    }
  }

  // Process player input (frozen when game over)
  if (gamePhase !== 'gameOver') {
  players.forEach((p) => {
    if (p.keys.left) p.x = Math.max(PLAYER_RADIUS, p.x - PLAYER_SPEED);
    if (p.keys.right) p.x = Math.min(ROOM_WIDTH - PLAYER_RADIUS, p.x + PLAYER_SPEED);
    if (p.keys.up) p.y = Math.max(PLAYER_RADIUS, p.y - PLAYER_SPEED);
    if (p.keys.down) p.y = Math.min(ROOM_HEIGHT - PLAYER_RADIUS, p.y + PLAYER_SPEED);
  });
  }

  // Bullet vs ball collision (swept) - with upgrades: critical, pierce, area damage
  const toRemoveBullets = new Set();
  const toRemoveBalls = new Set();
  const areaDamageHits = [];
  const bulletHits = [];
  bullets.forEach((bullet) => {
    let moveX = 0, moveY = -BULLET_SPEED;
    let damage = BULLET_DAMAGE;
    let owner = null;
    if (bullet.homing) {
      const target = balls.get(bullet.targetBallId);
      if (!target) { toRemoveBullets.add(bullet.id); return; }
      const dx = target.x - bullet.x;
      const dy = target.y - bullet.y;
      const len = Math.hypot(dx, dy) || 1;
      moveX = (dx / len) * BULLET_SPEED;
      moveY = (dy / len) * BULLET_SPEED;
      damage = bullet.damage ?? 1;
    } else {
      owner = players.get(bullet.ownerId);
      moveX = bullet.vx ?? 0;
      moveY = bullet.vy ?? -BULLET_SPEED;
    }
    const criticalChance = owner?.criticalChance ?? 0;
    const pierceChance = owner?.pierceChance ?? 0;
    const areaLevel = owner?.areaDamageLevel ?? 0;
    const pusherChance = owner?.pusherChance ?? 0;
    const ignitionChance = owner?.ignitionChance ?? 0;
    balls.forEach((ball) => {
      if (bulletHitsBall(bullet, ball, moveX, moveY)) {
        bulletHits.push({ x: ball.x, y: ball.y });
        let dmg = damage;
        if (!bullet.homing && Math.random() * 100 < criticalChance) dmg *= 2;
        ball.hp -= dmg;
        if (ball.hp <= 0) toRemoveBalls.add(ball.id);
        if (!bullet.homing && Math.random() * 100 < pusherChance) ball.y -= PUSHER_STRENGTH;
        if (!bullet.homing && ignitionChance > 0 && Math.random() * 100 < ignitionChance) ball.burnEndTick = tickCount + BURN_DURATION_TICKS;
        if (bullet.homing || Math.random() * 100 >= pierceChance) toRemoveBullets.add(bullet.id);
        if (!bullet.homing && areaLevel > 0) {
          const areaDmg = BULLET_DAMAGE * 0.1 * Math.pow(1.1, areaLevel - 1);
          areaDamageHits.push({ x: ball.x, y: ball.y });
          balls.forEach((b) => {
            if (b.id !== ball.id && Math.hypot(b.x - ball.x, b.y - ball.y) <= AREA_DAMAGE_RADIUS) {
              b.hp -= areaDmg;
              if (b.hp <= 0) toRemoveBalls.add(b.id);
            }
          });
        }
      }
    });
    bullet._moveX = moveX;
    bullet._moveY = moveY;
  });

  // Move bullets (before spawning - so new bullets stay at player for this tick)
  bullets.forEach((b) => {
    const mx = b._moveX ?? 0, my = b._moveY ?? -BULLET_SPEED;
    b.x += mx;
    b.y += my;
    delete b._moveX;
    delete b._moveY;
    // Update velocity for bouncy bullets (needed for next tick collision)
    if (!b.homing && (b.vx != null || b.vy != null)) {
      b.vx = mx;
      b.vy = my;
    }
    // Bounce off edges (bouncy bullets only)
    let bl = b.bouncesLeft ?? 0;
    if (bl > 0) {
      if (b.x < BULLET_RADIUS) { b.x = BULLET_RADIUS; b.vx = (b.vx ?? 0) * -1; bl--; }
      if (b.x > ROOM_WIDTH - BULLET_RADIUS) { b.x = ROOM_WIDTH - BULLET_RADIUS; b.vx = (b.vx ?? 0) * -1; bl--; }
      if (b.y < BULLET_RADIUS) { b.y = BULLET_RADIUS; b.vy = (b.vy ?? -BULLET_SPEED) * -1; bl--; }
      if (b.y > ROOM_HEIGHT - BULLET_RADIUS) { b.y = ROOM_HEIGHT - BULLET_RADIUS; b.vy = (b.vy ?? -BULLET_SPEED) * -1; bl--; }
      b.bouncesLeft = Math.max(0, bl);
    }
    if (b.y < -BULLET_RADIUS || b.y > ROOM_HEIGHT + BULLET_RADIUS || b.x < -BULLET_RADIUS || b.x > ROOM_WIDTH + BULLET_RADIUS) toRemoveBullets.add(b.id);
  });
  toRemoveBullets.forEach((id) => bullets.delete(id));

  // Spawn bullets at player center (bulletCount upgrades = multiple bullets)
  if (gameStarted && gamePhase === 'playing' && lives > 0) {
    players.forEach((p) => {
      const count = p.bulletCount ?? 1;
      const bounceCount = p.bounceCount ?? 0;
      for (let i = 0; i < count; i++) {
        const dx = count > 1 ? (i - (count - 1) / 2) * 16 : 0;
        const bullet = {
          id: nextBulletId++,
          x: p.x + dx,
          y: p.y,
          ownerId: p.id,
          radius: BULLET_RADIUS,
        };
        if (bounceCount > 0) {
          bullet.vx = 0;
          bullet.vy = -BULLET_SPEED;
          bullet.bouncesLeft = bounceCount;
        }
        bullets.set(bullet.id, bullet);
      }
      // Melee: 1 homing bullet per 4 ticks when ball within 200px
      const meleeDmg = p.meleeDamage ?? 0;
      if (meleeDmg > 0 && tickCount % MELEE_BULLET_INTERVAL === 0) {
        let nearest = null;
        let nearestDist = MELEE_RANGE;
        balls.forEach((b) => {
          const d = Math.hypot(b.x - p.x, b.y - p.y);
          if (d < nearestDist) { nearest = b; nearestDist = d; }
        });
        if (nearest) {
          bullets.set(nextBulletId, {
            id: nextBulletId++,
            x: p.x,
            y: p.y,
            ownerId: p.id,
            radius: BULLET_RADIUS,
            homing: true,
            targetBallId: nearest.id,
            damage: meleeDmg,
          });
        }
      }
    });
  }
  // Burn damage: 1 per tick for balls that are burning
  balls.forEach((b) => {
    if (b.burnEndTick != null && tickCount < b.burnEndTick) {
      b.hp -= 1;
      if (b.hp <= 0) toRemoveBalls.add(b.id);
    }
  });

  // Move balls down - off bottom = -1 life (shared)
  balls.forEach((b) => {
    b.y += b.speed;
    if (b.y > ROOM_HEIGHT + b.radius) {
      toRemoveBalls.add(b.id);
      lives--;
    }
  });
  toRemoveBalls.forEach((id) => balls.delete(id));
  if (lives < 0) lives = 0;

  // Broadcast state
  io.emit('state', {
    gameStarted,
    gamePhase,
    wave,
    lives,
    cardSelectionEndTime,
    players: Array.from(players.values()).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      offeredCards: p.offeredCards,
      criticalChance: p.criticalChance ?? 0,
      pierceChance: p.pierceChance ?? 0,
      areaDamageLevel: p.areaDamageLevel ?? 0,
      bulletCount: p.bulletCount ?? 1,
      pusherChance: p.pusherChance ?? 0,
      ignitionChance: p.ignitionChance ?? 0,
      meleeDamage: p.meleeDamage ?? 0,
      bounceCount: p.bounceCount ?? 0,
    })),
    bullets: Array.from(bullets.values()),
    balls: Array.from(balls.values()).map((b) => ({
      ...b,
      burning: b.burnEndTick != null && tickCount < b.burnEndTick,
    })),
    areaDamageHits,
    bulletHits,
  });
}

io.on('connection', (socket) => {
  const id = nextPlayerId++;
  const player = {
    id,
    socket,
    x: ROOM_WIDTH / 2,
    y: ROOM_HEIGHT - 80,
    criticalChance: 0,
    pierceChance: 0,
    areaDamageLevel: 0,
    bulletCount: 1,
    pusherChance: 0,
    ignitionChance: 0,
    meleeDamage: 0,
    bounceCount: 0,
    keys: { left: false, right: false, up: false, down: false },
    lastActivity: Date.now(),
  };
  players.set(id, player);
  socket.playerId = id;

  socket.emit('joined', { id, width: ROOM_WIDTH, height: ROOM_HEIGHT, gameStarted });

  socket.on('startGame', () => {
    gameStarted = true;
    player.lastActivity = Date.now();
  });

  socket.on('restartGame', () => {
    resetGame();
    gameStarted = true;
    player.lastActivity = Date.now();
  });

  socket.on('selectCard', (cardIndex) => {
    if (gamePhase !== 'cardSelection' || !player.offeredCards || player.cardSelected) return;
    const card = player.offeredCards[cardIndex];
    if (!card) return;
    player.cardSelected = true;
    if (card.id === 'critical') player.criticalChance = (player.criticalChance ?? 0) + 10;
    else if (card.id === 'piercing') player.pierceChance = (player.pierceChance ?? 0) + 10;
    else if (card.id === 'areaDamage') player.areaDamageLevel = (player.areaDamageLevel ?? 0) + 1;
    else if (card.id === 'bulletCount') player.bulletCount = (player.bulletCount ?? 1) + 1;
    else if (card.id === 'pusher') player.pusherChance = (player.pusherChance ?? 0) + 5;
    else if (card.id === 'extraLife') lives++;
    else if (card.id === 'ignition') player.ignitionChance = (player.ignitionChance ?? 0) + 1;
    else if (card.id === 'melee') player.meleeDamage = (player.meleeDamage ?? 0) + 1;
    else if (card.id === 'bouncyBullets') player.bounceCount = (player.bounceCount ?? 0) + 1;
  });

  socket.on('keys', (keys) => {
    if (player) {
      player.keys = keys;
      player.lastActivity = Date.now();
    }
  });

  socket.on('disconnect', () => {
    players.delete(id);
  });
});

// Inactivity check - disconnect idle players
setInterval(() => {
  const now = Date.now();
  const toDisconnect = [];
  players.forEach((player) => {
    if (now - player.lastActivity > INACTIVITY_TIMEOUT_MS) {
      toDisconnect.push(player);
    }
  });
  toDisconnect.forEach((p) => p.socket?.disconnect(true));
}, 5000);

setInterval(gameTick, TICK_MS);

server.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});
