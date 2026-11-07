// End-to-end smoke test for site/game.js using a minimal fake DOM (no browser needed).
// It boots the game, drags every piece into place with synthetic pointer events and
// checks the win flow, persistence and the "already solved today" reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../site/core.js');

const SITE = path.join(__dirname, '..', 'site');
const GAME_SRC = fs.readFileSync(path.join(SITE, 'game.js'), 'utf8');

function makeEnv({ search = '?debug', storage = new Map(), imageSize = [1000, 1200] } = {}) {
  const intervals = new Set();
  const els = {};
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });

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
    location: { search, origin: 'http://localhost', pathname: '/' },
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

async function solveByDragging(env) {
  const canvas = env.el('board');
  const { pieces, states, layout } = env.pento();
  const { s, bx, by } = layout;
  const toPx = (u) => [bx + u[0] * s, by + u[1] * s];

  for (let i = 0; i < pieces.length; i++) {
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
