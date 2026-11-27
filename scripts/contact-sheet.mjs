#!/usr/bin/env node
// Renders review sheets of every landmark image (full image + the square marker crop,
// labelled with rank and id) into data/sheets/, so a batch of downloads can be eyeballed quickly.
//
//   node scripts/contact-sheet.mjs            # all landmarks, 20 per sheet
//   node scripts/contact-sheet.mjs --ids=a,b  # just these

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data/sheets');
const PER_SHEET = 20;
const COLS = 5;
const CELL_W = 380;
const IMG_H = 200;
const LABEL_H = 34;
const CELL_H = IMG_H + LABEL_H;

const only = (process.argv.find((a) => a.startsWith('--ids=')) ?? '').slice(6).split(',').filter(Boolean);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const { landmarks } = JSON.parse(await readFile(path.join(ROOT, 'public/data/landmarks.json'), 'utf8'));
const list = only.length ? landmarks.filter((l) => only.includes(l.id)) : landmarks;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (let s = 0; s * PER_SHEET < list.length; s++) {
  const chunk = list.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
  const rows = Math.ceil(chunk.length / COLS);
  const layers = [];
  for (const [i, l] of chunk.entries()) {
    const left = (i % COLS) * CELL_W;
    const top = Math.floor(i / COLS) * CELL_H;
    const fullW = CELL_W - IMG_H - 6;
    layers.push({
      input: await sharp(path.join(ROOT, 'public', l.image.src)).resize(fullW, IMG_H, { fit: 'contain', background: '#222' }).png().toBuffer(),
      left,
      top,
    });
    layers.push({
      input: await sharp(path.join(ROOT, 'public', l.image.thumb)).resize(IMG_H, IMG_H).png().toBuffer(),
      left: left + fullW + 3,
      top,
    });
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111"/>` +
          `<text x="6" y="22" font-family="Helvetica, Arial" font-size="15" fill="#fff">#${l.rank} ${esc(l.id)} (${l.popularity})</text></svg>`,
      ),
      left,
      top: top + IMG_H,
    });
  }
  const file = path.join(OUT, `sheet-${String(s + 1).padStart(2, '0')}.jpg`);
  await sharp({ create: { width: COLS * CELL_W, height: rows * CELL_H, channels: 3, background: '#000' } })
    .composite(layers)
    .jpeg({ quality: 82 })
    .toFile(file);
  console.log(path.relative(ROOT, file));
}
