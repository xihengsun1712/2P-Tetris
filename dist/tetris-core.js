export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const LEVEL_SPEEDS = [800, 650, 500, 350, 200];
export const LOCK_DELAY_MS = 420;
export const MAX_LOCK_RESETS = 15;

const TYPES = ["I", "O", "T", "S", "Z", "J", "L"];

const BASE_SHAPES = {
  T: [[0, 1], [1, 1], [2, 1], [1, 0]],
  S: [[0, 1], [1, 1], [1, 0], [2, 0]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

const I_ROTATIONS = [
  [[0, 1], [1, 1], [2, 1], [3, 1]],
  [[2, 0], [2, 1], [2, 2], [2, 3]],
  [[0, 2], [1, 2], [2, 2], [3, 2]],
  [[1, 0], [1, 1], [1, 2], [1, 3]],
];

const O_ROTATIONS = Array.from({ length: 4 }, () => [
  [1, 0], [2, 0], [1, 1], [2, 1],
]);

function rotateAroundCenter(cells) {
  return cells.map(([x, y]) => [2 - y, x]);
}

export const SHAPES = Object.fromEntries(TYPES.map((type) => {
  if (type === "I") return [type, I_ROTATIONS];
  if (type === "O") return [type, O_ROTATIONS];
  const rotations = [BASE_SHAPES[type]];
  for (let i = 1; i < 4; i += 1) rotations.push(rotateAroundCenter(rotations[i - 1]));
  return [type, rotations];
}));

// SRS-inspired kicks. Board collision, never the other airborne piece, decides legality.
const NORMAL_KICKS = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1]];
const I_KICKS = [[0, 0], [-2, 0], [2, 0], [-1, 0], [1, 0], [0, -1], [0, -2]];

export function getPieceCells(piece) {
  if (!piece) return [];
  return SHAPES[piece.type][piece.rotation].map(([dx, dy]) => ({
    x: piece.x + dx,
    y: piece.y + dy,
  }));
}

function blankBoard() {
  return Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(0));
}

function clonePiece(piece) {
  return piece ? { ...piece } : null;
}

function makePlayerState() {
  return {
    active: null,
    hold: null,
    queue: [],
    canHold: true,
    gravityMs: 0,
    lockMs: 0,
    lockResets: 0,
  };
}

