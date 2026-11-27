#!/usr/bin/env node
// Picks the next batch of landmarks from the candidate pool in data/candidates/.
//
//   node scripts/select-candidates.mjs           # validate the pool, print the pick, write data/candidates/selection.json
//   node scripts/select-candidates.mjs --apply   # ...and append the pick to data/landmarks.seed.json
//
// The pool (data/candidates/pool/*.txt) is a long hand-written list: "# Region", "@ Country", then one place per line
// as "<letter> Name" or "<letter> Name=Wikipedia title" (letters: see CAT below). Each run checks every candidate
// against English Wikipedia (cached in data/candidates/wiki-cache.json), drops what cannot be used (no article, no
// coordinates, no free lead photo, already on the map, on top of an existing marker) and then fills QUOTA per region:
// the most-read place of every country first, then musts.txt, then by 60-day page views under the per-country CAP.
// drops.txt lists names (or "@ Country") never to pick; keeps.txt exempts names from the "is this a landmark?" filter.
// Set QUOTA and CAP below for the size of batch you want, then review the printed list before using --apply.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(repo, 'data/candidates');
const poolDir = path.join(DIR, 'pool');
const outFile = path.join(DIR, 'selection.json');
const UA = 'IconicLandmarksApp/0.1 (https://github.com/bddicken/iconic)';
const CAT = { n: 'natural', b: 'building', r: 'religious', a: 'ancient', m: 'monument', u: 'urban', g: 'bridge' };
const QUOTA = { Europe: 125, Asia: 120, 'North America': 90, Africa: 60, 'South America': 45, 'Middle East': 30, Oceania: 26, Antarctica: 4 };
const lines = (f) => readFileSync(path.join(DIR, f), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const MUST = new Set(lines('musts.txt'));
const DROP = new Set(lines('drops.txt'));
const KEEP = new Set(lines('keeps.txt'));
const SETTLEMENT = /\b(one|city|cities|town|municipality|municipal seat|village|commune|comune|capital|district|neighbou?rhood|suburb|borough|settlement|hamlet|county|province|prefecture|state|country|region|census-designated place|locality|ward|quarter|barrio|township|parish|seat|community|area|island country|territory|department|canton|subdivision)\b/i;
const NOT_PLACE = /\b(stadium|arena|ballpark|shopping (mall|centre|center)|university|college|airport|river|strait|sea|ocean|highway|road|route|event|explosion|battle|legislature|parliament|company|organi[sz]ation|festival|railway|air force base|military base|racetrack|circuit|speedway|theme park|amusement park|zoo|mine|expressway|motorway|tribe|people|ethnic group|culture|ship|shipwreck)\b/i;
const CAP = {
  Europe: { "*": 10 }, Asia: { "*": 10, India: 15, China: 15, Japan: 15 }, Africa: { "*": 5, Egypt: 8 }, "South America": { "*": 9 }, "Middle East": { "*": 5, Iran: 6 },
  "North America": { "*": 3, "United States": 45, Canada: 12, Mexico: 12 },
  Oceania: { "*": 2, Australia: 10, "New Zealand": 7 }, Antarctica: { "*": 99 },
};
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ʻʼ’']/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- pool
const pool = [];
for (const f of readdirSync(poolDir).filter((f) => f.endsWith('.txt')).sort()) {
  let region, country;
  for (const raw of readFileSync(path.join(poolDir, f), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) region = line.slice(2);
    else if (line.startsWith('@ ')) country = line.slice(2);
    else {
      const [name, wiki] = line.slice(2).split('=');
      if (DROP.has(name) || DROP.has('@ ' + country)) continue;
      pool.push({ name, wiki: wiki ?? name, country, region, category: CAT[line[0]], must: MUST.has(name), src: f });
    }
  }
}
// --- existing
const seed = JSON.parse(readFileSync(path.join(repo, 'data/landmarks.seed.json'), 'utf8'));
const existingIds = new Set(seed.map((s) => s.id));
const existingTitles = new Set();
const existingPts = [];
for (const s of seed) existingTitles.add(s.wiki);
// the built data knows every landmark's resolved article title and coordinates
for (const l of JSON.parse(readFileSync(path.join(repo, 'public/data/landmarks.json'), 'utf8')).landmarks) {
  existingTitles.add(decodeURIComponent(l.wikipedia.split('/wiki/')[1]).replace(/_/g, ' '));
  existingPts.push({ lat: l.lat, lon: l.lng, id: l.id });
}
// --- wikipedia
const info = new Map(); // requested title -> {title, missing, disambig, lat, lon, image, views}
const cachePath = path.join(DIR, 'wiki-cache.json');
const wikiCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const titles = [...new Set(pool.map((p) => p.wiki))].filter((t) => !wikiCache[t]);
for (let i = 0; i < titles.length; i += 40) {
  const batch = titles.slice(i, i + 40);
  const pages = {}, alias = {};
  let cont = {};
  for (let guard = 0; guard < 30; guard++) {
    const body = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', redirects: '1', titles: batch.join('|'),
      prop: 'pageprops|coordinates|pageimages|pageviews', ppprop: 'disambiguation', piprop: 'name', pilimit: 'max', colimit: 'max', pvipdays: '60', ...cont });
    let j;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch('https://en.wikipedia.org/w/api.php', { method: 'POST', body, headers: { 'User-Agent': UA } });
      if (r.ok) { j = await r.json(); break; }
      if (attempt > 5) throw new Error('HTTP ' + r.status);
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
    for (const n of j.query?.normalized ?? []) alias[n.from] = n.to;
    for (const n of j.query?.redirects ?? []) alias[n.from] = n.to;
    for (const p of j.query?.pages ?? []) {
      const prev = pages[p.title] ?? {};
      pages[p.title] = { ...prev, ...p, pageviews: { ...(prev.pageviews ?? {}), ...(p.pageviews ?? {}) } };
    }
    if (!j.continue) break;
    cont = j.continue;
  }
  for (const t of batch) {
    let x = t;
    for (let k = 0; k < 5 && alias[x]; k++) x = alias[x];
    const p = pages[x] ?? { missing: true };
    wikiCache[t] = {
      title: x, missing: !!p.missing || !!p.invalid, disambig: !!(p.pageprops && 'disambiguation' in p.pageprops),
      lat: p.coordinates?.[0]?.lat ?? null, lon: p.coordinates?.[0]?.lon ?? null, image: p.pageimage ?? null,
      views: Object.values(p.pageviews ?? {}).reduce((a, b) => a + (b ?? 0), 0),
    };
  }
  writeFileSync(cachePath, JSON.stringify(wikiCache));
  process.stderr.write(`\r  checked ${Math.min(i + 40, titles.length)}/${titles.length}`);
  await new Promise((res) => setTimeout(res, 350));
}
process.stderr.write('\n');

