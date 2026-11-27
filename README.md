# Iconic

A globe of the world's most iconic places. Spin it, zoom in, and the landmarks of that
part of the world reveal themselves. At most 12 are shown at once, most popular first.

```bash
npm install
npm run dev
```

## Deploying

The site is served from Cloudflare at <https://iconic.place>: static files (the app, the
photos, the map tiles) plus a small Worker that answers `/api/` from the database.

```bash
npm run deploy
```

That builds `dist/`, uploads the site and the Worker with Wrangler (config in
`wrangler.jsonc`, cache rules in `public/_headers`), and then loads the landmark data
into the database. The order matters: a new landmark only appears on the site once its
photos are live. It needs a Cloudflare login (`npx wrangler login`) and a PlanetScale
login (`pscale auth login`) on the machine; no keys or tokens live in this repo.
`npm run og` redraws the share image, `public/og.jpg`.

## The database

The landmarks live in PlanetScale Postgres (`bddicken/iconic`, branch `main`), and that
database is the source of truth for the running site: the app has no copy of the data of
its own and asks the API for everything.

| Request | Answer |
| --- | --- |
| `GET /api/landmarks` | Every landmark in brief (rank, id, name, country, region, category, coordinates, thumbnail), most popular first. Loaded once when the app starts. |
| `GET /api/landmarks/<id>` | One landmark in full (summary, popularity, photos and their credits). Loaded when its card is opened. |
| `GET /api/search` | Ids of the landmarks matching `q` (text), `region` and `category`, best first, up to `limit`. |

- **Tables:** `landmarks` has one row per landmark, with the photos and their credits as
  JSON columns; `dataset` records when the loaded data was generated and loaded.
