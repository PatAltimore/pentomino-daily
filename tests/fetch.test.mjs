import test from 'node:test';
import assert from 'node:assert/strict';
import { pickApod, pickCommons, isPlaceholderTitle, pickWikimedia, pickArtic, pickNasaLibraryItem, buildNasaLibraryPick, hashSeed } from '../scripts/fetch-daily.mjs';

const apod = {
  date: '2026-11-07',
  title: 'A Nebula',
  explanation: 'Gas   and\n dust.',
  media_type: 'image',
  url: 'https://apod.nasa.gov/apod/image/2611/nebula_1024.jpg',
  hdurl: 'https://apod.nasa.gov/apod/image/2611/nebula_big.jpg',
};

test('APOD: public-domain image is picked with a page link built from the date', () => {
  const pick = pickApod(apod);
  assert.equal(pick.date, '2026-11-07');
  assert.equal(pick.pageUrl, 'https://apod.nasa.gov/apod/ap261107.html');
  assert.equal(pick.description, 'Gas and dust.');
  assert.deepEqual(pick.imageUrls, [apod.url, apod.hdurl]);
  assert.match(pick.credit, /NASA/);
});

test('APOD: the "NASA Science" logo stand-in is not a picture of the day', () => {
  assert.equal(pickApod({ ...apod, title: 'NASA Science' }), null);
  assert.equal(pickApod({ ...apod, title: ' nasa science ' }), null);
  assert.ok(pickApod({ ...apod, title: 'NASA Science Live: a nebula' }), 'only the exact placeholder title');
  assert.equal(isPlaceholderTitle('NASA Science'), true);
  assert.equal(isPlaceholderTitle('Orion Nebula'), false);
  assert.equal(isPlaceholderTitle(undefined), false);
});

test('APOD: videos and copyrighted images are skipped unless allowed', () => {
  assert.equal(pickApod({ ...apod, media_type: 'video' }), null);
  assert.equal(pickApod({ ...apod, copyright: 'Jane Doe' }), null);
  const allowed = pickApod({ ...apod, copyright: 'Jane Doe' }, { allowCopyrighted: true });
  assert.match(allowed.credit, /Jane Doe/);
  assert.equal(pickApod(null), null);
  assert.equal(pickApod({ ...apod, date: 'yesterday' }), null);
});

test('Wikimedia: asks for a larger thumbnail first and keeps the original as a fallback', () => {
  const feed = {
    image: {
      title: 'File:Red_fox_(Vulpes_vulpes).jpg',
      thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fox.jpg/640px-Fox.jpg' },
      image: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Fox.jpg' },
      file_page: 'https://commons.wikimedia.org/wiki/File:Fox.jpg',
      artist: { text: 'Some Photographer' },
      license: { type: 'CC BY-SA 4.0' },
      description: { text: 'A fox in the snow.' },
    },
  };
  const pick = pickWikimedia(feed, '2026-11-07');
  assert.equal(pick.title, 'Red fox (Vulpes vulpes)');
  assert.deepEqual(pick.imageUrls, [
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fox.jpg/1280px-Fox.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fox.jpg/640px-Fox.jpg',
  ]);
  assert.match(pick.credit, /Some Photographer/);
  assert.match(pick.credit, /CC BY-SA 4\.0/);
  assert.equal(pick.pageUrl, 'https://commons.wikimedia.org/wiki/File:Fox.jpg');
  assert.equal(pickWikimedia({}, '2026-11-07'), null);
});

const artwork = (id, over = {}) => ({
  id,
  title: 'Work ' + id,
  artist_display: 'Some Artist\nAmerican, 1850-1910',
  image_id: 'img-' + id,
  is_public_domain: true,
  thumbnail: { width: 800, height: 1000 },
  short_description: '<p>A &quot;nice&quot; picture &amp; more.</p>',
  ...over,
});

