#!/usr/bin/env node
/*
 * Fetch today's picture and caption and write them into site/:
 *   site/images/daily-<date>.<ext>   the picture (same origin, so the canvas can slice it)
 *   site/data/today.json             title, caption, credit, link and the image path
 *
 * Sources, in order (IMAGE_SOURCE=auto): NASA APOD, then Wikipedia's Picture of the day.
 * Set IMAGE_SOURCE=apod or IMAGE_SOURCE=wikimedia to force one.
 *
 * Environment:
 *   NASA_API_KEY        free key from https://api.nasa.gov (falls back to the rate-limited DEMO_KEY)
 *   IMAGE_SOURCE        auto (default) | apod | wikimedia
 *   ALLOW_COPYRIGHTED   "true" to use APOD pictures that carry a photographer's copyright.
 *                       Default is to skip them, because this script republishes the image file.
 *
 * Exits non-zero if nothing could be fetched, so a scheduled deploy keeps yesterday's puzzle live.
 */
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

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
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

async function writeOutputs(pick, { buf, ext }) {
  const imagesDir = path.join(SITE, 'images');
  const dataDir = path.join(SITE, 'data');
  await mkdir(imagesDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const fileName = `daily-${pick.date}.${ext}`;
  for (const name of await readdir(imagesDir)) {
    if (name.startsWith('daily-') && name !== fileName) await rm(path.join(imagesDir, name));
  }
  await writeFile(path.join(imagesDir, fileName), buf);
  const today = {
    date: pick.date,
    title: pick.title,
    description: pick.description,
    credit: pick.credit,
    source: pick.source,
    pageUrl: pick.pageUrl,
    image: `images/${fileName}`,
  };
  await writeFile(path.join(dataDir, 'today.json'), JSON.stringify(today, null, 2) + '\n');
  return today;
}

async function main() {
  const source = (process.env.IMAGE_SOURCE || 'auto').toLowerCase();
  const allowCopyrighted = process.env.ALLOW_COPYRIGHTED === 'true';
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';

  const attempts = [];
  if (source === 'auto' || source === 'apod') {
    attempts.push([
      'NASA APOD',
      async () => pickApod(await fetchJson(`https://api.nasa.gov/planetary/apod?api_key=${apiKey}`), { allowCopyrighted }),
    ]);
  }
  if (source === 'auto' || source === 'wikimedia') {
    attempts.push([
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

  for (const [name, attempt] of attempts) {
    try {
      console.log(`Trying ${name}...`);
      const pick = await attempt();
      if (!pick) {
        console.log(`  Skipped: no usable picture today (video, copyrighted or missing).`);
        continue;
      }
      const today = await writeOutputs(pick, await download(pick.imageUrls));
      console.log(`Saved "${today.title}" (${today.date}) from ${today.source} -> site/${today.image}`);
      return;
    } catch (err) {
      console.warn(`  ${name} failed: ${err && err.message ? err.message : err}`);
    }
  }
  throw new Error('No picture source worked.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