// --- second chance for articles whose coordinates are not flagged "primary": ask Wikidata
const api = async (host, params) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://' + host + '/w/api.php', { method: 'POST', body: new URLSearchParams({ format: 'json', formatversion: '2', ...params }), headers: { 'User-Agent': UA } });
    if (r.ok) return r.json();
    if (attempt > 5) throw new Error('HTTP ' + r.status);
    await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
  }
};
const need = Object.entries(wikiCache).filter(([, w]) => !w.missing && !w.disambig && w.lat == null && !w.triedWikidata);
for (let i = 0; i < need.length; i += 40) {
  const batch = need.slice(i, i + 40);
  const q = await api('en.wikipedia.org', { action: 'query', titles: batch.map(([, w]) => w.title).join('|'), prop: 'pageprops|coordinates', ppprop: 'wikibase_item', coprimary: 'all', colimit: 'max' });
  const byTitle = new Map((q.query?.pages ?? []).map((p) => [p.title, p]));
  const qids = batch.map(([, w]) => byTitle.get(w.title)?.pageprops?.wikibase_item).filter(Boolean);
  const wd = qids.length ? await api('www.wikidata.org', { action: 'wbgetentities', ids: qids.join('|'), props: 'claims' }) : { entities: {} };
  for (const [, w] of batch) {
    const p = byTitle.get(w.title);
    const claim = wd.entities?.[p?.pageprops?.wikibase_item]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    const alt = p?.coordinates?.[0];
    if (claim?.globe?.endsWith('Q2') ?? false) { w.lat = claim.latitude; w.lon = claim.longitude; w.coordSource = 'wikidata'; }
    else if (alt) { w.lat = alt.lat; w.lon = alt.lon; w.coordSource = 'article (secondary)'; }
    w.triedWikidata = true;
  }
  writeFileSync(cachePath, JSON.stringify(wikiCache));
  process.stderr.write('\r  wikidata coordinates ' + Math.min(i + 40, need.length) + '/' + need.length);
  await new Promise((res) => setTimeout(res, 400));
}
if (need.length) process.stderr.write('\n');

