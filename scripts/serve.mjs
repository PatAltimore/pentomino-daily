#!/usr/bin/env node
// Tiny zero-dependency static server for local development: npm run dev
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

http
  .createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(SITE, path.normalize(rel));
      if (!file.startsWith(SITE + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  })
  .listen(PORT, () => console.log(`Pentomino Daily running at http://localhost:${PORT}`));