test('Art Institute: picks a public-domain work deterministically and builds IIIF image URLs', () => {
  const json = {
    config: { iiif_url: 'https://www.artic.edu/iiif/2' },
    data: [
      artwork(3),
      artwork(1),
      artwork(2, { is_public_domain: false }),
      artwork(4, { image_id: null }),
      artwork(5, { thumbnail: { width: 4000, height: 500 } }), // too wide a strip
      artwork(6, { thumbnail: null }),
      artwork(7),
    ],
  };
  const a = pickArtic(json, { date: '2026-11-07', seed: 'x' });
  const b = pickArtic({ ...json, data: [...json.data].reverse() }, { date: '2026-11-07', seed: 'x' });
  assert.equal(a.id, b.id, 'same seed, same pick, whatever order the API returned');
  assert.ok([1, 3, 7].includes(a.id));
  assert.match(a.pageUrl, /^https:\/\/www\.artic\.edu\/artworks\/\d+$/);
  assert.equal(a.imageUrls[0], `https://www.artic.edu/iiif/2/img-${a.id}/full/843,/0/default.jpg`);
  assert.equal(a.description, 'A "nice" picture & more.');
  assert.match(a.credit, /Some Artist, American, 1850-1910/);
  assert.match(a.credit, /CC0/);
  assert.equal(a.source, 'Art Institute of Chicago');
  assert.equal(a.date, '2026-11-07');
});

test('Art Institute: skipIds keeps two puzzles on different works; nothing usable gives null', () => {
  const json = { data: [artwork(1), artwork(2)] };
  const first = pickArtic(json, { date: 'd', seed: 'k1' });
  const second = pickArtic(json, { date: 'd', seed: 'k2', skipIds: [first.id] });
  assert.notEqual(first.id, second.id);
  assert.equal(pickArtic({ data: [artwork(1, { is_public_domain: false })] }, { date: 'd', seed: 's' }), null);
  assert.equal(pickArtic(null, { date: 'd', seed: 's' }), null);
});

test('hashSeed is stable', () => {
  assert.equal(hashSeed('2026-11-07'), hashSeed('2026-11-07'));
  assert.notEqual(hashSeed('2026-11-07'), hashSeed('2026-11-08'));
});

const libItem = (id, over = {}) => ({
  data: [{ nasa_id: id, title: 'Title ' + id, description: 'A <b>nebula</b>.', media_type: 'image', center: 'JPL', ...over }],
  links: [{ href: `http://images-assets.nasa.gov/image/${id}/${id}~thumb.jpg`, rel: 'preview', render: 'image' }],
});

test('NASA library: skips copyrighted and non-image items and picks by seed', () => {
  const json = {
    collection: {
      items: [
        libItem('B'),
        libItem('A'),
        libItem('C', { media_type: 'video' }),
        libItem('D', { description: 'Photo (c) copyright Someone' }),
        libItem('E', { secondary_creator: 'Jane \u00a9 Doe' }),
      ],
    },
  };
  const a = pickNasaLibraryItem(json, 'seed');
  const b = pickNasaLibraryItem({ collection: { items: [...json.collection.items].reverse() } }, 'seed');
  assert.equal(a.data[0].nasa_id, b.data[0].nasa_id);
  assert.ok(['A', 'B'].includes(a.data[0].nasa_id));
  assert.equal(pickNasaLibraryItem({ collection: { items: [] } }, 's'), null);
  assert.equal(pickNasaLibraryItem(null, 's'), null);
});

test('NASA library: prefers the large image, then medium, then the preview', () => {
  const item = libItem('X');
  const assets = {
    collection: {
      items: [
        { href: 'http://images-assets.nasa.gov/image/X/X~orig.tif' },
        { href: 'http://images-assets.nasa.gov/image/X/X~large.jpg' },
        { href: 'http://images-assets.nasa.gov/image/X/X~medium.jpg' },
        { href: 'http://images-assets.nasa.gov/image/X/X~thumb.jpg' },
      ],
    },
  };
  const pick = buildNasaLibraryPick(item, assets, '2026-11-07');
  assert.deepEqual(pick.imageUrls.slice(0, 2), [
    'https://images-assets.nasa.gov/image/X/X~large.jpg',
    'https://images-assets.nasa.gov/image/X/X~medium.jpg',
  ]);
  assert.equal(pick.description, 'A nebula.');
  assert.equal(pick.pageUrl, 'https://images.nasa.gov/details/X');
  assert.match(pick.credit, /NASA \/ JPL/);
  assert.equal(pick.source, 'NASA Image and Video Library');

  const previewOnly = buildNasaLibraryPick(item, null, '2026-11-07');
  assert.deepEqual(previewOnly.imageUrls, ['https://images-assets.nasa.gov/image/X/X~thumb.jpg']);
  assert.equal(buildNasaLibraryPick({ data: item.data, links: [] }, null, 'd'), null);
});

