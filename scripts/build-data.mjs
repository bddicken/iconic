#!/usr/bin/env node
// Builds public/data/landmarks.json and public/images/** from data/landmarks.seed.json.
//
// For every seed entry it gathers, from Wikipedia / Wikidata / Wikimedia Commons:
//   - coordinates, short description and intro text
//   - popularity signals (12 months of English Wikipedia pageviews + number of
//     Wikipedia language editions with an article), blended into a 0-100 score
//   - the article's lead image (or the `image` override in the seed), plus its
//     author / license / source page so it can be credited
//
// Usage:
//   node scripts/build-data.mjs              # incremental: reuses data/cache + data/originals
//   node scripts/build-data.mjs --refresh    # re-fetch everything
//   node scripts/build-data.mjs --only=eiffel-tower,petra   # re-fetch just these, keep the rest
//
// Seed entry fields:
//   id, name, wiki (English Wikipedia title), country, region, category   (required)
//   lat, lng     override coordinates (needed when the article has none)
//   image        override image: a Wikimedia Commons file name, e.g. "Foo bar.jpg"
//   boost        editorial adjustment added to the popularity score (can be negative)

import { mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'data/landmarks.seed.json');
const CACHE_DIR = path.join(ROOT, 'data/cache');
const ORIG_DIR = path.join(ROOT, 'data/originals');
const OUT_JSON = path.join(ROOT, 'public/data/landmarks.json');
const FULL_DIR = path.join(ROOT, 'public/images/full');
const THUMB_DIR = path.join(ROOT, 'public/images/thumb');

// Wikimedia asks automated clients to identify themselves. Set WIKIMEDIA_CONTACT (a URL or email)
// to be a good citizen and get friendlier rate limits; without it a generic client name is sent.
const UA = `IconicLandmarksApp/0.1 (${process.env.WIKIMEDIA_CONTACT || 'landmark explorer; data build script'})`;
const CONCURRENCY = 3; // per-article REST calls
const DOWNLOAD_CONCURRENCY = 2; // image downloads
const DOWNLOAD_WIDTH = 1920; // a standard Wikimedia thumbnail step
const FULL_WIDTH = 1600;
const THUMB_SIZE = 256;

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);

// Wikimedia API limits (2026): 10 requests/minute for clients that do not identify themselves,
// 200/minute with a compliant User-Agent. All API calls go through one paced queue so we stay
// under the limit instead of bouncing off 429s. Image downloads (upload/thumb.wikimedia.org)
// have a separate, far higher limit and are not paced.
const API_INTERVAL_MS = process.env.WIKIMEDIA_CONTACT ? 400 : 6500;
let nextApiSlot = 0;
async function apiSlot() {
  const now = Date.now();
  const at = Math.max(now, nextApiSlot);
  nextApiSlot = at + API_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

async function fetchRetry(url, { as = 'json', tries = 6, method = 'GET', body } = {}) {
  const paced = !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(url);
  for (let attempt = 1; ; attempt++) {
    if (paced) await apiSlot();
    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*' },
      });
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      // Respect retry-after, and hold back every other queued API call as well.
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2 * attempt, 120) + 1;
      if (paced) nextApiSlot = Math.max(nextApiSlot, Date.now() + wait * 1000);
      else await sleep(wait * 1000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

const wikiTitle = (t) => encodeURIComponent(t.replace(/ /g, '_'));

function stripHtml(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function blurb(text = '', max = 340) {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > max) break;
    out += s;
  }
  out = out.trim() || text.slice(0, max);
  return out.length > max + 80 ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
}

/** Last 12 complete calendar months, as YYYYMMDD strings for the pageviews API. */
function pageviewWindow() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of previous month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  return { start: fmt(start), end: fmt(end) };
}

const cachePath = (id) => path.join(CACHE_DIR, `${id}.json`);
const saveFacts = (facts) => writeFile(cachePath(facts.id), JSON.stringify(facts, null, 2));

/** POST to a MediaWiki action API. These endpoints are tightly rate limited, so callers batch titles/ids. */
async function mwApi(host, params) {
  const body = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  return fetchRetry(`https://${host}/w/api.php`, { method: 'POST', body });
}