- **Loading it:** `npm run db:sync` loads `public/data/landmarks.json`, the output of the
  data pipeline (see [Adding landmarks](#adding-landmarks)), through the PlanetScale CLI.
  It adds, updates and removes rows to match, in one transaction, and is safe to re-run.
  `npm run deploy` runs it for you. That JSON file is only the hand-off from the pipeline
  to the database: it is not uploaded to the site (`public/.assetsignore`).
- **Connection:** the Worker (`worker/index.ts`) reaches the database through Cloudflare
  Hyperdrive (the `HYPERDRIVE` binding in `wrangler.jsonc`), using a read-only database
  role. The credentials live in Cloudflare, not in this repo.
- **Caching:** landmark answers are kept in Cloudflare's cache for five minutes, so most
  visits never touch the database, and a week-old spare copy is served if the database
  cannot be reached. A change to the data therefore takes up to five minutes to show.
- **Search:** text search uses [TIN](https://planetscale.com/docs/postgres/search),
  PlanetScale's full-text index, on the name and on a combined description column, with
  English stemming. The Worker builds a TINQL query from the typed words: the last word
  also matches as a prefix (for search-as-you-type), a name match counts four times a
  description match, and popular places get a small lift. If nothing matches it retries
  allowing typos, then on any one word. Region and category are ordinary indexed columns.
- **In development:** `npm run dev` forwards `/api/` to the live site, so you see what
  visitors see without running a database. `npm run dev:local` reads the landmarks from
  `public/data/landmarks.json` instead, to preview ones you have built but not deployed
  (search still asks the live site, so it will not find them yet). To try a Worker
  version that is uploaded but not live, put `ICONIC_API_VERSION=<version id>` in
  `.env.local`.

## How it fits together

| Path | What it is |
| --- | --- |
| `data/landmarks.seed.json` | The curated list. One entry per landmark: id, name, Wikipedia article, country, region, category. **This is the file you edit.** |
| `scripts/build-data.mjs` | Turns the seed into everything the app needs (coordinates, popularity, photos, photo credits). |
| `public/data/landmarks.json` | Generated. The structured dataset, sorted by rank, that `npm run db:sync` loads into the database. Not deployed. |
| `public/images/full/`, `public/images/thumb/` | Generated. One 1600px photo and one 256px marker thumbnail per landmark. |
| `public/images/gallery/` | Generated. Up to three more 900px photos per landmark, shown in the card's gallery. |
| `src/select.ts` | Decides which landmarks are drawn for the current camera and where: at most 12 (`MAX_VISIBLE` in `src/main.ts`), most popular first, with crowded ones huddled close beside each other (tied together by a faint line) instead of hidden, then drifting onto their true spots as you zoom in. `MAX_NUDGE` in `src/main.ts` sets how far. |
| `src/main.ts` | The globe, markers and detail card. |
| `src/data.ts` | Fetches the landmarks from the API: the brief list at the start, full details per card. |
| `src/basemap.ts` | The illustrated map style. |
| `src/search.ts` | The search box, results list and filter chips. |
| `worker/index.ts` | The API (a Cloudflare Worker): the landmark list, one landmark in full, and search. |
| `scripts/db-sync.mjs` | Loads the landmark data into the database. |
| `scripts/build-landcover.mjs` | Renders the land-colour tiles in `public/tiles/landcover/`. |
| `scripts/build-ocean.mjs` | Renders the sea-floor tiles in `public/tiles/ocean/`. |
| `src/countries.json` | Generated by `npm run countries`. Label point and land area of each country; a country is named once it covers about 1% of the screen (`COUNTRY_LABEL_SCREEN_SHARE` in `src/main.ts`). |

## Adding landmarks

1. Add entries to `data/landmarks.seed.json`:

   ```json
   { "id": "blue-mosque", "name": "Blue Mosque", "wiki": "Blue Mosque, Istanbul",
     "country": "Turkey", "region": "Europe", "category": "religious" }
   ```

2. Run `npm run data`. It is incremental: only new or changed entries are fetched.
3. Run `npm run data:sheet` and look through `data/sheets/` to check the photos and their
   round marker crops. `npm run data:sheet -- --gallery` shows each landmark's main photo
   beside its gallery photos instead. `npm run dev:local` shows them on the globe.
4. Run `npm run deploy` to publish: it uploads the photos, then loads the new entries
   into the database, which is where the site reads them from.

Optional seed fields:

- `lat`, `lng`: override the coordinates (required when the article has none).
- `image`: use a specific Wikimedia Commons file instead of the article's lead image,
  e.g. `"image": "Tour Eiffel Wikimedia Commons.jpg"`.
- `thumbPosition`: how the square marker thumbnail is cropped (`"top"`, `"bottom"`,
  `"left"`, `"right"`, `"centre"`); default is automatic.
- `boost`: editorial nudge added to the popularity score.
- `gallery`: use exactly these Commons files as the extra photos, e.g.
  `"gallery": ["First.jpg", "Second.jpg"]`.
- `galleryExclude`: Commons files never to use as extra photos; the next best candidate
  takes their place.
- `gallerySearch`: words to search Commons for instead of the article title.

`npm run data -- --only=id1,id2` re-fetches specific entries, `-- --refresh` re-fetches all,
and `-- --no-gallery` skips the gallery step (galleries already built are kept).

Wikimedia rate-limits anonymous scripts, so a first full run takes several minutes (it
waits out the limits by itself). Setting `WIKIMEDIA_CONTACT` to a URL or email identifies
the script the way Wikimedia asks and is worth doing before building thousands of entries.

## Photo galleries

Opening a landmark shows its main photo first, then up to three more. The build picks them
automatically, best first:

1. the photos used in the landmark's Wikipedia article, in article order, those named after
   the landmark leading;
2. if the article has too few, Commons files tagged as depicting the landmark, then a plain
   Commons search for its name.

A candidate is skipped if it is not a large, freely licensed JPEG, if its name suggests a
map, drawing, old photograph or museum piece, if it turns out to be black and white or a
scan on paper, or if it is a near-duplicate of a photo already chosen. Landmarks with fewer
good candidates simply get fewer photos. When a pick is wrong, add the file to
`galleryExclude` (or list the right ones in `gallery`) and run `npm run data` again; the
search results are cached, so this needs no new requests.

## Popularity and rank

`popularity` is a 0-100 score: 55% English Wikipedia pageviews over the last 12 months
(log scale) and 45% the number of Wikipedia language editions that have an article, plus
any `boost`. Both use fixed scales, so scores stay comparable as the list grows.
`rank` is the position after sorting by that score.

## Image credits

Every image comes from Wikimedia Commons. For each one, the dataset records under
`image.credit` (and `gallery[].credit` for gallery photos) the author, license and license
URL, the Commons page (`sourcePage`), the original file URL and the exact URL the bytes
were downloaded from. The app shows the credit of whichever photo is on screen.

## The globe's look

The basemap is an illustrated map, not satellite photography: real coastlines, terrain
land cover and sea floor, drawn in a bright palette. It is defined in `src/basemap.ts`
(colours are in the `palette` object at the top) and stacks these:

- **Land colour**: `public/tiles/landcover/`, pre-rendered by `npm run landcover` from
  Natural Earth II land cover (public domain). The script floods land colour out over
  the oceans, saturates and posterises it, and cuts Web Mercator tiles. The `STYLE`
  block at the top of `scripts/build-landcover.mjs` controls how bold it looks;
  `-- --preview` writes a quick world preview instead of tiles. It needs
  `data/naturalearth/NE2_LR_LC.tif` (from
  `https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC.zip`, not committed). If the
  tiles are missing the app falls back to colouring land by elevation.
- **Terrain shading**: hillshade from [Mapterhorn](https://mapterhorn.com) elevation tiles,
  with the highest ground paling to snow.
- **Ocean depth**: `public/tiles/ocean/`, pre-rendered by `npm run ocean`. The sea darkens
  in bands from the continental shelves down to the trenches. The tiles record where each
  band begins rather than its colour, so the band edges stay sharp at any zoom and the
  colours stay in the `palette` (`deep`); the depths at which bands begin are `BAND_EDGES`
  in the script. The script downloads its input once, about 65 MB of
  [Terrarium](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
  elevation tiles, into `data/cache/`, and also writes `src/seam.json`, the same data
  along the 180° meridian, used to hide a seam there. Without the tiles the sea is one
  plain colour.
- **Water, rivers, borders, roads, names**: [OpenFreeMap](https://openfreemap.org)
  vector tiles (OpenStreetMap data), which also supply detailed land cover from zoom 7.

None of these needs an API key.

On top of the map, a soft highlight, shadow and rim of glow (`.globe-shade` in
`src/style.css`, placed by `updateShade` in `src/main.ts`) make the globe read as a ball.
They fade out as you zoom in.
