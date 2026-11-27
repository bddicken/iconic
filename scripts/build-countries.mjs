#!/usr/bin/env node
// Writes src/countries.json: the label point and land area of every country, which the
// globe uses to decide when a country is big enough on screen to be worth naming.
//
//   node scripts/build-countries.mjs
//
// Source: the `world-countries` npm package (mledoze/countries, ODbL).
// Each row is [ISO code, name, lat, lng, area in km²].

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const countries = createRequire(import.meta.url)('world-countries');

const SKIP = new Set(['UM']); // scattered islets with no sensible single label point
const RENAME = { CG: 'Congo', CD: 'DR Congo' };
const AREA = { SJ: 62045 }; // missing in the source
const POINT = { AQ: [-82, 0] }; // the source puts Antarctica's label exactly on the pole

const rows = countries
  .filter((c) => !SKIP.has(c.cca2))
  .map((c) => {
    const [lat, lng] = POINT[c.cca2] ?? c.latlng;
    return [c.cca2, RENAME[c.cca2] ?? c.name.common, +lat.toFixed(2), +lng.toFixed(2), AREA[c.cca2] ?? c.area];
  })
  .filter((r) => r[4] > 0)
  .sort((a, b) => b[4] - a[4]);

await writeFile(path.join(ROOT, 'src/countries.json'), '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n');
console.log(`Wrote ${rows.length} countries to src/countries.json`);