/** The Commons file name behind a Wikimedia image URL (original or /thumb/ rendition), or null if it is not on Commons. */
function commonsFileName(url) {
  const segs = new URL(url).pathname.split('/').map(decodeURIComponent);
  if (!segs.includes('commons')) return null; // e.g. /wikipedia/en/ = non-free upload local to English Wikipedia
  const t = segs.indexOf('thumb');
  return (t >= 0 ? segs[t + 3] : segs.at(-1)).replace(/_/g, ' ');
}

const cleanFileName = (name) => name?.replace(/^File:/i, '').replace(/_/g, ' ') ?? null;

/**
 * Phase 1 (one landmark at a time, cached in data/cache/<id>.json): article summary + pageviews.
 * Returns the cached facts untouched when the seed entry has not changed.
 */
async function gatherArticle(seed) {
  const force = REFRESH || ONLY.includes(seed.id);
  if (!force && (await exists(cachePath(seed.id)))) {
    const cached = JSON.parse(await readFile(cachePath(seed.id), 'utf8'));
    if (cached.wiki === seed.wiki) {
      if ((cached.imageOverride ?? null) === (seed.image ?? null)) return cached;
      // Only the image override changed: keep the article facts, look the new image up again.
      const imageFile = seed.image ?? cached.leadImage;
      if (imageFile) {
        const updated = { ...cached, imageOverride: seed.image ?? null, imageFile: cleanFileName(imageFile), image: null };
        await saveFacts(updated);
        return updated;
      }
    }
    // a different article (or nothing usable cached): fetch from scratch
  }

  const summary = await fetchRetry(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${wikiTitle(seed.wiki)}?redirect=true`,
  );
  const canonical = summary.titles?.canonical ?? seed.wiki.replace(/ /g, '_');

  // popularity signal 1: English Wikipedia pageviews (human traffic only)
  const { start, end } = pageviewWindow();
  let pageviews = 0;
  try {
    const pv = await fetchRetry(
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(canonical)}/monthly/${start}/${end}`,
    );
    pageviews = (pv.items ?? []).reduce((sum, i) => sum + i.views, 0);
  } catch (err) {
    console.warn(`  ! pageviews failed for ${seed.id}: ${err.message}`);
  }

  // image: seed override, else the article's lead image (only if it is hosted on Commons)
  const leadImage = summary.originalimage?.source ? commonsFileName(summary.originalimage.source) : null;

  const facts = {
    id: seed.id,
    wiki: seed.wiki,
    imageOverride: seed.image ?? null,
    fetchedAt: new Date().toISOString(),
    title: summary.title,
    canonical,
    wikidata: summary.wikibase_item ?? null,
    wikipediaUrl: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${canonical}`,
    description: summary.description ?? null,
    extract: summary.extract ?? '',
    coordinates: summary.coordinates ?? null,
    pageviews,
    pageviewWindow: { start, end },
    leadImage,
    imageFile: cleanFileName(seed.image ?? leadImage),
    sitelinks: null, // filled by gatherSitelinks
    image: null, // filled by gatherImageInfo
  };
  await saveFacts(facts);
  return facts;
}

/** Phase 2 (batched): popularity signal 2, the number of Wikipedia language editions with an article. */
async function gatherSitelinks(allFacts) {
  const todo = allFacts.filter((f) => f.wikidata && f.sitelinks == null);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const wd = await mwApi('www.wikidata.org', {
      action: 'wbgetentities',
      ids: batch.map((f) => f.wikidata).join('|'),
      props: 'sitelinks',
    });
    for (const f of batch) {
      const links = Object.keys(wd.entities?.[f.wikidata]?.sitelinks ?? {});
      f.sitelinks = links.filter(
        (k) => /wiki$/.test(k) && !/^(commons|species|meta|wikidata|sources|mediawiki)wiki$/.test(k),
      ).length;
      await saveFacts(f);
    }
    process.stdout.write(`\r  sitelinks ${Math.min(i + 50, todo.length)}/${todo.length}`);
  }
  if (todo.length) process.stdout.write('\n');
}

/** Phase 3 (batched): author, license and download URL for each image, from Wikimedia Commons. */
async function gatherImageInfo(allFacts) {
  const todo = allFacts.filter((f) => f.imageFile && !f.image);
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const pages = new Map(); // final title -> page
    const alias = new Map(); // requested/normalized/redirected-from title -> next title
    let cont = {};
    do {
      const q = await mwApi('commons.wikimedia.org', {
        action: 'query',
        titles: batch.map((f) => 'File:' + f.imageFile).join('|'),
        redirects: '1',
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: String(DOWNLOAD_WIDTH),
        ...cont,
      });
      for (const n of q.query?.normalized ?? []) alias.set(n.from, n.to);
      for (const r of q.query?.redirects ?? []) alias.set(r.from, r.to);
      for (const p of q.query?.pages ?? []) {
        if (p.imageinfo?.length || !pages.has(p.title)) pages.set(p.title, p);
      }
      cont = q.continue ?? null;
    } while (cont);

    for (const f of batch) {
      let title = 'File:' + f.imageFile;
      for (let hops = 0; alias.has(title) && hops < 5; hops++) title = alias.get(title);
      const page = pages.get(title);
      const info = page?.imageinfo?.[0];
      if (!info) continue; // reported later as "no image"
      const meta = info.extmetadata ?? {};
      f.image = {
        title: page.title,
        // Where the file lives and where we fetched the bytes from:
        sourcePage: info.descriptionurl,
        originalUrl: info.url,
        downloadUrl: info.thumburl ?? info.url,
        originalWidth: info.width,
        originalHeight: info.height,
        mime: info.mime,
        author: stripHtml(meta.Artist?.value) || null,
        credit: stripHtml(meta.Credit?.value) || null,
        license: meta.LicenseShortName?.value ?? null,
        licenseUrl: meta.LicenseUrl?.value ?? null,
        usageTerms: meta.UsageTerms?.value ?? null,
        attributionRequired: meta.AttributionRequired?.value === 'true',
        description: blurb(stripHtml(meta.ImageDescription?.value), 200) || null,
      };
      await saveFacts(f);
    }
    process.stdout.write(`\r  image info ${Math.min(i + 25, todo.length)}/${todo.length}`);
  }
  if (todo.length) process.stdout.write('\n');
}

/** Download the source image (once) and derive the web-sized full image + square marker thumbnail. */
async function processImage(seed, facts) {
  const img = facts.image;
  const ext = (img.downloadUrl.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'jpg').toLowerCase();
  const origFile = path.join(ORIG_DIR, `${seed.id}.${ext}`);
  const marker = path.join(ORIG_DIR, `${seed.id}.source.txt`);
  const force = REFRESH || ONLY.includes(seed.id);
  const sameSource = (await exists(marker)) && (await readFile(marker, 'utf8')).trim() === img.downloadUrl;

  if (force || !sameSource || !(await exists(origFile))) {
    const buf = await fetchRetry(img.downloadUrl, { as: 'buffer' });
    await writeFile(origFile, buf);
    await writeFile(marker, img.downloadUrl + '\n');
  }

  const fullOut = path.join(FULL_DIR, `${seed.id}.webp`);
  const thumbOut = path.join(THUMB_DIR, `${seed.id}.webp`);
  const input = sharp(origFile, { failOn: 'none' }).rotate();
  const full = await input
    .clone()
    .resize({ width: FULL_WIDTH, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(fullOut);
  await input
    .clone()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: seed.thumbPosition ?? sharp.strategy.attention })
    .webp({ quality: 78 })
    .toFile(thumbOut);
  const { dominant } = await sharp(thumbOut).stats();
  const hex = (n) => n.toString(16).padStart(2, '0');

  return {
    src: `images/full/${seed.id}.webp`,
    thumb: `images/thumb/${seed.id}.webp`,
    width: full.width,
    height: full.height,
    color: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
  };
}

/**
 * Popularity on fixed scales (not min/max of the current list) so scores stay
 * comparable as the dataset grows from 100 to thousands of landmarks.
 */
function popularityScore(pageviews, sitelinks, boost = 0) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const views = clamp((Math.log10(pageviews + 1) - 4) / 3); // 10k/yr -> 0, 10M/yr -> 1
  const reach = clamp((sitelinks - 10) / 190); // 10 languages -> 0, 200 -> 1
  return Math.round((55 * views + 45 * reach + boost) * 10) / 10;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  const seeds = JSON.parse(await readFile(SEED, 'utf8'));
  const ids = new Set();
  for (const s of seeds) {
    if (ids.has(s.id)) throw new Error(`Duplicate id in seed: ${s.id}`);
    ids.add(s.id);
  }
  for (const dir of [CACHE_DIR, ORIG_DIR, FULL_DIR, THUMB_DIR, path.dirname(OUT_JSON)]) {
    await mkdir(dir, { recursive: true });
  }

  const problems = [];
  const factsById = new Map();
  let done = 0;

  if (!process.env.WIKIMEDIA_CONTACT) {
    console.log('WIKIMEDIA_CONTACT is not set: pacing API calls at ~10/minute (the limit for unidentified clients).');
  }
  console.log('1/4 article summaries + pageviews');
  await pool(seeds, CONCURRENCY, async (seed) => {
    try {
      factsById.set(seed.id, await gatherArticle(seed));
    } catch (err) {
      problems.push(`${seed.id}: ${err.message}`);
    }
    process.stdout.write(`\r  ${++done}/${seeds.length}`);
  });
  process.stdout.write('\n');

  console.log('2/4 Wikipedia language counts');
  await gatherSitelinks([...factsById.values()]);
  console.log('3/4 image metadata');
  await gatherImageInfo([...factsById.values()]);

  console.log('4/4 images');
  done = 0;
  const built = await pool(seeds, DOWNLOAD_CONCURRENCY, async (seed) => {
    const facts = factsById.get(seed.id);
    if (!facts) return null; // already reported
    try {
      const lat = seed.lat ?? facts.coordinates?.lat;
      const lng = seed.lng ?? facts.coordinates?.lon;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new Error('no coordinates on the article; add "lat"/"lng" to the seed');
      }
      if (!facts.image) {
        throw new Error(
          facts.imageFile
            ? `image "${facts.imageFile}" not found on Commons; fix the "image" override in the seed`
            : 'no freely licensed lead image on Commons; add an "image" override to the seed',
        );
      }
      const files = await processImage(seed, facts);
      process.stdout.write(`\r  ${++done}/${seeds.length} ${seed.id.padEnd(40)}`);
      return {
        id: seed.id,
        name: seed.name,
        country: seed.country,
        region: seed.region,
        category: seed.category,
        lat: Math.round(lat * 1e5) / 1e5,
        lng: Math.round(lng * 1e5) / 1e5,
        description: facts.description,
        summary: blurb(facts.extract),
        popularity: popularityScore(facts.pageviews, facts.sitelinks ?? 0, seed.boost),
        metrics: { pageviews: facts.pageviews, wikipediaLanguages: facts.sitelinks ?? 0 },
        wikipedia: facts.wikipediaUrl,
        wikidata: facts.wikidata,
        image: {
          ...files,
          credit: {
            title: facts.image.title,
            author: facts.image.author,
            credit: facts.image.credit,
            license: facts.image.license,
            licenseUrl: facts.image.licenseUrl,
            attributionRequired: facts.image.attributionRequired,
            sourcePage: facts.image.sourcePage,
            originalUrl: facts.image.originalUrl,
            downloadedFrom: facts.image.downloadUrl,
          },
        },
      };
    } catch (err) {
      problems.push(`${seed.id}: ${err.message}`);
      return null;
    }
  });
  process.stdout.write('\n');

  // Drop generated files for landmarks that are no longer in the seed.
  for (const dir of [FULL_DIR, THUMB_DIR, CACHE_DIR, ORIG_DIR]) {
    for (const file of await readdir(dir)) {
      if (!file.startsWith('.') && !ids.has(file.replace(/(\.source)?\.\w+$/, ''))) await rm(path.join(dir, file));
    }
  }

  const landmarks = built
    .filter(Boolean)
    .sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name))
    .map((l, i) => ({ rank: i + 1, ...l }));

  await writeFile(
    OUT_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: landmarks.length,
        popularity:
          'Score 0-100 = 55% English Wikipedia pageviews over the last 12 months (log scale) + 45% number of Wikipedia language editions with an article, plus any editorial boost from the seed. rank 1 = most popular.',
        landmarks,
      },
      null,
      1,
    ),
  );

  console.log(`Wrote ${landmarks.length} landmarks to ${path.relative(ROOT, OUT_JSON)}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
