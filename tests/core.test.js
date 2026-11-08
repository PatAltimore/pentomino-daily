const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../site/core.js');

const SIZES = [
  [5, 6],
  [6, 5],
  [5, 4],
  [4, 5],
  [5, 8],
];

function connected(cells) {
  const set = new Set(cells.map((c) => c.join(',')));
  const seen = new Set([cells[0].join(',')]);
  const stack = [cells[0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = x + dx + ',' + (y + dy);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push([x + dx, y + dy]);
      }
    }
  }
  return seen.size === cells.length;
}

test('orientation counts add up to the 63 fixed pentominoes', () => {
  const expected = { F: 8, I: 2, L: 8, N: 8, P: 8, T: 4, U: 4, V: 4, W: 4, X: 1, Y: 8, Z: 4 };
  let total = 0;
  for (const [letter, n] of Object.entries(expected)) {
    assert.equal(C.ORIENTS[letter].length, n, letter);
    total += n;
  }
  assert.equal(total, 63);
});

test('tilings cover every cell exactly once with real pentominoes', () => {
  for (const [cols, rows] of SIZES) {
    for (let seed = 0; seed < 300; seed++) {
      const tiling = C.generateTiling(cols, rows, C.mulberry32(seed));
      const covered = new Map();
      for (const piece of tiling) {
        assert.equal(piece.cells.length, 5);
        assert.ok(connected(piece.cells), 'piece is connected');
        assert.equal(C.identify(piece.cells), piece.letter, 'letter matches shape');
        for (const [x, y] of piece.cells) {
          assert.ok(x >= 0 && x < cols && y >= 0 && y < rows, 'in bounds');
          const k = x + ',' + y;
          assert.ok(!covered.has(k), 'no overlap at ' + k);
          covered.set(k, true);
        }
      }
      assert.equal(covered.size, cols * rows, 'full coverage');
    }
  }
});

test('pieces have distinct shapes when enough shapes exist', () => {
  for (const [cols, rows] of SIZES) {
    for (let seed = 0; seed < 100; seed++) {
      const tiling = C.generateTiling(cols, rows, C.mulberry32(seed));
      const letters = new Set(tiling.map((p) => p.letter));
      assert.equal(letters.size, tiling.length, cols + 'x' + rows + ' seed ' + seed);
    }
  }
});

