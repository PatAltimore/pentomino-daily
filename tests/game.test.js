// End-to-end smoke test for site/game.js using a minimal fake DOM (no browser needed).
// It boots the game, drags every piece into place with synthetic pointer events and
// checks the win flow, persistence and the "already solved today" reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../site/core.js');
const { placementFor, otherTiling } = require('./tiling-helpers.cjs');

const SITE = path.join(__dirname, '..', 'site');
const GAME_SRC = fs.readFileSync(path.join(SITE, 'game.js'), 'utf8');

function makeEnv({ search = '?debug', hash = '#sample', storage = new Map(), imageSize = [1000, 1200], files = {}, flatImage = false } = {}) {
  const hashLog = [];
  const intervals = new Set();
  const els = {};
  // flatImage: getImageData reports one flat colour, like a picture of plain black sky.
  const flatPixels = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(120) });
  const ctx2d = new Proxy({}, {
    get: (t, k) => (k === 'getImageData' && flatImage ? flatPixels : k in t ? t[k] : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });

  function makeEl(id) {
    const handlers = {};
    return {
      id,
      handlers,
      textContent: '',
      hidden: false,
      disabled: false,
      open: false,
      src: '',
      alt: '',
      href: '',
      width: 0,
      height: 0,
      addEventListener(type, fn) {
        (handlers[type] = handlers[type] || []).push(fn);
      },
      fire(type, ev) {
        (handlers[type] || []).forEach((fn) => fn(ev || {}));
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 640 }),
      getContext: () => ctx2d,
      setPointerCapture() {},
      showModal() {
        this.open = true;
      },
      append() {},
    };
  }
  const el = (id) => (els[id] = els[id] || makeEl(id));
  const docHandlers = {};
  const clipboard = { text: null };

  const sandbox = {
    PentoCore: Core,
    console,
    Math,
    Date,
    Map,
    Promise,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
      clearInterval(id);
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    ResizeObserver: class {
      observe() {}
    },
    devicePixelRatio: 1,
    location: {
      search,
      origin: 'http://localhost',
      pathname: '/',
      get hash() {
        return hash;
      },
      set hash(v) {
        hash = v ? '#' + v : '';
        hashLog.push(hash);
      },
    },
    addEventListener() {},
    navigator: { clipboard: { writeText: (t) => ((clipboard.text = t), Promise.resolve()) } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: async (url) => {
      if (url === 'data/sample.json') {
        const text = fs.readFileSync(path.join(SITE, url), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(text) };
      }
      if (files[url]) return { ok: true, status: 200, json: async () => files[url] };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    Image: class {
      set src(v) {
        this._src = v;
        setTimeout(() => this.onload && this.onload(), 0);
      }
      get naturalWidth() {
        return imageSize[0];
      }
      get naturalHeight() {
        return imageSize[1];
      }
    },
    document: {
      hidden: false,
      getElementById: el,
      createElement: (tag) => makeEl(tag),
      addEventListener(type, fn) {
        (docHandlers[type] = docHandlers[type] || []).push(fn);
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GAME_SRC, sandbox, { filename: 'game.js' });

  return {
    el,
    sandbox,
    clipboard,
    hashLog,
    docHandlers,
    pento: () => sandbox.__pento,
    teardown: () => intervals.forEach((id) => clearInterval(id)),
  };
}

const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ptr = (x, y) => ({ pointerId: 1, clientX: x, clientY: y, button: 0, preventDefault() {} });

function tap(canvas, x, y) {
  canvas.fire('pointerdown', ptr(x, y));
  canvas.fire('pointerup', ptr(x, y));
}

async function solveByDragging(env, count) {
  const canvas = env.el('board');
  const { pieces, states, layout } = env.pento();
  const { s, bx, by } = layout;
  const toPx = (u) => [bx + u[0] * s, by + u[1] * s];

  for (let i = 0; i < (count === undefined ? pieces.length : count); i++) {
    const p = pieces[i];
    const st = states[i];
    const [sx, sy] = toPx(st.slot);

    tap(canvas, sx, sy); // select it
    assert.equal(env.sandbox.document.getElementById('btn-rotate').disabled, false, 'toolbar enables on select');
    for (let guard = 0; guard < 6 && !(st.r === 0 && !st.f); guard++) {
      env.el(st.f ? 'btn-flip' : 'btn-rotate').fire('click');
    }
    assert.ok(st.r === 0 && !st.f, 'piece ' + p.letter + ' reached its home orientation');

    // Drag it to its home spot, a little off-centre; it should snap.
    const [tx, ty] = toPx(Core.pivotForGrid(p, 0, false, p.home[0]));
    canvas.fire('pointerdown', ptr(sx, sy));
    canvas.fire('pointermove', ptr((sx + tx) / 2, (sy + ty) / 2));
    canvas.fire('pointermove', ptr(tx + s * 0.2, ty - s * 0.15));
    canvas.fire('pointerup', ptr(tx + s * 0.2, ty - s * 0.15));

    assert.equal(st.placed, true, 'piece ' + p.letter + ' placed');
    assert.equal(st.g0[0], p.home[0][0]);
    assert.equal(st.g0[1], p.home[0][1]);
  }
}

test('plays through a whole puzzle, then remembers it was solved', async () => {
  const storage = new Map();
  const env = makeEnv({ storage });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    assert.equal(env.el('status').hidden, true, 'loading message hidden');
    assert.equal(env.el('help').open, true, 'help shows on first visit');
    env.el('help').open = false;
    env.el('help').fire('close');

    const { pieces, layout } = env.pento();
    assert.equal(pieces.length, 6);
    assert.equal(layout.cols * layout.rows, 30);
    assert.ok(layout.s >= 16 && layout.rho >= 0.2);

    env.el('btn-hint').fire('click');
    assert.equal(env.el('hints').hidden, false);
    assert.equal(env.el('timer').textContent, '0:15', 'a hint adds the 15 second penalty');

    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);

    const date = [...storage.keys()].find((k) => k.startsWith('pd:done:')).slice('pd:done:'.length);
    const done = JSON.parse(storage.get('pd:done:' + date));
    assert.equal(done.hints, 1);
    assert.ok(done.moves >= 12, 'moves counted: ' + done.moves);
    assert.ok(done.seconds >= 15);
    const stats = JSON.parse(storage.get('pd:stats'));
    assert.equal(stats.streak, 1);
    assert.equal(stats.played, 1);
    assert.match(env.el('win-stats').textContent, /1-day streak/);

    env.el('btn-share').fire('click');
    await until(() => env.clipboard.text);
    assert.match(env.clipboard.text, /^🧩 Pentomino Daily/);
    env.teardown();

    // Come back later the same day: the solved board and the result dialog are restored.
    const again = makeEnv({ storage });
    await until(() => again.pento() && again.pento().won, 3000);
    assert.ok(again.pento().states.every((st) => st.placed));
    await until(() => again.el('win').open, 3000);
    assert.equal(again.el('help').open, false, 'help does not reappear');
    again.teardown();
  } finally {
    env.teardown();
  }
});

test('landscape pictures get a 6x5 board and tapping a selected piece rotates it', async () => {
  const env = makeEnv({ imageSize: [1600, 900] });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    const { layout, states } = env.pento();
    assert.equal(layout.cols, 6);
    assert.equal(layout.rows, 5);

    const canvas = env.el('board');
    const { s, bx, by } = layout;
    const st = states[0];
    const x = bx + st.slot[0] * s;
    const y = by + st.slot[1] * s;
    const r0 = st.r;
    tap(canvas, x, y); // select
    assert.equal(st.r, r0);
    tap(canvas, x, y); // tap again -> rotate
    assert.equal(st.r, (r0 + 1) & 3);
    env.el('btn-flip').fire('click');
    assert.equal(st.r, (4 - ((r0 + 1) & 3)) & 3);
  } finally {
    env.teardown();
  }
});

