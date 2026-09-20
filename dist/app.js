import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  DuoTetrisGame,
  SHAPES,
  getPieceCells,
} from "./tetris-core.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  board: $("#game-board"),
  roomCode: $("#room-code"),
  copyCode: $("#copy-code"),
  joinCode: $("#join-code"),
  joinButton: $("#join-button"),
  localDuo: $("#local-duo"),
  connection: $("#connection-status"),
  connectionLabel: $("#connection-label"),
  latency: $("#latency"),
  liveMark: $(".live-mark"),
  liveLabel: $("#live-label"),
  modeLabel: $("#mode-label"),
  overlay: $("#game-overlay"),
  overlayKicker: $("#overlay-kicker"),
  overlayTitle: $("#overlay-title"),
  overlayCopy: $("#overlay-copy"),
  overlayAction: $("#overlay-action"),
  countdown: $("#countdown"),
  level: $("#level-value"),
  levelTrack: $("#level-track"),
  score: $("#score-value"),
  lines: $("#lines-value"),
  speed: $("#speed-value"),
  restart: $("#restart-button"),
  sound: $("#sound-button"),
  toast: $("#toast"),
  p1Role: $("#p1-role"),
  p2Role: $("#p2-role"),
  p1HoldState: $("#p1-hold-state"),
  p2HoldState: $("#p2-hold-state"),
};

const previewCanvases = {
  1: {
    hold: $("#p1-hold"),
    queue: [$("#p1-next-0"), $("#p1-next-1")],
  },
  2: {
    hold: $("#p2-hold"),
    queue: [$("#p2-next-0"), $("#p2-next-1")],
  },
};

const COLORS = {
  1: { main: "#ff4d67", light: "#ffb0bb", dark: "#9d2036", rgb: "255,77,103" },
  2: { main: "#5c8dff", light: "#b8ceff", dark: "#254da7", rgb: "92,141,255" },
};

let game = new DuoTetrisGame();
let renderedState = game.snapshot();
let peer = null;
let connection = null;
let roomCode = "";
let role = "host";
let mode = "network";
let connected = false;
let lastFrame = performance.now();
let lastBroadcast = 0;
let lastEventSeq = 0;
let currentRound = 0;
let countdownToken = 0;
let toastTimer = null;
let pingTimer = null;
let soundEnabled = true;
let audioContext = null;
let lastInterfaceSignature = "";
let guestInputSeq = 0;
let hostGuestAck = 0;
const visualEffects = [];
const pendingGuestInputs = [];
const heldControls = new Map();
const HORIZONTAL_DAS_MS = 105;
const HORIZONTAL_ARR_MS = 28;
const SOFT_DROP_DAS_MS = 70;
const SOFT_DROP_ARR_MS = 38;

function generateRoomCode() {
  const values = new Uint16Array(1);
  crypto.getRandomValues(values);
  return String(1000 + (values[0] % 9000));
}

function roomPeerId(code) {
  return `2p-tetris-shared-v2-${code}`;
}

