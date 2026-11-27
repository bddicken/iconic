#!/usr/bin/env node
// Draws public/og.jpg, the 1200x630 picture shown when the site is shared in a chat or
// on social media: the wordmark and a line of copy beside an illustrated globe carrying
// a few landmark photos, in the app's own colours and typefaces.
//
//   node scripts/build-og.mjs
//
// Needs data/naturalearth/NE2_LR_LC.tif (see build-landcover.mjs) for the globe, and the
// built dataset in public/ for the photos. Re-run it after the look of the app changes.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const W = 1200;
const H = 630;

// ---- the composition ----
const GLOBE = { cx: 878, cy: 322, radius: 292, lng: 28, lat: 20 };
/** Landmarks to show on the globe, in order of preference; ones that would overlap are skipped. */
const FEATURED = [
  'eiffel-tower', 'pyramids-of-giza', 'taj-mahal', 'mount-kilimanjaro', 'saint-basils-cathedral',
  'table-mountain', 'burj-khalifa', 'victoria-falls', 'hagia-sophia', 'mount-everest', 'petra',
];
const PHOTO = 82;
const COLORS = { ocean: [0x45, 0xb9, 0xea], shallows: [0x8f, 0xe3, 0xf7], ink: '#1d2340', accent: '#ffc857' };

