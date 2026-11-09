#!/usr/bin/env node
/*
 * Fetch the puzzle pictures and captions for a window of days and write them into site/:
 *   site/data/<day>/<key>.json             title, caption, credit, link and the image path
 *   site/images/daily-<key>-<day>.<ext>    the picture (same origin, so the canvas can slice it)
 *   site/data/manifest.json                which days and puzzles are available
 * <day> is the puzzle's day. The browser shows each player the puzzles for their local date, and
 * lets them play the other days in the window. <key> is one of
 *   nasa        NASA's Astronomy Picture of the Day from the day before <day>; if that is not
 *               available, a NASA Image and Video Library picture chosen by <day>
 *   wikipedia   Wikipedia's Picture of the day from the day before <day>
 *   tetromino   a public-domain Art Institute of Chicago artwork chosen by <day>
 *   fixed       another Art Institute artwork (the no-rotation puzzle)
 *   commons     a Wikimedia Commons featured photograph of an animal, chosen by <day> (the animal
 *               photo puzzle, a second no-rotation puzzle)
 * The two "picture of the day" puzzles use the previous day's picture so that it already exists in
 * every time zone at local midnight. If the Art Institute is unreachable, tetromino and fixed fall back
 * to older Wikipedia pictures. The animal photo never falls back to a non-animal picture: if Commons is
 * unreachable that day is simply unavailable (earlier days stay, from the cache).
 *
 * The window is the UTC date's neighbours: from tomorrow (UTC) back BACK_DAYS days, which covers
 * every time zone's local "today" and leaves a week of earlier puzzles to play.
 *
 * Set IMAGE_SOURCE=apod (NASA only), wikimedia (Wikipedia only), artic (Art Institute only) or
 * commons (Commons animal photos only) to fetch just one source.
 *
 * Environment:
 *   NASA_API_KEY        free key from https://api.nasa.gov (falls back to the rate-limited DEMO_KEY)
 *   IMAGE_SOURCE        auto (default, all) | apod | wikimedia | artic | commons
 *   FORCE_REFETCH       set to 1 to fetch every picture even if it is already in site/
 *   ALLOW_COPYRIGHTED   "true" to use APOD pictures that carry a photographer's copyright.
 *                       Default is to skip them, because this script republishes the image file.
 *
 * Pictures already fetched (restored from the previous run's cache) are kept, and a source that
 * errors is not retried for the rest of the run. Exits non-zero only if nothing is available.
 */
import { createHash } from 'node:crypto';
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

// APOD sometimes publishes a stand-in (the NASA logo, titled "NASA Science") instead of a picture.
const PLACEHOLDER_TITLE = /^\s*nasa science\s*$/i;
export const isPlaceholderTitle = (title) => PLACEHOLDER_TITLE.test(String(title ?? ''));

