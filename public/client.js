const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const playersCountEl = document.getElementById('players-count');
const waveEl = document.getElementById('wave');
const livesEl = document.getElementById('lives');
const playerListEl = document.getElementById('player-list');
const cardOverlay = document.getElementById('card-overlay');
const cardChoices = document.getElementById('card-choices');
const cardTimer = document.getElementById('card-timer');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

const PLAYER_RADIUS = 20;
const BULLET_RADIUS = 6;
const SERVER_TICK_MS = 1000 / 15;
const BULLET_SPEED = 75; // px per tick, must match server
const PX_PER_MS_BULLET = (BULLET_SPEED / SERVER_TICK_MS);
const INTERP_DELAY_MS = 50; // Small delay for smooth interpolation without heavy input lag

// Ball colors by type
const BALL_COLORS = {
  normal: '#f59e0b',
  fast: '#06b6d4',
  big: '#8b5cf6',
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpEntity(a, b, t) {
  if (!a) return b;
  return {
    ...b,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
}

function lerpState(stateA, stateB, t) {
  if (!stateA) return stateB;
  const players = stateB.players.map((pb) => {
    const pa = stateA.players.find((p) => p.id === pb.id);
    return lerpEntity(pa, pb, t);
  });
  const bullets = stateB.bullets.map((bb) => {
    const ba = stateA.bullets.find((b) => b.id === bb.id);
    return lerpEntity(ba, bb, t);
  });
  const balls = stateB.balls.map((bb) => {
    const ba = stateA.balls.find((b) => b.id === bb.id);
    const lerped = lerpEntity(ba, bb, t);
    return { ...bb, ...lerped };
  });
  return {
    gameStarted: stateB.gameStarted,
    gamePhase: stateB.gamePhase,
    cardSelectionEndTime: stateB.cardSelectionEndTime,
    players,
    bullets,
    balls,
    areaDamageHits: stateB.areaDamageHits || [],
    bulletHits: stateB.bulletHits || [],
    lives: stateB.lives,
  };
}

let myId = null;
const stateBuffer = [];
const MAX_BUFFER_MS = 400;
const impactEffects = [];
const IMPACT_DURATION_MS = 200;

const socket = io();

socket.on('joined', ({ id, width, height, gameStarted }) => {
  myId = id;
  statusEl.textContent = 'Connected';
  statusEl.classList.add('connected');
  statusEl.classList.remove('disconnected');
  updateMenuVisibility(gameStarted);
});

socket.on('state', (state) => {
  const now = performance.now();
  const snapshot = {
    time: now,
    state: {
      gameStarted: state.gameStarted,
      gamePhase: state.gamePhase,
      cardSelectionEndTime: state.cardSelectionEndTime,
      players: state.players.map((p) => ({ ...p })),
      bullets: state.bullets.map((b) => ({ ...b })),
      balls: state.balls.map((b) => ({ ...b })),
      areaDamageHits: state.areaDamageHits || [],
      bulletHits: state.bulletHits || [],
      lives: state.lives ?? 10,
      gamePhase: state.gamePhase,
    },
  };
  stateBuffer.push(snapshot);
  // Trim old states
  const cutoff = now - MAX_BUFFER_MS;
  while (stateBuffer.length > 1 && stateBuffer[1].time < cutoff) {
    stateBuffer.shift();
  }
  updateMenuVisibility(state.gameStarted);
  playersCountEl.textContent = `${state.players.length} player${state.players.length !== 1 ? 's' : ''}`;
  waveEl.textContent = `Wave ${state.wave ?? 1}`;
  livesEl.textContent = `❤ ${state.lives ?? 10}`;
  const gameOverOverlay = document.getElementById('game-over-overlay');
  const restartGameOverBtn = document.getElementById('restart-game-over-btn');
  if (state.gamePhase === 'gameOver') {
    gameOverOverlay.classList.remove('hidden');
  } else {
    gameOverOverlay.classList.add('hidden');
  }
  restartGameOverBtn.onclick = () => socket.emit('restartGame');
  (state.bulletHits || []).forEach((h) => impactEffects.push({ x: h.x, y: h.y, t: 0 }));
  const me = state.players?.find((p) => p.id === myId);
  if (state.gamePhase === 'cardSelection' && me?.offeredCards?.length) {
    cardOverlay.classList.remove('hidden');
    if (cardChoices.children.length === 0 || cardChoices.children.length !== me.offeredCards.length) {
      cardChoices.innerHTML = me.offeredCards.map((card, i) =>
        `<div class="card-option" data-index="${i}"><div class="card-name">${card.name}</div><div class="card-desc">${card.desc}</div></div>`
      ).join('');
      cardChoices.querySelectorAll('.card-option').forEach((el) => {
        el.onclick = () => {
          socket.emit('selectCard', parseInt(el.dataset.index, 10));
          cardOverlay.classList.add('hidden');
        };
      });
    }
    const remaining = Math.max(0, Math.ceil((state.cardSelectionEndTime - Date.now()) / 1000));
    cardTimer.textContent = `${remaining}s to choose`;
  } else {
    cardOverlay.classList.add('hidden');
  }
  playerListEl.innerHTML = (state.players || []).map((p) => {
    const isMe = p.id === myId;
    return `<div class="player-row ${isMe ? 'me' : ''}"><span class="name">${isMe ? 'You' : `Player ${p.id}`}</span></div>`;
  }).join('');
});

socket.on('disconnect', () => {
  statusEl.textContent = 'Disconnected';
  statusEl.classList.remove('connected');
  statusEl.classList.add('disconnected');
});

function updateMenuVisibility(gameStarted) {
  if (gameStarted) {
    startBtn.classList.add('hidden');
    restartBtn.classList.remove('hidden');
  } else {
    startBtn.classList.remove('hidden');
    restartBtn.classList.add('hidden');
  }
}

startBtn.addEventListener('click', () => socket.emit('startGame'));
restartBtn.addEventListener('click', () => socket.emit('restartGame'));

// Keyboard input
const keys = { left: false, right: false, up: false, down: false };

document.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = true;
      e.preventDefault();
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = true;
      e.preventDefault();
      break;
    case 'KeyW':
    case 'ArrowUp':
      keys.up = true;
      e.preventDefault();
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.down = true;
      e.preventDefault();
      break;
  }
});

