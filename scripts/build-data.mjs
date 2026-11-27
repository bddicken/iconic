#!/usr/bin/env node
// Builds public/data/landmarks.json and public/images/** from data/landmarks.seed.json.
//
// For every seed entry it gathers, from Wikipedia / Wikidata / Wikimedia Commons:
//   - coordinates, short description and intro text
//   - popularity signals (12 months of English Wikipedia pageviews + number of
//     Wikipedia language editions with an article), blended into a 0-100 score
//   - the article's lead image (or the `image` override in the seed), plus its
//     author / license / source page so it can be credited
//   - up to three more photos per landmark for the card's gallery, found by searching
//     Wikimedia Commons, each with the same credit details
//
// Usage:
//   node scripts/build-data.mjs              # incremental: reuses data/cache + data/originals
//   node scripts/build-data.mjs --refresh    # re-fetch everything
//   node scripts/build-data.mjs --only=eiffel-tower,petra   # re-fetch just these, keep the rest
//   node scripts/build-data.mjs --no-gallery # skip the gallery search (keeps galleries already built)
//
// Seed entry fields:
//   id, name, wiki (English Wikipedia title), country, region, category   (required)
//   lat, lng     override coordinates (needed when the article has none)
//   image        override image: a Wikimedia Commons file name, e.g. "Foo bar.jpg"
//   boost        editorial adjustment added to the popularity score (can be negative)
//   gallery          use exactly these Commons files as the extra photos, e.g. ["A.jpg", "B.jpg"]
//   galleryExclude   Commons files never to use as extra photos (the next best takes their place)
//   gallerySearch    search Commons for these words instead of the article title

import { createHash } from 'node:crypto';
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
const GALLERY_DIR = path.join(ROOT, 'public/images/gallery');
const GALLERY_ORIG_DIR = path.join(ROOT, 'data/gallery-originals');

// Wikimedia asks automated clients to identify themselves. Set WIKIMEDIA_CONTACT (a URL or email)
// to be a good citizen and get friendlier rate limits; without it a generic client name is sent.
const UA = `IconicLandmarksApp/0.1 (${process.env.WIKIMEDIA_CONTACT || 'landmark explorer; data build script'})`;
const CONCURRENCY = 3; // per-article REST calls
const DOWNLOAD_CONCURRENCY = 4; // image downloads
const DOWNLOAD_WIDTH = 1920; // a standard Wikimedia thumbnail step
const FULL_WIDTH = 1600;
const THUMB_SIZE = 256;
const GALLERY_MAX = 3; // extra photos per landmark, on top of the main one
const GALLERY_DOWNLOAD_WIDTH = 1280; // a standard Wikimedia thumbnail step
const GALLERY_WIDTH = 900; // the card is under 400px wide, so this is sharp on any screen
const GALLERY_SEARCH_VERSION = 3; // bump to throw away every cached gallery search

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const NO_GALLERY = args.includes('--no-gallery');

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

/** What we keep about a Commons file: where it lives, how to download it, and who to credit. */
function imageRecord(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  return {
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
    // Used only to choose gallery photos: when it was made and what Commons files it under.
    date: stripHtml(meta.DateTimeOriginal?.value) || null,
    categories: (meta.Categories?.value ?? '').split('|').filter(Boolean),
  };
}

/** Looks up to 25 Commons files up by name. Returns a Map of the name as given -> record (missing files are absent). */
async function commonsFiles(fileNames, width) {
  const pages = new Map(); // final title -> page
  const alias = new Map(); // requested/normalized/redirected-from title -> next title
  let cont = {};
  do {
    const q = await mwApi('commons.wikimedia.org', {
      action: 'query',
      titles: fileNames.map((n) => 'File:' + n).join('|'),
      redirects: '1',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(width),
      ...cont,
    });
    for (const n of q.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of q.query?.redirects ?? []) alias.set(r.from, r.to);
    for (const p of q.query?.pages ?? []) {
      if (p.imageinfo?.length || !pages.has(p.title)) pages.set(p.title, p);
    }
    cont = q.continue ?? null;
  } while (cont);

  const found = new Map();
  for (const name of fileNames) {
    let title = 'File:' + name;
    for (let hops = 0; alias.has(title) && hops < 5; hops++) title = alias.get(title);
    const record = imageRecord(pages.get(title));
    if (record) found.set(name, record);
  }
  return found;
}