function setConnectionStatus(state, label, latency = null) {
  els.connection.dataset.state = state;
  els.connectionLabel.textContent = label;
  els.latency.textContent = latency === null ? "— ms" : `${Math.round(latency)} ms`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function packState(state) {
  return {
    ...state,
    board: state.board.map((row) => row.join("")).join(""),
  };
}

function unpackState(state) {
  if (Array.isArray(state.board)) return state;
  const cells = [...state.board].map(Number);
  return {
    ...state,
    board: Array.from({ length: BOARD_HEIGHT }, (_, y) => (
      cells.slice(y * BOARD_WIDTH, (y + 1) * BOARD_WIDTH)
    )),
  };
}

function send(message) {
  if (connection?.open) connection.send(message);
}

function broadcastState(force = false) {
  if (role !== "host" || !connected || !connection?.open) return;
  const now = performance.now();
  if (!force && now - lastBroadcast < 40) return;
  lastBroadcast = now;
  send({ type: "state", round: currentRound, ack: hostGuestAck, state: packState(game.snapshot()) });
}

function ingestEvents(state, round = currentRound) {
  if (round !== currentRound) {
    currentRound = round;
    lastEventSeq = 0;
    visualEffects.length = 0;
    guestInputSeq = 0;
    pendingGuestInputs.length = 0;
  }
  for (const event of state.events ?? []) {
    if (event.seq <= lastEventSeq) continue;
    lastEventSeq = event.seq;
    if (["hardDrop", "lineClear", "displace", "gameOver"].includes(event.type)) {
      visualEffects.push({ ...event, startedAt: performance.now() });
    }
    if (event.type === "lineClear") playSound("line", 0, event.count);
    if (event.type === "hardDrop") playSound("drop", event.player);
    if (event.type === "hold") playSound("hold", event.player);
    if (event.type === "gameOver") playSound("gameover");
  }
}

function setRenderedState(state, round = currentRound) {
  renderedState = unpackState(state);
  ingestEvents(renderedState, round);
  const signature = getInterfaceSignature(renderedState);
  if (signature !== lastInterfaceSignature) {
    lastInterfaceSignature = signature;
    updateInterface(renderedState);
  }
}

function beginMatch(matchMode = mode) {
  mode = matchMode;
  role = matchMode === "local" ? "local" : "host";
  currentRound += 1;
  lastEventSeq = 0;
  hostGuestAck = 0;
  guestInputSeq = 0;
  pendingGuestInputs.length = 0;
  heldControls.clear();
  visualEffects.length = 0;
  game.reset("countdown");
  setRenderedState(game.snapshot(), currentRound);
  updateRoleLabels();
  startCountdown();
}

async function startCountdown() {
  const token = ++countdownToken;
  els.overlay.classList.add("hidden");
  els.liveLabel.textContent = "SYNCING";
  els.liveMark.classList.remove("active");

  for (const value of [3, 2, 1]) {
    if (token !== countdownToken) return;
    els.countdown.textContent = value;
    els.countdown.classList.remove("pop");
    void els.countdown.offsetWidth;
    els.countdown.classList.add("pop");
    send({ type: "countdown", value, round: currentRound, state: packState(game.snapshot()) });
    await new Promise((resolve) => setTimeout(resolve, 760));
  }

  if (token !== countdownToken) return;
  els.countdown.textContent = "GO";
  els.countdown.classList.remove("pop");
  void els.countdown.offsetWidth;
  els.countdown.classList.add("pop");
  game.start();
  setRenderedState(game.snapshot(), currentRound);
  broadcastState(true);
  setTimeout(() => {
    if (token === countdownToken) els.countdown.textContent = "";
  }, 650);
}

function showRemoteCountdown(value, round, state) {
  if (round !== currentRound) {
    currentRound = round;
    lastEventSeq = 0;
    guestInputSeq = 0;
    pendingGuestInputs.length = 0;
    heldControls.clear();
    visualEffects.length = 0;
  }
  if (state) setRenderedState(state, round);
  els.overlay.classList.add("hidden");
  els.countdown.textContent = value;
  els.countdown.classList.remove("pop");
  void els.countdown.offsetWidth;
  els.countdown.classList.add("pop");
}

function closeConnection() {
  clearInterval(pingTimer);
  pingTimer = null;
  if (connection) {
    const old = connection;
    connection = null;
    old.close();
  }
  connected = false;
  pendingGuestInputs.length = 0;
  heldControls.clear();
}

function rejectConnection(candidate, reason = "Room is busy") {
  candidate.on("open", () => {
    candidate.send({ type: "reject", reason });
    setTimeout(() => candidate.close(), 100);
  });
}

function attachConnection(candidate, incoming) {
  if (connection && connection !== candidate) closeConnection();
  connection = candidate;

  candidate.on("open", () => {
    connected = true;
    if (incoming) {
      role = "host";
      mode = "network";
      setConnectionStatus("connected", "Player 2 connected");
      updateRoleLabels();
      beginMatch("network");
    } else {
      role = "guest";
      mode = "network";
      setConnectionStatus("connected", "Connected as Player 2");
      updateRoleLabels();
      send({ type: "hello", version: 2 });
      startPingLoop();
    }
  });

  candidate.on("data", (data) => handleNetworkMessage(data));
  candidate.on("close", () => {
    if (candidate !== connection) return;
    connection = null;
    connected = false;
    clearInterval(pingTimer);
    setConnectionStatus("error", "Connection lost");
    showDisconnectedOverlay();
  });
  candidate.on("error", () => {
    if (candidate !== connection) return;
    setConnectionStatus("error", "Connection error");
  });
}

function handleNetworkMessage(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "input" && role === "host") {
    if (Number.isInteger(data.seq)) hostGuestAck = Math.max(hostGuestAck, data.seq);
    game.applyAction(2, data.action);
    setRenderedState(game.snapshot(), currentRound);
    broadcastState(true);
  } else if (data.type === "state" && role === "guest") {
    reconcileGuestState(data.state, data.round, data.ack);
    if (renderedState.status === "playing") els.countdown.textContent = "";
  } else if (data.type === "countdown" && role === "guest") {
    showRemoteCountdown(data.value, data.round, data.state);
  } else if (data.type === "restart" && role === "host") {
    beginMatch("network");
  } else if (data.type === "ping" && role === "host") {
    send({ type: "pong", sentAt: data.sentAt });
  } else if (data.type === "pong" && role === "guest") {
    const latency = performance.now() - data.sentAt;
    setConnectionStatus("connected", "Connected as Player 2", latency);
    send({ type: "latency", value: latency });
  } else if (data.type === "latency" && role === "host") {
    setConnectionStatus("connected", "Player 2 connected", data.value);
  } else if (data.type === "reject") {
    showToast(data.reason || "That room cannot be joined");
    closeConnection();
    role = "host";
    setConnectionStatus("waiting", "Room open");
  }
}

