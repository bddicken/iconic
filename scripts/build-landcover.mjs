#!/usr/bin/env node
// Renders the globe's illustrated land-colour tiles into public/tiles/landcover/.
//
// Input: Natural Earth II land cover (public domain), an equirectangular painting of the
// world's biomes with no relief and no water:
//   https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC.zip  ->  data/naturalearth/NE2_LR_LC.tif
//
// What it does:
//   1. Floods land colours out over the (white) oceans and lakes, so the crisp vector
//      coastline drawn on top never reveals a pale fringe.
//   2. Stylises: simplifies shapes, pushes the pastel palette to something bright and
//      playful, then posterises to a handful of flat colours.
//   3. Reprojects to Web Mercator and cuts z0..MAX_ZOOM tiles.
//
//   node scripts/build-landcover.mjs             # build the tiles
//   node scripts/build-landcover.mjs --preview   # only write data/naturalearth/preview.png

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data/naturalearth/NE2_LR_LC.tif');
const OUT = path.join(ROOT, 'public/tiles/landcover');
const PREVIEW = process.argv.includes('--preview');

const MAX_ZOOM = 5;
const TILE = 256;

// ---- the look ----
const STYLE = {
  median: 9, // px at working size; bigger = blobbier shapes
  // The source is very pale (most land sits at 180-245 of 255): stretch it down into
  // the mid-tones first, then saturate.
  gain: Number(process.env.LC_GAIN ?? 1.45),
  offset: Number(process.env.LC_OFFSET ?? -105),
  saturation: Number(process.env.LC_SAT ?? 1.7),
  colours: Number(process.env.LC_COLOURS ?? 14), // posterisation levels for the whole world
  soften: 0.8, // blur after posterising, to round off the stair-steps
};

/** Working size: the equirectangular image is as wide as the deepest zoom level. */
const W = PREVIEW ? 2048 : TILE * 2 ** MAX_ZOOM;
const H = W / 2;

async function loadFilled() {
  const { data } = await sharp(SOURCE, { limitInputPixels: false })
    .resize(W, H, { kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Water is pure white in the source. Resizing leaves a pale blended rim along every
  // shore, so grow the water mask by a pixel before filling.
  const n = W * H;
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (data[i * 3] >= 251 && data[i * 3 + 1] >= 251 && data[i * 3 + 2] >= 251) water[i] = 1;
  }
  const grown = new Uint8Array(water);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (water[i]) continue;
      const l = y * W + ((x + W - 1) % W);
      const r = y * W + ((x + 1) % W);
      if (water[l] || water[r] || (y > 0 && water[i - W]) || (y < H - 1 && water[i + W])) grown[i] = 1;
    }
  }

  // Multi-source breadth-first flood: every water pixel takes the colour of its nearest land pixel.
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (!grown[i]) queue[tail++] = i;
  const visit = (from, to) => {
    if (!grown[to]) return;
    grown[to] = 0;
    data[to * 3] = data[from * 3];
    data[to * 3 + 1] = data[from * 3 + 1];
    data[to * 3 + 2] = data[from * 3 + 2];
    queue[tail++] = to;
  };
  while (head < tail) {
    const i = queue[head++];
    const y = (i / W) | 0;
    const x = i - y * W;
    visit(i, y * W + ((x + 1) % W));
    visit(i, y * W + ((x + W - 1) % W));
    if (y > 0) visit(i, i - W);
    if (y < H - 1) visit(i, i + W);
  }

  // The brightest desert in the source is nearly white and would posterise into white
  // holes. Pull the blue out of pale *warm* pixels so they stay sand; ice (cool) is untouched.
  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const b = data[i * 3 + 2];
    if (r >= b && b > 190) data[i * 3 + 2] = b - (b - 190) * 0.65;
  }
  return data;
}

async function stylise(raw) {
  const rawOpts = { raw: { width: W, height: H, channels: 3 } };
  const scale = W / 8192; // keep the look the same in the small preview
  const painted = await sharp(raw, rawOpts)
    .median(Math.max(3, Math.round(STYLE.median * scale) | 1))
    .linear(STYLE.gain, STYLE.offset)
    .modulate({ saturation: STYLE.saturation })
    .png({ palette: true, colours: STYLE.colours, dither: 0, effort: 4 })
    .toBuffer();
  return sharp(painted)
    .removeAlpha()
    .blur(Math.max(0.3, STYLE.soften * scale))
    .raw()
    .toBuffer();
}

/** Equirectangular (W x H) -> Web Mercator (W x W), one row at a time. Columns already line up. */
function toMercator(src) {
  const out = Buffer.alloc(W * W * 3);
  const rowBytes = W * 3;
  for (let y = 0; y < W; y++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / W))) * 180) / Math.PI;
    const sy = Math.min(H - 1, Math.max(0, ((90 - lat) / 180) * H - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(H - 1, y0 + 1);
    const t = sy - y0;
    const a = y0 * rowBytes;
    const b = y1 * rowBytes;
    const o = y * rowBytes;
    for (let k = 0; k < rowBytes; k++) out[o + k] = src[a + k] * (1 - t) + src[b + k] * t + 0.5;
  }
  return out;
}

async function cutTiles(mercator) {
  await rm(OUT, { recursive: true, force: true });
  let image = mercator;
  let size = W;
  let count = 0;
  let bytes = 0;
  for (let z = MAX_ZOOM; z >= 0; z--) {
    const tiles = 2 ** z;
    for (let x = 0; x < tiles; x++) {
      await mkdir(path.join(OUT, String(z), String(x)), { recursive: true });
      for (let y = 0; y < tiles; y++) {
        const tile = Buffer.alloc(TILE * TILE * 3);
        for (let row = 0; row < TILE; row++) {
          const start = ((y * TILE + row) * size + x * TILE) * 3;
          image.copy(tile, row * TILE * 3, start, start + TILE * 3);
        }
        const info = await sharp(tile, { raw: { width: TILE, height: TILE, channels: 3 } })
          .webp({ quality: 82, effort: 4 })
          .toFile(path.join(OUT, String(z), String(x), `${y}.webp`));
        count++;
        bytes += info.size;
      }
    }
    process.stdout.write(`\r  z${z}: ${tiles * tiles} tiles   `);
    if (z > 0) {
      image = await sharp(image, { raw: { width: size, height: size, channels: 3 } })
        .resize(size / 2, size / 2, { kernel: 'lanczos3' })
        .raw()
        .toBuffer();
      size /= 2;
    }
  }
  await writeFile(
    path.join(OUT, 'tiles.json'),
    JSON.stringify(
      {
        tiles: 'tiles/landcover/{z}/{x}/{y}.webp',
        maxzoom: MAX_ZOOM,
        attribution: 'Land cover: <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>',
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${count} tiles (${(bytes / 1e6).toFixed(1)} MB) to ${path.relative(ROOT, OUT)}`);
}

console.log(`Filling water at ${W}x${H}...`);
const filled = await loadFilled();
console.log('Stylising...');
const styled = await stylise(filled);
if (PREVIEW) {
  const file = path.join(ROOT, `data/naturalearth/${process.env.LC_NAME ?? 'preview'}.png`);
  await sharp(styled, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
  console.log(path.relative(ROOT, file));
} else {
  console.log('Reprojecting to Web Mercator...');
  const mercator = toMercator(styled);
  await cutTiles(mercator);
}
