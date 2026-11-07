import test from 'node:test';
import assert from 'node:assert/strict';
import { pickApod, pickWikimedia } from '../scripts/fetch-daily.mjs';

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