test('restart puts every piece back in the tray, scrambled as at the start, and resets the counters', async () => {
  const env = makeEnv();
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    env.el('help').open = false;
    const start = env.pento().states.map((st) => [st.r, st.f]);

    env.el('btn-hint').fire('click');
    await solveByDragging(env, 3);
    assert.ok(env.pento().states.slice(0, 3).every((st) => st.placed));
    assert.notEqual(env.el('moves').textContent, '0 moves');

    env.el('btn-restart').fire('click');
    const { states } = env.pento();
    assert.ok(states.every((st) => !st.placed && !st.dragging), 'nothing left on the board');
    states.forEach((st, i) => {
      assert.equal(st.r, start[i][0]);
      assert.equal(st.f, start[i][1]);
      assert.equal(st.pivot[0], st.slot[0], 'back in its tray slot');
      assert.equal(st.pivot[1], st.slot[1]);
    });
    assert.equal(env.el('moves').textContent, '0 moves');
    assert.equal(env.el('timer').textContent, '0:00');
    assert.equal(env.el('hints').hidden, true);

    // ...and the puzzle is still playable after a restart.
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);
  } finally {
    env.teardown();
  }
});

test('restart after solving starts a practice run and keeps the saved result', async () => {
  const storage = new Map();
  const env = makeEnv({ storage });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    env.el('help').open = false;
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    const key = [...storage.keys()].find((k) => k.startsWith('pd:done:'));
    const saved = storage.get(key);
    const stats = storage.get('pd:stats');

    env.el('win').open = false; // close the result dialog
    env.el('btn-restart').fire('click');
    assert.equal(env.pento().won, false);
    assert.ok(env.pento().states.every((st) => !st.placed), 'board is cleared');
    assert.match(env.el('puzzle-date').textContent, /practice/);
    assert.equal(env.el('btn-hint').disabled, false);

    env.el('btn-hint').fire('click'); // makes this run's result differ from the saved one
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);
    assert.equal(storage.get(key), saved, "today's saved result is untouched");
    assert.equal(storage.get('pd:stats'), stats, 'streak is untouched');
    assert.match(env.el('win-stats').textContent, /retry/);
    env.el('btn-share').fire('click');
    await until(() => env.clipboard.text);
    assert.match(env.clipboard.text.split('\n')[0], /retry/, 'shared text says it was a retry');
  } finally {
    env.teardown();
  }
});

