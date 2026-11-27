import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * The globe's look: an illustrated map rather than satellite photography.
 *
 * It is still geographically honest (real coastlines, rivers, borders, land cover and
 * terrain) but drawn with a bright storybook palette, chunky relief shading and a
 * sticker-like white coastline.
 *
 *   land colour   LAND_COVER_TILES when present (true biome colours at globe zoom),
 *                 otherwise an elevation tint; OpenStreetMap land cover from zoom 7
 *   terrain       hillshade from Mapterhorn elevation tiles
 *   water, rivers, borders, roads, names   OpenFreeMap vector tiles (OpenStreetMap)
 *
 * None of the sources needs an API key.
 */

export const palette = {
  space: '#0a0b1e',
  ocean: '#45b9ea',
  shallows: '#8fe3f7',
  coast: '#ffffff',
  land: '#bfe58d',
  forest: '#56bd6c',
  grass: '#a5dd78',
  farmland: '#dceb8e',
  wetland: '#7fd8b5',
  sand: '#f8de8a',
  rock: '#cdb89b',
  ice: '#ffffff',
  shadow: '#5a4a9c',
  highlight: '#fff8dc',
  border: '#ffffff',
  road: '#fff6e0',
  ink: '#27304f',
  waterInk: '#0f5f8f',
} as const;

/**
 * Optional pre-rendered land-cover tiles (see scripts/build-landcover.mjs). When the
 * folder exists they give deserts, forests, tundra and ice their real colours at globe
 * zoom, where the vector tiles carry no land cover at all.
 */
export interface LandCoverTiles {
  /** URL template with {z}/{x}/{y}. */
  tiles: string;
  maxzoom: number;
  attribution: string;
}

const FONT = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']] as never;