// ---- type: glyph outlines straight from the bundled fonts, so no font needs installing ----
const fontFile = (pkg, file) => path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file);
const loadFont = async (pkg, file) => {
  const buf = await readFile(fontFile(pkg, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const caprasimo = await loadFont('caprasimo', 'caprasimo-latin-400-normal.woff');
const rubik500 = await loadFont('rubik', 'rubik-latin-500-normal.woff');
const rubik600 = await loadFont('rubik', 'rubik-latin-600-normal.woff');

/**
 * Lays a string out glyph by glyph (with kerning). opentype.js's own text shaping trips
 * over a feature in Rubik, and plain Latin copy needs nothing fancier than this.
 */
function layout(font, str, size) {
  const scale = size / font.unitsPerEm;
  const glyphs = [...str].map((ch) => font.charToGlyph(ch));
  let x = 0;
  const placed = glyphs.map((glyph, i) => {
    const at = x;
    x += glyph.advanceWidth * scale;
    if (glyphs[i + 1]) x += (font.getKerningValue(glyph, glyphs[i + 1]) || 0) * scale; // (undefined for some pairs)
    return { glyph, at };
  });
  return { placed, width: x };
}

const textWidth = (font, str, size) => layout(font, str, size).width;

/** SVG path for a line of text. `anchor` is 'start' or 'middle'; y is the baseline. */
function text(font, str, x, y, size, fill, anchor = 'start') {
  const { placed, width } = layout(font, str, size);
  const left = anchor === 'middle' ? x - width / 2 : x;
  // Written out by hand: opentype.js's own toPathData() emits NaN for near-zero coordinates.
  const n = (v) => v.toFixed(2);
  const d = placed
    .flatMap(({ glyph, at }) => glyph.getPath(left + at, y, size).commands)
    .map((c) =>
      c.type === 'M' || c.type === 'L'
        ? `${c.type}${n(c.x)} ${n(c.y)}`
        : c.type === 'Q'
          ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
          : c.type === 'C'
            ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
            : 'Z',
    )
    .join('');
  if (d.includes('NaN')) throw new Error(`Could not outline "${str}"`);
  return `<path d="${d}" fill="${fill}"/>`;
}

// ---- the globe: an orthographic view of the same land-cover painting the app uses ----
async function drawGlobe() {
  const SW = 2400;
  const SH = 1200;
  const source = sharp(path.join(ROOT, 'data/naturalearth/NE2_LR_LC.tif'), { limitInputPixels: false })
    .resize(SW, SH, { kernel: 'lanczos3' })
    .removeAlpha();
  const original = await source.clone().raw().toBuffer();

  // water is pure white in the source
  const land = Buffer.alloc(SW * SH);
  for (let i = 0; i < SW * SH; i++) {
    if (Math.min(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]) < 250) land[i] = 255;
  }
  // (extractChannel: blurring a one-channel image hands back three)
  const coast = await sharp(land, { raw: { width: SW, height: SH, channels: 1 } }).blur(2.2).extractChannel(0).raw().toBuffer();

  // the same treatment as the map tiles: keep pale deserts sandy, darken, saturate, posterise
  for (let i = 0; i < SW * SH; i++) {
    const r = original[i * 3];
    const b = original[i * 3 + 2];
    if (r >= b && b > 190) original[i * 3 + 2] = b - (b - 190) * 0.65;
  }
  const painted = await sharp(
    await sharp(original, { raw: { width: SW, height: SH, channels: 3 } })
      .median(3)
      .linear(1.45, -105)
      .modulate({ saturation: 1.7 })
      .png({ palette: true, colours: 14, dither: 0 })
      .toBuffer(),
  )
    .removeAlpha()
    .blur(0.6)
    .raw()
    .toBuffer();

  // render at 2x and scale down for smooth edges
  const size = GLOBE.radius * 4;
  const out = Buffer.alloc(size * size * 4);
  const lat0 = (GLOBE.lat * Math.PI) / 180;
  const sin0 = Math.sin(lat0);
  const cos0 = Math.cos(lat0);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / (size / 2) - 1;
      const v = 1 - (py + 0.5) / (size / 2);
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const z = Math.sqrt(1 - d2);
      const lat = Math.asin(z * sin0 + v * cos0);
      const lng = (GLOBE.lng * Math.PI) / 180 + Math.atan2(u, z * cos0 - v * sin0);
      const fx = ((((lng * 180) / Math.PI + 180) % 360) + 360) % 360 / 360 * SW;
      const fy = Math.min(SH - 1.001, Math.max(0, ((90 - (lat * 180) / Math.PI) / 180) * SH));
      const sx = Math.floor(fx) % SW;
      const sy = Math.floor(fy);
      const s = sy * SW + sx;

      // the coast mask is read with bilinear smoothing, or the shallows come out striped
      const x1 = (sx + 1) % SW;
      const y1 = Math.min(SH - 1, sy + 1);
      const tx = fx - Math.floor(fx);
      const ty = fy - sy;
      const nearLand =
        ((coast[s] * (1 - tx) + coast[sy * SW + x1] * tx) * (1 - ty) +
          (coast[y1 * SW + sx] * (1 - tx) + coast[y1 * SW + x1] * tx) * ty) /
        255;
      let rgb;
      if (land[s]) {
        rgb = [painted[s * 3], painted[s * 3 + 1], painted[s * 3 + 2]];
        // a white "sticker" edge along the shore
        if (nearLand < 0.62) rgb = rgb.map((c) => c + (255 - c) * 0.7);
      } else {
        const t = Math.min(1, nearLand * 2.2); // pale shallows hugging the coast
        rgb = COLORS.ocean.map((c, k) => c + (COLORS.shallows[k] - c) * t);
      }
      // soft light from the upper left, darker towards the rim
      const shade = 0.7 + 0.3 * z + 0.1 * (-u * 0.6 + v * 0.6);
      const o = (py * size + px) * 4;
      out[o] = Math.min(255, rgb[0] * shade);
      out[o + 1] = Math.min(255, rgb[1] * shade);
      out[o + 2] = Math.min(255, rgb[2] * shade);
      out[o + 3] = 255;
    }
  }
  return sharp(out, { raw: { width: size, height: size, channels: 4 } }).resize(GLOBE.radius * 2).png().toBuffer();
}

/** Screen position of a lng/lat on the globe, or null if it is round the back or on the rim. */
function project(lng, lat) {
  const rad = Math.PI / 180;
  const dl = (lng - GLOBE.lng) * rad;
  const sin0 = Math.sin(GLOBE.lat * rad);
  const cos0 = Math.cos(GLOBE.lat * rad);
  const facing = sin0 * Math.sin(lat * rad) + cos0 * Math.cos(lat * rad) * Math.cos(dl);
  if (facing < 0.3) return null;
  return {
    x: GLOBE.cx + Math.cos(lat * rad) * Math.sin(dl) * GLOBE.radius,
    y: GLOBE.cy - (cos0 * Math.sin(lat * rad) - sin0 * Math.cos(lat * rad) * Math.cos(dl)) * GLOBE.radius,
  };
}

// ---- compose ----
const { landmarks, count } = JSON.parse(await readFile(path.join(ROOT, 'public/data/landmarks.json'), 'utf8'));
const byId = new Map(landmarks.map((l) => [l.id, l]));