document.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = false;
      break;
    case 'KeyD':
    case 'ArrowRight':
      keys.right = false;
      break;
    case 'KeyW':
    case 'ArrowUp':
      keys.up = false;
      break;
    case 'KeyS':
    case 'ArrowDown':
      keys.down = false;
      break;
  }
});

function sendKeys() {
  socket.emit('keys', { ...keys });
  requestAnimationFrame(sendKeys);
}
requestAnimationFrame(sendKeys);

function getInterpolatedState() {
  if (stateBuffer.length === 0) return null;
  const now = performance.now();
  const renderTime = now - INTERP_DELAY_MS;

  // Find two states to interpolate between
  let prev = stateBuffer[0];
  let next = stateBuffer[stateBuffer.length - 1];

  for (let i = 0; i < stateBuffer.length - 1; i++) {
    if (stateBuffer[i].time <= renderTime && stateBuffer[i + 1].time >= renderTime) {
      prev = stateBuffer[i];
      next = stateBuffer[i + 1];
      break;
    }
  }

  let state;
  if (prev === next) {
    state = prev.state;
  } else {
    const dt = next.time - prev.time || 1;
    const alpha = Math.min(1, Math.max(0, (renderTime - prev.time) / dt));
    state = lerpState(prev.state, next.state, alpha);
  }

  // Bullets: use latest state + extrapolate to "now" so they appear/disappear at correct positions
  const latest = stateBuffer[stateBuffer.length - 1];
  if (latest) {
    const elapsed = now - latest.time;
    state = {
      ...state,
      bullets: latest.state.bullets.map((b) => {
        if (b.homing) return { ...b }; // homing bullets move toward target - no simple extrapolation
        if (b.vx != null || b.vy != null) {
          const ticks = elapsed / SERVER_TICK_MS;
          return {
            ...b,
            x: b.x + (b.vx ?? 0) * ticks,
            y: b.y + (b.vy ?? -BULLET_SPEED) * ticks,
          };
        }
        return {
          ...b,
          y: b.y - PX_PER_MS_BULLET * elapsed,
        };
      }),
    };
  }
  return state;
}

function draw() {
  const gameState = getInterpolatedState();
  if (!gameState) {
    requestAnimationFrame(draw);
    return;
  }

  const { players, bullets, balls, areaDamageHits = [] } = gameState;
  const now = performance.now();

  for (let i = impactEffects.length - 1; i >= 0; i--) {
    const e = impactEffects[i];
    e.t += 16;
    const p = Math.min(1, e.t / IMPACT_DURATION_MS);
    const r = 8 + p * 20;
    const alpha = 1 - p;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251, 191, 36, ${alpha * 0.8})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(251, 191, 36, ${alpha * 0.4})`;
    ctx.fill();
    if (e.t >= IMPACT_DURATION_MS) impactEffects.splice(i, 1);
  }

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  areaDamageHits.forEach((h) => {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 100, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();
  });
  balls.forEach((ball) => {
    const color = BALL_COLORS[ball.type] || '#666';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (ball.burning) {
      const t = performance.now() * 0.003;
      const flicker = 0.85 + Math.sin(t) * 0.15;
      const g = ctx.createRadialGradient(ball.x, ball.y, ball.radius * 0.5, ball.x, ball.y, ball.radius * 1.8);
      g.addColorStop(0, `rgba(251, 146, 60, ${0.6 * flicker})`);
      g.addColorStop(0.6, `rgba(239, 68, 68, ${0.3 * flicker})`);
      g.addColorStop(1, 'rgba(220, 38, 38, 0)');
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
    const barW = ball.radius * 1.5;
    const barH = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ball.x - barW / 2, ball.y - ball.radius - 8, barW, barH);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(ball.x - barW / 2, ball.y - ball.radius - 8, barW * (ball.hp / ball.maxHp), barH);
  });

  bullets.forEach((b) => {
    const r = b.radius ?? BULLET_RADIUS;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = b.homing ? '#ef4444' : '#fbbf24';
    ctx.fill();
    ctx.strokeStyle = b.homing ? '#dc2626' : '#f59e0b';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  players.forEach((p) => {
    const isMe = p.id === myId;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#22c55e' : '#3b82f6';
    ctx.fill();
    ctx.strokeStyle = isMe ? '#4ade80' : '#60a5fa';
    ctx.lineWidth = 3;
    ctx.stroke();
    if (isMe) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(p.x - 5, p.y - 5, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  requestAnimationFrame(draw);
}

requestAnimationFrame(draw);