/** Phase 3 (batched): author, license and download URL for each image, from Wikimedia Commons. */
async function gatherImageInfo(allFacts) {
  const todo = allFacts.filter((f) => f.imageFile && !f.image);
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const found = await commonsFiles(batch.map((f) => f.imageFile), DOWNLOAD_WIDTH);
    for (const f of batch) {
      const record = found.get(f.imageFile);
      if (!record) continue; // reported later as "no image"
      f.image = record;
      await saveFacts(f);
    }
    process.stdout.write(`\r  image info ${Math.min(i + 25, todo.length)}/${todo.length}`);
  }
  if (todo.length) process.stdout.write('\n');
}

// ---------------------------------------------------------------------------------------
// Gallery: up to GALLERY_MAX more photos per landmark.
//
// Candidates come, best first, from:
//   1. the photos used in the landmark's Wikipedia article, in article order. Editors chose
//      them to illustrate this very subject, which no search can match for relevance;
//   2. when the article has too few, two Commons searches: files whose structured data says
//      they depict the landmark's Wikidata item, and a plain text search for its name. Both
//      are noisy ("depicts" includes photos where the landmark is a speck on the skyline, the
//      text search drags in altar details and namesakes), so those named after the landmark
//      go first.
// Picking happens at image time, so the rules below can change without searching again.
// ---------------------------------------------------------------------------------------

const galleryQuery = (seed, facts) => seed.gallerySearch ?? facts.title.replace(/\s*\([^)]*\)$/, '');
const gallerySignature = (seed, facts) =>
  JSON.stringify([GALLERY_SEARCH_VERSION, facts.wikidata, galleryQuery(seed, facts)]);

/** One Commons file search; returns records for large bitmap files, in search order. */
async function commonsSearch(search, limit = 20) {
  const pages = new Map();
  let cont = {};
  for (;;) {
    const q = await mwApi('commons.wikimedia.org', {
      action: 'query',
      generator: 'search',
      gsrnamespace: '6',
      gsrsearch: `${search} filetype:bitmap filew:>1600`,
      gsrlimit: String(limit),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiextmetadatafilter:
        'Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|AttributionRequired|ImageDescription|DateTimeOriginal|Categories',
      iiurlwidth: String(GALLERY_DOWNLOAD_WIDTH),
      ...cont,
    });
    for (const p of q.query?.pages ?? []) {
      if (p.imageinfo?.length || !pages.has(p.title)) pages.set(p.title, p);
    }
    // keep going only to finish this batch's image details, never on to the next page of results
    if (q.batchcomplete || !q.continue) break;
    cont = q.continue;
  }
  return [...pages.values()]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(imageRecord)
    .filter(Boolean);
}

