#!/usr/bin/env node
/*
 * Fetch today's two pictures and captions and write them into site/:
 *   site/images/daily-<key>-<date>.<ext>   the pictures (same origin, so the canvas can slice them)
 *   site/data/<key>.json                   title, caption, credit, link and the image path
 * where <key> is "nasa" (NASA's Astronomy Picture of the Day) or "wikipedia"
 * (Wikipedia's Picture of the day). The site's start page offers one puzzle for each.
 *
 * Set IMAGE_SOURCE=apod or IMAGE_SOURCE=wikimedia to fetch only one of them.
 *
 * Environment:
 *   NASA_API_KEY        free key from https://api.nasa.gov (falls back to the rate-limited DEMO_KEY)
 *   IMAGE_SOURCE        auto (default, both) | apod | wikimedia
 *   ALLOW_COPYRIGHTED   "true" to use APOD pictures that carry a photographer's copyright.
 *                       Default is to skip them, because this script republishes the image file.
 *
 * Exits non-zero only if neither picture could be fetched, so a scheduled deploy keeps the
 * previous puzzles live. If just one fails, the start page shows that puzzle as unavailable.
 */
import { existsSync } from 'node:fs';
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

async function fetchJson(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
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
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
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

async function main() {
  const source = (process.env.IMAGE_SOURCE || 'auto').toLowerCase();
  const allowCopyrighted = process.env.ALLOW_COPYRIGHTED === 'true';
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';

  const attempts = [];
  if (source === 'auto' || source === 'apod') {
    attempts.push([
      'nasa',
      'NASA APOD',
      async () => {
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
      },
    ]);
  }
  if (source === 'auto' || source === 'wikimedia') {
    attempts.push([
      'wikipedia',
      'Wikipedia Picture of the day',
      async () => {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const urls = [
          `https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`,
          `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${d}`,
        ];
        let lastError;
        for (const url of urls) {
          try {
            return pickWikimedia(await fetchJson(url), `${y}-${m}-${d}`);
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError;
      },
    ]);
  }

  let saved = 0;
  let kept = 0;
  for (const [key, name, attempt] of attempts) {
    try {
      console.log(`Trying ${name}...`);
      const pick = await attempt();
      if (!pick) {
        console.log('  Skipped: no usable picture (video, copyrighted or missing).');
      } else {
        const today = await writeOutputs(key, pick, await download(pick.imageUrls));
        console.log(`Saved "${today.title}" (${today.date}) from ${today.source} -> site/${today.image}`);
        saved++;
        continue;
      }
    } catch (err) {
      console.warn(`  ${name} failed: ${err && err.message ? err.message : err}`);
    }
    // The deploy workflow restores the previous run's files, so an outage keeps the old puzzle.
    if (existsSync(path.join(SITE, 'data', `${key}.json`))) {
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
