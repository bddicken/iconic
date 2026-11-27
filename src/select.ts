import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Landmark } from './types';

export interface SelectOptions {
  /** Hard cap on markers drawn at once. */
  max: number;
  /** Minimum horizontal / vertical gap between two marker centres, in CSS pixels. */
  gapX: number;
  gapY: number;
  /** Viewport insets (px) a marker centre must stay within to be drawn. */
  inset: { top: number; right: number; bottom: number; left: number };
  /** A landmark that is always drawn when in view (the one whose card is open). */
  pinned?: Landmark | null;
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

/**
 * Chooses which landmarks to draw for the current camera.
 *
 * `landmarks` must be sorted most-popular-first. Walking it in that order and greedily
 * keeping anything that is in view and not crowding an already-kept marker means:
 *   - zoomed out, the globe shows the world's top landmarks, spread apart;
 *   - zooming in pushes the famous ones apart or out of view, which frees slots and
 *     screen space for the lesser-known landmarks of that area.
 *
 * Returns at most `opts.max` landmarks, most popular first.
 *
 * It is a linear scan that stops as soon as the cap is reached, with a cheap rejection
 * before any projection maths, which is comfortably fast for a few thousand landmarks
 * per frame. Beyond that, put the list in a spatial index (e.g. rbush/kdbush on lng/lat)
 * and scan only the camera's bounding cap.
 */
export function selectLandmarks(map: MapLibreMap, landmarks: Landmark[], opts: SelectOptions): Landmark[] {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const center = map.getCenter();
  const { inset } = opts;

  const shown: Landmark[] = [];
  const points: { x: number; y: number }[] = [];

  const consider = (lm: Landmark, force: boolean): void => {
    // 1. Far hemisphere: can never be visible (the camera has no pitch).
    if (cosAngle(center.lng, center.lat, lm.lng, lm.lat) <= 0) return;

    // 2. Outside the viewport.
    const p = map.project([lm.lng, lm.lat]);
    if (p.x < inset.left || p.x > width - inset.right || p.y < inset.top || p.y > height - inset.bottom) return;

    // 3. Near hemisphere but past the horizon.
    const back = map.unproject(p);
    if (cosAngle(back.lng, back.lat, lm.lng, lm.lat) < OCCLUSION_COS) return;

    if (!force) {
      for (const q of points) {
        if (Math.abs(q.x - p.x) < opts.gapX && Math.abs(q.y - p.y) < opts.gapY) return;
      }
    }
    shown.push(lm);
    points.push(p);
  };

  if (opts.pinned) consider(opts.pinned, true);
  for (const lm of landmarks) {
    if (shown.length >= opts.max) break;
    if (lm !== opts.pinned) consider(lm, false);
  }

  return shown.sort((a, b) => a.rank - b.rank);
}
