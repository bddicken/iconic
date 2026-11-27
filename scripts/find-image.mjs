#!/usr/bin/env node
// Finds alternative photos on Wikimedia Commons when an article's lead image is not a
// good one (a logo, a map, a collage, a dull angle).
//
//   node scripts/find-image.mjs <id> "<search terms>" [more "<id>" "<terms>" pairs...]
//
// For each pair it writes data/sheets/candidates-<id>.jpg (numbered thumbnails) and prints
// the matching file names. Put the one you like in the seed as "image": "<file name>" and
// run `npm run data`.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data/sheets');
const UA = `IconicLandmarksApp/0.1 (${process.env.WIKIMEDIA_CONTACT || 'landmark explorer; data build script'})`;
const PER_QUERY = 10;
const COLS = 5;
const CELL = 330;
const LABEL = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function get(url, init) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep((Math.min(Number(res.headers.get('retry-after')) || 5, 120) + 1) * 1000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

const pairs = process.argv.slice(2);
if (!pairs.length || pairs.length % 2) {
  console.error('usage: node scripts/find-image.mjs <id> "<search terms>" [...]');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

for (let i = 0; i < pairs.length; i += 2) {
  const [id, terms] = [pairs[i], pairs[i + 1]];
  if (i) await sleep(process.env.WIKIMEDIA_CONTACT ? 500 : 6500); // API pacing, see build-data.mjs
  const body = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${terms} filetype:bitmap filew:>1500`,
    gsrlimit: String(PER_QUERY),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiextmetadatafilter: 'LicenseShortName',
    iiurlwidth: '330',
  });
  const json = await (await get('https://commons.wikimedia.org/w/api.php', { method: 'POST', body })).json();
  const pages = (json.query?.pages ?? []).filter((p) => p.imageinfo?.[0]?.thumburl).sort((a, b) => a.index - b.index);

  console.log(`\n== ${id}: "${terms}"`);
  const layers = [];
  for (const [n, p] of pages.entries()) {
    const info = p.imageinfo[0];
    console.log(`  ${n + 1}. ${p.title.replace(/^File:/, '')}  [${info.width}x${info.height}, ${info.extmetadata?.LicenseShortName?.value ?? '?'}]`);
    const left = (n % COLS) * CELL;
    const top = Math.floor(n / COLS) * (CELL + LABEL);
    try {
      const buf = Buffer.from(await (await get(info.thumburl)).arrayBuffer());
      layers.push({
        input: await sharp(buf).resize(CELL - 4, CELL - 4, { fit: 'contain', background: '#222' }).png().toBuffer(),
        left: left + 2,
        top,
      });
    } catch (err) {
      console.log(`     (thumbnail failed: ${err.message})`);
    }
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${LABEL}"><rect width="100%" height="100%" fill="#111"/>` +
          `<text x="6" y="20" font-family="Helvetica, Arial" font-size="14" fill="#fff">${n + 1}. ${esc(p.title.replace(/^File:/, '').slice(0, 40))}</text></svg>`,
      ),
      left,
      top: top + CELL - 4,
    });
  }
  if (!pages.length) {
    console.log('  (no results)');
    continue;
  }
  const rows = Math.ceil(pages.length / COLS);
  const file = path.join(OUT, `candidates-${id}.jpg`);
  await sharp({ create: { width: COLS * CELL, height: rows * (CELL + LABEL), channels: 3, background: '#000' } })
    .composite(layers)
    .jpeg({ quality: 80 })
    .toFile(file);
  console.log(`  -> ${path.relative(ROOT, file)}`);
}
