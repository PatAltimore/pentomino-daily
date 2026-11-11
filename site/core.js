/*
 * Pentomino Daily - pure game logic (no DOM).
 * Loads in the browser as window.PentoCore and in Node via require().
 *
 * Coordinate conventions
 *  - Grid cells are [x, y] integers, x to the right, y down, origin = board top-left.
 *  - "Units" are board-cell widths. A piece's pivot is the centroid of its cells.
 *  - A piece's orientation is (r, f): flip left-right first (f), then rotate r quarter-turns clockwise.
 *    T(p) = Rot^r(Flip^f(p)).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PentoCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The 12 free pentominoes as [x, y] cells.
  const SHAPES = {
    F: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
    I: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
    L: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
    N: [[1, 0], [1, 1], [0, 2], [1, 2], [0, 3]],
    P: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],
    U: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
    V: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
    W: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
    X: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
    Y: [[1, 0], [0, 1], [1, 1], [1, 2], [1, 3]],
    Z: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
  };

  // The 5 free tetrominoes (I, O, T, S and L; Z and J are mirror images of S and L).
  const TETROMINOES = {
    I: [[0, 0], [0, 1], [0, 2], [0, 3]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    L: [[0, 0], [0, 1], [0, 2], [1, 2]],
  };

  // ---------------------------------------------------------------- transforms

  function applyT(p, r, f) {
    let x = f ? 0 - p[0] : p[0];
    let y = p[1];
    for (let i = 0; i < (r & 3); i++) {
      const nx = 0 - y;
      y = x;
      x = nx;
    }
    return [x, y];
  }

  function normalize(cells) {
    let minX = Infinity;
    let minY = Infinity;
    for (const c of cells) {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
    }
    return cells
      .map((c) => [c[0] - minX, c[1] - minY])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }

  function key(cells) {
    return cells.map((c) => c[0] + ',' + c[1]).join(';');
  }

  // All distinct orientations of every shape, each normalized and sorted row-major.
  function orientsOf(shapes) {
    const out = {};
    for (const letter of Object.keys(shapes)) {
      const seen = new Map();
      for (let f = 0; f < 2; f++) {
        for (let r = 0; r < 4; r++) {
          const o = normalize(shapes[letter].map((c) => applyT(c, r, f)));
          seen.set(key(o), o);
        }
      }
      out[letter] = Array.from(seen.values());
    }
    return out;
  }

  const ORIENTS = orientsOf(SHAPES);
  const LETTER_BY_KEY = new Map();
  for (const letter of Object.keys(ORIENTS)) {
    for (const o of ORIENTS[letter]) LETTER_BY_KEY.set(key(o), letter);
  }

  // Piece sets a puzzle can be cut from.
  const SHAPE_SETS = {
    pentomino: { shapes: SHAPES, orients: ORIENTS, size: 5 },
    tetromino: { shapes: TETROMINOES, orients: orientsOf(TETROMINOES), size: 4 },
  };

  function identify(cells) {
    return LETTER_BY_KEY.get(key(normalize(cells))) || null;
  }

  // --------------------------------------------------------------------- random

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  // --------------------------------------------------------------------- tiling

  /**
   * Randomly tile a cols x rows grid with pentominoes, or tetrominoes with
   * opts.set = 'tetromino' (seeded, so the same rng state always gives the same
   * tiling). Prefers using each shape at most once so the pieces have distinct
   * silhouettes; falls back to allowing repeats.
   * Returns [{ letter, cells: [[x, y], ...] }] in row-major order of each piece's first cell.
   */
  function generateTiling(cols, rows, rng, opts) {
    const o = opts || {};
    const maxSteps = o.maxSteps || 20000;
    const attempts = o.attempts || 12;
    const set = SHAPE_SETS[o.set || 'pentomino'];
    if (!set) throw new Error('Unknown piece set ' + o.set);
    const ORIENTS = set.orients;
    const area = cols * rows;
    if (area % set.size !== 0) throw new Error('Grid area must be a multiple of ' + set.size);
    const letters = Object.keys(set.orients);
    const needed = area / set.size;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const unique = needed <= letters.length && attempt < attempts - 2;
      const grid = new Array(area).fill(-1);
      const placed = [];
      const used = new Set();
      let steps = 0;

      const solve = function () {
        let idx = grid.indexOf(-1);
        if (idx === -1) return true;
        if (++steps > maxSteps) return false;
        const x0 = idx % cols;
        const y0 = Math.floor(idx / cols);
        for (const letter of shuffle(letters, rng)) {
          if (unique && used.has(letter)) continue;
          for (const orient of shuffle(ORIENTS[letter], rng)) {
            // orient[0] is the row-major-first cell; it must land on the first empty cell.
            const cells = orient.map((c) => [c[0] - orient[0][0] + x0, c[1] - orient[0][1] + y0]);
            let ok = true;
            for (const c of cells) {
              if (c[0] < 0 || c[0] >= cols || c[1] < 0 || c[1] >= rows || grid[c[1] * cols + c[0]] !== -1) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
            const id = placed.length;
            for (const c of cells) grid[c[1] * cols + c[0]] = id;
            placed.push({ letter, cells });
            used.add(letter);
            if (solve()) return true;
            if (steps > maxSteps) return false;
            placed.pop();
            used.delete(letter);
            for (const c of cells) grid[c[1] * cols + c[0]] = -1;
          }
        }
        return false;
      };

      if (solve()) return placed;
    }
    throw new Error('Could not tile a ' + cols + 'x' + rows + ' grid');
  }

  // --------------------------------------------------------------------- pieces

  /** Precompute everything the renderer and snapping need for one tiled piece. */
  function buildPiece(tp, id) {
    const cells = tp.cells;
    const n = cells.length;
    let cx = 0;
    let cy = 0;
    for (const c of cells) {
      cx += c[0] + 0.5;
      cy += c[1] + 0.5;
    }
    cx /= n;
    cy /= n;
    // d[k]: vector (in cell units) from the centroid to the centre of cell k.
    const d = cells.map((c) => [c[0] + 0.5 - cx, c[1] + 0.5 - cy]);
    // rel[k]: integer offset of cell k from cell 0.
    const rel = cells.map((c) => [c[0] - cells[0][0], c[1] - cells[0][1]]);
    const set = new Set(cells.map((c) => c[0] + ',' + c[1]));
    const edges = [];
    cells.forEach((c, k) => {
      for (const nb of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        if (!set.has(c[0] + nb[0] + ',' + (c[1] + nb[1]))) edges.push({ k, n: nb });
      }
    });
    let half = 0;
    for (const v of d) half = Math.max(half, Math.abs(v[0]), Math.abs(v[1]));
    return {
      id,
      letter: tp.letter,
      home: cells,
      d,
      rel,
      edges,
      centroid: [cx, cy],
      half: half + 0.5, // max-norm radius from the centroid; unchanged by rotation/flip
    };
  }

  function cellsAt(piece, r, f, g0) {
    return piece.rel.map((p) => {
      const q = applyT(p, r, f);
      return [g0[0] + q[0], g0[1] + q[1]];
    });
  }

  /** Pivot (units) that puts cell 0's centre exactly on grid cell g0. */
  function pivotForGrid(piece, r, f, g0) {
    const q = applyT(piece.d[0], r, f);
    return [g0[0] + 0.5 - q[0], g0[1] + 0.5 - q[1]];
  }

  function nearestGrid0(piece, r, f, pivot) {
    const q = applyT(piece.d[0], r, f);
    return [Math.round(pivot[0] + q[0] - 0.5), Math.round(pivot[1] + q[1] - 0.5)];
  }

  /**
   * Find where a piece at (r, f) with the given pivot should snap on the board.
   * `occupied` is a Map of "x,y" -> pieceId for pieces already placed.
   * Returns { g0, cells, pivot } or null when nothing within `radius` cells fits.
   */
  function findSnap(piece, r, f, pivot, ctx) {
    const radius = ctx.radius === undefined ? 1 : ctx.radius;
    const base = nearestGrid0(piece, r, f, pivot);
    let best = null;
    let bestDist = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const g0 = [base[0] + dx, base[1] + dy];
        const cells = cellsAt(piece, r, f, g0);
        let ok = true;
        for (const c of cells) {
          if (c[0] < 0 || c[0] >= ctx.cols || c[1] < 0 || c[1] >= ctx.rows) {
            ok = false;
            break;
          }
          const other = ctx.occupied.get(c[0] + ',' + c[1]);
          if (other !== undefined && other !== piece.id) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const pv = pivotForGrid(piece, r, f, g0);
        const dist = Math.hypot(pv[0] - pivot[0], pv[1] - pivot[1]);
        if (dist < bestDist) {
          bestDist = dist;
          best = { g0, cells, pivot: pv };
        }
      }
    }
    return best;
  }

  // A piece counts as home when it covers exactly its home cells. Symmetric shapes
  // (T, U, V, W, Z, I, X) can do that in a second orientation, which is just as correct.
  function isHome(piece, st) {
    if (!st.placed) return false;
    const home = new Set(piece.home.map((c) => c[0] + ',' + c[1]));
    return cellsAt(piece, st.r, st.f, st.g0).every((c) => home.has(c[0] + ',' + c[1]));
  }

  // ------------------------------------------------------------ visual matching
  //
  // Pictures with big flat areas (black space, a plain sky) look the same in more than one
  // arrangement, so a player can rebuild the picture a different way and see nothing wrong. A
  // "visual" is a small luminance grid for every board cell of the picture; a piece counts as
  // right if the slices it shows look like the picture that belongs in those cells.
  //   visual = { n, meanTol, maxTol, grids: { "x,y": number[n*n] } }

  /** Rotate/flip an n x n grid the way a piece's slices are drawn (T(p) = Rot^r(Flip^f(p))). */
  function transformGrid(grid, n, r, f) {
    const out = new Array(n * n);
    const c = (n - 1) / 2;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const q = applyT([i - c, j - c], r, f);
        out[Math.round(q[1] + c) * n + Math.round(q[0] + c)] = grid[j * n + i];
      }
    }
    return out;
  }

  function gridsMatch(a, b, meanTol, maxTol) {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > max) max = d;
    }
    return sum / a.length <= meanTol && max <= maxTol;
  }

  // ------------------------------------------------------- mirrored solutions
  //
  // A player can also rebuild the whole picture as a mirror image: every piece flipped and sitting
  // at its mirror-image spot. That is a complete, valid solution, so it counts. `mode` is
  //   'normal'      the picture as it is
  //   'horizontal'  mirrored left-to-right
  //   'vertical'    mirrored top-to-bottom
  // The mirrored arrangement of a piece is (r=0, flipped) for horizontal and (r=2, flipped) for
  // vertical, at the mirrored position of its home cell.

  const MIRROR_MODES = ['normal', 'horizontal', 'vertical'];

  /** Where a home cell ends up under a mode on a cols x rows board (each mirror is its own inverse). */
  function mirrorCell(mode, cell, board) {
    if (mode === 'horizontal') return [board.cols - 1 - cell[0], cell[1]];
    if (mode === 'vertical') return [cell[0], board.rows - 1 - cell[1]];
    return [cell[0], cell[1]];
  }

  /** The orientation that turns a slice into its mirror image under a mode. */
  function mirrorOrientation(mode) {
    if (mode === 'horizontal') return [0, true];
    if (mode === 'vertical') return [2, true];
    return [0, false];
  }

  /**
   * Does this placed piece fit the picture under a mode: does it cover exactly the (mirrored)
   * home cells, or show slices that look like the (mirrored) picture in the cells it sits on?
   */
  function pieceFitsUnder(piece, st, visual, mode, board) {
    if (!st.placed) return false;
    const here = cellsAt(piece, st.r, st.f, st.g0);
    const want = new Set(piece.home.map((c) => mirrorCell(mode, c, board).join(',')));
    if (here.every((c) => want.has(c.join(',')))) return true;
    if (!visual) return false;
    const [mr, mf] = mirrorOrientation(mode);
    for (let k = 0; k < here.length; k++) {
      const shown = transformGrid(visual.grids[piece.home[k][0] + ',' + piece.home[k][1]] || [], visual.n, st.r, st.f);
      const source = visual.grids[mirrorCell(mode, here[k], board).join(',')];
      if (!source || shown.length !== source.length) return false;
      if (!gridsMatch(shown, transformGrid(source, visual.n, mr, mf), visual.meanTol, visual.maxTol)) return false;
    }
    return true;
  }

  /** Does every slice this placed piece shows look like the picture at the cell it sits on? */
  function looksRight(piece, st, visual) {
    if (!visual || !st.placed) return false;
    const here = cellsAt(piece, st.r, st.f, st.g0);
    for (let k = 0; k < here.length; k++) {
      const want = visual.grids[here[k][0] + ',' + here[k][1]];
      const slice = visual.grids[piece.home[k][0] + ',' + piece.home[k][1]];
      if (!want || !slice) return false;
      if (!gridsMatch(transformGrid(slice, visual.n, st.r, st.f), want, visual.meanTol, visual.maxTol)) return false;
    }
    return true;
  }

  /** A piece is right if it sits on its own cells, or shows slices that look like the picture there. */
  function pieceFits(piece, st, visual) {
    return isHome(piece, st) || looksRight(piece, st, visual);
  }

  /**
   * Exactly right: in its home spot AND the orientation it was cut in, so every slice shows what belongs
   * in its cell. Stricter than isHome, which also accepts a "twin" orientation (a flipped T, a turned Z...)
   * that covers the same cells but shows mirrored or turned slices. That is enough to win, but it is not
   * what Assist should call correct.
   */
  function isExactHome(piece, st) {
    return (
      !!st.placed &&
      (st.r & 3) === 0 &&
      !st.f &&
      st.g0[0] === piece.home[0][0] &&
      st.g0[1] === piece.home[0][1]
    );
  }

  /** The pieces that are still wrong: in the tray, or placed where the picture does not match. */
  function misplaced(pieces, states, visual) {
    return pieces.filter((p, i) => !pieceFits(p, states[i], visual));
  }

  /** True when every piece is placed without overlap (the board is full), right or not. */
  function boardFull(pieces, states) {
    const seen = new Set();
    for (let i = 0; i < pieces.length; i++) {
      const st = states[i];
      if (!st.placed) return false;
      for (const c of cellsAt(pieces[i], st.r, st.f, st.g0)) {
        const k = c[0] + ',' + c[1];
        if (seen.has(k)) return false;
        seen.add(k);
      }
    }
    return true;
  }

  /**
   * How the puzzle is solved, or null if it isn't: 'normal', or 'horizontal' / 'vertical' for a
   * mirror image. Every piece must fit under the same mode. `board` ({cols, rows}) is needed to
   * recognise mirrored solutions; without it only 'normal' is considered.
   */
  function solvedMode(pieces, states, visual, board) {
    if (!boardFull(pieces, states)) return null;
    for (const mode of board ? MIRROR_MODES : ['normal']) {
      if (pieces.every((p, i) => pieceFitsUnder(p, states[i], visual, mode, board || { cols: 0, rows: 0 }))) return mode;
    }
    return null;
  }

  /** True when every piece is on the board without overlap and the picture is right (any mode). */
  function isSolved(pieces, states, visual, board) {
    return solvedMode(pieces, states, visual, board) !== null;
  }

  // ----------------------------------------------------------------------- tray

  function packShelves(sides, W, gap) {
    const rows = [];
    let row = { items: [], w: 0, h: 0 };
    sides.forEach((w, i) => {
      if (row.items.length && row.w + gap + w > W) {
        rows.push(row);
        row = { items: [], w: 0, h: 0 };
      }
      row.w += (row.items.length ? gap : 0) + w;
      row.h = Math.max(row.h, w);
      row.items.push({ i, w });
    });
    if (row.items.length) rows.push(row);
    return rows;
  }

  /**
   * Lay out square slots (one per piece, side = 2 * half * rho) on shelves inside a
   * W x H tray, choosing the largest scale `rho` that fits. Units are board cells.
   * Returns { rho, slots: [{ cx, cy }] } with slot centres relative to the tray's top-left.
   */
  function layoutTray(halves, W, H, gap) {
    const heightOf = (rows) => rows.reduce((s, r) => s + r.h, 0) + gap * Math.max(0, rows.length - 1);
    let rho = 0.2;
    let rows = null;
    for (let r = 0.9; r >= 0.2 - 1e-9; r -= 0.02) {
      const cand = packShelves(halves.map((h) => 2 * h * r), W, gap);
      if (heightOf(cand) <= H && cand.every((row) => row.w <= W + 1e-9)) {
        rho = r;
        rows = cand;
        break;
      }
    }
    if (!rows) rows = packShelves(halves.map((h) => 2 * h * rho), W, gap);
    let y = Math.max(0, (H - heightOf(rows)) / 2);
    const slots = new Array(halves.length);
    for (const row of rows) {
      let x = Math.max(0, (W - row.w) / 2);
      for (const it of row.items) {
        slots[it.i] = { cx: x + it.w / 2, cy: y + row.h / 2 };
        x += it.w + gap;
      }
      y += row.h + gap;
    }
    return { rho, slots };
  }

  // ------------------------------------------------------- dates, stats, sharing

  function dayNumber(dateStr) {
    return Math.round(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
  }

  /**
   * Which of the published days is "today" for a player whose local date is `local`: the newest
   * day that is not in their future, or the oldest one if every day is.
   */
  function pickDay(days, local) {
    const sorted = days.slice().sort();
    if (!sorted.length) return null;
    let best = null;
    for (const d of sorted) if (d <= local) best = d;
    return best || sorted[0];
  }

  /** "Today", "Yesterday" or a short date, for a puzzle day relative to the player's current day. */
  function dayLabel(day, current) {
    const diff = dayNumber(current) - dayNumber(day);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return formatDateShort(day);
  }

  /**
   * The URL hash names a puzzle: "#2026-11-08/nasa" (that day), "#2026-11-08" (that day's list),
   * "#nasa" (today's) or nothing (today's list). `day` is "" when it means the player's today.
   */
  function parseRoute(hash) {
    const h = String(hash || '').replace(/^#/, '');
    const m = /^(\d{4}-\d{2}-\d{2})(?:\/([a-z]+))?$/.exec(h);
    if (m) return { day: m[1], key: m[2] || '' };
    return { day: '', key: h };
  }

  /** How many pieces a puzzle is cut into: board cells divided by the piece size. */
  function pieceCount(cfg) {
    return (cfg.grid[0] * cfg.grid[1]) / (cfg.set === 'tetromino' ? 4 : 5);
  }

  /** A card's one-line description: picture category, number of pieces, and whether they can turn. */
  function puzzleSummary(cfg) {
    const n = pieceCount(cfg);
    // Non-breaking spaces keep each phrase together, so a long line wraps between the dots.
    const nb = (text) => text.replace(/ /g, '\u00a0');
    return [nb(cfg.category), nb(n + (n === 1 ? ' piece' : ' pieces')), nb(cfg.fixed ? 'fixed orientation' : 'rotate & flip')].join(' · ');
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function formatDateShort(dateStr) {
    return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  /** Update streak/best-time stats after finishing the puzzle for `dateStr`. */
  function updateStats(stats, dateStr, score) {
    const s = Object.assign({ streak: 0, best: null, played: 0, lastDate: null }, stats || {});
    if (s.lastDate === dateStr) return s;
    const consecutive = s.lastDate !== null && dayNumber(dateStr) - dayNumber(s.lastDate) === 1;
    s.streak = consecutive ? s.streak + 1 : 1;
    s.lastDate = dateStr;
    s.played += 1;
    if (s.best === null || score < s.best) s.best = score;
    return s;
  }

  // ---------------------------------------------------------------------- scoring
  //
  // A score to compare with friends who played the same puzzle. It starts at 1000 and loses
  // points for being slow, for hints, and for wasted moves, so a clean, quick run scores 1000.
  // Time itself is never changed: a hint costs points, not seconds.
  //   time   after a free allowance of 10 s per piece, 1.5 points per second (at most 450)
  //   hints  100 points each (at most 400)
  //   moves  10 points per extra placement beyond one per piece, plus 5 per extra turn beyond
  //          the fewest turns the pieces needed from the way they started (at most 250)
  const SCORING = {
    base: 1000,
    freeSecondsPerPiece: 10,
    perSecond: 1.5,
    timeCap: 450,
    perHint: 100,
    hintCap: 400,
    perExtraPlacement: 10,
    perExtraTurn: 5,
    moveCap: 250,
  };

  /** The fewest turn / flip presses to bring a piece from orientation (r, f) to upright (0, no flip). */
  function minTurns(r, f) {
    const goal = '0,0';
    const seen = new Map([[(r & 3) + ',' + (f ? 1 : 0), 0]]);
    const queue = [[r & 3, f ? 1 : 0]];
    while (queue.length) {
      const [cr, cf] = queue.shift();
      const d = seen.get(cr + ',' + cf);
      if (cr + ',' + cf === goal) return d;
      // clockwise, counter-clockwise, and flip (which mirrors left-right on screen)
      for (const [nr, nf] of [[(cr + 1) & 3, cf], [(cr + 3) & 3, cf], [(4 - cr) & 3, cf ? 0 : 1]]) {
        const k = nr + ',' + nf;
        if (!seen.has(k)) {
          seen.set(k, d + 1);
          queue.push([nr, nf]);
        }
      }
    }
    return 0;
  }

  /**
   * Score a finished puzzle. Input: seconds (real elapsed time), pieces, placements (drops onto
   * the board or tray), turns (rotate/flip presses), parTurns (fewest turns needed) and hints.
   * Returns { score, time, hints, moves } where the last three are the points each cost.
   */
  function computeScore(o) {
    const k = SCORING;
    const free = k.freeSecondsPerPiece * o.pieces;
    const time = Math.min(k.timeCap, Math.round(Math.max(0, o.seconds - free) * k.perSecond));
    const hints = Math.min(k.hintCap, (o.hints || 0) * k.perHint);
    const extraPlacements = Math.max(0, o.placements - o.pieces);
    const extraTurns = Math.max(0, o.turns - (o.parTurns || 0));
    const moves = Math.min(k.moveCap, extraPlacements * k.perExtraPlacement + extraTurns * k.perExtraTurn);
    return { score: Math.max(0, k.base - time - hints - moves), time, hints, moves };
  }

  /** "1000 − 120 time − 100 hints − 40 extra moves", skipping the parts that cost nothing. */
  function scoreBreakdown(b) {
    const parts = [String(SCORING.base)];
    if (b.time) parts.push('− ' + b.time + ' time');
    if (b.hints) parts.push('− ' + b.hints + ' hints');
    if (b.moves) parts.push('− ' + b.moves + ' extra moves');
    return parts.length === 1 ? 'No points lost' : parts.join(' ');
  }

  function shareText(o) {
    const parts = ['⏱ ' + formatTime(o.seconds), '🔄 ' + o.moves + (o.moves === 1 ? ' move' : ' moves')];
    if (o.score !== undefined && o.score !== null) parts.unshift('🏆 ' + o.score);
    if (o.hints) parts.push('💡 ' + o.hints + (o.hints === 1 ? ' hint' : ' hints'));
    if (o.mirrored) parts.push('🪞 mirrored ' + o.mirrored + 'ly');
    if (o.assist) parts.push('🟢 assist on');
    return (
      '🧩 Pentomino Daily · ' + (o.source ? o.source + ' · ' : '') + formatDateShort(o.date) + (o.retry ? ' · 🔁 retry' : '') + '\n' + parts.join(' · ') + (o.url ? '\n' + o.url : '')
    );
  }

  return {
    SHAPES,
    TETROMINOES,
    SHAPE_SETS,
    ORIENTS,
    SCORING,
    minTurns,
    computeScore,
    scoreBreakdown,
    applyT,
    normalize,
    identify,
    hashString,
    mulberry32,
    shuffle,
    generateTiling,
    buildPiece,
    cellsAt,
    pivotForGrid,
    findSnap,
    isHome,
    isExactHome,
    transformGrid,
    gridsMatch,
    looksRight,
    pieceFits,
    misplaced,
    boardFull,
    mirrorCell,
    solvedMode,
    isSolved,
    layoutTray,
    dayNumber,
    pickDay,
    dayLabel,
    pieceCount,
    puzzleSummary,
    parseRoute,
    formatTime,
    formatDateShort,
    updateStats,
    shareText,
  };
});