export function buildStyle(landCover: LandCoverTiles | null): StyleSpecification {
  const layers: LayerSpecification[] = [{ id: 'land', type: 'background', paint: { 'background-color': palette.land } }];

  if (landCover) {
    layers.push({
      id: 'land-cover',
      type: 'raster',
      source: 'landcover',
      paint: {
        'raster-resampling': 'linear',
        'raster-fade-duration': 200,
        'raster-saturation': 0.12,
        // hand over to the sharper OpenStreetMap land cover once it exists
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1, 10, 0.75],
      },
    });
  } else {
    // No land-cover tiles: fall back to a classic physical-map tint by height.
    layers.push({
      id: 'elevation-tint',
      type: 'color-relief',
      source: 'elevation-tint',
      paint: {
        'color-relief-color': [
          'interpolate',
          ['linear'],
          ['elevation'],
          0,
          '#a9df7c',
          250,
          '#c4e88e',
          700,
          '#e6ea96',
          1400,
          '#f4d98a',
          2400,
          '#e0b98a',
          3600,
          '#cdb89b',
          4800,
          '#f3efe6',
          6000,
          '#ffffff',
        ],
      },
    });
  }

  const landcoverFill = (id: string, classes: string[], color: string, opacity: number): LayerSpecification => ({
    id,
    type: 'fill',
    source: 'osm',
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', classes]],
    paint: {
      'fill-color': color,
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6.5, 0, 8, opacity],
      'fill-antialias': false,
    },
  });

  layers.push(
    landcoverFill('lc-farmland', ['farmland'], palette.farmland, 0.55),
    landcoverFill('lc-grass', ['grass'], palette.grass, 0.6),
    landcoverFill('lc-wetland', ['wetland'], palette.wetland, 0.6),
    landcoverFill('lc-wood', ['wood'], palette.forest, 0.62),
    landcoverFill('lc-sand', ['sand'], palette.sand, 0.75),
    landcoverFill('lc-rock', ['rock'], palette.rock, 0.6),
    {
      id: 'lc-ice',
      type: 'fill',
      source: 'osm',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'ice'],
      paint: { 'fill-color': palette.ice, 'fill-opacity': 0.9, 'fill-antialias': false },
    },
    {
      id: 'towns',
      type: 'fill',
      source: 'osm',
      'source-layer': 'landuse',
      minzoom: 8,
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial']]],
      paint: { 'fill-color': '#f3e6d3', 'fill-opacity': 0.55 },
    },
    {
      id: 'relief',
      type: 'hillshade',
      source: 'elevation',
      paint: {
        'hillshade-method': 'standard',
        'hillshade-illumination-direction': 315,
        // strong, chunky relief on the globe; gentler up close so mountain regions stay bright
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 1, 0.7, 5, 0.55, 8, 0.3, 12, 0.22],
        'hillshade-shadow-color': palette.shadow,
        'hillshade-highlight-color': palette.highlight,
        'hillshade-accent-color': '#7b62b8',
      },
    },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': palette.ocean } },
    // A soft band of pale shallows hugging every shore, then a crisp white "sticker" edge.
    {
      id: 'shallows',
      type: 'line',
      source: 'osm',
      'source-layer': 'water',
      filter: ['==', ['get', 'class'], 'ocean'],
      paint: {
        'line-color': palette.shallows,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 9, 11, 16],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 8, 11, 14],
        'line-opacity': 0.75,
      },
    },
    {
      id: 'coast',
      type: 'line',
      source: 'osm',
      'source-layer': 'water',
      filter: ['in', ['get', 'class'], ['literal', ['ocean', 'lake']]],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': palette.coast,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.7, 6, 1.4, 11, 2],
        'line-opacity': 0.9,
      },
    },
    {
      id: 'rivers',
      type: 'line',
      source: 'osm',
      'source-layer': 'waterway',
      filter: ['==', ['get', 'class'], 'river'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.ocean,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.8, 12, 4],
      },
    },
    {
      id: 'roads',
      type: 'line',
      source: 'osm',
      'source-layer': 'transportation',
      minzoom: 7,
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.road,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 10, 0.8],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 2.6],
      },
    },
    {
      id: 'borders',
      type: 'line',
      source: 'osm',
      'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.border,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 6, 0.85],
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.7, 8, 2.2],
        'line-dasharray': [1, 2.2],
      },
    },
    {
      id: 'sea-names',
      type: 'symbol',
      source: 'osm',
      'source-layer': 'water_name',
      filter: ['in', ['get', 'class'], ['literal', ['ocean', 'sea']]],
      layout: {
        'text-field': NAME,
        'text-font': FONT_ITALIC,
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 6, 16],
        'text-letter-spacing': 0.18,
        'text-max-width': 6,
      },
      paint: {
        'text-color': palette.waterInk,
        'text-halo-color': 'rgba(255,255,255,0.45)',
        'text-halo-width': 1,
      },
    },
    {
      id: 'country-names',
      type: 'symbol',
      source: 'osm',
      'source-layer': 'place',
      minzoom: 2.2,
      maxzoom: 7.5,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': NAME,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 16],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 7,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: {
        'text-color': palette.ink,
        'text-halo-color': 'rgba(255,255,255,0.85)',
        'text-halo-width': 1.6,
      },
    },
    {
      id: 'city-names',
      type: 'symbol',
      source: 'osm',
      'source-layer': 'place',
      minzoom: 4.5,
      filter: [
        'any',
        ['all', ['==', ['get', 'class'], 'city'], ['<=', ['coalesce', ['get', 'rank'], 99], 7]],
        ['all', ['>=', ['zoom'], 8], ['in', ['get', 'class'], ['literal', ['city', 'town']]]],
      ],
      layout: {
        'text-field': NAME,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10.5, 10, 14.5],
        'text-max-width': 8,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: {
        'text-color': palette.ink,
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.5,
      },
    },
  );

  const elevation = {
    type: 'raster-dem' as const,
    // Global coverage stops at zoom 12, and tiles that are entirely open ocean do not
    // exist (they 404, harmlessly: the water layer covers them).
    tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
    tileSize: 512,
    encoding: 'terrarium' as const,
    maxzoom: 12,
    attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>',
  };

  return {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      },
      elevation,
      ...(landCover
        ? {
            landcover: {
              type: 'raster' as const,
              tiles: [landCover.tiles],
              tileSize: 256,
              maxzoom: landCover.maxzoom,
              attribution: landCover.attribution,
            },
          }
        : // A second handle on the same elevation tiles: MapLibre wants a source per terrain-style layer.
          { 'elevation-tint': elevation }),
    },
    sky: {
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4.5, 0.9, 7, 0],
    },
    layers,
  };
}