function startPingLoop() {
  clearInterval(pingTimer);
  const ping = () => send({ type: "ping", sentAt: performance.now() });
  ping();
  pingTimer = setInterval(ping, 1200);
}

function claimRoom(attempt = 0) {
  if (!window.Peer) {
    els.roomCode.textContent = "OFF";
    setConnectionStatus("error", "Online rooms unavailable");
    showToast("Online signaling did not load. Local duo still works.");
    return;
  }

  roomCode = generateRoomCode();
  els.roomCode.textContent = roomCode;
  peer = new window.Peer(roomPeerId(roomCode), { debug: 0 });

  peer.on("open", () => setConnectionStatus("waiting", "Room open"));
  peer.on("connection", (candidate) => {
    if (role !== "host" || connection || mode === "local") {
      rejectConnection(candidate);
      return;
    }
    attachConnection(candidate, true);
  });
  peer.on("error", (error) => {
    if (error?.type === "unavailable-id" && attempt < 8) {
      peer.destroy();
      peer = null;
      claimRoom(attempt + 1);
      return;
    }
    if (error?.type === "peer-unavailable" && role === "guest") {
      showToast("No open room uses that code.");
      closeConnection();
      role = "host";
      setConnectionStatus("waiting", "Room open");
      updateRoleLabels();
      return;
    }
    setConnectionStatus("error", "Room service unavailable");
  });
}

function joinRoom() {
  const code = els.joinCode.value.replace(/\D/g, "").slice(0, 4);
  els.joinCode.value = code;
  if (code.length !== 4) {
    showToast("Enter a four-digit room code.");
    els.joinCode.focus();
    return;
  }
  if (!peer?.open) {
    showToast("Your room is still opening. Try again in a moment.");
    return;
  }
  if (code === roomCode) {
    showToast("That is your own room code.");
    return;
  }

  closeConnection();
  countdownToken += 1;
  role = "guest";
  mode = "network";
  setConnectionStatus("waiting", "Connecting…");
  updateRoleLabels();
  const candidate = peer.connect(roomPeerId(code), {
    reliable: true,
    serialization: "json",
    metadata: { game: "2p-tetris", version: 2 },
  });
  attachConnection(candidate, false);
}