test('the same seed always gives the same puzzle, different seeds differ', () => {
  const a = C.generateTiling(5, 6, C.mulberry32(C.hashString('pentomino-daily:2026-11-07:5x6')));
  const b = C.generateTiling(5, 6, C.mulberry32(C.hashString('pentomino-daily:2026-11-07:5x6')));
  const c = C.generateTiling(5, 6, C.mulberry32(C.hashString('pentomino-daily:2026-11-08:5x6')));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('rendered cell centres line up with the grid cells they snap to', () => {
  const rng = C.mulberry32(7);
  for (let seed = 0; seed < 40; seed++) {
    const pieces = C.generateTiling(5, 6, C.mulberry32(seed)).map((t, i) => C.buildPiece(t, i));
    for (const p of pieces) {
      for (let f = 0; f < 2; f++) {
        for (let r = 0; r < 4; r++) {
          const g0 = [Math.floor(rng() * 20) - 5, Math.floor(rng() * 20) - 5];
          const pivot = C.pivotForGrid(p, r, !!f, g0);
          const cells = C.cellsAt(p, r, !!f, g0);
          p.d.forEach((d, k) => {
            const q = C.applyT(d, r, !!f);
            assert.ok(Math.abs(pivot[0] + q[0] - (cells[k][0] + 0.5)) < 1e-9);
            assert.ok(Math.abs(pivot[1] + q[1] - (cells[k][1] + 0.5)) < 1e-9);
          });
        }
      }
    }
  }
});

test('flip mirrors left-right on screen and rotate turns clockwise on screen', () => {
  const p = [1.5, -0.5];
  for (let f = 0; f < 2; f++) {
    for (let r = 0; r < 4; r++) {
      const t = C.applyT(p, r, !!f);
      // Rotate button: r + 1, same f  ==  rotate the on-screen result 90 degrees clockwise.
      const rot = C.applyT(p, (r + 1) & 3, !!f);
      assert.ok(Math.abs(rot[0] - (0 - t[1])) < 1e-9 && Math.abs(rot[1] - t[0]) < 1e-9);
      // Flip button: r -> -r, f toggled  ==  mirror the on-screen result left-right.
      const flip = C.applyT(p, (4 - r) & 3, !f);
      assert.ok(Math.abs(flip[0] - (0 - t[0])) < 1e-9 && Math.abs(flip[1] - t[1]) < 1e-9);
    }
  }
});

test('every scrambled orientation can reach the solved one with rotate and flip', () => {
  const id = '0,0';
  const seen = new Set([id]);
  const queue = [[0, 0]];
  while (queue.length) {
    const [r, f] = queue.shift();
    for (const [nr, nf] of [[(r + 1) & 3, f], [(4 - r) & 3, f ? 0 : 1]]) {
      const k = nr + ',' + nf;
      if (!seen.has(k)) {
        seen.add(k);
        queue.push([nr, nf]);
      }
    }
  }
  assert.equal(seen.size, 8);
});

test('symmetric pieces count as home in their twin orientation', () => {
  const tiles = [];
  for (let seed = 1; seed < 40 && tiles.length < 3; seed++) {
    for (const t of C.generateTiling(5, 6, C.mulberry32(seed))) if (t.letter === 'T') tiles.push(t);
  }
  const p = C.buildPiece(tiles[0], 0);
  const home = p.home.map((c) => c.join(',')).sort().join(';');
  let twin = null;
  for (let r = 0; r < 4 && !twin; r++)
    for (let x = 0; x < 6 && !twin; x++)
      for (let y = 0; y < 6 && !twin; y++) {
        if (r === 0 && x === p.home[0][0] && y === p.home[0][1]) continue;
        const cs = C.cellsAt(p, r, true, [x, y]).map((c) => c.join(',')).sort().join(';');
        if (cs === home) twin = { r, g0: [x, y] };
      }
  assert.ok(twin, 'a mirrored T covers its own cells');
  assert.ok(C.isHome(p, { placed: true, r: twin.r, f: true, g0: twin.g0 }));
});

test('tetromino tilings cover the board with 4-cell pieces', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const [cols, rows] of [[4, 6], [6, 4]]) {
      const tiles = C.generateTiling(cols, rows, C.mulberry32(seed), { set: 'tetromino' });
      assert.equal(tiles.length, 6);
      const seen = new Set();
      for (const t of tiles) {
        assert.equal(t.cells.length, 4);
        assert.ok(C.SHAPE_SETS.tetromino.orients[t.letter], 'a real tetromino: ' + t.letter);
        for (const c of t.cells) {
          assert.ok(c[0] >= 0 && c[0] < cols && c[1] >= 0 && c[1] < rows);
          seen.add(c.join(','));
        }
      }
      assert.equal(seen.size, cols * rows, 'every cell covered exactly once');
    }
  }
  assert.equal(C.SHAPE_SETS.tetromino.orients.O.length, 1);
  assert.equal(C.SHAPE_SETS.tetromino.orients.I.length, 2);
  assert.throws(() => C.generateTiling(5, 6, C.mulberry32(1), { set: 'tetromino' }), /multiple of 4/);
  assert.throws(() => C.generateTiling(4, 6, C.mulberry32(1)), /multiple of 5/);
});

test('share text names the puzzle when a source is given', () => {
  assert.match(C.shareText({ date: '2026-11-07', source: 'NASA picture', seconds: 5, moves: 1, hints: 0 }), /Daily · NASA picture · Nov 7/);
});

test('share text marks a retry', () => {
  const t = C.shareText({ date: '2026-11-07', source: 'NASA picture', seconds: 65, moves: 3, hints: 0, retry: true });
  assert.match(t.split('\n')[0], /Nov 7 · 🔁 retry$/);
  assert.doesNotMatch(C.shareText({ date: '2026-11-07', seconds: 65, moves: 3, hints: 0 }), /retry/);
});

test('snapping, solving and un-solving', () => {
  const cols = 5;
  const rows = 6;
  const pieces = C.generateTiling(cols, rows, C.mulberry32(11)).map((t, i) => C.buildPiece(t, i));
  const states = pieces.map(() => ({ placed: false, g0: null, r: 2, f: true, pivot: [0, 0] }));
  assert.ok(!C.isSolved(pieces, states));

  // Drop each piece, off by a fraction of a cell, in its home orientation.
  const occupied = new Map();
  pieces.forEach((p, i) => {
    const home = C.pivotForGrid(p, 0, false, p.home[0]);
    const nudged = [home[0] + 0.3, home[1] - 0.25];
    const snap = C.findSnap(p, 0, false, nudged, { cols, rows, occupied, radius: 1 });
    assert.ok(snap, 'piece ' + p.letter + ' snaps');
    assert.deepEqual(snap.g0, p.home[0]);
    Object.assign(states[i], { placed: true, g0: snap.g0, r: 0, f: false, pivot: snap.pivot });
    for (const c of snap.cells) occupied.set(c.join(','), p.id);
  });
  assert.ok(C.isSolved(pieces, states));

  // A piece in the right place but turned is not solved (even for symmetric shapes).
  states[0].r = 1;
  assert.ok(!C.isSolved(pieces, states));
  states[0].r = 0;
  states[0].f = true;
  assert.ok(!C.isSolved(pieces, states));
  states[0].f = false;
  assert.ok(C.isSolved(pieces, states));
});

