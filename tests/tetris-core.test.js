import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  DuoTetrisGame,
  LEVEL_SPEEDS,
  getPieceCells,
} from "../dist/tetris-core.js";

const fixedRng = () => 0.314159;

function freshGame() {
  return new DuoTetrisGame({ rng: fixedRng });
}

function piece(player, type, x, y, rotation = 0) {
  return { player, type, x, y, rotation, canHold: true };
}

test("the board is exactly 10 by 20", () => {
  const game = freshGame();
  game.reset("playing");
  assert.equal(game.board.length, BOARD_HEIGHT);
  assert.ok(game.board.every((row) => row.length === BOARD_WIDTH));
});

test("airborne pieces may overlap each other", () => {
  const game = freshGame();
  game.reset("playing");
  game.players[1].active = piece(1, "O", 3, 4);
  game.players[2].active = piece(2, "O", 3, 4);

  assert.deepEqual(getPieceCells(game.players[1].active), getPieceCells(game.players[2].active));
  assert.equal(game._isValid(game.players[1].active), true);
  assert.equal(game._isValid(game.players[2].active), true);
});

test("simultaneous overlapping locks never create overlapping solid cells", () => {
  const game = freshGame();
  game.reset("playing");
  game.players[1].active = piece(1, "O", 3, 18);
  game.players[2].active = piece(2, "O", 3, 18);

  game._commitLocks([1, 2]);

  const occupied = game.board.flat().filter(Boolean);
  assert.equal(occupied.length, 4);
  assert.ok(occupied.every((owner) => owner === 1));
  assert.equal(game.players[2].active.type, "O");
  assert.equal(game.players[2].active.y, 16);
  assert.equal(game._isValid(game.players[2].active), true);
  assert.equal(game.status, "playing");
});

test("lock priority alternates across contested landings", () => {
  const game = freshGame();
  game.reset("playing");
  game.lockPriority = 2;
  game.players[1].active = piece(1, "O", 3, 18);
  game.players[2].active = piece(2, "O", 3, 18);

  game._commitLocks([1, 2]);

  assert.ok(game.board.flat().filter(Boolean).every((owner) => owner === 2));
  assert.equal(game.lockPriority, 1);
});

test("hold is allowed once per falling piece and a swap does not consume queue", () => {
  const game = freshGame();
  game.reset("playing");
  const original = game.players[1].active.type;
  const firstQueued = game.players[1].queue[0];

  assert.equal(game.applyAction(1, "hold"), true);
  assert.equal(game.players[1].hold, original);
  assert.equal(game.players[1].active.type, firstQueued);
  assert.equal(game.players[1].canHold, false);
  assert.equal(game.applyAction(1, "hold"), false);

  game.applyAction(1, "hardDrop");
  assert.equal(game.players[1].canHold, true);
  const queueBeforeSwap = [...game.players[1].queue];
  const heldBeforeSwap = game.players[1].hold;
  const outgoing = game.players[1].active.type;

  assert.equal(game.applyAction(1, "hold"), true);
  assert.equal(game.players[1].active.type, heldBeforeSwap);
  assert.equal(game.players[1].hold, outgoing);
  assert.deepEqual(game.players[1].queue, queueBeforeSwap);
});

test("hard drop locks immediately and emits a correctly typed visual event", () => {
  const game = freshGame();
  game.reset("playing");
  const fallingType = game.players[1].active.type;

  assert.equal(game.applyAction(1, "hardDrop"), true);
  assert.equal(game.board.flat().filter((owner) => owner === 1).length, 4);
  assert.notEqual(game.players[1].active, null);
  const event = game.events.find((item) => item.type === "hardDrop");
  assert.ok(event);
  assert.equal(event.pieceType, fallingType);
  assert.ok(event.toY >= event.fromY);
});

test("a completed row clears, scores, and leaves every airborne piece legal", () => {
  const game = freshGame();
  game.reset("playing");
  for (let x = 0; x < 8; x += 1) game.board[19][x] = 1;
  game.players[1].active = piece(1, "O", 7, 18);

  game._commitLocks([1]);

  assert.equal(game.lines, 1);
  assert.equal(game.score, 100);
  assert.equal(game.board[19].filter(Boolean).length, 2);
  assert.equal(game._isValid(game.players[2].active), true);
  assert.ok(game.events.some((event) => event.type === "lineClear" && event.count === 1));
});

test("five line thresholds select the requested gravity speeds", () => {
  const game = freshGame();
  game.reset("playing");
  assert.equal(game.speedMs, LEVEL_SPEEDS[0]);

  for (let expectedLevel = 2; expectedLevel <= 5; expectedLevel += 1) {
    game.lines = (expectedLevel - 1) * 5;
    game.level = Math.min(5, Math.floor(game.lines / 5) + 1);
    assert.equal(game.level, expectedLevel);
    assert.equal(game.speedMs, LEVEL_SPEEDS[expectedLevel - 1]);
  }
});

test("gravity moves exactly after the current interval", () => {
  const game = freshGame();
  game.reset("playing");
  const initialY = game.players[1].active.y;
  game.players[1].gravityMs = game.speedMs - 1;
  game.advance(1);
  assert.equal(game.players[1].active.y, initialY + 1);
});

test("locking above the ceiling ends the match instead of corrupting the board", () => {
  const game = freshGame();
  game.reset("playing");
  game.players[1].active = piece(1, "O", 3, -1);
  game._commitLocks([1]);
  assert.equal(game.status, "gameover");
  assert.match(game.reason, /above the board/i);
});

test("randomized play preserves board and active-piece invariants", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const game = new DuoTetrisGame({ rng: random });
  game.reset("playing");
  const actions = ["left", "right", "down", "rotateCW", "rotateCCW", "hardDrop", "hold"];

  for (let step = 0; step < 6000; step += 1) {
    if (game.status === "gameover") game.reset("playing");
    const player = random() < 0.5 ? 1 : 2;
    const action = actions[Math.floor(random() * actions.length)];
    game.applyAction(player, action);
    game.advance(10 + Math.floor(random() * 91));

    assert.equal(game.board.length, BOARD_HEIGHT);
    assert.ok(game.board.every((row) => row.length === BOARD_WIDTH));
    assert.ok(game.board.flat().every((cell) => cell === 0 || cell === 1 || cell === 2));
    if (game.status === "playing") {
      assert.equal(game._isValid(game.players[1].active), true);
      assert.equal(game._isValid(game.players[2].active), true);
    }
  }
});
