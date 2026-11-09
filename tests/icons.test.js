// The app icon and the link-preview card: the files exist, have the right sizes, and the page points at them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.join(__dirname, '..', 'site');
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

/** Width and height from a PNG's header (and a check that it really is a PNG). */
function pngSize(file) {
  const buf = fs.readFileSync(path.join(SITE, file));
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' is a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const tag = (re) => {
  const m = re.exec(html);
  assert.ok(m, 'index.html has ' + re);
  return m[1];
};

test('the icons exist at the sizes phones and browsers ask for', () => {
  assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180], 'iPhone home screen and link previews');
  assert.deepEqual(pngSize('icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('icon-512.png'), [512, 512]);
  assert.deepEqual(pngSize('favicon-32.png'), [32, 32]);
  assert.match(fs.readFileSync(path.join(SITE, 'icon.svg'), 'utf8'), /^<svg[^>]*viewBox/);
});

test('the page links the icon files', () => {
  for (const href of [
    tag(/rel="apple-touch-icon" href="([^"]+)"/),
    tag(/rel="icon" type="image\/svg\+xml" href="([^"]+)"/),
    tag(/rel="icon" type="image\/png" sizes="32x32" href="([^"]+)"/),
    tag(/rel="manifest" href="([^"]+)"/),
  ]) {
    assert.ok(!/^(https?:)?\/\//.test(href) && !href.startsWith('/'), 'relative, so it works on a project page: ' + href);
    assert.ok(fs.existsSync(path.join(SITE, href)), href + ' exists');
  }
});

test('the link-preview card is an absolute-URL image with the right size', () => {
  const image = tag(/property="og:image" content="([^"]+)"/);
  assert.match(image, /^https:\/\/[^/]+\/.+\/og-image\.png$/, 'absolute https URL, as message apps require');
  assert.deepEqual(pngSize('og-image.png'), [1200, 630]);
  assert.equal(tag(/property="og:image:width" content="(\d+)"/), '1200');
  assert.equal(tag(/property="og:image:height" content="(\d+)"/), '630');
  assert.equal(tag(/property="og:title" content="([^"]+)"/), 'Pentomino Daily');
  assert.match(tag(/property="og:description" content="([^"]+)"/), /puzzle/i);
  assert.equal(tag(/name="twitter:card" content="([^"]+)"/), 'summary_large_image');
  assert.ok(fs.statSync(path.join(SITE, 'og-image.png')).size < 600 * 1024, 'small enough for message apps to fetch quickly');
});

test('the web app manifest names the app and points at real icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Pentomino Daily');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(SITE, icon.src)), icon.src + ' exists');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'), 'a 512 icon, for installing');
});
