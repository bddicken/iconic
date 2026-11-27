# Iconic

A globe of the world's most iconic places. Spin it, zoom in, and the landmarks of that
part of the world reveal themselves. At most 15 are shown at once, most popular first.

```bash
npm install
npm run dev
```

## How it fits together

| Path | What it is |
| --- | --- |
| `data/landmarks.seed.json` | The curated list. One entry per landmark: id, name, Wikipedia article, country, region, category. **This is the file you edit.** |
| `scripts/build-data.mjs` | Turns the seed into everything the app needs (coordinates, popularity, photo, photo credit). |
| `public/data/landmarks.json` | Generated. The structured dataset the app loads, sorted by rank. |
| `public/images/full/`, `public/images/thumb/` | Generated. One 1600px photo and one 256px marker thumbnail per landmark. |
| `src/select.ts` | Decides which landmarks are drawn for the current camera (the "max 15" rule). |
| `src/main.ts` | The globe, markers and detail card. |
| `src/basemap.ts` | The illustrated map style. |
| `scripts/build-landcover.mjs` | Renders the land-colour tiles in `public/tiles/landcover/`. |

## Adding landmarks

1. Add entries to `data/landmarks.seed.json`:

   ```json
   { "id": "blue-mosque", "name": "Blue Mosque", "wiki": "Blue Mosque, Istanbul",
     "country": "Turkey", "region": "Europe", "category": "religious" }
   ```

2. Run `npm run data`. It is incremental: only new or changed entries are fetched.
3. Run `npm run data:sheet` and look through `data/sheets/` to check the photos and their
   round marker crops.

Optional seed fields:

- `lat`, `lng`: override the coordinates (required when the article has none).
- `image`: use a specific Wikimedia Commons file instead of the article's lead image,
  e.g. `"image": "Tour Eiffel Wikimedia Commons.jpg"`.
- `thumbPosition`: how the square marker thumbnail is cropped (`"top"`, `"bottom"`,
  `"left"`, `"right"`, `"centre"`); default is automatic.
- `boost`: editorial nudge added to the popularity score.

`npm run data -- --only=id1,id2` re-fetches specific entries, `-- --refresh` re-fetches all.

Wikimedia rate-limits anonymous scripts, so a first full run takes several minutes (it
waits out the limits by itself). Setting `WIKIMEDIA_CONTACT` to a URL or email identifies
the script the way Wikimedia asks and is worth doing before building thousands of entries.

## Popularity and rank

`popularity` is a 0-100 score: 55% English Wikipedia pageviews over the last 12 months
(log scale) and 45% the number of Wikipedia language editions that have an article, plus
any `boost`. Both use fixed scales, so scores stay comparable as the list grows.
`rank` is the position after sorting by that score.

## Image credits

Every image comes from Wikimedia Commons. For each one, `landmarks.json` records under
`image.credit` the author, license and license URL, the Commons page (`sourcePage`), the
original file URL and the exact URL the bytes were downloaded from. The app shows the
credit on a landmark's card when you open it.

## The globe's look

The basemap is an illustrated map, not satellite photography: real coastlines, terrain
and land cover, drawn in a bright palette. It is defined in `src/basemap.ts` (colours
are in the `palette` object at the top) and stacks three things:

- **Land colour**: `public/tiles/landcover/`, pre-rendered by `npm run landcover` from
  Natural Earth II land cover (public domain). The script floods land colour out over
  the oceans, saturates and posterises it, and cuts Web Mercator tiles. The `STYLE`
  block at the top of `scripts/build-landcover.mjs` controls how bold it looks;
  `-- --preview` writes a quick world preview instead of tiles. It needs
  `data/naturalearth/NE2_LR_LC.tif` (from
  `https://naciscdn.org/naturalearth/10m/raster/NE2_LR_LC.zip`, not committed). If the
  tiles are missing the app falls back to colouring land by elevation.
- **Terrain shading**: hillshade from [Mapterhorn](https://mapterhorn.com) elevation tiles.
- **Water, rivers, borders, roads, names**: [OpenFreeMap](https://openfreemap.org)
  vector tiles (OpenStreetMap data), which also supply detailed land cover from zoom 7.

None of these needs an API key.
