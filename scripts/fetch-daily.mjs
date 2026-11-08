#!/usr/bin/env node
/*
 * Fetch today's four puzzle pictures and captions and write them into site/:
 *   site/images/daily-<key>-<date>.<ext>   the pictures (same origin, so the canvas can slice them)
 *   site/data/<key>.json                   title, caption, credit, link and the image path
 * where <key> is one of
 *   nasa        NASA's Astronomy Picture of the Day; if NASA's API is down, a picture from the
 *               NASA Image and Video Library (a different host) chosen by the date
 *   wikipedia   Wikipedia's Picture of the day
 *   tetromino   a public-domain artwork from the Art Institute of Chicago, chosen by the date
 *   fixed       another Art Institute artwork (the no-rotation puzzle)
 * If the Art Institute is unreachable, tetromino and fixed fall back to Wikipedia's Picture of
 * the day from one and two days earlier. The site's start page offers one puzzle for each.
 *
 * Set IMAGE_SOURCE=apod (NASA only), wikimedia (Wikipedia only) or artic (Art Institute only)
 * to fetch just one source.
 *
 * Environment:
 *   NASA_API_KEY        free key from https://api.nasa.gov (falls back to the rate-limited DEMO_KEY)
 *   IMAGE_SOURCE        auto (default, all) | apod | wikimedia | artic
 *   FORCE_REFETCH       set to 1 to fetch every picture even if today's is already in site/
 *   ALLOW_COPYRIGHTED   "true" to use APOD pictures that carry a photographer's copyright.
 *                       Default is to skip them, because this script republishes the image file.
 *
 * Exits non-zero only if nothing could be fetched or kept from a previous run, so a scheduled
 * deploy keeps the previous puzzles live. A puzzle with no picture shows as unavailable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const MAX_BYTES = 8 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const USER_AGENT =
  'pentomino-daily/1.0 (' +
  (process.env.GITHUB_REPOSITORY ? 'https://github.com/' + process.env.GITHUB_REPOSITORY : 'hobby project') +
  ')';

const tidy = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
};

/** Turn a NASA APOD API response into a pick, or null if it can't be used. */
export function pickApod(json, { allowCopyrighted = false } = {}) {
  if (!json || json.media_type !== 'image') return null; // videos can't be sliced
  if (!/^\d{4}-\d{2}-\d{2}$/.test(json.date || '')) return null;
  if (json.copyright && !allowCopyrighted) return null;
  const imageUrls = [json.url, json.hdurl].filter(Boolean); // url is the web-sized version; hdurl can be huge
  if (!imageUrls.length) return null;
  const [y, m, d] = json.date.split('-');
  return {
    source: 'NASA APOD',
    date: json.date,
    title: tidy(json.title, 120),
    description: tidy(json.explanation, 1500),
    credit: json.copyright ? 'Image credit & copyright: ' + tidy(json.copyright, 120) : 'Image credit: NASA',
    pageUrl: `https://apod.nasa.gov/apod/ap${y.slice(2)}${m}${d}.html`,
    imageUrls,
  };
}

const stripHtml = (value) =>
  String(value ?? '')
    .replace(/<\/?(p|br|div|li|ul|ol|h\d)\b[^>]*>/gi, ' ') // block tags separate words
    .replace(/<[^>]*>/g, '') // inline tags (b, i, a...) do not
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** Small stable string hash, so the same date always picks the same item. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Choose a public-domain artwork from an Art Institute of Chicago search response. The pick is
 * deterministic for a given seed, and only works whose image has a puzzle-friendly shape
 * (not a very long strip) are considered. `skipIds` keeps two puzzles from using the same work.
 */