/** Turn a NASA APOD API response into a pick, or null if it can't be used. */
export function pickApod(json, { allowCopyrighted = false } = {}) {
  if (!json || json.media_type !== 'image') return null; // videos can't be sliced
  if (isPlaceholderTitle(json.title)) return null; // the logo stand-in, not a picture of the day
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

/**
 * Choose a featured photograph from a Wikimedia Commons query response (generator=search with
 * imageinfo). Only ordinary JPEG photos of a puzzle-friendly shape and size with a stated licence
 * are considered, and `accept` (if given) can rule pages out, for example by their categories. The pick is
 * deterministic for a given seed; `skipIds` avoids reusing a picture.
 */
// Words that mark a Commons category as being about an animal, and words that mark it as being about
// something else (art, models, specimens) that merely shows one.
const ANIMAL_WORDS = /\b(animals?|fauna|birds?|mammals?|insects?|reptiles?|amphibians?|fish(?:es)?|arachnids?|spiders?|butterfl(?:y|ies)|moths?|beetles?|bees|wasps?|ants|dragonflies|damselflies|snakes?|lizards?|frogs?|toads?|turtles?|tortoises?|crocodil\w+|mammalia|aves|insecta|reptilia|amphibia|arthropods?|crustaceans?|molluscs?|mollusks?|primates?|monkeys?|apes?|bats|owls?|eagles?|hawks?|falcons?|ducks?|geese|swans?|herons?|parrots?|penguins?|whales?|dolphins?|seals?|sharks?|cats|dogs|horses|cattle|cows|sheep|goats|deer|bears|wolves|foxes|lions?|tigers?|elephants?|giraffes?|zebras?|rhinoceros\w*|hippopotam\w+|squirrels?|rabbits?|hares?|otters?|lemurs?)\b/i;
const NOT_A_PHOTO = /\b(sculptures?|statues?|paintings?|drawings?|illustrations?|engravings?|stamps?|coins?|logos?|coats? of arms|heraldry|toys?|taxidermy|museums?|mascots?|cartoons?|comics?|emblems?|monuments?|mosaics?|tapestr\w+|lithographs?|posters?|fossils?|skeletons?|skulls?|specimens?)\b/i;

/** The category names (without the "Category:" prefix) of a page from a prop=categories response. */
export function categoryNames(page) {
  return ((page && page.categories) || []).map((c) => String(c.title || '').replace(/^Category:/i, ''));
}

/** True when a page's own categories say it shows an animal (and it is not art or a specimen). */
export function looksLikeAnimal(page) {
  const names = categoryNames(page);
  return names.some((n) => ANIMAL_WORDS.test(n)) && !names.some((n) => NOT_A_PHOTO.test(n));
}

export function pickCommons(json, { date, seed, skipIds = [], accept } = {}) {
  const raw = json && json.query && json.query.pages;
  const pages = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
  const meta = (info, name) => stripHtml(info.extmetadata && info.extmetadata[name] && info.extmetadata[name].value).trim();
  const items = pages
    .map((page) => ({ page, info: page && page.imageinfo && page.imageinfo[0] }))
    .filter(({ page, info }) => {
      if (!page || !info || skipIds.includes(page.pageid)) return false;
      if (accept && !accept(page)) return false;
      if (info.mime !== 'image/jpeg') return false;
      if (!(info.width >= 1000 || info.height >= 1000) || Math.min(info.width, info.height) < 700) return false;
      const ratio = info.width / info.height;
      if (ratio < 0.6 || ratio > 1.7) return false;
      const license = meta(info, 'LicenseShortName');
      if (!license || /fair use|non-?free/i.test(license)) return false;
      return Boolean(info.thumburl || info.url);
    })
    .sort((a, b) => a.page.pageid - b.page.pageid);
  if (!items.length) return null;
  const { page, info } = items[hashSeed(String(seed)) % items.length];
  const fileTitle = String(page.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  const artist = tidy(meta(info, 'Artist'), 100);
  const license = tidy(meta(info, 'LicenseShortName'), 40);
  const big = info.thumburl || info.url;
  return {
    source: 'Wikimedia Commons featured picture',
    id: page.pageid,
    date,
    title: tidy(meta(info, 'ObjectName') || fileTitle || 'Photograph', 120),
    description: tidy(meta(info, 'ImageDescription'), 1500),
    credit: [artist && 'Photo: ' + artist, license && 'License: ' + license].filter(Boolean).join(' · ') || 'See the file page for credit and license',
    pageUrl: info.descriptionurl || '',
    imageUrls: [...new Set([big, big.replace(/\/\d+px-([^/]+)$/, '/960px-$1')])],
  };
}

/** NASA Image and Video Library: pick one result from a search response by seed. */
export function pickNasaLibraryItem(json, seed, skipIds = []) {
  const items = ((json && json.collection && json.collection.items) || []).filter((it) => {
    const d = it && it.data && it.data[0];
    if (!d || !d.nasa_id || d.media_type !== 'image') return false;
    if (skipIds.includes(d.nasa_id)) return false;
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
    id: d.nasa_id,
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
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}` + (detail ? `: ${detail}` : ''));
    err.status = res.status;
    throw err;
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

const KEYS = ['nasa', 'wikipedia', 'tetromino', 'fixed', 'commons'];
const BACK_DAYS = 5;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The days to publish, newest first: tomorrow (UTC) back BACK_DAYS days before today. */
export function windowDays(today) {
  const out = [];
  for (let i = 1; i >= -BACK_DAYS; i--) out.push(shiftDate(today, i));
  return out;
}

/** Order to fetch in, so the days players are most likely to open come first. */
export function fetchOrder(today) {
  const days = windowDays(today);
  const first = [today, shiftDate(today, 1), shiftDate(today, -1)];
  return [...first, ...days.filter((d) => !first.includes(d))];
}

const entryPath = (day, key) => path.join(SITE, 'data', day, `${key}.json`);

/** The saved entry for a day and puzzle, or null when missing or its picture is gone. */
function readEntry(day, key) {
  try {
    const info = JSON.parse(readFileSync(entryPath(day, key), 'utf8'));
    if (isPlaceholderTitle(info.title)) return null; // saved before placeholders were rejected: refetch
    if (key === 'commons' && info.topic !== 'animals') return null; // saved before it was animals only: refetch
    return existsSync(path.join(SITE, info.image)) ? info : null;
  } catch {
    return null;
  }
}

/** Ids (artwork or NASA library item) other entries already use, so two days don't get one picture. */
function usedItemIds(days, keys, exceptDay, exceptKey) {
  const ids = [];
  for (const d of days) {
    for (const k of keys) {
      if (d === exceptDay && k === exceptKey) continue;
      const e = readEntry(d, k);
      if (e && e.itemId) ids.push(e.itemId);
    }
  }
  return ids;
}

/** The day another entry for this puzzle already uses exactly this image, if any. */
function sameImageElsewhere(days, key, day, hash) {
  for (const d of days) {
    if (d === day) continue;
    const e = readEntry(d, key);
    if (e && e.sha256 === hash) return d;
  }
  return null;
}

async function writeEntry(day, key, pick, { buf, ext }, extra) {
  const imagesDir = path.join(SITE, 'images');
  await mkdir(imagesDir, { recursive: true });
  await mkdir(path.join(SITE, 'data', day), { recursive: true });
  const base = `daily-${key}-${day}`;
  for (const name of await readdir(imagesDir)) {
    if (name.startsWith(base + '.')) await rm(path.join(imagesDir, name));
  }
  const fileName = `${base}.${ext}`;
  await writeFile(path.join(imagesDir, fileName), buf);
  const entry = {
    key,
    day,
    date: pick.date,
    title: pick.title,
    description: pick.description,
    credit: pick.credit,
    source: pick.source,
    pageUrl: pick.pageUrl,
    image: `images/${fileName}`,
    ...extra,
  };
  await writeFile(entryPath(day, key), JSON.stringify(entry, null, 2) + '\n');
  return entry;
}

/** Drop days outside the window, pictures no entry uses, and the old single-day layout. */
async function prune(days) {
  const dataDir = path.join(SITE, 'data');
  const keep = new Set(days);
  for (const name of existsSync(dataDir) ? await readdir(dataDir) : []) {
    const old = KEYS.map((k) => `${k}.json`).includes(name) || name === 'today.json';
    if (old || (DAY_RE.test(name) && !keep.has(name))) await rm(path.join(dataDir, name), { recursive: true, force: true });
  }
  const used = new Set();
  for (const day of days) for (const key of KEYS) {
    const e = readEntry(day, key);
    if (e) used.add(path.basename(e.image));
  }
  const imagesDir = path.join(SITE, 'images');
  for (const name of existsSync(imagesDir) ? await readdir(imagesDir) : []) {
    if (name.startsWith('daily-') && !used.has(name)) await rm(path.join(imagesDir, name));
  }
}

/** Write data/manifest.json from the entries on disk. Returns the number of entries listed. */
async function writeManifest(days, today) {
  const entries = {};
  let count = 0;
  for (const day of days) {
    const keys = KEYS.filter((k) => readEntry(day, k));
    if (keys.length) {
      entries[day] = keys;
      count += keys.length;
    }
  }
  const manifest = { today, days: Object.keys(entries).sort().reverse(), entries };
  await mkdir(path.join(SITE, 'data'), { recursive: true });
  await writeFile(path.join(SITE, 'data', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return count;
}

async function fetchWikipedia(date) {
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

const articPages = new Map();

/** A public-domain artwork from the Art Institute of Chicago, chosen by day (and puzzle key). */
async function fetchArtic(day, key, skipIds) {
  // The list is the first 1000 public-domain results in 100-item pages; the day picks the page,
  // then the work within it, so everyone gets the same artwork and it changes daily.
  const page = (hashSeed('page:' + day) % 10) + 1;
  if (!articPages.has(page)) {
    const fields = 'id,title,artist_display,image_id,is_public_domain,thumbnail,short_description,description';
    const url =
      'https://api.artic.edu/api/v1/artworks/search?query[term][is_public_domain]=true' +
      `&fields=${fields}&limit=100&page=${page}`;
    articPages.set(page, await fetchJsonRetry(url));
  }
  return pickArtic(articPages.get(page), { date: day, seed: day + ':' + key, skipIds });
}

const NASA_LIBRARY_TOPICS = [
  'nebula', 'galaxy', 'hubble', 'earth from space', 'mars', 'supernova', 'moon',
  'aurora', 'sun', 'saturn', 'jupiter', 'webb telescope', 'star cluster', 'comet',
];

/** NASA Image and Video Library (images-api.nasa.gov), used when the APOD picture is unavailable. */
async function fetchNasaLibrary(day, skipIds = []) {
  const topic = NASA_LIBRARY_TOPICS[hashSeed('topic:' + day) % NASA_LIBRARY_TOPICS.length];
  const search = await fetchJson(
    `https://images-api.nasa.gov/search?q=${encodeURIComponent(topic)}&media_type=image&page_size=100`,
    45000,
  );
  const item = pickNasaLibraryItem(search, day + ':' + topic, skipIds);
  if (!item) return null;
  let assets = null;
  try {
    assets = await fetchJson(`https://images-api.nasa.gov/asset/${encodeURIComponent(item.data[0].nasa_id)}`, 30000);
  } catch (err) {
    console.warn('  Could not list sizes, using the preview image: ' + (err && err.message ? err.message : err));
  }
  return buildNasaLibraryPick(item, assets, day);
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_EXCLUDE =
  '-incategory:"Featured pictures of artwork|Featured pictures of paintings|Featured maps|Featured pictures of maps|Featured pictures of illustrations|Featured pictures of drawings and watercolors"';
// Every featured photograph (the base set), minus categories that are scans of artwork, maps and diagrams.
const COMMONS_FEATURED_QUERY = `filetype:bitmap incategory:"Featured pictures on Wikimedia Commons" ${COMMONS_EXCLUDE}`;
// Featured photographs filed under an animal category. Several likely names are listed; a name that
// does not exist simply matches nothing.
const COMMONS_ANIMAL_CATEGORIES = [
  'Featured pictures of animals',
  'Featured pictures of mammals',
  'Featured pictures of birds',
  'Featured pictures of insects',
  'Featured pictures of reptiles',
  'Featured pictures of amphibians',
  'Featured pictures of fish',
  'Featured pictures of arachnids',
  'Featured pictures of arthropods',
  'Featured pictures of molluscs',
  'Featured pictures of crustaceans',
  'Featured pictures of butterflies',
  'Featured pictures of spiders',
];
const COMMONS_ANIMAL_QUERY = `filetype:bitmap incategory:"${COMMONS_ANIMAL_CATEGORIES.join('|')}" ${COMMONS_EXCLUDE}`;

const commonsTotals = new Map();

/** How many Commons files match a search (cached for the run): the day picks a position among them. */
async function commonsTotal(query, label) {
  if (!commonsTotals.has(query)) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', list: 'search',
      srsearch: query, srnamespace: '6', srlimit: '1', srinfo: 'totalhits', srprop: '',
    });
    const json = await fetchJsonRetry(`${COMMONS_API}?${params}`);
    const total = Number(json && json.query && json.query.searchinfo && json.query.searchinfo.totalhits) || 0;
    console.log(`  Commons ${label}: ${total} pictures`);
    commonsTotals.set(query, total);
  }
  return commonsTotals.get(query);
}