function startLocalDuo() {
  closeConnection();
  setConnectionStatus("waiting", "Local duo");
  beginMatch("local");
}

function updateRoleLabels() {
  if (mode === "local") {
    els.p1Role.textContent = "A / D";
    els.p2Role.textContent = "ARROWS";
    els.modeLabel.textContent = "LOCAL · SHARED BOARD";
  } else if (role === "guest") {
    els.p1Role.textContent = "REMOTE";
    els.p2Role.textContent = "YOU";
    els.modeLabel.textContent = "ONLINE · PLAYER 2";
  } else {
    els.p1Role.textContent = "YOU";
    els.p2Role.textContent = connected ? "REMOTE" : "GUEST";
    els.modeLabel.textContent = "ONLINE · PLAYER 1";
  }
}

function showDisconnectedOverlay() {
  countdownToken += 1;
  els.countdown.textContent = "";
  if (role !== "guest" && game?.status === "playing") {
    game.status = "paused";
    setRenderedState(game.snapshot(), currentRound);
  }
  els.overlayKicker.textContent = "CONNECTION LOST";
  els.overlayTitle.textContent = "The match is paused";
  els.overlayCopy.textContent = "Start locally or use a new room code to play again.";
  els.overlayAction.textContent = "Play local duo";
  els.overlay.classList.remove("game-over");
  els.overlay.classList.remove("hidden");
}

function updateOverlay(state) {
  const isGameOver = state.status === "gameover";
  els.overlay.classList.toggle("game-over", isGameOver);
  if (state.status === "playing" || state.status === "countdown") {
    els.overlay.classList.add("hidden");
  } else if (isGameOver) {
    els.overlayKicker.textContent = "";
    els.overlayTitle.textContent = "GAME OVER";
    els.overlayCopy.textContent = "";
    els.overlayAction.textContent = role === "guest" ? "Request restart" : "Play again";
    els.overlay.classList.remove("hidden");
  } else {
    els.overlayKicker.textContent = "ROOM READY";
    els.overlayTitle.textContent = "Send your code";
    els.overlayCopy.textContent = "The match starts when Player 2 joins.";
    els.overlayAction.textContent = "Play local duo";
    els.overlay.classList.remove("hidden");
  }
}

function getInterfaceSignature(state) {
  return JSON.stringify([
    state.status,
    state.level,
    state.score,
    state.lines,
    state.speedMs,
    state.holds[1],
    state.holds[2],
    state.canHold[1],
    state.canHold[2],
    ...(state.queues[1] ?? []),
    ...(state.queues[2] ?? []),
  ]);
}