/** Phase 4 (one or two searches per landmark, cached): gallery candidates. */
async function gatherGallery(seeds, factsById) {
  const todo = seeds.filter((seed) => {
    const facts = factsById.get(seed.id);
    if (!facts || seed.gallery) return false;
    if (ONLY.length) return ONLY.includes(seed.id); // --only searches for just those; the rest keep what they have
    return REFRESH || facts.gallery?.signature !== gallerySignature(seed, facts);
  });
  let done = 0;
  await pool(todo, CONCURRENCY, async (seed) => {
    const facts = factsById.get(seed.id);
    try {
      const candidates = [];
      const seen = new Set();
      const add = (records, via) => {
        for (const c of records) {
          if (!seen.has(c.title)) candidates.push({ ...c, via });
          seen.add(c.title);
        }
      };
      // 1. the article's own photos (non-free ones are not on Commons and drop out here)
      const media = await fetchRetry(
        `https://en.wikipedia.org/api/rest_v1/page/media-list/${encodeURIComponent(facts.canonical)}`,
      ).catch(() => ({ items: [] }));
      const names = [
        ...new Set(
          (media.items ?? [])
            .filter((item) => item.type === 'image' && /\.jpe?g$/i.test(item.title ?? ''))
            .map((item) => cleanFileName(item.title)),
        ),
      ].slice(0, 25);
      if (names.length) {
        const found = await commonsFiles(names, GALLERY_DOWNLOAD_WIDTH);
        add(names.map((n) => found.get(n)).filter(Boolean), 'article');
      }
      // 2. top up from Commons when the article is thin on photos
      if (candidates.filter((c) => galleryUsable(c, facts, seed)).length < GALLERY_MAX * 2) {
        if (facts.wikidata) add(await commonsSearch(`haswbstatement:P180=${facts.wikidata}`), 'depicts');
        add(await commonsSearch(galleryQuery(seed, facts)), 'search');
      }
      facts.gallery = { signature: gallerySignature(seed, facts), fetchedAt: new Date().toISOString(), candidates };
      facts.galleryRejected = {};
      await saveFacts(facts);
    } catch (err) {
      console.warn(`\n  ! gallery search failed for ${seed.id}: ${err.message}`);
    }
    process.stdout.write(`\r  gallery search ${++done}/${todo.length}`);
  });
  if (todo.length) process.stdout.write('\n');

  // Files named outright in the seed's "gallery" list.
  const wanted = [];
  for (const seed of seeds) {
    const facts = factsById.get(seed.id);
    if (!facts || !seed.gallery) continue;
    facts.galleryExplicit ??= {};
    for (const name of seed.gallery.map(cleanFileName)) {
      if (!facts.galleryExplicit[name] || REFRESH || ONLY.includes(seed.id)) wanted.push({ facts, name });
    }
  }
  for (let i = 0; i < wanted.length; i += 25) {
    const batch = wanted.slice(i, i + 25);
    const found = await commonsFiles([...new Set(batch.map((w) => w.name))], GALLERY_DOWNLOAD_WIDTH);
    for (const { facts, name } of batch) {
      if (found.has(name)) facts.galleryExplicit[name] = found.get(name);
    }
    for (const facts of new Set(batch.map((w) => w.facts))) await saveFacts(facts);
  }
}

// File names that give away something other than a present-day photograph.
const NOT_A_PHOTO =
  /\b(map|plan|diagram|logo|drawing|painting|engraving|lithograph|etching|sketch|poster|stamp|postcard|coat of arms|flag|model|maquette|replica|facsimile|18\d\d|19[0-6]\d)\b/i;
// Commons categories that mark artwork, documents, objects and pictures from orbit.
const NOT_A_PHOTO_CATEGORY =
  /\b(paintings?|drawings?|engravings?|etchings?|lithographs?|woodcuts?|ukiyo-e|watercolou?rs?|illustrations?|prints|maps?|floor plans|plans of|diagrams?|coins?|medals?|plaques?|stamps|postcards?|stereo ?cards?|stereographs?|black and white|sepia|historical (images|photographs)|old photographs|portraits?|satellite pictures|landsat|sentinel-\d|from the iss|astronaut photography|scale models|architectural models|models of|logos|information boards|in art|(1[0-8]\d\d|19[0-6]\d)s? (photographs|in|works|paintings))\b/i;
const FROM_ORBIT = /\b(satellite|landsat|sentinel|iss\d{3}|iss-\d+|astronaut|nasa earth observatory|from space|from orbit)\b/i;