/** 20 Commons files from a position in a search, with their image info (and categories if asked). */
async function commonsWindow(query, offset, withCategories) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: '20',
    gsroffset: String(offset),
    prop: withCategories ? 'imageinfo|categories' : 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1280',
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription|ObjectName',
  });
  if (withCategories) params.set('cllimit', 'max');
  return fetchJsonRetry(`${COMMONS_API}?${params}`);
}

/** A position for the day that leaves room for a full window of 20 (and stays within the search's reach). */
function commonsOffset(day, total, salt) {
  const span = Math.max(1, Math.min(total, 9000) - 19);
  return hashSeed(salt + day) % span;
}

/**
 * An animal photograph from Wikimedia Commons' featured pictures, chosen by day. First choice: pictures
 * filed under an animal category of the featured pictures. If those category names match nothing,
 * look through all featured pictures and keep those whose own categories say animal. Never a
 * non-animal picture: if neither finds one, there is no picture that day.
 */
async function fetchCommons(day, skipIds) {
  const seed = day + ':commons';
  const animals = await commonsTotal(COMMONS_ANIMAL_QUERY, 'featured animal pictures (by category)');
  if (animals > 0) {
    const json = await commonsWindow(COMMONS_ANIMAL_QUERY, commonsOffset(day, animals, 'animals:'), false);
    const pick = pickCommons(json, { date: day, seed, skipIds });
    if (pick) return { ...pick, topic: 'animals' };
  }
  const all = await commonsTotal(COMMONS_FEATURED_QUERY, 'featured pictures (all)');
  if (!all) return null;
  const base = commonsOffset(day, all, 'all:');
  for (let k = 0; k < 6; k++) { // animals are a fraction of the featured pictures: look at a few windows
    const offset = Math.min(base + k * 20, 9980);
    const json = await commonsWindow(COMMONS_FEATURED_QUERY, offset, true);
    const pick = pickCommons(json, { date: day, seed, skipIds, accept: looksLikeAnimal });
    if (pick) return { ...pick, topic: 'animals' };
  }
  return null;
}