function updateInterface(state) {
  els.level.textContent = state.level;
  els.score.textContent = String(state.score).padStart(6, "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  els.lines.textContent = String(state.lines).padStart(2, "0");
  els.speed.innerHTML = `${state.speedMs} <small>ms</small>`;
  els.levelTrack.setAttribute("aria-label", `Level ${state.level} of 5`);
  [...els.levelTrack.children].forEach((item, index) => item.classList.toggle("active", index < state.level));
  els.p1HoldState.textContent = state.canHold[1] ? "READY" : "USED";
  els.p2HoldState.textContent = state.canHold[2] ? "READY" : "USED";
  els.restart.classList.remove("visible");
  els.liveLabel.textContent = state.status === "playing" ? "LIVE" : state.status === "countdown" ? "SYNCING" : "STANDBY";
  els.liveMark.classList.toggle("active", state.status === "playing");
  els.board.setAttribute("aria-label", state.status === "playing"
    ? `Shared Tetris board. Level ${state.level}, score ${state.score}, ${state.lines} lines.`
    : "Shared Tetris board, waiting to play.");
  updateOverlay(state);
  drawPreviews(state);
}

function applyLocalAction(player, action) {
  if (role === "guest") {
    if (!connection?.open || renderedState.status !== "playing") return;
    const seq = ++guestInputSeq;
    pendingGuestInputs.push({ seq, action });
    applyGuestPrediction(renderedState, player, action);
    send({ type: "input", action, seq });
    return;
  }
  if (!game || game.status !== "playing") return;
  game.applyAction(player, action);
  setRenderedState(game.snapshot(), currentRound);
  if (role === "host") broadcastState(true);
}

function applyGuestPrediction(state, player, action) {
  const piece = state.active?.[player];
  if (!piece || !["left", "right", "down"].includes(action)) return false;
  const candidate = {
    ...piece,
    x: piece.x + (action === "left" ? -1 : action === "right" ? 1 : 0),
    y: piece.y + (action === "down" ? 1 : 0),
  };
  if (!validOnSnapshot(candidate, state.board)) return false;
  state.active[player] = candidate;
  return true;
}

function reconcileGuestState(state, round, ack = 0) {
  const acknowledged = Number.isInteger(ack) ? ack : 0;
  while (pendingGuestInputs.length && pendingGuestInputs[0].seq <= acknowledged) {
    pendingGuestInputs.shift();
  }
  setRenderedState(state, round);
  for (const input of pendingGuestInputs) applyGuestPrediction(renderedState, 2, input.action);
}

function actionForNetworkKey(code) {
  const map = {
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    ArrowDown: "down", KeyS: "down",
    ArrowUp: "rotateCW", KeyW: "rotateCW", KeyX: "rotateCW",
    KeyZ: "rotateCCW",
    Space: "hardDrop", Enter: "hardDrop",
    KeyC: "hold", ShiftLeft: "hold", ShiftRight: "hold",
  };
  return map[code];
}

function localBinding(code) {
  const p1 = {
    KeyA: "left", KeyD: "right", KeyS: "down", KeyW: "rotateCW",
    KeyQ: "rotateCCW", Space: "hardDrop", KeyC: "hold",
  };
  const p2 = {
    ArrowLeft: "left", ArrowRight: "right", ArrowDown: "down", ArrowUp: "rotateCW",
    Slash: "rotateCCW", Enter: "hardDrop", ShiftRight: "hold",
  };
  if (p1[code]) return { player: 1, action: p1[code] };
  if (p2[code]) return { player: 2, action: p2[code] };
  return null;
}

function isRepeatableAction(action) {
  return ["left", "right", "down"].includes(action);
}

function holdControl(key, binding, now = performance.now()) {
  if (!isRepeatableAction(binding.action) || renderedState.status !== "playing") return;
  if (binding.action === "left" || binding.action === "right") {
    const opposite = binding.action === "left" ? "right" : "left";
    for (const [heldKey, held] of heldControls) {
      if (held.player === binding.player && held.action === opposite) heldControls.delete(heldKey);
    }
  }
  const isSoftDrop = binding.action === "down";
  heldControls.set(key, {
    ...binding,
    interval: isSoftDrop ? SOFT_DROP_ARR_MS : HORIZONTAL_ARR_MS,
    nextAt: now + (isSoftDrop ? SOFT_DROP_DAS_MS : HORIZONTAL_DAS_MS),
  });
}

function processHeldControls(now) {
  if (renderedState.status !== "playing") return;
  for (const held of heldControls.values()) {
    let repeats = 0;
    while (now >= held.nextAt && repeats < 4) {
      applyLocalAction(held.player, held.action);
      held.nextAt += held.interval;
      repeats += 1;
    }
  }
}

function requestRestart() {
  if (role === "guest") {
    send({ type: "restart" });
    showToast("Restart requested.");
  } else if (mode === "local") {
    beginMatch("local");
  } else if (connected) {
    beginMatch("network");
  } else {
    startLocalDuo();
  }
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBlock(ctx, x, y, sizeX, sizeY, player, active = false, alpha = 1) {
  const palette = COLORS[player];
  const inset = active ? Math.max(1.5, sizeX * 0.09) : Math.max(1, sizeX * 0.055);
  const bx = x + inset;
  const by = y + inset;
  const bw = sizeX - inset * 2;
  const bh = sizeY - inset * 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (active) ctx.globalCompositeOperation = "screen";
  roundedRect(ctx, bx, by, bw, bh, Math.max(2, sizeX * 0.12));
  const gradient = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  gradient.addColorStop(0, active ? palette.light : palette.main);
  gradient.addColorStop(1, active ? palette.main : palette.dark);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = active ? palette.light : `rgba(${palette.rgb}, .85)`;
  ctx.lineWidth = active ? 1.6 : 0.8;
  ctx.stroke();
  if (!active) {
    ctx.fillStyle = "rgba(255,255,255,.16)";
    roundedRect(ctx, bx + bw * 0.14, by + bh * 0.12, bw * 0.58, Math.max(1, bh * 0.08), 1);
    ctx.fill();
  }
  ctx.restore();
}

function validOnSnapshot(piece, board) {
  return getPieceCells(piece).every(({ x, y }) => (
    x >= 0 && x < BOARD_WIDTH && y < BOARD_HEIGHT && (y < 0 || board[y][x] === 0)
  ));
}

function ghostPiece(piece, board) {
  if (!piece) return null;
  let y = piece.y;
  while (validOnSnapshot({ ...piece, y: y + 1 }, board)) y += 1;
  return { ...piece, y };
}

function drawBoard(state, now) {
  const { ctx, width, height } = canvasContext(els.board);
  const cellW = width / BOARD_WIDTH;
  const cellH = height / BOARD_HEIGHT;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#090d16";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(183, 202, 255, .055)";
  ctx.lineWidth = 1;
  for (let x = 1; x < BOARD_WIDTH; x += 1) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x * cellW) + 0.5, 0);
    ctx.lineTo(Math.round(x * cellW) + 0.5, height);
    ctx.stroke();
  }
  for (let y = 1; y < BOARD_HEIGHT; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y * cellH) + 0.5);
    ctx.lineTo(width, Math.round(y * cellH) + 0.5);
    ctx.stroke();
  }

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const owner = state.board[y][x];
      if (owner) drawBlock(ctx, x * cellW, y * cellH, cellW, cellH, owner, false, 1);
    }
  }

  for (const player of [1, 2]) {
    const piece = state.active[player];
    if (!piece) continue;
    const ghost = ghostPiece(piece, state.board);
    if (ghost && ghost.y !== piece.y) {
      for (const { x, y } of getPieceCells(ghost)) {
        if (y < 0) continue;
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.strokeStyle = COLORS[player].main;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(x * cellW + 3, y * cellH + 3, cellW - 6, cellH - 6);
        ctx.restore();
      }
    }
  }

  for (const player of [1, 2]) {
    const piece = state.active[player];
    if (!piece) continue;
    for (const { x, y } of getPieceCells(piece)) {
      if (y < 0) continue;
      drawBlock(ctx, x * cellW, y * cellH, cellW, cellH, player, true, 0.48);
    }
  }

  drawEffects(ctx, cellW, cellH, width, now);
}