// --- a one-line Wikidata description of every usable candidate, to tell landmarks from towns, stadiums, rivers...
const undescribed = [...new Set(Object.values(wikiCache).filter((w) => !w.missing && !w.disambig && w.lat != null && w.image && w.desc === undefined).map((w) => w.title))];
for (let i = 0; i < undescribed.length; i += 50) {
  const batch = undescribed.slice(i, i + 50);
  const j = await api('www.wikidata.org', { action: 'wbgetentities', formatversion: '1', sites: 'enwiki', titles: batch.join('|'), props: 'descriptions|sitelinks', languages: 'en', sitefilter: 'enwiki' });
  const byTitle = {};
  for (const e of Object.values(j.entities ?? {})) if (e.sitelinks?.enwiki) byTitle[e.sitelinks.enwiki.title] = e.descriptions?.en?.value ?? '';
  for (const w of Object.values(wikiCache)) if (batch.includes(w.title) && w.desc === undefined) w.desc = byTitle[w.title] ?? '';
  writeFileSync(cachePath, JSON.stringify(wikiCache));
  process.stderr.write('\r  descriptions ' + Math.min(i + 50, undescribed.length) + '/' + undescribed.length);
  await new Promise((res) => setTimeout(res, 300));
}
if (undescribed.length) process.stderr.write('\n');

