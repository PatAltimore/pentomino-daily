const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../site/viewport.js');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('only iPhone browser tabs get the bottom gap', () => {
  assert.equal(V.needsBarGap(IPHONE, false), true);
  assert.equal(V.needsBarGap(IPHONE, undefined), true);
  assert.equal(V.needsBarGap(IPHONE, true), false, 'an installed home-screen app has no browser bar');
  assert.equal(V.needsBarGap(ANDROID, false), false);
  assert.equal(V.needsBarGap(IPAD_AS_MAC, false), false);
  assert.equal(V.needsBarGap(undefined, false), false);
});

test('the visible height comes from visualViewport, and is not changed while pinch-zoomed', () => {
  assert.equal(V.visibleHeight({ innerHeight: 800 }, 0), 800, 'no visualViewport: innerHeight');
  assert.equal(V.visibleHeight({ innerHeight: 800, visualViewport: { height: 712.6, scale: 1 } }, 0), 713);
  assert.equal(V.visibleHeight({ innerHeight: 800, visualViewport: { height: 300, scale: 2.5 } }, 713), 713, 'zoomed: keep the last height');
  assert.equal(V.visibleHeight({ innerHeight: 800, visualViewport: { height: 300, scale: 2.5 } }, 0), 800, 'zoomed with no last height: innerHeight');
});

function fakeEnv(userAgent, standalone, vv) {
  const classes = new Set();
  const props = {};
  const listeners = [];
  const vvListeners = [];
  const win = {
    navigator: { userAgent, standalone },
    innerHeight: 844,
    visualViewport: vv && { ...vv, addEventListener: (t) => vvListeners.push(t) },
    addEventListener: (t) => listeners.push(t),
  };
  const doc = { documentElement: { classList: { add: (c) => classes.add(c) }, style: { setProperty: (k, v) => (props[k] = v) } } };
  return { win, doc, classes, props, listeners, vvListeners };
}

test('install marks iPhone browsers, sets --app-h and follows resizes', () => {
  const env = fakeEnv(IPHONE, false, { height: 760, scale: 1 });
  V.install(env.win, env.doc);
  assert.ok(env.classes.has('ios-browser'));
  assert.equal(env.props['--app-h'], '760px');
  assert.ok(env.listeners.includes('resize'));
  assert.deepEqual(env.vvListeners.sort(), ['resize', 'scroll']);

  const other = fakeEnv(ANDROID, false, null);
  V.install(other.win, other.doc);
  assert.ok(!other.classes.has('ios-browser'));
  assert.equal(other.props['--app-h'], '844px', 'falls back to innerHeight');
});