function drawEffects(ctx, cellW, cellH, width, now) {
  for (let index = visualEffects.length - 1; index >= 0; index -= 1) {
    const effect = visualEffects[index];
    const age = now - effect.startedAt;
    const lifetime = effect.type === "lineClear" ? 520 : effect.type === "hardDrop" ? 300 : 420;
    if (age > lifetime) {
      visualEffects.splice(index, 1);
      continue;
    }
    const progress = age / lifetime;
    const alpha = 1 - progress;

    if (effect.type === "hardDrop") {
      const palette = COLORS[effect.player];
      for (const [dx, dy] of SHAPES[effect.pieceType ?? "T"][effect.rotation] ?? []) {
        const column = effect.x + dx;
        const from = Math.max(0, effect.fromY + dy);
        const to = Math.max(from, effect.toY + dy);
        const gradient = ctx.createLinearGradient(0, from * cellH, 0, (to + 1) * cellH);
        gradient.addColorStop(0, `rgba(${palette.rgb}, 0)`);
        gradient.addColorStop(1, `rgba(${palette.rgb}, ${0.34 * alpha})`);
        ctx.fillStyle = gradient;
        ctx.fillRect(column * cellW + cellW * 0.35, from * cellH, cellW * 0.3, (to - from + 1) * cellH);
      }
      ctx.strokeStyle = `rgba(${palette.rgb}, ${0.8 * alpha})`;
      ctx.lineWidth = 2 + progress * 5;
      ctx.beginPath();
      ctx.ellipse((effect.x + 2) * cellW, Math.min(BOARD_HEIGHT, effect.toY + 3) * cellH, cellW * (1.5 + progress), cellH * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "lineClear") {
      for (const row of effect.rows ?? []) {
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, `rgba(${COLORS[1].rgb}, 0)`);
        gradient.addColorStop(0.24, `rgba(${COLORS[1].rgb}, ${0.8 * alpha})`);
        gradient.addColorStop(0.5, `rgba(255,255,255,${0.95 * alpha})`);
        gradient.addColorStop(0.76, `rgba(${COLORS[2].rgb}, ${0.8 * alpha})`);
        gradient.addColorStop(1, `rgba(${COLORS[2].rgb}, 0)`);
        ctx.fillStyle = gradient;
        const band = cellH * (0.28 + progress * 0.72);
        ctx.fillRect(0, row * cellH + (cellH - band) / 2, width, band);
      }
    } else if (effect.type === "displace") {
      ctx.fillStyle = `rgba(${COLORS[effect.player].rgb}, ${0.12 * alpha})`;
      ctx.fillRect(0, 0, width, cellH * 4);
    } else if (effect.type === "gameOver") {
      ctx.fillStyle = `rgba(255,77,103,${0.15 * alpha})`;
      ctx.fillRect(0, 0, width, cellH * 2);
    }
  }
}

