// Where the app gets its landmarks: the API in worker/, which reads them from the database.
//
// The whole list arrives up front in a brief form (enough for the globe and search); the
// rest of a landmark (its summary, photos and credits) is fetched when its card is opened.

import type { Landmark, LandmarkDetails } from './types';

/**
 * Development only (`npm run dev:local`): read the pipeline's output file instead of the
 * API, to look at landmarks that have been built on this machine but not deployed yet.
 */
export const LOCAL = import.meta.env.DEV && Boolean(import.meta.env.VITE_LOCAL_DATA);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) {
    throw new Error(`${url} answered ${res.status}`);
  }
  return (await res.json()) as T;
}

let localFile: Promise<LandmarkDetails[]> | null = null;
const local = (): Promise<LandmarkDetails[]> =>
  (localFile ??= getJson<{ landmarks: LandmarkDetails[] }>(`${import.meta.env.BASE_URL}data/landmarks.json`).then(
    (file) => file.landmarks,
  ));

/** Every landmark, most popular first. */
export async function loadLandmarks(): Promise<Landmark[]> {
  const list = LOCAL ? await local() : (await getJson<{ landmarks: Landmark[] }>('/api/landmarks')).landmarks;
  return [...list].sort((a, b) => a.rank - b.rank);
}

const details = new Map<string, Promise<LandmarkDetails>>();

/** One landmark in full. Asked for once; later calls (and a prefetch) share the answer. */
export function loadDetails(id: string): Promise<LandmarkDetails> {
  let pending = details.get(id);
  if (!pending) {
    pending = LOCAL
      ? local().then((all) => {
          const found = all.find((l) => l.id === id);
          if (!found) throw new Error(`No landmark "${id}" in the local data`);
          return found;
        })
      : getJson<LandmarkDetails>(`/api/landmarks/${encodeURIComponent(id)}`);
    details.set(id, pending);
    // a failure is not remembered, so opening the card again tries again
    pending.catch(() => details.delete(id));
  }
  return pending;
}
