#!/usr/bin/env node
// Renders the sea-floor tiles in public/tiles/ocean/, and src/seam.json.
//
// The map draws the sea in bands of blue that darken with depth. These tiles say where
// the bands are; the map style (src/basemap.ts) gives them their colours as it draws.
//
// A tile is not a picture of the bands, which would blur when zoomed past its
// resolution. Each pixel holds one number (in the red channel) that climbs by LEVELS for
// every band edge lying on the shallow side of it, ramping up smoothly across the few
// pixels either side of each edge. The style colours a pixel by where its number falls
// between those steps, which stays a sharp line however far the tile is stretched: the
// same trick as the "distance field" lettering in games. To the map it is an elevation
// tile in a custom encoding.
//
// src/seam.json holds the same numbers along the 180° meridian, where the globe paints a
// thin patch to hide a seam in the map data (the `date-line` layer in src/basemap.ts).
// Each row is [north latitude, south latitude, number].
//
//   node scripts/build-ocean.mjs
//
// Input: Terrarium elevation tiles, which include the sea floor (ETOPO1 and GEBCO). The
// zoom-5 tiles, about 65 MB, are downloaded once into data/cache/terrarium/.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const CACHE = path.join(ROOT, 'data/cache/terrarium');
const OUT = path.join(ROOT, 'public/tiles/ocean');

const MAX_ZOOM = 5;
const SOURCE_ZOOM = 5;
const TILE = 256;

// ---- the look ----
/** Where one band gives way to the next, in metres: shelf, slope, rise, plain, trench. */
const BAND_EDGES = [-180, -800, -2000, -3500, -5300];
const SMOOTH = 2; // passes of a 3x3 box blur over the depths, to round off the shapes

/** How much the number in a tile climbs across one band edge... */
const LEVELS = 50;
/** ...and over how many pixels either side of the edge it does so. */
const REACH = 3;

// ---- 1. download ----

async function sourceTile(x, y) {
  const file = path.join(CACHE, String(SOURCE_ZOOM), String(x), `${y}.png`);
  try {
    return await readFile(file);
  } catch {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${SOURCE}/${SOURCE_ZOOM}/${x}/${y}.png`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
        return bytes;
      } catch (err) {
        if (attempt === 4) throw new Error(`Tile ${SOURCE_ZOOM}/${x}/${y}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
}

/** Depth of every pixel of the world in metres; land counts as 0. */
async function loadDepths() {
  const size = TILE * 2 ** SOURCE_ZOOM;
  const depths = new Float32Array(size * size);
  const jobs = [];
  for (let x = 0; x < 2 ** SOURCE_ZOOM; x++) for (let y = 0; y < 2 ** SOURCE_ZOOM; y++) jobs.push([x, y]);
  let done = 0;
  const worker = async () => {
    for (let job; (job = jobs.pop()); ) {
      const [x, y] = job;
      const data = await sharp(await sourceTile(x, y)).removeAlpha().raw().toBuffer();
      for (let row = 0; row < TILE; row++) {
        const o = (y * TILE + row) * size + x * TILE;
        for (let col = 0; col < TILE; col++) {
          const i = (row * TILE + col) * 3;
          depths[o + col] = Math.min(0, data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768);
        }
      }
      if (++done % 64 === 0) process.stdout.write(`\r  ${done} of ${jobs.length + done} tiles`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  process.stdout.write('\n');
  return { depths, size };
}

/** 3x3 box blur, wrapping round the world east-west. */
function smooth({ depths: src, size }) {
  const tmp = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const o = y * size;
    for (let x = 0; x < size; x++) {
      tmp[o + x] = (src[o + ((x + size - 1) % size)] + src[o + x] + src[o + ((x + 1) % size)]) / 3;
    }
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const a = Math.max(0, y - 1) * size;
    const b = y * size;
    const c = Math.min(size - 1, y + 1) * size;
    for (let x = 0; x < size; x++) out[b + x] = (tmp[a + x] + tmp[b + x] + tmp[c + x]) / 3;
  }
  return { depths: out, size };
}

/** Half the size: each pixel the mean of four. */
function halve({ depths: src, size }) {
  const half = size / 2;
  const out = new Float32Array(half * half);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const i = 2 * y * size + 2 * x;
      out[y * half + x] = (src[i] + src[i + 1] + src[i + size] + src[i + size + 1]) / 4;
    }
  }
  return { depths: out, size: half };
}

// ---- 2. cut tiles ----

/** The number stored for every pixel: see the top of this file. */
function encode({ depths, size }) {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const up = Math.max(0, y - 1) * size;
    const down = Math.min(size - 1, y + 1) * size;
    for (let x = 0; x < size; x++) {
      const left = (x + size - 1) % size;
      const right = (x + 1) % size;
      const depth = depths[y * size + x];
      // metres per pixel downhill; depth past an edge divided by it is the distance to that edge
      const slope = Math.max(
        0.25,
        Math.hypot(depths[y * size + right] - depths[y * size + left], depths[down + x] - depths[up + x]) / 2,
      );
      let v = 0;
      for (const edge of BAND_EDGES) {
        v += LEVELS * Math.min(1, Math.max(0, 0.5 + (edge - depth) / slope / (2 * REACH)));
      }
      out[y * size + x] = Math.round(v);
    }
  }
  return out;
}

