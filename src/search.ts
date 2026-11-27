// The search box and its filters.
//
// Matching is done by the server (worker/index.ts): PlanetScale Postgres with TIN
// full-text search over each landmark's name and description. The API answers with
// landmark ids, best first; this module turns them into a results list and, for filters,
// into the set of landmarks the globe is allowed to show.

import { LOCAL } from './data';
import type { Landmark, LandmarkDetails } from './types';

interface SearchResponse {
  ids: string[];
  total: number;
  /** How the text matched: as typed, allowing typos, or on any one word. 'all' = no text. */
  mode: 'all' | 'exact' | 'fuzzy' | 'any';
}

interface Query {
  q?: string;
  region?: string | null;
  category?: string | null;
  limit: number;
}

export interface SearchOptions {
  /** Every landmark, most popular first. */
  landmarks: Landmark[];
  /** Where landmark thumbnails are served from. */
  asset(path: string): string;
  /** Open a landmark (fly to it and show its card). */
  open(lm: Landmark): void;
  /** Restrict the globe to these landmarks, or lift the restriction with null. */
  filter(ids: Set<string> | null): void;
}

const RESULTS = 8;
const DEBOUNCE_MS = 130;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export function mountSearch(opts: SearchOptions): void {
  const { landmarks } = opts;
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  const root = document.getElementById('search') as HTMLElement;
  const input = document.getElementById('search-input') as HTMLInputElement;
  const panel = document.getElementById('search-panel') as HTMLElement;
  const chips = document.getElementById('search-filters') as HTMLElement;
  const list = document.getElementById('search-results') as HTMLUListElement;
  const note = document.getElementById('search-note') as HTMLElement;
  const clear = document.getElementById('search-clear') as HTMLButtonElement;

  let region: string | null = null;
  let category: string | null = null;
  let results: Landmark[] = [];
  let active = -1;

  // ----- talking to the API -----

  /**
   * A plain match in the browser, for when the API cannot answer. Every word must appear
   * somewhere in the landmark's name and place (and its blurb, when the local data has it).
   */
  function matchHere(query: Query): SearchResponse {
    const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = landmarks.filter((l) => {
      if (query.region && l.region !== query.region) return false;
      if (query.category && l.category !== query.category) return false;
      const { description, summary } = l as Partial<LandmarkDetails>;
      const text = `${l.name} ${l.country} ${l.region} ${l.category} ${description ?? ''} ${summary ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    // a match in the name comes before one found only in the blurb; otherwise most popular first
    const named = (l: Landmark): number => (words.every((w) => l.name.toLowerCase().includes(w)) ? 0 : 1);
    if (words.length) hits.sort((a, b) => named(a) - named(b) || a.rank - b.rank);
    return { ids: hits.slice(0, query.limit).map((l) => l.id), total: hits.length, mode: words.length ? 'exact' : 'all' };
  }

  let warned = false;
  async function ask(query: Query, signal?: AbortSignal): Promise<SearchResponse> {
    // `npm run dev:local` shows landmarks that are not in the database yet, which the API
    // cannot know about, so they are matched here instead.
    if (LOCAL) return matchHere(query);
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.region) params.set('region', query.region);
    if (query.category) params.set('category', query.category);
    params.set('limit', String(query.limit));
    try {
      const res = await fetch(`/api/search?${params}`, { signal });
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`search API answered ${res.status}`);
      return (await res.json()) as SearchResponse;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      // The API is unreachable (offline, or a preview with no server). Rather than leave
      // the box dead, fall back to a plain name-and-place match in the browser.
      if (!warned) console.warn('Search API unavailable; using basic in-browser matching instead.', err);
      warned = true;
      return matchHere(query);
    }
  }

  // ----- filters: one category and/or one region -----

  const count = (values: string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  const groups: { label: string; values: string[]; get: () => string | null; set: (v: string | null) => void }[] = [
    { label: 'Type', values: count(landmarks.map((l) => l.category)), get: () => category, set: (v) => (category = v) },
    { label: 'Region', values: count(landmarks.map((l) => l.region)), get: () => region, set: (v) => (region = v) },
  ];
  const chipButtons: { button: HTMLButtonElement; isOn: () => boolean }[] = [];
  for (const group of groups) {
    const row = el('div', 'search-chip-row');
    row.append(el('span', 'search-chip-label', group.label));
    for (const value of group.values) {
      const button = el('button', 'search-chip', value);
      button.type = 'button';
      button.addEventListener('click', () => {
        group.set(group.get() === value ? null : value);
        filtersChanged();
      });
      chipButtons.push({ button, isOn: () => group.get() === value });
      row.append(button);
    }
    chips.append(row);
  }

  let filterRequest: AbortController | null = null;
  async function filtersChanged(): Promise<void> {
    for (const { button, isOn } of chipButtons) {
      button.classList.toggle('on', isOn());
      button.setAttribute('aria-pressed', String(isOn()));
    }
    const filtered = Boolean(region || category);
    root.classList.toggle('filtered', filtered);
    input.placeholder = filtered
      ? `Search ${[category, 'places', region && `in ${region}`].filter(Boolean).join(' ')}`
      : 'Search places';

    // The globe shows only what the filters allow.
    filterRequest?.abort();
    if (!filtered) {
      opts.filter(null);
    } else {
      filterRequest = new AbortController();
      try {
        const all = await ask({ region, category, limit: 2000 }, filterRequest.signal);
        opts.filter(new Set(all.ids));
      } catch {
        return; // superseded by a newer filter choice
      }
    }
    void refresh();
  }

  // ----- results -----

  function show(items: Landmark[], message: string): void {
    results = items;
    active = -1;
    list.replaceChildren(
      ...items.map((lm, i) => {
        const item = el('li', 'search-result');
        item.id = `search-result-${i}`;
        item.setAttribute('role', 'option');
        const thumb = el('img');
        thumb.src = opts.asset(lm.image.thumb);
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.style.backgroundColor = lm.image.color;
        const text = el('span', 'search-result-text');
        text.append(el('strong', '', lm.name), el('span', '', `${lm.country} · ${lm.category}`));
        item.append(thumb, text);
        // mousedown, not click: it fires before the input loses focus and closes the panel
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(lm);
        });
        item.addEventListener('mousemove', () => highlight(i));
        return item;
      }),
    );
    note.textContent = message;
    note.hidden = !message;
    input.setAttribute('aria-expanded', String(!panel.hidden));
  }

  function highlight(i: number): void {
    active = i;
    [...list.children].forEach((child, j) => child.classList.toggle('active', j === i));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', `search-result-${i}`);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  let request: AbortController | null = null;
  async function refresh(): Promise<void> {
    const q = input.value.trim();
    clear.hidden = !input.value;
    request?.abort();
    if (!q && !region && !category) {
      show([], '');
      return;
    }
    request = new AbortController();
    try {
      const found = await ask({ q, region, category, limit: RESULTS }, request.signal);
      const items = found.ids.map((id) => byId.get(id)).filter((l): l is Landmark => Boolean(l));
      const more = found.total - items.length;
      show(
        items,
        !items.length
          ? 'No places match. Try fewer or different words.'
          : found.mode === 'fuzzy' || found.mode === 'any'
            ? 'No exact match, so here are the closest.'
            : more > 0
              ? `and ${more.toLocaleString()} more`
              : '',
      );
    } catch {
      // superseded by a newer keystroke
    }
  }

  function choose(lm: Landmark): void {
    input.value = '';
    close();
    void refresh();
    opts.open(lm);
  }

  // ----- opening, closing and the keyboard -----

  function open(): void {
    panel.hidden = false;
    root.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  }
  function close(): void {
    panel.hidden = true;
    root.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    input.blur();
  }

  let timer = 0;
  input.addEventListener('input', () => {
    open();
    clearTimeout(timer);
    timer = window.setTimeout(refresh, DEBOUNCE_MS);
  });
  input.addEventListener('focus', open);
  input.addEventListener('keydown', (e) => {
    // keep the app's own shortcuts (arrows change landmark, Esc closes the card) out of it
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) highlight((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length + (active < 0 && e.key === 'ArrowUp' ? 1 : 0)) % results.length);
    } else if (e.key === 'Enter') {
      const pick = results[active] ?? results[0];
      if (pick) choose(pick);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    input.focus();
    void refresh();
  });
  // clicking anywhere else closes the panel (the filters stay applied)
  document.addEventListener('pointerdown', (e) => {
    if (!root.contains(e.target as Node)) close();
  });
  // "/" jumps to search, as on many sites
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
    }
  });

  void filtersChanged();
}