test('a drop that does not fit puts the piece back', async () => {
  const env = makeEnv();
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    const { layout, states } = env.pento();
    const canvas = env.el('board');
    const { s, bx, by } = layout;
    const st = states[2];
    const start = [bx + st.slot[0] * s, by + st.slot[1] * s];
    canvas.fire('pointerdown', ptr(start[0], start[1]));
    canvas.fire('pointermove', ptr(start[0] + 30, start[1] - 40));
    canvas.fire('pointermove', ptr(-500, -500)); // far outside the board
    canvas.fire('pointerup', ptr(-500, -500));
    assert.equal(st.placed, false);
    assert.equal(st.dragging, false);
    assert.equal(st.pivot[0], st.slot[0], 'back in its tray slot');
    assert.equal(st.pivot[1], st.slot[1]);
  } finally {
    env.teardown();
  }
});


// ---- helpers for the day-based puzzle layout (data/manifest.json + data/<day>/<key>.json)
const pad2 = (n) => String(n).padStart(2, '0');
const localToday = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const shiftDay = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ALL_KEYS = ['nasa', 'wikipedia', 'tetromino', 'fixed'];

/** Files for a fake server: `days` maps a day to the puzzle keys published for it. */
function publish(days) {
  const files = {};
  const entries = {};
  for (const [day, keys] of Object.entries(days)) {
    entries[day] = keys;
    for (const key of keys) {
      files['data/' + day + '/' + key + '.json'] = {
        key, day, date: day, title: 'T ' + key + ' ' + day, image: 'images/' + key + '.jpg', source: key, credit: '', description: '',
      };
    }
  }
  files['data/manifest.json'] = { today: localToday(), days: Object.keys(entries).sort().reverse(), entries };
  return files;
}

test('the start page offers all four puzzles and shows which are solved today', async () => {
  const today = localToday();
  const storage = new Map([['pd:done:nasa:' + today, JSON.stringify({ seconds: 125, moves: 20, hints: 0 })]]);
  const env = makeEnv({ hash: '', storage, files: publish({ [today]: ALL_KEYS }) });
  try {
    await until(() => env.el('start-progress').textContent);
    assert.equal(env.el('start').hidden, false, 'start page is shown');
    assert.equal(env.el('start-progress').textContent, '1 of 4 solved today');
    assert.match(env.el('day-label').textContent, /^Today/);
    assert.equal(env.pento().pieces.length, 0);
  } finally {
    env.teardown();
  }
});

test('a puzzle that was not published is shown as unavailable', async () => {
  const today = localToday();
  const env = makeEnv({ hash: '', files: publish({ [today]: ['wikipedia'] }) });
  try {
    await until(() => env.el('start-progress').textContent);
    assert.equal(env.el('start-progress').textContent, '0 of 1 solved today');
  } finally {
    env.teardown();
  }
});

test('with nothing published (local development) the start page offers the sample', async () => {
  const env = makeEnv({ hash: '' });
  try {
    await until(() => env.el('start-progress').textContent);
    assert.equal(env.el('start-progress').textContent, '0 of 1 solved today');
  } finally {
    env.teardown();
  }
});