async function cutTiles(world) {
  await rm(OUT, { recursive: true, force: true });
  let count = 0;
  let bytes = 0;
  for (let z = MAX_ZOOM; z >= 0; z--) {
    const { size } = world;
    const values = encode(world);
    const tiles = 2 ** z;
    for (let x = 0; x < tiles; x++) {
      await mkdir(path.join(OUT, String(z), String(x)), { recursive: true });
      for (let y = 0; y < tiles; y++) {
        const tile = Buffer.alloc(TILE * TILE * 3); // green and blue stay 0
        for (let row = 0; row < TILE; row++) {
          const o = (y * TILE + row) * size + x * TILE;
          for (let col = 0; col < TILE; col++) tile[(row * TILE + col) * 3] = values[o + col];
        }
        const info = await sharp(tile, { raw: { width: TILE, height: TILE, channels: 3 } })
          .webp({ lossless: true, effort: 6 })
          .toFile(path.join(OUT, String(z), String(x), `${y}.webp`));
        count++;
        bytes += info.size;
      }
    }
    process.stdout.write(`\r  z${z}: ${tiles * tiles} tiles   `);
    if (z > 0) world = halve(world);
  }
  await writeFile(
    path.join(OUT, 'tiles.json'),
    JSON.stringify(
      {
        tiles: 'tiles/ocean/{z}/{x}/{y}.webp',
        maxzoom: MAX_ZOOM,
        attribution:
          'Sea floor: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen terrain tiles</a>',
        // for the style: the number at each band edge, and how fast it climbs per pixel there
        edges: BAND_EDGES.map((_, i) => LEVELS * (i + 0.5)),
        levelsPerPixel: LEVELS / (2 * REACH),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${count} tiles (${(bytes / 1e6).toFixed(1)} MB) to ${path.relative(ROOT, OUT)}`);
}

// ---- 3. the 180° meridian ----

async function writeSeam(world) {
  const { size } = world;
  const values = encode(world);
  const ROWS = 8; // pixels per sample
  const lat = (y) => +((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI).toFixed(2);
  const rows = [];
  for (let y = 0; y < size; y += ROWS) {
    let sum = 0;
    for (let dy = 0; dy < ROWS; dy++) sum += values[(y + dy) * size] + values[(y + dy) * size + size - 1];
    const value = Math.round(sum / (ROWS * 2));
    const prev = rows[rows.length - 1];
    if (prev && prev[2] === value) prev[1] = lat(y + ROWS);
    else rows.push([lat(y), lat(y + ROWS), value]);
  }
  await writeFile(path.join(ROOT, 'src/seam.json'), '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n');
  console.log(`Wrote ${rows.length} pieces to src/seam.json`);
}

console.log('Loading elevation tiles...');
let world = await loadDepths();
for (let i = 0; i < SMOOTH; i++) world = smooth(world);
await writeSeam(world);
await cutTiles(world);
