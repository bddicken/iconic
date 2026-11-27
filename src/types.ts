/**
 * Landmarks as the app receives them from the API (worker/index.ts), which reads them from
 * the database. The pipeline's public/data/landmarks.json has the same full shape.
 */

export interface ImageCredit {
  title: string;
  author: string | null;
  credit: string | null;
  license: string | null;
  licenseUrl: string | null;
  attributionRequired: boolean;
  /** The Wikimedia Commons page describing the file. */
  sourcePage: string;
  originalUrl: string;
  downloadedFrom: string;
}

/** What the app knows about every landmark from the start: enough for the globe and search. */
export interface Landmark {
  /** 1 = most popular. The list is sorted by rank. */
  rank: number;
  id: string;
  name: string;
  country: string;
  region: string;
  category: string;
  lat: number;
  lng: number;
  image: {
    thumb: string;
    /** Dominant colour, shown while the photo loads. */
    color: string;
  };
}

/** Everything about one landmark, fetched when its card is opened. */
export interface LandmarkDetails extends Landmark {
  description: string | null;
  summary: string;
  /** 0-100 */
  popularity: number;
  metrics: { pageviews: number; wikipediaLanguages: number };
  wikipedia: string;
  wikidata: string | null;
  image: Landmark['image'] & {
    src: string;
    width: number;
    height: number;
    credit: ImageCredit;
  };
  /** Up to three more photos, shown after the main one when the card is open. */
  gallery?: GalleryImage[];
}

export interface GalleryImage {
  src: string;
  width: number;
  height: number;
  /** Dominant colour, shown while the photo loads. */
  color: string;
  credit: ImageCredit;
}
