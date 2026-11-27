// The site's only server-side code: a search API.
//
//   GET /api/search?q=<text>&region=<Region>&category=<category>&limit=<n>
//
// Everything else on iconic.place is static files served straight from Cloudflare's edge
// (see "run_worker_first" in wrangler.jsonc), so this Worker runs only for /api/ requests.
//
// Search runs in PlanetScale Postgres using TIN, PlanetScale's full-text index, reached
// through Cloudflare Hyperdrive (which pools connections and caches repeated reads). The
// database holds one small row per landmark (scripts/db-sync.mjs keeps it in step with
// public/data/landmarks.json); this API answers with matching landmark ids, best first,
// and the app, which already has every landmark's details, does the rest.

import postgres from 'postgres';

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

const json = (body: unknown, status = 200, cache = 'no-store'): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

async function search(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ws = words(url.searchParams.get('q') ?? '');
  const region = url.searchParams.get('region')?.slice(0, 40) || null;
  const category = url.searchParams.get('category')?.slice(0, 40) || null;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));

  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
  try {
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

    // Results change only when the dataset is re-synced, so let browsers and the edge reuse them briefly.
    return json({ ids, total, mode }, 200, 'public, max-age=300');
  } catch (err) {
    console.error('search failed', err);
    return json({ error: 'Search is unavailable right now.' }, 503);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/search' && request.method === 'GET') return search(url, env, ctx);
    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