// ...and photographs of things kept indoors rather than of the place. Skipped only when the
// landmark's own name does not use the word (a fresco is fine for a chapel famous for its frescoes).
const INDOOR_EXHIBIT =
  /\b(exposici[oó]n|exhibition|exhibit|fresco|mosaic|manuscript|codex|codice|scroll|inscription|relief|portrait|artefact|artifact|pottery|coin|museum|museo|mus[eé]e)\b/i;

// Words too common in landmark names to tell one place's photos from another's.
const GENERIC_WORDS = new Set(
  `the and of de del la le los las des di da do el al san santa saint st mount mont monte lake river falls beach bay
   valley island islands national park temple church cathedral basilica mosque shrine monastery abbey chapel castle
   palace fort fortress tower bridge square city town old great grand big little new north south east west upper
   lower building monument memorial museum gate wall house hall garden gardens rock rocks hill hills mountain
   mountains canyon desert forest cave caves coast peak point port plaza temple pagoda statue ruins site historic
   ancient royal world heritage`.split(/\s+/),
);
const plain = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** The words that identify this landmark ("eiffel", "hallstatt"), for spotting it in file names. */
function nameWords(seed, facts) {
  const words = plain(`${seed.name} ${facts.title} ${seed.gallerySearch ?? ''}`)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  return [...new Set(words)];
}