function drawPiecePreview(canvas, type, player) {
  const { ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!type) return;
  const shape = SHAPES[type][0];
  const xs = shape.map(([x]) => x);
  const ys = shape.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cellsWide = maxX - minX + 1;
  const cellsHigh = maxY - minY + 1;
  const size = Math.min(width / (cellsWide + 1.4), height / (cellsHigh + 1.2));
  const offsetX = (width - cellsWide * size) / 2 - minX * size;
  const offsetY = (height - cellsHigh * size) / 2 - minY * size;
  for (const [x, y] of shape) drawBlock(ctx, offsetX + x * size, offsetY + y * size, size, size, player, false, 0.92);
}

function drawPreviews(state) {
  for (const player of [1, 2]) {
    drawPiecePreview(previewCanvases[player].hold, state.holds[player], player);
    drawPiecePreview(previewCanvases[player].queue[0], state.queues[player]?.[0], player);
    drawPiecePreview(previewCanvases[player].queue[1], state.queues[player]?.[1], player);
  }
}

function ensureAudio() {
  if (!soundEnabled) return null;
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

function playTone(frequency, duration, gain = 0.025, delay = 0) {
  const context = ensureAudio();
  if (!context) return;
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  const starts = context.currentTime + delay;
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, starts);
  volume.gain.setValueAtTime(gain, starts);
  volume.gain.exponentialRampToValueAtTime(0.0001, starts + duration);
  oscillator.connect(volume).connect(context.destination);
  oscillator.start(starts);
  oscillator.stop(starts + duration);
}