const pins = [];
for (const id of FEATURED) {
  const lm = byId.get(id);
  const p = lm && project(lm.lng, lm.lat);
  if (!p) continue;
  if (p.x > W - 70 || p.y < 60 || p.y > H - 80) continue;
  // footprint: the photo, plus the name pill underneath it
  const half = Math.max(PHOTO / 2 + 6, textWidth(rubik600, lm.name, 15) / 2 + 16);
  if (pins.some((q) => Math.abs(q.x - p.x) < half + q.half && Math.abs(q.y - p.y) < PHOTO + 40)) continue;
  pins.push({ lm, half, ...p });
}

const stars = Array.from({ length: 90 }, (_, i) => {
  // a fixed scatter (golden-ratio sequence), so the image is the same every build
  const x = ((i * 0.61803398875) % 1) * W;
  const y = ((i * 0.38196601125 * 1.7) % 1) * H;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 7 === 0 ? 1.6 : 0.9}" fill="#fff" opacity="${0.35 + (i % 5) * 0.12}"/>`;
}).join('');

const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="space" cx="${GLOBE.cx}" cy="${GLOBE.cy}" r="760" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#24236a"/><stop offset="0.55" stop-color="#14143a"/><stop offset="1" stop-color="#0a0b1e"/>
    </radialGradient>
    <radialGradient id="air" cx="${GLOBE.cx}" cy="${GLOBE.cy}" r="${GLOBE.radius + 34}" gradientUnits="userSpaceOnUse">
      <stop offset="${(GLOBE.radius / (GLOBE.radius + 34)).toFixed(3)}" stop-color="#9fdcff" stop-opacity="0.75"/><stop offset="1" stop-color="#9fdcff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#space)"/>
  ${stars}
  <circle cx="${GLOBE.cx}" cy="${GLOBE.cy}" r="${GLOBE.radius + 34}" fill="url(#air)"/>
</svg>`);

const pillText = `${count} landmarks to explore`;
const pillSize = 26;
const pillWidth = textWidth(rubik600, pillText, pillSize) + 52;

const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.45"/></filter>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.35"/></filter>
  </defs>
  ${pins
    .map(({ lm, x, y }) => {
      const labelSize = 15;
      const w = textWidth(rubik600, lm.name, labelSize) + 24;
      const top = y + PHOTO / 2 + 6;
      return `<circle cx="${x}" cy="${y}" r="${PHOTO / 2 + 4}" fill="#fff" filter="url(#shadow)"/>
        <rect x="${x - w / 2}" y="${top}" width="${w}" height="26" rx="13" fill="#fff" filter="url(#soft)"/>
        ${text(rubik600, lm.name, x, top + 18.5, labelSize, COLORS.ink, 'middle')}`;
    })
    .join('\n')}
  ${text(caprasimo, 'Iconic', 66, 262, 168, '#fff')}
  ${text(rubik500, 'Spin the globe and explore', 72, 330, 34, '#d9dcf3')}
  ${text(rubik500, 'the world’s most iconic places.', 72, 374, 34, '#d9dcf3')}
  <rect x="72" y="424" width="${pillWidth}" height="58" rx="29" fill="${COLORS.accent}" stroke="#fff" stroke-width="5" filter="url(#shadow)"/>
  ${text(rubik600, pillText, 72 + 26, 424 + 38, pillSize, COLORS.ink)}
</svg>`);

const circle = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO}" height="${PHOTO}"><circle cx="${PHOTO / 2}" cy="${PHOTO / 2}" r="${PHOTO / 2}"/></svg>`);
const photos = await Promise.all(
  pins.map(async ({ lm, x, y }) => ({
    input: await sharp(path.join(ROOT, 'public', lm.image.thumb))
      .resize(PHOTO, PHOTO)
      .composite([{ input: circle, blend: 'dest-in' }])
      .png()
      .toBuffer(),
    left: Math.round(x - PHOTO / 2),
    top: Math.round(y - PHOTO / 2),
  })),
);

const info = await sharp(background)
  .composite([
    { input: await drawGlobe(), left: GLOBE.cx - GLOBE.radius, top: GLOBE.cy - GLOBE.radius },
    { input: overlay, left: 0, top: 0 },
    ...photos,
  ])
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(path.join(ROOT, 'public/og.jpg'));
console.log(`Wrote public/og.jpg (${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KB) with ${pins.length} landmarks: ${pins.map((p) => p.lm.name).join(', ')}`);
