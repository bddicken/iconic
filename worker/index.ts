// The site's only server-side code: the API the app gets its landmarks from.
//
//   GET /api/landmarks        every landmark, briefly: what the globe and search list need
//   GET /api/landmarks/<id>   one landmark in full: what its card shows
//   GET /api/search?q=<text>&region=<Region>&category=<category>&limit=<n>
//
// Everything else on iconic.place is static files served straight from Cloudflare's edge
// (see "run_worker_first" in wrangler.jsonc), so this Worker runs only for /api/ requests.
//
// The data lives in PlanetScale Postgres, the source of truth for the running site
// (scripts/db-sync.mjs loads it). It is reached through Cloudflare Hyperdrive, which pools
// connections and caches repeated reads. Search uses TIN, PlanetScale's full-text index.

import postgres from 'postgres';

type Sql = postgres.Sql;

const JSON_TYPE = 'application/json; charset=utf-8';
const json = (body: unknown, status = 200, cache = 'no-store'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE, 'cache-control': cache } });

/** Runs `work` with a database connection and closes it once the response is on its way. */
async function withDb<T>(env: Env, ctx: ExecutionContext, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
  try {
    return await work(sql);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

/**
 * Answers from Cloudflare's edge cache when it can, so most visits never touch the
 * database, and keeps a long-lived spare copy to fall back on if the database cannot be
 * reached. The data only changes when the dataset is re-synced, so a few minutes of
 * staleness is fine.
 */
async function cached(request: Request, ctx: ExecutionContext, produce: () => Promise<unknown | null>): Promise<Response> {
  const cache = caches.default;
  // (keyed on the path alone, so a made-up query string cannot be used to dodge the cache)
  const { origin, pathname } = new URL(request.url);
  const fresh = new Request(origin + pathname);
  const hit = await cache.match(fresh);
  if (hit) return marked(hit, 'hit');

  const spare = new Request(origin + pathname + '?spare');
  try {
    const body = await produce();
    if (body === null) return json({ error: 'Not found' }, 404);
    const text = JSON.stringify(body);
    const reply = (cacheControl: string): Response =>
      new Response(text, { headers: { 'content-type': JSON_TYPE, 'cache-control': cacheControl } });
    ctx.waitUntil(
      Promise.all([
        cache.put(fresh, reply('public, max-age=60, s-maxage=300')),
        cache.put(spare, reply('public, s-maxage=604800')),
      ]),
    );
    return marked(reply('public, max-age=60, s-maxage=300'), 'miss');
  } catch (err) {
    console.error('database read failed', err);
    const old = await cache.match(spare);
    if (old) return marked(new Response(old.body, { headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' } }), 'spare');
    return json({ error: 'The landmark database is unavailable right now.' }, 503);
  }
}

/** Says where an answer came from (the cache, the database, or the spare copy), for debugging. */
function marked(response: Response, source: 'hit' | 'miss' | 'spare'): Response {
  const out = new Response(response.body, response);
  out.headers.set('x-iconic-cache', source);
  return out;
}

// ---------- landmarks ----------

/** Every landmark, most popular first, with just the fields needed before one is opened. */
function listLandmarks(env: Env, ctx: ExecutionContext): Promise<unknown> {
  return withDb(env, ctx, async (sql) => {
    const [rows, meta] = await Promise.all([
      sql`
        SELECT rank, id, name, country, region, category, lat, lng,
               image->>'thumb' AS thumb, image->>'color' AS color
        FROM landmarks
        WHERE lat IS NOT NULL AND lng IS NOT NULL AND image ? 'thumb'
        ORDER BY rank`,
      sql`SELECT generated_at FROM dataset`,
    ]);
    return {
      generatedAt: meta[0]?.generated_at ?? null,
      count: rows.length,
      landmarks: rows.map(({ thumb, color, ...rest }) => ({ ...rest, image: { thumb, color } })),
    };
  });
}

/** One landmark in full, or null if there is no such id. */
function getLandmark(id: string, env: Env, ctx: ExecutionContext): Promise<unknown | null> {
  return withDb(env, ctx, async (sql) => {
    const [row] = await sql`
      SELECT rank, id, name, country, region, category, lat, lng, description, summary, popularity,
             pageviews, wikipedia_languages, wikipedia, wikidata, image, gallery
      FROM landmarks
      WHERE id = ${id}`;
    if (!row) return null;
    const { pageviews, wikipedia_languages, description, ...rest } = row;
    return {
      ...rest,
      description: description || null,
      metrics: { pageviews, wikipediaLanguages: wikipedia_languages },
    };
  });
}

// ---------- search ----------

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 2000;

/** How a text query was matched: as typed, allowing typos, or on any one of the words. */
type Mode = 'all' | 'exact' | 'fuzzy' | 'any';

/**
 * The words of a query, lower-cased, with everything that is not a letter or digit dropped.
 * That makes them safe to place in a TINQL query: TINQL's operators are punctuation and
 * UPPERCASE keywords, and none of either survives.
 */
function words(q: string): string[] {
  return (q.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((w) => w.slice(0, 40));
}

/**
 * TINQL for the words. The last word is treated as possibly unfinished (people search as
 * they type), so it also matches as a prefix: "pyr" finds "pyramid".
 *   exact  every word must appear
 *   fuzzy  every word must appear, give or take a couple of mistyped letters
 *   any    at least one word must appear, typos allowed
 */
function tinql(ws: string[], mode: Exclude<Mode, 'all'>): string {
  const typo = (w: string): string => (mode !== 'exact' && w.length >= 4 ? `${w}~2` : w);
  const terms = ws.map((w, i) => (i === ws.length - 1 ? `(${w}* OR ${typo(w)})` : typo(w)));
  return terms.join(mode === 'any' ? ' OR ' : ' AND ');
}

async function search(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ws = words(url.searchParams.get('q') ?? '');
  const region = url.searchParams.get('region')?.slice(0, 40) || null;
  const category = url.searchParams.get('category')?.slice(0, 40) || null;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));

  try {
    const result = await withDb(env, ctx, async (sql) => {
      const filters = sql`${region ? sql`AND region = ${region}` : sql``} ${category ? sql`AND category = ${category}` : sql``}`;
      let mode: Mode = 'all';
      let ids: string[] = [];
      let total = 0;

      if (ws.length === 0) {
        // No text: just the filters, most popular first.
        const rows = await sql<{ id: string; total: number }[]>`
          SELECT id, count(*) OVER ()::int AS total
          FROM landmarks
          WHERE true ${filters}
          ORDER BY rank
          LIMIT ${limit}`;
        ids = rows.map((r) => r.id);
        total = rows[0]?.total ?? 0;
      } else {
        // Try the query as typed; if nothing matches, allow typos; then settle for any word.
        for (mode of ['exact', 'fuzzy', 'any'] as const) {
          const query = tinql(ws, mode);
          // A match in the name counts four times as much as one in the description, and
          // better-known places get a gentle lift so the obvious answer comes first.
          const rows = await sql<{ id: string; total: number }[]>`
            SELECT id, count(*) OVER ()::int AS total
            FROM landmarks
            WHERE (name ==> ${`(${query})^4`} OR about ==> ${query}) ${filters}
            ORDER BY tin.score(ctid) / (1 + ln(rank::real + 1) / 12) DESC, rank
            LIMIT ${limit}`;
          ids = rows.map((r) => r.id);
          total = rows[0]?.total ?? 0;
          if (ids.length) break;
        }
      }
      return { ids, total, mode };
    });
    // Results change only when the dataset is re-synced, so let browsers reuse them briefly.
    return json(result, 200, 'public, max-age=300');
  } catch (err) {
    console.error('search failed', err);
    return json({ error: 'Search is unavailable right now.' }, 503);
  }
}

// ---------- routing ----------

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/search') return search(url, env, ctx);
    if (url.pathname === '/api/landmarks') return cached(request, ctx, () => listLandmarks(env, ctx));

    const one = url.pathname.match(/^\/api\/landmarks\/([a-z0-9-]{1,80})$/);
    if (one) return cached(request, ctx, () => getLandmark(one[1], env, ctx));

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