test("the player's local date picks the day, and days in their future are not offered", async () => {
  const today = localToday();
  const files = publish({
    [shiftDay(today, 1)]: ALL_KEYS, // tomorrow: published for time zones ahead of UTC
    [today]: ALL_KEYS,
    [shiftDay(today, -1)]: ALL_KEYS,
  });
  const env = makeEnv({ hash: '', files });
  try {
    await until(() => env.el('start-progress').textContent);
    assert.match(env.el('day-label').textContent, /^Today/);
    assert.equal(env.el('day-next').disabled, true, 'cannot go past today');
    assert.equal(env.el('day-prev').disabled, false, 'yesterday is available');
    env.el('day-prev').fire('click');
    assert.equal(env.hashLog.at(-1), '#' + shiftDay(today, -1), 'earlier day opens its list');
  } finally {
    env.teardown();
  }
});

test('an earlier day lists its own puzzles and results, and can be played', async () => {
  const today = localToday();
  const yesterday = shiftDay(today, -1);
  const files = publish({ [today]: ALL_KEYS, [yesterday]: ALL_KEYS });
  const storage = new Map([['pd:done:fixed:' + yesterday, JSON.stringify({ seconds: 300, moves: 30, hints: 0 })]]);
  const env = makeEnv({ hash: '#' + yesterday, storage, files });
  try {
    await until(() => env.el('start-progress').textContent);
    assert.match(env.el('day-label').textContent, /^Yesterday/);
    assert.equal(env.el('start-progress').textContent, '1 of 4 solved', "yesterday's list, not today's");
    assert.equal(env.el('day-next').disabled, false, 'can go forward to today');
  } finally {
    env.teardown();
  }
});

test('an earlier day is saved but does not touch the streak, and Back returns to that day', async () => {
  const today = localToday();
  const yesterday = shiftDay(today, -1);
  const files = publish({ [today]: ALL_KEYS, [yesterday]: ALL_KEYS });
  const storage = new Map();
  const env = makeEnv({ hash: '#' + yesterday + '/tetromino', storage, files });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    assert.match(env.el('puzzle-date').textContent, /earlier day/);
    env.el('help').open = false;
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.ok(storage.has('pd:done:tetromino:' + yesterday), 'result saved for that day');
    assert.ok(!storage.has('pd:stats'), 'streak and best time untouched by an earlier day');
    env.el('btn-more').fire('click');
    assert.equal(env.hashLog.at(-1), '#' + yesterday, 'Back goes to that day, not today');
  } finally {
    env.teardown();
  }
});

test("today's puzzle still counts toward the streak, and Back returns to today", async () => {
  const today = localToday();
  const storage = new Map();
  const env = makeEnv({ hash: '#' + today + '/nasa', storage, files: publish({ [today]: ALL_KEYS, [shiftDay(today, -1)]: ALL_KEYS }) });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    assert.doesNotMatch(env.el('puzzle-date').textContent, /earlier day/);
    env.el('help').open = false;
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.equal(JSON.parse(storage.get('pd:stats')).streak, 1);
    env.el('btn-more').fire('click');
    assert.equal(env.hashLog.at(-1), '', 'Back goes to the start page for today');
  } finally {
    env.teardown();
  }
});

test('each picture has its own puzzle and its own saved result', async () => {
  const today = localToday();
  const storage = new Map();
  const env = makeEnv({ hash: '#nasa', storage, files: publish({ [today]: ALL_KEYS }) });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    assert.equal(env.el('app').hidden, false);
    assert.match(env.el('puzzle-date').textContent, /NASA picture/);
    env.el('help').open = false;
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.ok(storage.has('pd:done:nasa:' + today));
    assert.ok(!storage.has('pd:done:wikipedia:' + today), 'the other puzzle is still unsolved');
    env.el('btn-share').fire('click');
    await until(() => env.clipboard.text);
    assert.match(env.clipboard.text, /NASA picture/);

    env.el('btn-more').fire('click');
    assert.deepEqual(env.hashLog, [''], 'More puzzles returns to the start page');
  } finally {
    env.teardown();
  }
});

test('the tetromino puzzle is a 4x6 board of 4-cell pieces', async () => {
  const env = makeEnv({ hash: '#tetromino', files: publish({ [localToday()]: ALL_KEYS }) });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    const { pieces, layout } = env.pento();
    assert.equal(layout.cols, 4);
    assert.equal(layout.rows, 6);
    assert.equal(pieces.length, 6);
    assert.ok(pieces.every((p) => p.home.length === 4));
    env.el('help').open = false;
    await solveByDragging(env);
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);
  } finally {
    env.teardown();
  }
});