export function pickArtic(json, { date, seed, skipIds = [] } = {}) {
  const items = (json && Array.isArray(json.data) ? json.data : [])
    .filter((a) => {
      if (!a || !a.image_id || a.is_public_domain !== true) return false;
      if (skipIds.includes(a.id)) return false;
      const w = a.thumbnail && a.thumbnail.width;
      const h = a.thumbnail && a.thumbnail.height;
      if (!w || !h) return false;
      const ratio = w / h;
      return ratio >= 0.6 && ratio <= 1.7;
    })
    .sort((a, b) => a.id - b.id);
  if (!items.length) return null;
  const art = items[hashSeed(String(seed)) % items.length];
  const iiif = (json.config && json.config.iiif_url) || 'https://www.artic.edu/iiif/2';
  const byline = tidy(stripHtml(art.artist_display).replace(/\s*\n\s*/g, ', '), 120);
  return {
    source: 'Art Institute of Chicago',
    id: art.id,
    date,
    title: tidy(stripHtml(art.title) || 'Untitled', 120),
    description: tidy(stripHtml(art.short_description || art.description), 1500) || byline,
    credit: [byline && 'Artwork: ' + byline, 'Art Institute of Chicago, CC0 public domain'].filter(Boolean).join(' · '),
    pageUrl: `https://www.artic.edu/artworks/${art.id}`,
    imageUrls: [`${iiif}/${art.image_id}/full/843,/0/default.jpg`, `${iiif}/${art.image_id}/full/600,/0/default.jpg`],
  };
}

/** NASA Image and Video Library: pick one result from a search response by seed. */
export function pickNasaLibraryItem(json, seed) {
  const items = ((json && json.collection && json.collection.items) || []).filter((it) => {
    const d = it && it.data && it.data[0];
    if (!d || !d.nasa_id || d.media_type !== 'image') return false;
    // The library mixes in a few pictures with outside credits; keep to plain NASA ones.
    return !/copyright|©/i.test([d.description, d.secondary_creator, d.photographer].join(' '));
  });
  if (!items.length) return null;
  items.sort((a, b) => String(a.data[0].nasa_id).localeCompare(String(b.data[0].nasa_id)));
  return items[hashSeed(String(seed)) % items.length];
}

/** Turn a library search result (plus its asset list, if we have it) into a pick. */
export function buildNasaLibraryPick(item, assetJson, date) {
  const d = item.data[0];
  const links = ((assetJson && assetJson.collection && assetJson.collection.items) || []).map((x) => x.href);
  const preview = (item.links || []).find((l) => l.render === 'image' || l.rel === 'preview');
  const pick = (suffix) => links.find((h) => new RegExp('~' + suffix + '\\.(jpe?g|png)$', 'i').test(h));
  const imageUrls = [pick('large'), pick('medium'), preview && preview.href]
    .filter(Boolean)
    .map((u) => u.replace(/^http:/, 'https:').replace(/ /g, '%20'));
  if (!imageUrls.length) return null;
  const who = d.secondary_creator || d.photographer || d.center || '';
  return {
    source: 'NASA Image and Video Library',
    date,
    title: tidy(d.title || 'NASA picture', 120),
    description: tidy(stripHtml(d.description_508 || d.description), 1500),
    credit: 'Image credit: NASA' + (who && who !== 'NASA' ? ' / ' + tidy(who, 80) : ''),
    pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
    imageUrls: [...new Set(imageUrls)],
  };
}

/** Turn a Wikimedia "featured content" feed response into a pick, or null. */
export function pickWikimedia(json, date) {
  const image = json && json.image;
  if (!image) return null;
  const thumb = image.thumbnail && image.thumbnail.source;
  const full = image.image && image.image.source;
  const imageUrls = [];
  if (thumb) {
    // Ask for a larger standard thumbnail size first; fall back to the one the feed gave us.
    imageUrls.push(thumb.replace(/\/\d+px-([^/]+)$/, '/1280px-$1'), thumb);
  }
  if (!thumb && full) imageUrls.push(full);
  if (!imageUrls.length) return null;
  const fileTitle = String(image.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  const artist = image.artist && image.artist.text;
  const license = image.license && (image.license.type || image.license.code);
  const credit = [artist && 'Image credit: ' + tidy(artist, 120), license && 'License: ' + tidy(license, 40)]
    .filter(Boolean)
    .join(' · ');
  return {
    source: 'Wikipedia Picture of the day',
    date,
    title: tidy(fileTitle || 'Picture of the day', 120),
    description: tidy(image.description && image.description.text, 1500),
    credit: credit || 'See the file page for credit and license',
    pageUrl: image.file_page || '',
    imageUrls: [...new Set(imageUrls)],
  };
}

/** Headers for a request; the Art Institute asks API clients to identify themselves in AIC-User-Agent. */
function headersFor(url, extra) {
  const headers = { 'User-Agent': USER_AGENT, ...extra };
  if (/(^|\.)artic\.edu$/.test(new URL(url).hostname)) headers['AIC-User-Agent'] = USER_AGENT;
  return headers;
}

async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: headersFor(url, { Accept: 'application/json' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Include the start of the response so the CI log says why (bad key, rate limit, outage...).
    const body = await res.text().catch(() => '');
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}` + (detail ? `: ${detail}` : ''));
  }
  return res.json();
}

async function download(urls) {
  let lastError = new Error('No image URL to download');
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: headersFor(url, {}), signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading the image`);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_EXT[type];
      if (!ext) throw new Error(`Unsupported image type "${type}"`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`Image is too large (${buf.length} bytes)`);
      return { buf, ext };
    } catch (err) {
      lastError = err;
      console.warn('  ' + (err && err.message ? err.message : err));
    }
  }
  throw lastError;
}