/** APOD for one date. A 4xx (e.g. a date NASA has not published yet) means "no picture", not an outage. */
async function fetchApodOn(date, apiKey, allowCopyrighted) {
  try {
    const json = await fetchJsonRetry(`https://api.nasa.gov/planetary/apod?api_key=${apiKey}&date=${date}`);
    return pickApod(json, { allowCopyrighted });
  } catch (err) {
    if (err && err.status >= 400 && err.status < 500) return null;
    throw err;
  }
}

async function main() {
  const source = (process.env.IMAGE_SOURCE || 'auto').toLowerCase();
  const allowCopyrighted = process.env.ALLOW_COPYRIGHTED === 'true';
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';
  const force = Boolean(process.env.FORCE_REFETCH);
  const want = (name) => source === 'auto' || source === name;
  const today = todayUtc();
  const days = windowDays(today);

  // Sources that errored (outage, timeout) this run are skipped from then on, so one dead API
  // costs one timeout, not one per day.
  const down = new Set();

  // For a day and puzzle: sources to try in order. `fallback` marks a stand-in picture; those are
  // replaced as soon as the preferred source works again.
  const chainFor = (day, key) => {
    const before = (n) => shiftDate(day, -n);
    const chain = [];
    if (key === 'nasa') {
      if (want('apod')) chain.push({ name: 'NASA APOD', run: () => fetchApodOn(before(1), apiKey, allowCopyrighted) });
      if (want('apod')) chain.push({ name: 'NASA Image and Video Library', fallback: true, run: () => fetchNasaLibrary(day, usedItemIds(days, ['nasa'], day, key)) });
    } else if (key === 'wikipedia') {
      if (want('wikimedia')) chain.push({ name: 'Wikipedia Picture of the day', run: () => fetchWikipedia(before(1)) });
    } else if (key === 'commons') {
      // No fallback to another kind of picture: it is the animal photo or nothing for that day.
      if (want('commons')) chain.push({ name: 'Wikimedia Commons featured picture', run: () => fetchCommons(day, usedItemIds(days, ['commons'], day, key)) });
    } else {
      if (want('artic')) chain.push({ name: 'Art Institute of Chicago', run: () => fetchArtic(day, key, usedItemIds(days, ['tetromino', 'fixed'], day, key)) });
      if (want('wikimedia')) {
        const n = key === 'tetromino' ? 2 : 3; // distinct from the "wikipedia" puzzle's day-1 picture
        chain.push({ name: `Wikipedia Picture of the day (${n} days back)`, fallback: true, run: () => fetchWikipedia(before(n)) });
      }
    }
    return chain;
  };

  let saved = 0;
  for (const day of fetchOrder(today)) {
    for (const key of KEYS) {
      const existing = readEntry(day, key);
      if (existing && !existing.fallback && !force) continue; // already have the preferred picture
      let chain = chainFor(day, key);
      if (existing && existing.fallback && !force) chain = chain.filter((c) => !c.fallback); // only try to upgrade
      for (const c of chain) {
        if (down.has(c.name.replace(/ \(.*\)$/, ''))) continue;
        try {
          console.log(`[${day} ${key}] Trying ${c.name}...`);
          const pick = await c.run();
          if (!pick) {
            console.log('  Skipped: no usable picture (video, copyrighted or missing).');
            continue;
          }
          const extra = { ...(c.fallback ? { fallback: true } : {}), ...(pick.id ? { itemId: pick.id } : {}), ...(pick.topic ? { topic: pick.topic } : {}) };
          const downloaded = await download(pick.imageUrls);
          const sha256 = createHash('sha256').update(downloaded.buf).digest('hex');
          const dup = sameImageElsewhere(days, key, day, sha256);
          if (dup) { // the same picture two days running is a placeholder, not a daily picture
            console.log(`  Skipped: identical image to ${dup}.`);
            continue;
          }
          const entry = await writeEntry(day, key, pick, downloaded, { ...extra, sha256 });
          console.log(`  Saved "${entry.title}" (${entry.date}) from ${entry.source}`);
          saved++;
          break;
        } catch (err) {
          console.warn(`  ${c.name} failed: ${err && err.message ? err.message : err}`);
          if (!err || !err.status || err.status >= 500) down.add(c.name.replace(/ \(.*\)$/, ''));
        }
      }
    }
  }

  await prune(days);
  const total = await writeManifest(days, today);
  console.log(`${saved} fetched, ${total} puzzles available across ${days.length} days.`);
  if (!total) throw new Error('No picture source worked.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
