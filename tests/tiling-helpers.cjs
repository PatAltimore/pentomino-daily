// Test helpers: re-tile a puzzle's own pieces in a different (valid) way.
const C = require('../site/core.js');

function placementFor(piece, cells, cols, rows) {
  const want = cells.map((c) => c.join(',')).sort().join(';');
  for (let f = 0; f < 2; f++) {
    for (let r = 0; r < 4; r++) {
      for (let x = -4; x < cols + 4; x++) {
        for (let y = -4; y < rows + 4; y++) {
          const got = C.cellsAt(piece, r, !!f, [x, y]).map((c) => c.join(',')).sort().join(';');
          if (got === want) return { r, f: !!f, g0: [x, y] };
        }
      }
    }
  }
  return null;
}

/** Another way to cover the board with exactly these pieces (each once), or null. */
function otherTiling(pieces, cols, rows) {
  const homeKey = pieces.map((p) => p.home.map((c) => c.join(',')).sort().join(';')).join('|');
  const grid = new Array(cols * rows).fill(-1);
  const result = [];
  let found = null;
  const used = new Set();
  function go() {
    if (found) return;
    const idx = grid.indexOf(-1);
    if (idx === -1) {
      const key = pieces.map((p, i) => result[i].map((c) => c.join(',')).sort().join(';')).join('|');
      if (key !== homeKey) found = result.map((c) => c.slice());
      return;
    }
    const x0 = idx % cols;
    const y0 = Math.floor(idx / cols);
    for (let i = 0; i < pieces.length; i++) {
      if (used.has(i)) continue;
      for (const orient of C.ORIENTS[pieces[i].letter]) {
        const cells = orient.map((c) => [c[0] - orient[0][0] + x0, c[1] - orient[0][1] + y0]);
        if (cells.some((c) => c[0] < 0 || c[0] >= cols || c[1] < 0 || c[1] >= rows || grid[c[1] * cols + c[0]] !== -1)) continue;
        cells.forEach((c) => (grid[c[1] * cols + c[0]] = i));
        used.add(i);
        result[i] = cells;
        go();
        used.delete(i);
        cells.forEach((c) => (grid[c[1] * cols + c[0]] = -1));
        if (found) return;
      }
    }
  }
  go();
  return found;
}


module.exports = { placementFor, otherTiling };
