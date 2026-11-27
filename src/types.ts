/** Shape of public/data/landmarks.json, produced by scripts/build-data.mjs. */

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
  description: string | null;
  summary: string;
  /** 0-100 */
  popularity: number;
  metrics: { pageviews: number; wikipediaLanguages: number };
  wikipedia: string;
  wikidata: string | null;
  image: {
    src: string;
    thumb: string;
    width: number;
    height: number;
    /** Dominant colour, shown while the photo loads. */
    color: string;
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

export interface LandmarkData {
  generatedAt: string;
  count: number;
  popularity: string;
  landmarks: Landmark[];
}