// --- validate
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371; };
const rejected = [], valid = [], seenTitle = new Set(), seenId = new Set();
for (const p of pool) {
  const w = wikiCache[p.wiki];
  const id = slug(p.name);
  let why = null;
  if (!w || w.missing) why = 'no article';
  else if (w.disambig) why = 'disambiguation page';
  else if (existingTitles.has(w.title) || existingTitles.has(p.wiki)) why = 'already on the map';
  else if (existingIds.has(id) || seenId.has(id)) why = 'id clash';
  else if (seenTitle.has(w.title)) why = 'duplicate in pool';
  else if (w.lat == null) why = 'no coordinates';
  else if (!w.image) why = 'no free lead image';
  // files 1-8 were written place by place, towns included on purpose; 9-more is a broad sweep, so it is filtered
  else if (p.src.startsWith('9-') && !KEEP.has(p.name) && (() => { const head = (w.desc ?? '').split(/ in | on | at | of |, /)[0]; return SETTLEMENT.test(head) || NOT_PLACE.test(head); })()) why = 'settlement or not a landmark';
  else {
    const near = existingPts.find((e) => km(e, w) < 0.12);
    if (near) why = 'same spot as ' + near.id;
  }
  if (why) { rejected.push({ ...p, why }); continue; }
  seenTitle.add(w.title); seenId.add(id);
  valid.push({ ...p, id, title: w.title, views: w.views, lat: w.lat, lon: w.lon, image: w.image, coordSource: w.coordSource ?? null });
}
// --- select
const chosen = [];
const summary = {};
for (const region of Object.keys(QUOTA)) {
  const cands = valid.filter((v) => v.region === region).sort((a, b) => b.views - a.views);
  const cap = (c) => CAP[region][c] ?? CAP[region]['*'];
  const count = {}, picked = [];
  const take = (c) => { picked.push(c); count[c.country] = (count[c.country] ?? 0) + 1; };
  // 1. the top place of every country
  const firsts = [];
  for (const c of cands) if (!firsts.some((f) => f.country === c.country)) firsts.push(c);
  for (const c of firsts.slice(0, QUOTA[region])) take(c);
  // 2. the must-haves, whatever their traffic
  for (const c of cands) if (c.must && !picked.includes(c) && picked.length < QUOTA[region]) take(c);
  // 3. fill by views, respecting the per-country cap; drop near-duplicates of picks
  for (const c of cands) {
    if (picked.length >= QUOTA[region]) break;
    if (picked.includes(c) || count[c.country] >= cap(c.country)) continue;
    if (picked.some((q) => km(q, c) < 0.12)) continue;
    take(c);
  }
  chosen.push(...picked);
  summary[region] = { pool: pool.filter((p) => p.region === region).length, valid: cands.length, picked: picked.length, quota: QUOTA[region], countries: Object.keys(count).length };
}
writeFileSync(outFile, JSON.stringify({ chosen, rejected, valid }, null, 1));
console.log(JSON.stringify(summary, null, 1));
const whyCount = {}; for (const r of rejected) whyCount[r.why.startsWith('same spot') ? 'same spot as an existing landmark' : r.why] = (whyCount[r.why.startsWith('same spot') ? 'same spot as an existing landmark' : r.why] ?? 0) + 1;
console.log('rejected:', JSON.stringify(whyCount));
console.log('total chosen:', chosen.length);
for (const region of Object.keys(QUOTA)) {
  const byCountry = {};
  for (const c of chosen.filter((c) => c.region === region)) (byCountry[c.country] ??= []).push(c.name === c.title ? c.name : c.name + ' [' + c.title + ']');
  console.log('\n## ' + region);
  for (const [country, names] of Object.entries(byCountry)) console.log(country + ': ' + names.join('; '));
}

if (process.argv.includes('--apply')) {
  const file = path.join(repo, 'data/landmarks.seed.json');
  const text = readFileSync(file, 'utf8');
  const ids = new Set(existingIds);
  const out = [];
  for (const region of Object.keys(QUOTA)) {
    const group = chosen.filter((c) => c.region === region).sort((a, b) => a.country.localeCompare(b.country));
    if (!group.length) continue;
    out.push('');
    for (const c of group) {
      const id = ids.has(c.id) ? slug(c.name + ' ' + c.country) : c.id;
      ids.add(id);
      const fields = ['"id": ' + JSON.stringify(id), '"name": ' + JSON.stringify(c.name), '"wiki": ' + JSON.stringify(c.title), '"country": ' + JSON.stringify(c.country), '"region": ' + JSON.stringify(c.region), '"category": ' + JSON.stringify(c.category)];
      // coordinates that came from Wikidata are not what the build would find by itself, so pin them
      if (c.coordSource) fields.push('"lat": ' + +c.lat.toFixed(5), '"lng": ' + +c.lon.toFixed(5));
      out.push('  { ' + fields.join(', ') + ' }');
    }
  }
  writeFileSync(file, text.slice(0, text.lastIndexOf('}') + 1) + ',\n' + out.join(',\n').replace(/,\n,\n/g, ',\n\n').replace(/^,?\n?/, '\n') + '\n]\n');
  console.log('\nappended ' + out.filter(Boolean).length + ' entries to data/landmarks.seed.json; now run: npm run data');
}