test('the fixed-pieces puzzle starts upright and cannot rotate or flip', async () => {
  const env = makeEnv({ hash: '#fixed', files: publish({ [localToday()]: ALL_KEYS }) });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    const { pieces, states, layout } = env.pento();
    assert.equal(layout.cols * layout.rows, 40);
    assert.equal(pieces.length, 8);
    assert.ok(states.every((st) => st.r === 0 && !st.f), 'every piece starts in its home orientation');
    assert.equal(env.el('btn-rotate').hidden, true);
    assert.equal(env.el('btn-flip').hidden, true);

    // Selecting a piece and trying to turn it (button, tap, key) changes nothing.
    const canvas = env.el('board');
    const { s, bx, by } = layout;
    const st = states[0];
    const x = bx + st.slot[0] * s;
    const y = by + st.slot[1] * s;
    tap(canvas, x, y);
    tap(canvas, x, y);
    env.el('btn-rotate').fire('click');
    env.el('btn-flip').fire('click');
    (env.docHandlers.keydown || []).forEach((fn) => fn({ key: 'r' }));
    assert.ok(st.r === 0 && !st.f);

    // Dragging each piece straight to its spot solves it, with no rotation needed.
    env.el('help').open = false;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const q = states[i];
      const [sx, sy] = [bx + q.slot[0] * s, by + q.slot[1] * s];
      const [tx, ty] = [bx + Core.pivotForGrid(p, 0, false, p.home[0])[0] * s, by + Core.pivotForGrid(p, 0, false, p.home[0])[1] * s];
      canvas.fire('pointerdown', ptr(sx, sy));
      canvas.fire('pointermove', ptr((sx + tx) / 2, (sy + ty) / 2));
      canvas.fire('pointermove', ptr(tx + s * 0.2, ty - s * 0.15));
      canvas.fire('pointerup', ptr(tx + s * 0.2, ty - s * 0.15));
      assert.equal(q.placed, true, 'piece ' + i + ' placed');
    }
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);
  } finally {
    env.teardown();
  }
});



// Re-tiles the game's own pieces a different way (see tiling-helpers) and drags them there.
async function placeAlternateTiling(env, cols, rows) {
  const canvas = env.el('board');
  const { pieces, states, layout } = env.pento();
  const alt = otherTiling(pieces, cols, rows);
  assert.ok(alt, 'this seed has a second tiling');
  const { s, bx, by } = layout;
  const toPx = (u) => [bx + u[0] * s, by + u[1] * s];
  for (let i = 0; i < pieces.length; i++) {
    const pl = placementFor(pieces[i], alt[i], cols, rows);
    assert.ok(pl, 'piece ' + i + ' fits its new cells');
    const st = states[i];
    st.r = pl.r; // turn it in the tray first, as a player would with Rotate/Flip
    st.f = pl.f;
    const [sx, sy] = toPx(st.slot);
    const [tx, ty] = toPx(Core.pivotForGrid(pieces[i], pl.r, pl.f, pl.g0));
    canvas.fire('pointerdown', ptr(sx, sy));
    canvas.fire('pointermove', ptr((sx + tx) / 2, (sy + ty) / 2));
    canvas.fire('pointermove', ptr(tx + s * 0.1, ty - s * 0.1));
    canvas.fire('pointerup', ptr(tx + s * 0.1, ty - s * 0.1));
    assert.equal(st.placed, true, 'piece ' + i + ' placed');
  }
}

test('a different arrangement that looks identical on a flat picture ends the game', async () => {
  const env = makeEnv({ search: '?debug&seed=alt0', flatImage: true });
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    env.el('help').open = false;
    await placeAlternateTiling(env, 5, 6);
    await until(() => env.el('win').open, 4000);
    assert.equal(env.pento().won, true);
  } finally {
    env.teardown();
  }
});

test('a full board that does not match the picture says so instead of silently continuing', async () => {
  const env = makeEnv({ search: '?debug&seed=alt0' }); // no pixel data: only the exact arrangement counts
  try {
    await until(() => env.pento() && env.pento().pieces.length > 0);
    env.el('help').open = false;
    await placeAlternateTiling(env, 5, 6);
    assert.equal(env.pento().won, false, 'not solved');
    assert.equal(env.el('notice').hidden, false, 'the player is told why');
    assert.match(env.el('notice').textContent, /wrong spot/);

    // Hint still helps: it points at a piece that is not where the picture wants it.
    env.el('btn-hint').fire('click');
    assert.equal(env.el('hints').hidden, false);
  } finally {
    env.teardown();
  }
});
