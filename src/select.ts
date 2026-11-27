import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Landmark } from './types';

/** Where to draw one landmark: `dx`/`dy` is how far its photo sits from its true spot, in px. */
export interface Placement {
  lm: Landmark;
  dx: number;
  dy: number;
  /**
   * Set when the marker is bunched up against a more popular neighbour: the vector from
   * this landmark's true position to that neighbour's photo, for drawing a faint line
   * that ties the two together.
   */
  link: { x: number; y: number } | null;
}

/** On-screen footprint of a marker: a round photo with a name pill underneath. */
export interface Footprint {
  /** photo diameter */
  size: number;
  labelWidth: number;
  labelHeight: number;
}

export interface LayoutOptions {
  /** Hard cap on markers drawn at once. */
  max: number;
  /** Viewport insets (px) a landmark's true position must be within to be drawn. */
  inset: { top: number; right: number; bottom: number; left: number };
  /** A landmark that is always drawn, on its true spot, when in view (the one whose card is open). */
  pinned?: Landmark | null;
  footprint(lm: Landmark): Footprint;
  /** The furthest a crowded marker may be moved off its true position. */
  maxOffset: number;
  /** Last frame's offsets, by landmark id. Keeps nudged markers from hopping about. */
  previous: ReadonlyMap<string, { dx: number; dy: number }>;
}

const RAD = Math.PI / 180;

/** Cosine of the great-circle angle between two lng/lat points. */
function cosAngle(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const a = lat1 * RAD;
  const b = lat2 * RAD;
  return Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lng2 - lng1) * RAD);
}

// A point on the far side of the globe still projects to a pixel. Unprojecting that pixel
// gives the near-side location drawn there, so a large mismatch means "behind the planet".
const OCCLUSION_COS = Math.cos(2 * RAD);

// Landmarks more than ~63° of arc from the centre of the view sit on the squashed rim of
// the globe: leave them out rather than pile markers up along the horizon.
const RIM_COS = 0.45;

/** Breathing room between markers that each sit on their own spot. */
const GAP = 2;
/** Markers in a huddle are allowed to nestle into each other by this much, so they read as one group. */
const HUDDLE_OVERLAP = 5;
/** How finely the area around a crowded landmark is searched for a free spot. */
const RING_STEP = 9;
const DIRECTIONS = 12;

type Box = [left: number, top: number, right: number, bottom: number];

interface Placed {
  x: number;
  y: number;
  photo: Box;
  label: Box;
}

const overlaps = (a: Box, b: Box): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Chooses which landmarks to draw for the current camera, and where.
 *
 * `landmarks` must be sorted most-popular-first. They are placed in that order:
 *
 *   1. on its true position, if nothing more popular is already in the way;
 *   2. otherwise nudged to the nearest free spot within `maxOffset`, pushed away from
 *      whatever is crowding it, so the two sit snugly side by side as a huddle (`link`
 *      lets the caller draw a faint line tying it to that neighbour);
 *   3. otherwise left out until the view is zoomed in further.
 *
 * So a dense area fills up with a small huddle of its best-known places rather than
 * showing only one or two of them, and as zooming in spreads the true positions apart
 * each nudged marker creeps back until it sits exactly on its landmark.
 *
 * Returns at most `opts.max` placements, most popular first. It is a linear scan that
 * stops once the cap is reached, which is comfortably fast for a few thousand landmarks
 * per frame. Beyond that, put the list in a spatial index (e.g. rbush/kdbush on lng/lat)
 * and scan only the camera's bounding cap.
 */