test('findSnap rejects off-board and overlapping drops', () => {
  const cols = 5;
  const rows = 6;
  const pieces = C.generateTiling(cols, rows, C.mulberry32(3)).map((t, i) => C.buildPiece(t, i));
  const [a, b] = pieces;
  const far = C.findSnap(a, 0, false, [20, 20], { cols, rows, occupied: new Map(), radius: 2 });
  assert.equal(far, null);

  const occupied = new Map();
  for (const c of a.home) occupied.set(c.join(','), a.id);
  const onTop = C.findSnap(b, 0, false, C.pivotForGrid(b, 0, false, a.home[0]), { cols, rows, occupied, radius: 0 });
  assert.equal(onTop, null);
  // A piece may "overlap" itself (re-dropping where it already was).
  const self = C.findSnap(a, 0, false, C.pivotForGrid(a, 0, false, a.home[0]), { cols, rows, occupied, radius: 0 });
  assert.ok(self);
});

test('tray layout fits every slot inside the tray without overlap', () => {
  for (const [W, H] of [[6.8, 4.3], [5, 6], [9, 3], [12, 5]]) {
    for (const [cols, rows] of [[5, 6], [6, 5], [5, 8]]) {
      const pieces = C.generateTiling(cols, rows, C.mulberry32(5)).map((t, i) => C.buildPiece(t, i));
      const halves = pieces.map((p) => p.half);
      const gap = 0.15;
      const { rho, slots } = C.layoutTray(halves, W, H, gap);
      assert.ok(rho >= 0.2 && rho <= 0.9);
      const boxes = slots.map((s, i) => ({ x0: s.cx - halves[i] * rho, x1: s.cx + halves[i] * rho, y0: s.cy - halves[i] * rho, y1: s.cy + halves[i] * rho }));
      if (rho > 0.2 + 1e-9) {
        for (const b of boxes) assert.ok(b.x0 >= -1e-6 && b.x1 <= W + 1e-6 && b.y0 >= -1e-6 && b.y1 <= H + 1e-6, 'slot inside tray');
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const A = boxes[i];
          const B = boxes[j];
          const overlap = A.x0 < B.x1 - 1e-6 && B.x0 < A.x1 - 1e-6 && A.y0 < B.y1 - 1e-6 && B.y0 < A.y1 - 1e-6;
          assert.ok(!overlap, 'slots ' + i + ' and ' + j + ' overlap');
        }
      }
    }
  }
});

test('streaks continue on consecutive days and reset after a gap', () => {
  let s = C.updateStats(null, '2026-11-07', 120);
  assert.deepEqual([s.streak, s.played, s.best], [1, 1, 120]);
  s = C.updateStats(s, '2026-11-07', 60); // same day again: ignored
  assert.deepEqual([s.streak, s.played, s.best], [1, 1, 120]);
  s = C.updateStats(s, '2026-11-08', 90);
  assert.deepEqual([s.streak, s.played, s.best], [2, 2, 90]);
  s = C.updateStats(s, '2026-11-10', 200);
  assert.deepEqual([s.streak, s.played, s.best], [1, 3, 90]);
  s = C.updateStats(s, '2026-12-01', 50);
  s = C.updateStats(s, '2026-12-02', 50);
  assert.equal(s.streak, 2);
  // month and year boundaries
  s = C.updateStats({ streak: 4, best: 80, played: 4, lastDate: '2026-12-31' }, '2027-01-01', 70);
  assert.equal(s.streak, 5);
});

test('share text', () => {
  assert.equal(
    C.shareText({ date: '2026-11-07', seconds: 222, moves: 28, hints: 0, url: 'https://example.com/' }),
    '🧩 Pentomino Daily · Nov 7\n⏱ 3:42 · 🔄 28 moves\nhttps://example.com/'
  );
  assert.match(C.shareText({ date: '2026-11-07', seconds: 65, moves: 1, hints: 2 }), /1 move · 💡 2 hints$/);
});
