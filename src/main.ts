import {
  AttributionControl,
  Map as GlobeMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import '@fontsource/caprasimo/latin-400.css';
import '@fontsource/caprasimo/latin-ext-400.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-600.css';
import '@fontsource/rubik/latin-ext-500.css';
import './style.css';
import { buildStyle, COUNTRY_LABELS, countryAreas, countryLabelFilter, type LandCoverTiles } from './basemap';
import { layoutLandmarks, type Footprint } from './select';
import type { Landmark, LandmarkData } from './types';

/** The most landmarks ever drawn at once, whatever the position or zoom. */
const MAX_VISIBLE = 12;
/**
 * When landmarks crowd together, the less popular ones huddle beside the most popular one
 * instead of being hidden, and drift onto their true spots as zooming in makes room. This
 * is the furthest, in pixels, a marker may sit from its landmark; raise it to fit more
 * into dense areas, lower it for a tidier map.
 */
const MAX_NUDGE = 130;
/** ...but less when the whole globe is in view, where that many pixels is half a continent. */
const MAX_NUDGE_ZOOMED_OUT = 95;
/** Zoom the camera flies to when a landmark is opened (kept if already closer). */
const FOCUS_ZOOM = 5.6;
/**
 * A country is named once it covers at least this share of the screen, so zooming in
 * brings up the big countries first and the small ones later. The pixel floor keeps the
 * rule sensible on small screens, where 1% is too little room for a label.
 */
const COUNTRY_LABEL_SCREEN_SHARE = 0.01;
const COUNTRY_LABEL_MIN_PIXELS = 7000;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
/** Idle spin before the first interaction, in degrees of longitude per second. */
const SPIN_SPEED = 3.5;

const BASE = import.meta.env.BASE_URL;
const asset = (p: string): string => BASE + p;

setWorkerUrl(workerUrl);

// ---------- tiny DOM helper (all text goes through textContent, never innerHTML) ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) el.className = className;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

function extLink(href: string, text: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Zoom at which the whole globe fills ~`fill` of the smaller viewport side. */
function globeFitZoom(fill: number): number {
  // (a hidden or collapsed window reports 0, which would give a zoom of -Infinity)
  const side = Math.max(240, Math.min(window.innerWidth, window.innerHeight));
  return Math.log2((fill * side * Math.PI) / 512);
}

// ---------- app ----------

async function start(): Promise<void> {
  const res = await fetch(asset('data/landmarks.json'));
  if (!res.ok) throw new Error(`Could not load landmark data (${res.status})`);
  const data: LandmarkData = await res.json();
  // Most popular first: the selection algorithm relies on this order.
  const landmarks = [...data.landmarks].sort((a, b) => a.rank - b.rank);
  const byId = new Map(landmarks.map((l) => [l.id, l]));

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNarrow = (): boolean => window.innerWidth <= 700;

  // Pre-rendered land-cover tiles are optional (npm run landcover); without them the
  // style falls back to an elevation tint.
  const landCover: LandCoverTiles | null = await fetch(asset('tiles/landcover/tiles.json'))
    .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
    // (join as strings: new URL() would percent-encode the {z}/{x}/{y} placeholders)
    .then((meta) => (meta ? { ...meta, tiles: new URL(BASE, location.href).href + meta.tiles } : null))
    .catch(() => null);

  const map = new GlobeMap({
    container: 'map',
    style: buildStyle(landCover),
    center: [12, 26],
    zoom: globeFitZoom(0.82),
    minZoom: globeFitZoom(0.5),
    maxZoom: 15,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  // Collapse the map credits behind the (i) button once they have filled in, to keep the
  // globe uncluttered. (MapLibre re-opens them as each source reports in.)
  map.once('idle', () => {
    const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    attrib?.classList.remove('maplibregl-compact-show');
    attrib?.removeAttribute('open');
  });
  if (import.meta.env.DEV) Object.assign(window, { __map: map });
  map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

  // ----- markers -----

  interface Pin {
    marker: Marker;
    el: HTMLButtonElement;
    inner: HTMLElement;
    /** A faint line from this marker to the neighbour it is bunched against (hidden when it stands alone). */
    link: HTMLElement;
    linkTo: { x: number; y: number } | null;
    leaving: number | null;
    /** Where the photo is drawn relative to the landmark's true position, and where it is heading. */
    x: number;
    y: number;
    targetX: number;
    targetY: number;
  }
  const pins = new Map<string, Pin>();
  let selected: Landmark | null = null;

  const tierOf = (lm: Landmark): 1 | 2 | 3 => (lm.rank <= 10 ? 1 : lm.rank <= 35 ? 2 : 3);

  /** Rough on-screen size of a marker (kept in step with .pin / .pin-label in style.css). */
  function footprint(lm: Landmark): Footprint {
    const narrow = isNarrow();
    const size = (narrow ? [60, 52, 46] : [74, 62, 54])[tierOf(lm) - 1];
    const charWidth = narrow ? 5.9 : 6.4;
    const maxWidth = narrow ? 100 : 132;
    const oneLine = lm.name.length * charWidth + 20;
    return oneLine <= maxWidth
      ? { size, labelWidth: oneLine, labelHeight: 23 }
      : { size, labelWidth: Math.min(maxWidth, (lm.name.length / 2) * charWidth + 34), labelHeight: 38 };
  }

  function createPin(lm: Landmark, dx: number, dy: number): Pin {
    const photo = h('img', {
      class: 'pin-photo',
      src: asset(lm.image.thumb),
      alt: '',
      draggable: false,
      decoding: 'async',
    });
    photo.style.backgroundColor = lm.image.color;
    const inner = h('span', { class: 'pin-inner' }, photo, h('span', { class: 'pin-label' }, lm.name));
    const link = h('span', { class: 'pin-link' });
    const el = h('button', { class: `pin tier-${tierOf(lm)}`, type: 'button', title: lm.name }, link, inner);
    el.setAttribute('aria-label', `${lm.name}, ${lm.country}`);
    el.style.zIndex = String(100000 - lm.rank);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select(lm);
    });
    const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([lm.lng, lm.lat]).addTo(map);
    const pin: Pin = { marker, el, inner, link, linkTo: null, leaving: null, x: dx, y: dy, targetX: dx, targetY: dy };
    drawOffset(pin);
    return pin;
  }

  function drawOffset(pin: Pin): void {
    const at = `${pin.x.toFixed(1)}px ${pin.y.toFixed(1)}px`;
    pin.inner.style.translate = at;
    pin.el.classList.toggle('nudged', Math.hypot(pin.x, pin.y) > 6);
    // The line runs photo to photo (never to a spot on the map); both ends tuck under the photos.
    pin.el.classList.toggle('linked', pin.linkTo !== null);
    if (pin.linkTo) {
      const lx = pin.linkTo.x - pin.x;
      const ly = pin.linkTo.y - pin.y;
      pin.link.style.translate = at;
      pin.link.style.width = `${Math.hypot(lx, ly).toFixed(1)}px`;
      pin.link.style.rotate = `${Math.atan2(ly, lx).toFixed(4)}rad`;
    }
  }

  // Nudged markers glide to their new spot rather than jumping.
  let gliding = 0;
  function glide(): void {
    gliding = 0;
    let moving = false;
    for (const pin of pins.values()) {
      const dx = pin.targetX - pin.x;
      const dy = pin.targetY - pin.y;
      if (!dx && !dy) continue;
      if (reducedMotion || Math.abs(dx) + Math.abs(dy) < 0.5) {
        pin.x = pin.targetX;
        pin.y = pin.targetY;
      } else {
        pin.x += dx * 0.22;
        pin.y += dy * 0.22;
        moving = true;
      }
      drawOffset(pin);
    }
    if (moving) gliding = requestAnimationFrame(glide);
  }

  /** Short nudges at world view, growing to the full reach by the time a region fills the screen. */
  function nudgeReach(): number {
    const t = Math.max(0, Math.min(1, (map.getZoom() - 2) / 2.5));
    return MAX_NUDGE_ZOOMED_OUT + (MAX_NUDGE - MAX_NUDGE_ZOOMED_OUT) * t;
  }

  function render(): void {
    const narrow = isNarrow();
    const previous = new Map<string, { dx: number; dy: number }>();
    for (const [id, pin] of pins) {
      if (pin.leaving === null) previous.set(id, { dx: pin.targetX, dy: pin.targetY });
    }
    const placements = layoutLandmarks(map, landmarks, {
      max: MAX_VISIBLE,
      inset: { top: narrow ? 70 : 60, right: 24, bottom: 40, left: 24 },
      pinned: selected,
      footprint,
      maxOffset: nudgeReach() * (narrow ? 0.8 : 1),
      previous,
    });

    const wanted = new Set<string>();
    for (const { lm, dx, dy, link } of placements) {
      wanted.add(lm.id);
      let pin = pins.get(lm.id);
      if (!pin) {
        pin = createPin(lm, dx, dy);
        pins.set(lm.id, pin);
      } else if (pin.leaving !== null) {
        clearTimeout(pin.leaving);
        pin.leaving = null;
        pin.el.classList.remove('leaving');
      }
      pin.targetX = dx;
      pin.targetY = dy;
      pin.linkTo = link;
      drawOffset(pin);
      pin.el.classList.toggle('selected', lm === selected);
    }
    for (const [id, pin] of pins) {
      if (wanted.has(id) || pin.leaving !== null) continue;
      pin.el.classList.add('leaving');
      pin.targetX = pin.x; // stay put while fading out
      pin.targetY = pin.y;
      pin.linkTo = null;
      drawOffset(pin);
      pin.leaving = window.setTimeout(() => {
        pin.marker.remove();
        pins.delete(id);
      }, 210);
    }
    if (!gliding) gliding = requestAnimationFrame(glide);
  }

  // ----- country names: only for countries that are big enough on screen -----

  let namedCountries = -1;
  function updateCountryLabels(): void {
    if (!map.getLayer(COUNTRY_LABELS)) return;
    const canvas = map.getCanvas();
    // ground size of one screen pixel at the centre of the view
    const metresPerPixel =
      (EARTH_CIRCUMFERENCE_M * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const pixels = Math.max(
      COUNTRY_LABEL_SCREEN_SHARE * canvas.clientWidth * canvas.clientHeight,
      COUNTRY_LABEL_MIN_PIXELS,
    );
    const minAreaKm2 = pixels * (metresPerPixel / 1000) ** 2;
    // countryAreas is sorted largest first; count how many clear the bar
    let count = 0;
    while (count < countryAreas.length && countryAreas[count] >= minAreaKm2) count++;
    if (count === namedCountries) return; // same set as before: leave the layer alone
    namedCountries = count;
    map.setFilter(COUNTRY_LABELS, countryLabelFilter(count ? countryAreas[count - 1] : Infinity));
  }

  let frame = 0;
  const scheduleRender = (): void => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
        updateCountryLabels();
      });
    }
  };
  map.on('move', scheduleRender);
  map.on('resize', scheduleRender);

  // ----- idle spin until the first interaction -----

  let spinning = !reducedMotion;
  let lastTick = performance.now();
  function spin(now: number): void {
    if (!spinning) return;
    const dt = Math.min(now - lastTick, 100);
    lastTick = now;
    if (!document.hidden) {
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + (SPIN_SPEED * dt) / 1000, c.lat] });
    }
    requestAnimationFrame(spin);
  }
  const stopSpin = (): void => {
    spinning = false;
  };
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const) {
    window.addEventListener(type, stopSpin, { once: true, passive: true, capture: true });
  }

  // ----- detail card -----

  const card = $('card');

  function select(lm: Landmark | null, opts: { fly?: boolean } = {}): void {
    stopSpin();
    selected = lm;
    document.body.classList.toggle('card-open', !!lm);
    if (!lm) {
      card.hidden = true;
      history.replaceState(null, '', location.pathname + location.search);
      scheduleRender();
      return;
    }
    history.replaceState(null, '', `#${lm.id}`);
    renderCard(lm);
    if (opts.fly !== false) {
      // Keep the landmark clear of the card: beside it on wide screens, above the sheet on phones.
      const offset: [number, number] = isNarrow() ? [0, -window.innerHeight * 0.2] : [200, 0];
      map.flyTo({
        center: [lm.lng, lm.lat],
        zoom: Math.max(map.getZoom(), FOCUS_ZOOM),
        offset,
        duration: reducedMotion ? 0 : 2200,
        essential: true,
      });
    }
    scheduleRender();
  }

  function renderCard(lm: Landmark): void {
    // The main photo first, then the rest of the gallery.
    const photos = [lm.image, ...(lm.gallery ?? [])];
    const img = h('img', { alt: lm.name, decoding: 'async', draggable: false });
    const creditLine = h('p', { class: 'card-credit' });
    const dots = photos.map((_, i) => {
      const dot = h('button', { class: 'card-dot', type: 'button' });
      dot.setAttribute('aria-label', `Photo ${i + 1} of ${photos.length}`);
      dot.addEventListener('click', () => showPhoto(i));
      return dot;
    });
    let shown = 0;
    function showPhoto(i: number): void {
      shown = (i + photos.length) % photos.length;
      const photo = photos[shown];
      const credit = photo.credit;
      img.style.backgroundColor = photo.color;
      img.src = asset(photo.src);
      dots.forEach((dot, j) => {
        dot.classList.toggle('on', j === shown);
        dot.setAttribute('aria-current', String(j === shown));
      });
      creditLine.replaceChildren(
        'Photo: ',
        credit.author ?? credit.credit ?? 'Unknown author',
        ' · ',
        credit.licenseUrl
          ? extLink(credit.licenseUrl, credit.license ?? 'License')
          : (credit.license ?? 'See source for license'),
        ' · ',
        extLink(credit.sourcePage, 'Wikimedia Commons'),
      );
      // fetch the following photo now, so stepping on is instant
      if (photos.length > 1) new Image().src = asset(photos[(shown + 1) % photos.length].src);
    }
    const stepButton = (delta: number, label: string, glyph: string): HTMLButtonElement => {
      const b = h('button', { class: `icon-btn card-step ${delta < 0 ? 'prev' : 'next'}`, type: 'button' }, glyph);
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => showPhoto(shown + delta));
      return b;
    };
    const photoFrame = h('div', { class: 'card-photo' }, img);
    if (photos.length > 1) {
      photoFrame.classList.add('has-gallery');
      photoFrame.append(
        stepButton(-1, 'Previous photo', '‹'),
        stepButton(1, 'Next photo', '›'),
        h('div', { class: 'card-dots' }, ...dots),
      );
      // tap the photo for the next one, or swipe either way
      let downX: number | null = null;
      let swiped = false;
      img.addEventListener('click', () => {
        // a swipe ends with a click on the photo too; it has already been handled
        if (!swiped) showPhoto(shown + 1);
      });
      photoFrame.addEventListener('pointerdown', (e) => {
        downX = e.clientX;
        swiped = false;
      });
      photoFrame.addEventListener('pointerup', (e) => {
        const dx = downX === null ? 0 : e.clientX - downX;
        downX = null;
        if (Math.abs(dx) > 40) {
          swiped = true;
          showPhoto(shown + (dx < 0 ? 1 : -1));
        }
      });
    }
    showPhoto(0);

    const prev = landmarks[lm.rank - 2];
    const next = landmarks[lm.rank];
    const navButton = (target: Landmark | undefined, label: string): HTMLButtonElement => {
      const b = h('button', { type: 'button', disabled: !target }, target ? label : '');
      if (target) {
        b.title = target.name;
        b.addEventListener('click', () => select(target));
      }
      return b;
    };

    card.replaceChildren(
      (() => {
        const close = h('button', { class: 'icon-btn card-close', type: 'button' }, '×');
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', () => select(null));
        photoFrame.append(h('span', { class: 'card-rank' }, `#${lm.rank} of ${landmarks.length}`), close);
        return photoFrame;
      })(),
      h(
        'div',
        { class: 'card-body' },
        h('p', { class: 'card-kicker' }, `${lm.region} · ${lm.category}`),
        h('h2', {}, lm.name),
        h('p', { class: 'card-place' }, lm.description ? `${lm.country} · ${lm.description}` : lm.country),
        h('p', { class: 'card-summary' }, lm.summary),
        h(
          'div',
          { class: 'card-pop' },
          h('span', {}, 'Popularity'),
          h('b', {}, `${Math.round(lm.popularity)} / 100`),
          (() => {
            const fill = h('i');
            fill.style.width = `${Math.max(2, Math.min(100, lm.popularity))}%`;
            return h('span', { class: 'card-pop-bar' }, fill);
          })(),
        ),
        h('p', { class: 'card-links' }, extLink(lm.wikipedia, 'Read more on Wikipedia ↗')),
        creditLine,
      ),
      h(
        'div',
        { class: 'card-nav' },
        navButton(prev, prev ? `← #${prev.rank} ${prev.name}` : ''),
        navButton(next, next ? `#${next.rank} ${next.name} →` : ''),
      ),
    );
    card.hidden = false;
    // restart the entrance animation when hopping between landmarks
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  map.on('click', () => {
    if (selected) select(null);
  });
  window.addEventListener('keydown', (e) => {
    if (!selected) return;
    if (e.key === 'Escape') select(null);
    else if (e.key === 'ArrowRight' && landmarks[selected.rank]) select(landmarks[selected.rank]);
    else if (e.key === 'ArrowLeft' && landmarks[selected.rank - 2]) select(landmarks[selected.rank - 2]);
  });

  $('random').addEventListener('click', () => {
    let pick: Landmark;
    do pick = landmarks[Math.floor(Math.random() * landmarks.length)];
    while (pick === selected && landmarks.length > 1);
    select(pick);
  });

  // ----- go -----

  // 'styledata' rather than 'load': show the globe straight away and let tiles paint in,
  // instead of holding a blank screen until every terrain tile has arrived.
  map.once('styledata', () => {
    document.body.classList.add('ready');
    const fromHash = byId.get(decodeURIComponent(location.hash.slice(1)));
    if (fromHash) {
      select(fromHash);
    } else {
      render();
      requestAnimationFrame(spin);
    }
    updateCountryLabels();
  });
  window.addEventListener('hashchange', () => {
    const lm = byId.get(decodeURIComponent(location.hash.slice(1)));
    if (lm && lm !== selected) select(lm);
  });
}

start().catch((err) => {
  console.error(err);
  const notice = $('notice');
  notice.textContent = 'Something went wrong loading the globe. Check the console for details.';
  notice.hidden = false;
  document.body.classList.add('ready');
});