test('NASA library: skipIds keeps a day from reusing a picture another day already has', () => {
  const json = { collection: { items: [libItem('A'), libItem('B'), libItem('C')] } };
  const first = pickNasaLibraryItem(json, 'seed');
  const second = pickNasaLibraryItem(json, 'seed', [first.data[0].nasa_id]);
  assert.notEqual(first.data[0].nasa_id, second.data[0].nasa_id);
  assert.equal(pickNasaLibraryItem(json, 'seed', ['A', 'B', 'C']), null);
  assert.equal(buildNasaLibraryPick(first, null, 'd').id, first.data[0].nasa_id);
});

const commonsPage = (id, over = {}, info = {}) => ({
  pageid: id,
  title: 'File:Red_fox_' + id + '.jpg',
  imageinfo: [
    {
      mime: 'image/jpeg',
      width: 4000,
      height: 3000,
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Red_fox_${id}.jpg/1280px-Red_fox_${id}.jpg`,
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Red_fox_' + id + '.jpg',
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane Photographer</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        ImageDescription: { value: '<p>A red fox &amp; her kit.</p>' },
        ObjectName: { value: 'Red fox ' + id },
      },
      ...info,
    },
  ],
  ...over,
});

test('Commons: picks a licensed landscape/portrait JPEG photo deterministically and credits the photographer', () => {
  const json = {
    query: {
      pages: [
        commonsPage(30),
        commonsPage(10),
        commonsPage(20, {}, { mime: 'image/png' }), // not a JPEG photo
        commonsPage(40, {}, { width: 600, height: 500 }), // too small
        commonsPage(50, {}, { width: 6000, height: 800 }), // a very long strip
        commonsPage(60, {}, { extmetadata: { Artist: { value: 'X' } } }), // no licence
        commonsPage(70, {}, { extmetadata: { LicenseShortName: { value: 'Fair use' } } }),
        commonsPage(80, { imageinfo: [] }),
        commonsPage(90),
      ],
    },
  };
  const a = pickCommons(json, { date: '2026-11-07', seed: 'k' });
  const b = pickCommons({ query: { pages: [...json.query.pages].reverse() } }, { date: '2026-11-07', seed: 'k' });
  assert.equal(a.id, b.id, 'same seed, same pick, whatever order the API returned');
  assert.ok([10, 30, 90].includes(a.id), 'only the usable pages: ' + a.id);
  assert.equal(a.title, 'Red fox ' + a.id);
  assert.equal(a.description, 'A red fox & her kit.');
  assert.equal(a.credit, 'Photo: Jane Photographer · License: CC BY-SA 4.0');
  assert.match(a.pageUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  assert.match(a.imageUrls[0], /1280px-/);
  assert.match(a.imageUrls[1], /960px-/, 'a smaller size as a fallback');
  assert.equal(a.source, 'Wikimedia Commons featured picture');
  assert.equal(a.date, '2026-11-07');
});

test('Commons: accepts the older object-keyed response, honours skipIds and returns null when nothing fits', () => {
  const keyed = { query: { pages: { 11: commonsPage(11), 12: commonsPage(12) } } };
  const first = pickCommons(keyed, { date: 'd', seed: 's' });
  const second = pickCommons(keyed, { date: 'd', seed: 's', skipIds: [first.id] });
  assert.notEqual(first.id, second.id);
  assert.equal(pickCommons(keyed, { date: 'd', seed: 's', skipIds: [11, 12] }), null);
  assert.equal(pickCommons({ query: { pages: [] } }, { date: 'd', seed: 's' }), null);
  assert.equal(pickCommons(null, { date: 'd', seed: 's' }), null);
  const noName = pickCommons({ query: { pages: [commonsPage(5, {}, { extmetadata: { LicenseShortName: { value: 'CC0' } } })] } }, { date: 'd', seed: 's' });
  assert.equal(noName.title, 'Red fox 5', 'falls back to the file name');
  assert.equal(noName.credit, 'License: CC0');
});