/** Best first: the article's photos (those named after the landmark leading), then search results, named ones leading. */
function rankCandidates(candidates, seed, facts) {
  const words = nameWords(seed, facts);
  const named = (c) => {
    const title = plain(c.title).replace(/[^a-z0-9]+/g, '');
    return words.some((w) => title.includes(w));
  };
  const tier = (c) => (c.via === 'article' ? (named(c) ? 0 : 1) : (c.via === 'depicts' ? 2 : 3) + (named(c) ? 0 : 2));
  return candidates.map((c, i) => ({ c, i, t: tier(c) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.c);
}

/** Cheap checks that need no download: a properly licensed, reasonably shaped JPEG that is not the main photo. */
function galleryUsable(c, facts, seed) {
  if (c.title === facts.image?.title) return false;
  if (c.mime !== 'image/jpeg') return false; // PNGs here are mostly maps, diagrams and scans
  const title = c.title.replace(/_/g, ' ');
  if (NOT_A_PHOTO.test(title)) return false;
  if (FROM_ORBIT.test(title) || FROM_ORBIT.test(`${c.author ?? ''} ${c.credit ?? ''}`)) return false;
  if ((c.categories ?? []).some((cat) => NOT_A_PHOTO_CATEGORY.test(cat))) return false;
  // made before colour photography was the norm: an old photograph, or a picture of an artwork
  const year = Number((c.date ?? '').match(/\b(1[0-9]\d\d|20[0-2]\d)\b/)?.[1]);
  if (year && year < 1975) return false;
  const exhibit = title.match(INDOOR_EXHIBIT)?.[0];
  if (exhibit && !plain(`${seed?.name} ${facts.title}`).includes(plain(exhibit))) return false;
  if (!c.license || !c.sourcePage) return false;
  if (c.originalWidth < 1600 || c.originalHeight < 900) return false;
  const ratio = c.originalWidth / c.originalHeight;
  return ratio >= 0.6 && ratio <= 2.4; // no stitched panoramas or tall slivers
}

/** A file name boiled down to its words, so "Foo 01.jpg" and "Foo (2).jpg" count as one series. */
const nameStem = (title) =>
  title
    .replace(/^File:/, '')
    .replace(/\.\w+$/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[\d_.,;:–-]+/g, ' ')
    .replace(/\b(img|dsc|dscn|dscf|pano|panorama|panoramio|flickr|cropped|crop|edit|edited|version|hdr|jpg|jpeg)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A 64-bit difference hash (to spot near-duplicate shots), the mean colourfulness (to spot
 * black-and-white photos) and how much of the picture is the pale yellow-brown of old paper
 * (to spot scanned maps, drawings and manuscripts).
 */
async function fingerprint(file) {
  const image = sharp(file, { failOn: 'none' }).rotate().removeAlpha();
  const small = await image.clone().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  const grey = (i) => small[i * 3] * 0.299 + small[i * 3 + 1] * 0.587 + small[i * 3 + 2] * 0.114;
  const bits = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(grey(y * 9 + x) < grey(y * 9 + x + 1) ? 1 : 0);
  }
  const px = await image.clone().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
  let colour = 0;
  let paper = 0;
  let warm = 0;
  for (let i = 0; i < px.length; i += 3) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    const max = Math.max(r, g, b);
    const spread = max - Math.min(r, g, b);
    colour += spread;
    // light, weakly saturated, and warm (red >= green > blue)
    if (max > 150 && spread > 12 && spread < 95 && r >= g - 4 && g > b) paper++;
    // brown-toned or neutral: nothing blue, green or vividly coloured about it
    if (r >= g - 3 && g >= b - 3 && spread < 110) warm++;
  }
  // A toned monochrome print is brown all over and only mildly so; a desert photo has sky or strong colour.
  const sepia = warm / 1024 > 0.985 && colour / 1024 < 62;
  return { bits, colour: colour / 1024, paper: paper / 1024, sepia };
}
const hashDistance = (a, b) => a.reduce((n, bit, i) => n + (bit !== b[i] ? 1 : 0), 0);

/**
 * Chooses and builds the gallery for one landmark. Walks the candidates best-first and keeps
 * the first GALLERY_MAX that are in colour and are not another take of a shot already chosen.
 */
async function processGallery(seed, facts) {
  const force = REFRESH || ONLY.includes(seed.id);
  const exclude = new Set((seed.galleryExclude ?? []).map((n) => 'File:' + cleanFileName(n)));
  const explicit = seed.gallery
    ? seed.gallery.map((n) => facts.galleryExplicit?.[cleanFileName(n)]).filter(Boolean)
    : null;
  const candidates =
    explicit ?? rankCandidates((facts.gallery?.candidates ?? []).filter((c) => galleryUsable(c, facts, seed)), seed, facts);
  const rejected = (facts.galleryRejected ??= {});

  const mainExt = (facts.image.downloadUrl.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'jpg').toLowerCase();
  const prints = [await fingerprint(path.join(ORIG_DIR, `${seed.id}.${mainExt}`))];
  const stems = new Set([nameStem(facts.image.title)]);
  const authors = new Map(); // author -> photos taken so far
  const chosen = [];
  let dirty = false;

  // Two passes: first at most one photo per photographer and per series, then anything left, to fill up.
  for (const perAuthor of explicit ? [Infinity] : [1, Infinity]) {
    for (const c of candidates) {
      if (chosen.length >= GALLERY_MAX) break;
      if (chosen.some((x) => x.record === c) || exclude.has(c.title)) continue;
      if (!explicit) {
        if (rejected[c.title]) continue;
        // first time round, skip other shots from a series already used ("Foo 01", "Foo 02")
        if (perAuthor === 1 && stems.has(nameStem(c.title))) continue;
        if ((authors.get(c.author ?? c.title) ?? 0) >= perAuthor) continue;
      }
      const file = path.join(GALLERY_ORIG_DIR, `${seed.id}--${createHash('sha1').update(c.title).digest('hex').slice(0, 10)}.jpg`);
      try {
        if (force || !(await exists(file))) await writeFile(file, await fetchRetry(c.downloadUrl, { as: 'buffer' }));
        const print = await fingerprint(file);
        if (!explicit) {
          const why =
            print.colour < 14
              ? 'black and white'
              : print.paper > 0.8
                ? 'looks like a scan on paper'
                : print.sepia
                  ? 'sepia toned'
                : prints.some((p) => hashDistance(p.bits, print.bits) <= 10)
                  ? 'near-duplicate'
                  : null;
          if (why) {
            rejected[c.title] = why;
            dirty = true;
            continue;
          }
        }
        prints.push(print);
        stems.add(nameStem(c.title));
        authors.set(c.author ?? c.title, (authors.get(c.author ?? c.title) ?? 0) + 1);
        chosen.push({ record: c, file });
      } catch (err) {
        rejected[c.title] = `download failed: ${err.message}`;
        dirty = true;
      }
    }
  }
  if (dirty) await saveFacts(facts);

  const out = [];
  for (const [n, { record, file }] of chosen.entries()) {
    const src = `images/gallery/${seed.id}-${n + 1}.webp`;
    const dest = path.join(ROOT, 'public', src);
    const info = await sharp(file, { failOn: 'none' })
      .rotate()
      .resize({ width: GALLERY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(dest);
    const { dominant } = await sharp(dest).stats();
    const hex = (v) => v.toString(16).padStart(2, '0');
    out.push({
      src,
      width: info.width,
      height: info.height,
      color: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
      credit: {
        title: record.title,
        author: record.author,
        credit: record.credit,
        license: record.license,
        licenseUrl: record.licenseUrl,
        attributionRequired: record.attributionRequired,
        sourcePage: record.sourcePage,
        originalUrl: record.originalUrl,
        downloadedFrom: record.downloadUrl,
      },
    });
  }
  return out;
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
  for (const dir of [CACHE_DIR, ORIG_DIR, FULL_DIR, THUMB_DIR, GALLERY_DIR, GALLERY_ORIG_DIR, path.dirname(OUT_JSON)]) {
    await mkdir(dir, { recursive: true });
  }

  const problems = [];
  const factsById = new Map();
  let done = 0;

  if (!process.env.WIKIMEDIA_CONTACT) {
    console.log('WIKIMEDIA_CONTACT is not set: pacing API calls at ~10/minute (the limit for unidentified clients).');
  }
  console.log('1/5 article summaries + pageviews');
  await pool(seeds, CONCURRENCY, async (seed) => {
    try {
      factsById.set(seed.id, await gatherArticle(seed));
    } catch (err) {
      problems.push(`${seed.id}: ${err.message}`);
    }
    process.stdout.write(`\r  ${++done}/${seeds.length}`);
  });
  process.stdout.write('\n');

  console.log('2/5 Wikipedia language counts');
  await gatherSitelinks([...factsById.values()]);
  console.log('3/5 image metadata');
  await gatherImageInfo([...factsById.values()]);
  console.log(NO_GALLERY ? '4/5 gallery search (skipped: --no-gallery)' : '4/5 gallery search');
  if (!NO_GALLERY) await gatherGallery(seeds, factsById);

  console.log('5/5 images');
  const previous = (await exists(OUT_JSON)) ? JSON.parse(await readFile(OUT_JSON, 'utf8')).landmarks : [];
  const previousGallery = new Map(previous.map((l) => [l.id, l.gallery ?? []]));
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
      // With --no-gallery, galleries are left exactly as the last full run built them.
      const gallery = NO_GALLERY ? (previousGallery.get(seed.id) ?? []) : await processGallery(seed, facts);
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
        gallery,
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

  // Drop gallery photos that are no longer used (a landmark removed, or a different pick).
  const galleryInUse = new Set(landmarks.flatMap((l) => l.gallery.map((g) => path.basename(g.src))));
  for (const file of await readdir(GALLERY_DIR)) {
    if (!file.startsWith('.') && !galleryInUse.has(file)) await rm(path.join(GALLERY_DIR, file));
  }
  for (const file of await readdir(GALLERY_ORIG_DIR)) {
    if (!file.startsWith('.') && !ids.has(file.split('--')[0])) await rm(path.join(GALLERY_ORIG_DIR, file));
  }

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