export function layoutLandmarks(map: MapLibreMap, landmarks: Landmark[], opts: LayoutOptions): Placement[] {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const center = map.getCenter();
  const { inset } = opts;

  const result: Placement[] = [];
  const placed: Placed[] = [];

  const boxesAt = (x: number, y: number, f: Footprint, gap = GAP): { photo: Box; label: Box } => {
    const r = f.size / 2 + gap;
    const labelTop = y + f.size / 2 + 3;
    return {
      photo: [x - r, y - r, x + r, y + r],
      label: [x - f.labelWidth / 2 - gap, labelTop, x + f.labelWidth / 2 + gap, labelTop + f.labelHeight + gap],
    };
  };
  const isFree = (b: { photo: Box; label: Box }): boolean => {
    for (const q of placed) {
      if (overlaps(b.photo, q.photo) || overlaps(b.photo, q.label) || overlaps(b.label, q.photo) || overlaps(b.label, q.label)) {
        return false;
      }
    }
    return true;
  };
  // A nudged marker must be wholly on screen; one on its true spot may hang off the edge.
  const onScreen = (b: { photo: Box; label: Box }): boolean =>
    b.photo[0] >= 4 && b.label[0] >= 4 && b.photo[2] <= width - 4 && b.label[2] <= width - 4 && b.photo[1] >= inset.top - 12 && b.label[3] <= height - 4;

  const consider = (lm: Landmark, force: boolean): void => {
    // Far hemisphere, or so close to the globe's edge that it is seen almost side-on.
    if (cosAngle(center.lng, center.lat, lm.lng, lm.lat) <= RIM_COS) return;
    // Outside the viewport.
    const p = map.project([lm.lng, lm.lat]);
    if (p.x < inset.left || p.x > width - inset.right || p.y < inset.top || p.y > height - inset.bottom) return;
    // Near hemisphere but past the horizon.
    const back = map.unproject(p);
    if (cosAngle(back.lng, back.lat, lm.lng, lm.lat) < OCCLUSION_COS) return;

    const f = opts.footprint(lm);
    const touches = (b: { photo: Box; label: Box }, q: Placed): boolean =>
      overlaps(b.photo, q.photo) || overlaps(b.photo, q.label) || overlaps(b.label, q.photo) || overlaps(b.label, q.label);
    const accept = (dx: number, dy: number, crowd: Placed[] = []): void => {
      const x = p.x + dx;
      const y = p.y + dy;
      // tie it to whichever of the markers that crowded it out ended up nearest
      let partner: Placed | null = null;
      for (const q of crowd) {
        if (!partner || Math.hypot(q.x - x, q.y - y) < Math.hypot(partner.x - x, partner.y - y)) partner = q;
      }
      // (record the full-size footprint, whatever leeway was used to squeeze it in)
      placed.push({ x, y, ...boxesAt(x, y, f) });
      result.push({ lm, dx, dy, link: partner ? { x: partner.x - p.x, y: partner.y - p.y } : null });
    };

    // 1. Its true position.
    const home = boxesAt(p.x, p.y, f);
    if (force) return accept(0, 0);
    const crowd = placed.filter((q) => touches(home, q));
    if (!crowd.length) return accept(0, 0);

    const before = opts.previous.get(lm.id);
    // markers already on screen may stray a little further, so they don't flicker in and out
    const reach = opts.maxOffset * (before ? 1.2 : 1);

    // 2a. Already nudged last frame: stay on that line, as close to home as now fits.
    if (before && (before.dx || before.dy)) {
      const stretch = Math.min(1, reach / Math.hypot(before.dx, before.dy));
      for (let t = 0.125; t <= 1; t += 0.125) {
        const dx = before.dx * t * stretch;
        const dy = before.dy * t * stretch;
        const b = boxesAt(p.x + dx, p.y + dy, f, -HUDDLE_OVERLAP);
        if (isFree(b) && onScreen(b)) return accept(dx, dy, crowd);
      }
    }

    // 2b. The nearest free spot, trying first the direction that leads away from the crowd.
    let pushX = 0;
    let pushY = 0;
    for (const q of crowd) {
      pushX += p.x - q.x;
      pushY += p.y - q.y;
    }
    const away = pushX || pushY ? Math.atan2(pushY, pushX) : 0;
    for (let radius = RING_STEP; radius <= reach; radius += RING_STEP) {
      for (let k = 0; k < DIRECTIONS; k++) {
        // 0, +30°, -30°, +60°, -60°, ... fanning out from the "away" direction
        const turn = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * ((2 * Math.PI) / DIRECTIONS);
        const dx = Math.cos(away + turn) * radius;
        const dy = Math.sin(away + turn) * radius;
        const b = boxesAt(p.x + dx, p.y + dy, f, -HUDDLE_OVERLAP);
        if (isFree(b) && onScreen(b)) return accept(dx, dy, crowd);
      }
    }
    // 3. No room: wait for a closer zoom.
  };

  if (opts.pinned) consider(opts.pinned, true);
  for (const lm of landmarks) {
    if (result.length >= opts.max) break;
    if (lm !== opts.pinned) consider(lm, false);
  }

  return result.sort((a, b) => a.lm.rank - b.lm.rank);
}