async function writeOutputs(key, pick, { buf, ext }) {
  const imagesDir = path.join(SITE, 'images');
  const dataDir = path.join(SITE, 'data');
  await mkdir(imagesDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const fileName = `daily-${key}-${pick.date}.${ext}`;
  for (const name of await readdir(imagesDir)) {
    if (name.startsWith(`daily-${key}-`) && name !== fileName) await rm(path.join(imagesDir, name));
  }
  await writeFile(path.join(imagesDir, fileName), buf);
  const today = {
    key,
    date: pick.date,
    title: pick.title,
    description: pick.description,
    credit: pick.credit,
    source: pick.source,
    pageUrl: pick.pageUrl,
    image: `images/${fileName}`,
  };
  await writeFile(path.join(dataDir, `${key}.json`), JSON.stringify(today, null, 2) + '\n');
  return today;
}

function shiftDate(dateStr, days) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

/** NASA's API is sometimes slow, so give it a longer timeout and a second try. */
async function fetchJsonRetry(url) {
  try {
    return await fetchJson(url, 45000);
  } catch (err) {
    console.warn('  ' + (err && err.message ? err.message : err) + ' - retrying once');
    return fetchJson(url, 45000);
  }
}

async function fetchWikipedia(daysBack) {
  const date = shiftDate(new Date().toISOString().slice(0, 10), -daysBack);
  const [y, m, d] = date.split('-');
  const urls = [
    `https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`,
    `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${d}`,
  ];
  let lastError;
  for (const url of urls) {
    try {
      return pickWikimedia(await fetchJson(url), date);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * True when a picture for `key` dated today is already in site/ (restored from the previous run's
 * cache). The deploy runs hourly, so skipping these keeps today's puzzle from changing under a
 * player (say, from a fallback picture to the preferred source) and saves needless requests.
 */
function haveTodaysPicture(key) {
  try {
    const info = JSON.parse(readFileSync(path.join(SITE, 'data', `${key}.json`), 'utf8'));
    return info.date === todayUtc() && existsSync(path.join(SITE, info.image));
  } catch {
    return false;
  }
}

/** A public-domain artwork from the Art Institute of Chicago, chosen by date (and puzzle key). */
async function fetchArtic(key, skipIds) {
  const date = todayUtc();
  // The list is the first 1000 public-domain results in 100-item pages; the date picks the page,
  // then the work within it, so everyone gets the same artwork and it changes daily.
  const page = (hashSeed('page:' + date) % 10) + 1;
  const fields = 'id,title,artist_display,image_id,is_public_domain,thumbnail,short_description,description';
  const url =
    'https://api.artic.edu/api/v1/artworks/search?query[term][is_public_domain]=true' +
    `&fields=${fields}&limit=100&page=${page}`;
  return pickArtic(await fetchJsonRetry(url), { date, seed: date + ':' + key, skipIds });
}

const NASA_LIBRARY_TOPICS = [
  'nebula', 'galaxy', 'hubble', 'earth from space', 'mars', 'supernova', 'moon',
  'aurora', 'sun', 'saturn', 'jupiter', 'webb telescope', 'star cluster', 'comet',
];

/** NASA Image and Video Library (images-api.nasa.gov), used when the APOD API is down. */
async function fetchNasaLibrary() {
  const date = todayUtc();
  const topic = NASA_LIBRARY_TOPICS[hashSeed('topic:' + date) % NASA_LIBRARY_TOPICS.length];
  const search = await fetchJson(
    `https://images-api.nasa.gov/search?q=${encodeURIComponent(topic)}&media_type=image&page_size=100`,
    45000,
  );
  const item = pickNasaLibraryItem(search, date + ':' + topic);
  if (!item) return null;
  let assets = null;
  try {
    assets = await fetchJson(`https://images-api.nasa.gov/asset/${encodeURIComponent(item.data[0].nasa_id)}`, 30000);
  } catch (err) {
    console.warn('  Could not list sizes, using the preview image: ' + (err && err.message ? err.message : err));
  }
  return buildNasaLibraryPick(item, assets, date);
}

async function fetchApod(apiKey, allowCopyrighted) {
  // One request per day: NASA's date-range query is slow and times out. Start with
  // today, then step back a few days if that day has no usable picture.
  const base = `https://api.nasa.gov/planetary/apod?api_key=${apiKey}`;
  let json = await fetchJsonRetry(base);
  const pick = pickApod(json, { allowCopyrighted });
  if (pick) return pick;
  for (let back = 1; back <= 6; back++) {
    const date = shiftDate(json.date, -1);
    json = await fetchJsonRetry(`${base}&date=${date}`);
    const older = pickApod(json, { allowCopyrighted });
    if (older) return older;
  }
  return null;
}

async function main() {
  const source = (process.env.IMAGE_SOURCE || 'auto').toLowerCase();
  const allowCopyrighted = process.env.ALLOW_COPYRIGHTED === 'true';
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';
  const want = (name) => source === 'auto' || source === name;

  // For each puzzle, sources to try in order; the first one that gives a downloadable picture wins.
  let articPick = null;
  const chains = {};
  if (want('apod')) {
    chains.nasa = [
      ['NASA APOD', () => fetchApod(apiKey, allowCopyrighted)],
      ['NASA Image and Video Library', fetchNasaLibrary],
    ];
  }
  if (want('wikimedia')) chains.wikipedia = [['Wikipedia Picture of the day', () => fetchWikipedia(0)]];
  for (const [key, daysBack] of [['tetromino', 1], ['fixed', 2]]) {
    const chain = [];
    if (want('artic')) {
      chain.push([
        'Art Institute of Chicago',
        async () => {
          const pick = await fetchArtic(key, articPick ? [articPick.id] : []);
          if (pick) articPick = pick;
          return pick;
        },
      ]);
    }
    if (want('wikimedia')) chain.push([`Wikipedia Picture of the day (${daysBack} day back)`, () => fetchWikipedia(daysBack)]);
    if (chain.length) chains[key] = chain;
  }

  let saved = 0;
  let kept = 0;
  for (const [key, chain] of Object.entries(chains)) {
    if (!process.env.FORCE_REFETCH && haveTodaysPicture(key)) {
      console.log(`[${key}] Already have today's picture; keeping it.`);
      kept++;
      continue;
    }
    let done = false;
    for (const [name, attempt] of chain) {
      try {
        console.log(`[${key}] Trying ${name}...`);
        const pick = await attempt();
        if (!pick) {
          console.log('  Skipped: no usable picture (video, copyrighted or missing).');
          continue;
        }
        const today = await writeOutputs(key, pick, await download(pick.imageUrls));
        console.log(`  Saved "${today.title}" (${today.date}) from ${today.source} -> site/${today.image}`);
        saved++;
        done = true;
        break;
      } catch (err) {
        console.warn(`  ${name} failed: ${err && err.message ? err.message : err}`);
      }
    }
    // The deploy workflow restores the previous run's files, so an outage keeps the old puzzle.
    if (!done && existsSync(path.join(SITE, 'data', `${key}.json`))) {
      console.log(`  Keeping the previously fetched ${key} picture.`);
      kept++;
    }
  }
  if (!saved && !kept) throw new Error('No picture source worked.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
