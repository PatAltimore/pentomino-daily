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
  const ORIENTS = {};
  const LETTER_BY_KEY = new Map();
  for (const letter of Object.keys(SHAPES)) {
    const seen = new Map();
    for (let f = 0; f < 2; f++) {
      for (let r = 0; r < 4; r++) {
        const o = normalize(SHAPES[letter].map((c) => applyT(c, r, f)));
        seen.set(key(o), o);
      }
    }
    ORIENTS[letter] = Array.from(seen.values());
    for (const k of seen.keys()) LETTER_BY_KEY.set(k, letter);
  }

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
   * Randomly tile a cols x rows grid with pentominoes (seeded, so the same rng
   * state always gives the same tiling). Prefers using each shape at most once so
   * the pieces have distinct silhouettes; falls back to allowing repeats.
   * Returns [{ letter, cells: [[x, y], ...] }] in row-major order of each piece's first cell.
   */
  function generateTiling(cols, rows, rng, opts) {
    const o = opts || {};
    const maxSteps = o.maxSteps || 20000;
    const attempts = o.attempts || 12;
    const area = cols * rows;
    if (area % 5 !== 0) throw new Error('Grid area must be a multiple of 5');
    const letters = Object.keys(SHAPES);
    const needed = area / 5;

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

  function isSolved(pieces, states) {
    return pieces.every((p, i) => isHome(p, states[i]));
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

  function shareText(o) {
    const parts = ['⏱ ' + formatTime(o.seconds), '🔄 ' + o.moves + (o.moves === 1 ? ' move' : ' moves')];
    if (o.hints) parts.push('💡 ' + o.hints + (o.hints === 1 ? ' hint' : ' hints'));
    return (
      '🧩 Pentomino Daily · ' + formatDateShort(o.date) + '\n' + parts.join(' · ') + (o.url ? '\n' + o.url : '')
    );
  }

  return {
    SHAPES,
    ORIENTS,
    HINT_PENALTY_SECONDS: 15,
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
    isSolved,
    layoutTray,
    dayNumber,
    formatTime,
    formatDateShort,
    updateStats,
    shareText,
  };
});