export class DuoTetrisGame {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.eventSeq = 0;
    this.events = [];
    this.lockPriority = 1;
    this.reset("waiting");
  }

  reset(status = "playing") {
    this.board = blankBoard();
    this.players = { 1: makePlayerState(), 2: makePlayerState() };
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.status = status;
    this.reason = "";
    this.events = [];
    this.eventSeq = 0;
    this.lockPriority = 1;
    if (status !== "waiting") {
      this._spawn(1);
      this._spawn(2);
    }
    return this.snapshot();
  }

  start() {
    if (!this.players[1].active || !this.players[2].active) this.reset("playing");
    this.status = "playing";
  }

  get speedMs() {
    return LEVEL_SPEEDS[this.level - 1];
  }

  _newBag() {
    const bag = [...TYPES];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  }

  _ensureQueue(player) {
    const state = this.players[player];
    while (state.queue.length < 7) state.queue.push(...this._newBag());
  }

  _takeNext(player) {
    this._ensureQueue(player);
    const next = this.players[player].queue.shift();
    this._ensureQueue(player);
    return next;
  }

  _makePiece(player, type, canHold = true) {
    return {
      player,
      type,
      rotation: 0,
      x: player === 1 ? 1 : 5,
      y: -1,
      canHold,
    };
  }

  _spawn(player, explicitType = null, canHold = true) {
    const state = this.players[player];
    const type = explicitType ?? this._takeNext(player);
    const piece = this._makePiece(player, type, canHold);
    state.active = piece;
    state.canHold = canHold;
    state.gravityMs = 0;
    state.lockMs = 0;
    state.lockResets = 0;
    if (!this._isValid(piece)) {
      this._gameOver("The stack reached a spawn zone");
      return false;
    }
    return true;
  }

  _isValid(piece) {
    return getPieceCells(piece).every(({ x, y }) => (
      x >= 0 && x < BOARD_WIDTH && y < BOARD_HEIGHT && (y < 0 || this.board[y][x] === 0)
    ));
  }

  _isGrounded(piece) {
    return !this._isValid({ ...piece, y: piece.y + 1 });
  }

  _move(player, dx, dy, countForScore = false) {
    const state = this.players[player];
    const piece = state.active;
    if (!piece) return false;
    const wasGrounded = this._isGrounded(piece);
    const candidate = { ...piece, x: piece.x + dx, y: piece.y + dy };
    if (!this._isValid(candidate)) return false;
    state.active = candidate;
    if (countForScore && dy > 0) this.score += dy;
    if (wasGrounded && state.lockResets < MAX_LOCK_RESETS) {
      state.lockMs = 0;
      state.lockResets += 1;
    }
    return true;
  }

  _rotate(player, direction = 1) {
    const state = this.players[player];
    const piece = state.active;
    if (!piece || piece.type === "O") return Boolean(piece);
    const wasGrounded = this._isGrounded(piece);
    const nextRotation = (piece.rotation + direction + 4) % 4;
    const kicks = piece.type === "I" ? I_KICKS : NORMAL_KICKS;
    for (const [dx, dy] of kicks) {
      const candidate = { ...piece, rotation: nextRotation, x: piece.x + dx, y: piece.y + dy };
      if (!this._isValid(candidate)) continue;
      state.active = candidate;
      if (wasGrounded && state.lockResets < MAX_LOCK_RESETS) {
        state.lockMs = 0;
        state.lockResets += 1;
      }
      return true;
    }
    return false;
  }

  _hardDrop(player) {
    const state = this.players[player];
    const piece = state.active;
    if (!piece) return false;
    const fromY = piece.y;
    let toY = fromY;
    while (this._isValid({ ...piece, y: toY + 1 })) toY += 1;
    state.active = { ...piece, y: toY };
    const distance = Math.max(0, toY - fromY);
    this.score += distance * 2;
    this._emit("hardDrop", {
      player,
      pieceType: piece.type,
      rotation: piece.rotation,
      x: piece.x,
      fromY,
      toY,
      distance,
    });
    this._commitLocks([player]);
    return true;
  }

  _hold(player) {
    const state = this.players[player];
    const current = state.active;
    if (!current || !state.canHold) return false;

    const outgoing = current.type;
    const incoming = state.hold === null ? this._takeNext(player) : state.hold;
    state.hold = outgoing;
    state.active = this._makePiece(player, incoming, false);
    state.canHold = false;
    state.gravityMs = 0;
    state.lockMs = 0;
    state.lockResets = 0;

    if (!this._isValid(state.active)) {
      this._gameOver("A held piece could not enter the board");
      return false;
    }
    this._emit("hold", { player, outgoing, incoming });
    return true;
  }

  applyAction(player, action) {
    if (this.status !== "playing" || !this.players[player]) return false;
    switch (action) {
      case "left": return this._move(player, -1, 0);
      case "right": return this._move(player, 1, 0);
      case "down": return this._move(player, 0, 1, true);
      case "rotateCW": return this._rotate(player, 1);
      case "rotateCCW": return this._rotate(player, -1);
      case "hardDrop": return this._hardDrop(player);
      case "hold": return this._hold(player);
      default: return false;
    }
  }

  advance(deltaMs) {
    if (this.status !== "playing") return;
    const dt = Math.max(0, Math.min(deltaMs, 100));
    const lockCandidates = [];

    for (const player of [1, 2]) {
      const state = this.players[player];
      if (!state.active) continue;
      state.gravityMs += dt;
      while (state.gravityMs >= this.speedMs) {
        state.gravityMs -= this.speedMs;
        if (!this._move(player, 0, 1)) break;
      }

      if (this._isGrounded(state.active)) {
        state.lockMs += dt;
        if (state.lockMs >= LOCK_DELAY_MS) lockCandidates.push(player);
      } else {
        state.lockMs = 0;
      }
    }

    if (lockCandidates.length) this._commitLocks(lockCandidates);
  }

  _commitLocks(playersToLock) {
    if (this.status !== "playing") return;
    const unique = [...new Set(playersToLock)].filter((p) => this.players[p]?.active);
    unique.sort((a, b) => {
      if (a === this.lockPriority) return -1;
      if (b === this.lockPriority) return 1;
      return a - b;
    });

    const accepted = [];
    const claimed = new Set();
    for (const player of unique) {
      const piece = this.players[player].active;
      const cells = getPieceCells(piece);
      const overlapsAccepted = cells.some(({ x, y }) => claimed.has(`${x},${y}`));
      if (overlapsAccepted) continue;
      accepted.push(player);
      cells.forEach(({ x, y }) => claimed.add(`${x},${y}`));
    }

    if (!accepted.length) return;
    const locking = accepted.map((player) => {
      const piece = clonePiece(this.players[player].active);
      return { player, piece, cells: getPieceCells(piece) };
    });
    if (locking.some(({ cells }) => cells.some(({ y }) => y < 0))) {
      this._gameOver("A piece locked above the board");
      return;
    }

    // Validate the complete locking batch before writing any cell, so two
    // simultaneous landings are committed atomically.
    if (locking.some(({ cells }) => cells.some(({ x, y }) => this.board[y][x] !== 0))) {
      this._gameOver("A landing conflicted with the settled board");
      return;
    }

    const lockedPieces = [];
    for (const { player, piece, cells } of locking) {
      for (const { x, y } of cells) this.board[y][x] = player;
      lockedPieces.push(piece);
      this.players[player].active = null;
    }

    this.lockPriority = this.lockPriority === 1 ? 2 : 1;
    const clearedRows = this._clearLines();
    if (clearedRows.length) this._applyLineClear(clearedRows);

    // Any still-falling piece that overlapped a newly frozen piece is displaced
    // upward as one rigid tetromino. It never freezes into occupied cells.
    for (const player of [1, 2]) {
      if (!this.players[player].active) continue;
      if (!this._resolveAirborneOverlap(player)) return;
    }

    for (const piece of lockedPieces) {
      if (this.status !== "playing") break;
      this._spawn(piece.player);
      this._emit("lock", { player: piece.player });
    }
  }

  _resolveAirborneOverlap(player) {
    const state = this.players[player];
    if (this._isValid(state.active)) return true;
    const original = state.active;
    for (let lift = 1; lift <= BOARD_HEIGHT + 4; lift += 1) {
      const candidate = { ...original, y: original.y - lift };
      if (!this._isValid(candidate)) continue;
      state.active = candidate;
      state.lockMs = 0;
      state.gravityMs = 0;
      this._emit("displace", { player, cells: lift });
      return true;
    }
    this._gameOver("Two pieces could not resolve their landing");
    return false;
  }

  _clearLines() {
    const rows = [];
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      if (this.board[y].every(Boolean)) rows.push(y);
    }
    if (!rows.length) return rows;

    const rowSet = new Set(rows);
    const remaining = this.board.filter((_, y) => !rowSet.has(y));
    this.board = [
      ...Array.from({ length: rows.length }, () => Array(BOARD_WIDTH).fill(0)),
      ...remaining,
    ];

    // Settled rows above a clear fall; airborne pieces above those rows follow.
    for (const player of [1, 2]) {
      const piece = this.players[player].active;
      if (!piece) continue;
      const maxY = Math.max(...getPieceCells(piece).map((cell) => cell.y));
      const rowsBelow = rows.filter((row) => row > maxY).length;
      if (rowsBelow) piece.y += rowsBelow;
    }
    return rows;
  }

  _applyLineClear(rows) {
    const count = rows.length;
    const scoreTable = [0, 100, 300, 500, 800, 1200, 1600, 2000, 2400];
    const points = (scoreTable[count] ?? (count * 300)) * this.level;
    this.score += points;
    this.lines += count;
    this.level = Math.min(5, Math.floor(this.lines / 5) + 1);
    this._emit("lineClear", { rows, count, points });
  }

  _emit(type, data = {}) {
    const event = { seq: ++this.eventSeq, type, ...data };
    this.events.push(event);
    if (this.events.length > 24) this.events.shift();
    return event;
  }

  _gameOver(reason) {
    this.status = "gameover";
    this.reason = reason;
    this._emit("gameOver", { reason });
  }

  snapshot() {
    return {
      board: this.board.map((row) => [...row]),
      active: {
        1: clonePiece(this.players[1].active),
        2: clonePiece(this.players[2].active),
      },
      holds: { 1: this.players[1].hold, 2: this.players[2].hold },
      canHold: { 1: this.players[1].canHold, 2: this.players[2].canHold },
      queues: {
        1: this.players[1].queue.slice(0, 2),
        2: this.players[2].queue.slice(0, 2),
      },
      score: this.score,
      lines: this.lines,
      level: this.level,
      speedMs: this.speedMs,
      status: this.status,
      reason: this.reason,
      events: this.events.map((event) => ({ ...event, rows: event.rows ? [...event.rows] : undefined })),
    };
  }
}
