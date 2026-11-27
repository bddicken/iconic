import {
  AttributionControl,
  Map as GlobeMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import { buildStyle, type LandCoverTiles } from './basemap';
import { selectLandmarks } from './select';
import type { Landmark, LandmarkData } from './types';

/** The most landmarks ever drawn at once, whatever the position or zoom. */
const MAX_VISIBLE = 15;
/** Zoom the camera flies to when a landmark is opened (kept if already closer). */
const FOCUS_ZOOM = 5.6;
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
    leaving: number | null;
  }
  const pins = new Map<string, Pin>();
  let selected: Landmark | null = null;

  function createPin(lm: Landmark): Pin {
    const tier = lm.rank <= 10 ? 'tier-1' : lm.rank <= 35 ? 'tier-2' : 'tier-3';
    const photo = h('img', {
      class: 'pin-photo',
      src: asset(lm.image.thumb),
      alt: '',
      draggable: false,
      decoding: 'async',
    });
    photo.style.backgroundColor = lm.image.color;
    const el = h(
      'button',
      { class: `pin ${tier}`, type: 'button', title: lm.name },
      h('span', { class: 'pin-inner' }, photo, h('span', { class: 'pin-label' }, lm.name)),
    );
    el.setAttribute('aria-label', `${lm.name}, ${lm.country}`);
    el.style.zIndex = String(100000 - lm.rank);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      select(lm);
    });
    const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([lm.lng, lm.lat]).addTo(map);
    return { marker, el, leaving: null };
  }

  function render(): void {
    const narrow = isNarrow();
    const shown = selectLandmarks(map, landmarks, {
      max: MAX_VISIBLE,
      gapX: narrow ? 92 : 118,
      gapY: narrow ? 92 : 112,
      inset: { top: narrow ? 70 : 60, right: 24, bottom: 40, left: 24 },
      pinned: selected,
    });

    const wanted = new Set<string>();
    for (const lm of shown) {
      wanted.add(lm.id);
      let pin = pins.get(lm.id);
      if (!pin) {
        pin = createPin(lm);
        pins.set(lm.id, pin);
      } else if (pin.leaving !== null) {
        clearTimeout(pin.leaving);
        pin.leaving = null;
        pin.el.classList.remove('leaving');
      }
      pin.el.classList.toggle('selected', lm === selected);
    }
    for (const [id, pin] of pins) {
      if (wanted.has(id) || pin.leaving !== null) continue;
      pin.el.classList.add('leaving');
      pin.leaving = window.setTimeout(() => {
        pin.marker.remove();
        pins.delete(id);
      }, 210);
    }
  }

  let frame = 0;
  const scheduleRender = (): void => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
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
    const credit = lm.image.credit;
    const img = h('img', { src: asset(lm.image.src), alt: lm.name, decoding: 'async' });
    img.style.backgroundColor = lm.image.color;

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
      h(
        'div',
        { class: 'card-photo' },
        img,
        h('span', { class: 'card-rank' }, `#${lm.rank} of ${landmarks.length}`),
        (() => {
          const close = h('button', { class: 'icon-btn card-close', type: 'button' }, '×');
          close.setAttribute('aria-label', 'Close');
          close.addEventListener('click', () => select(null));
          return close;
        })(),
      ),
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
        h(
          'p',
          { class: 'card-credit' },
          'Photo: ',
          credit.author ?? credit.credit ?? 'Unknown author',
          ' · ',
          credit.licenseUrl
            ? extLink(credit.licenseUrl, credit.license ?? 'License')
            : (credit.license ?? 'See source for license'),
          ' · ',
          extLink(credit.sourcePage, 'Wikimedia Commons'),
        ),
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