function playSound(type, player = 0, count = 1) {
  if (!soundEnabled || !audioContext) return;
  if (type === "drop") playTone(player === 1 ? 96 : 112, 0.09, 0.028);
  if (type === "hold") playTone(player === 1 ? 260 : 310, 0.06, 0.018);
  if (type === "line") {
    playTone(420, 0.16, 0.025);
    playTone(530 + count * 35, 0.2, 0.022, 0.07);
  }
  if (type === "gameover") {
    playTone(190, 0.32, 0.03);
    playTone(120, 0.4, 0.025, 0.18);
  }
}

function animate(now) {
  const delta = Math.min(100, now - lastFrame);
  lastFrame = now;
  processHeldControls(now);
  if (role !== "guest" && game?.status === "playing") {
    game.advance(delta);
    setRenderedState(game.snapshot(), currentRound);
    if (role === "host") broadcastState();
  }
  drawBoard(renderedState, now);
  requestAnimationFrame(animate);
}

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const tools = [
    {
      name: "start_local_duo",
      title: "Start local duo",
      description: "Start a new two-player 2P Tetris match on this device.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async () => {
        startLocalDuo();
        return { status: "countdown", mode: "local" };
      },
    },
    {
      name: "read_game_status",
      title: "Read game status",
      description: "Read the visible 2P Tetris match status and score.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async () => ({
        status: renderedState.status,
        mode,
        level: renderedState.level,
        score: renderedState.score,
        lines: renderedState.lines,
      }),
    },
    {
      name: "restart_game",
      title: "Restart game",
      description: "Restart the current 2P Tetris match or request a restart from the host.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async () => {
        requestRestart();
        return { requested: true, role };
      },
    },
  ];
  for (const tool of tools) Promise.resolve(context.registerTool(tool)).catch(() => {});
}

els.joinCode.addEventListener("input", () => {
  els.joinCode.value = els.joinCode.value.replace(/\D/g, "").slice(0, 4);
});
els.joinCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});
els.joinButton.addEventListener("click", joinRoom);
els.localDuo.addEventListener("click", startLocalDuo);
els.overlayAction.addEventListener("click", () => {
  if (renderedState.status === "gameover") requestRestart();
  else startLocalDuo();
});
els.restart.addEventListener("click", requestRestart);
els.copyCode.addEventListener("click", async () => {
  if (!roomCode) return;
  try {
    await navigator.clipboard.writeText(roomCode);
    showToast(`Room code ${roomCode} copied.`);
  } catch {
    showToast(`Your room code is ${roomCode}.`);
  }
});
els.sound.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  els.sound.setAttribute("aria-pressed", String(soundEnabled));
  els.sound.innerHTML = soundEnabled ? '<span aria-hidden="true">◖))</span> Sound' : '<span aria-hidden="true">◖×</span> Muted';
  if (soundEnabled) {
    ensureAudio();
    playTone(360, 0.07, 0.018);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const binding = mode === "local"
    ? localBinding(event.code)
    : { player: role === "guest" ? 2 : 1, action: actionForNetworkKey(event.code) };
  if (!binding?.action) return;
  event.preventDefault();
  if (event.repeat) return;
  ensureAudio();
  applyLocalAction(binding.player, binding.action);
  holdControl(event.code, binding);
});

document.addEventListener("keyup", (event) => heldControls.delete(event.code));
window.addEventListener("blur", () => heldControls.clear());

for (const button of $$(".touch-controls button")) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    ensureAudio();
    const player = role === "guest" ? 2 : 1;
    const binding = { player, action: button.dataset.action };
    applyLocalAction(binding.player, binding.action);
    holdControl(`pointer-${event.pointerId}`, binding);
    button.setPointerCapture?.(event.pointerId);
  });
  const release = (event) => heldControls.delete(`pointer-${event.pointerId}`);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

document.addEventListener("visibilitychange", () => {
  lastFrame = performance.now();
  if (document.hidden) heldControls.clear();
});
window.addEventListener("resize", () => drawPreviews(renderedState));
window.addEventListener("load", () => claimRoom());

updateRoleLabels();
lastInterfaceSignature = getInterfaceSignature(renderedState);
updateInterface(renderedState);
registerWebMCP();
requestAnimationFrame(animate);
