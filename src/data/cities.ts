// Major cities for search and "go to my city": Natural Earth populated places (public domain), 7,342 places.
// Shown in English only (name, region, country); local and other-language names only help matching a query.
// The data (cities.json) is loaded on first use.

export type City = {
  /** English name */
  name: string;
  country: string;
  region: string;
  lat: number;
  lng: number;
  population: number;
  /** all names, normalized for matching */
  keys: string[];
};

type Row = [string, string, string, string, string, string, string, number, number, number];

/** lower case, no accents ("São Paulo" → "sao paulo"), so queries match with or without them */
export const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

let cities: Promise<City[]> | null = null;

export function loadCities(): Promise<City[]> {
  cities ??= import("./cities.json").then(({ default: data }) =>
    (data.rows as Row[]).map(([name, other, ko, ja, zh, country, region, lat, lng, population]) => ({
      name,
      country,
      region,
      lat,
      lng,
      population,
      keys: [name, ...other.split("|"), ko, ja, zh].filter(Boolean).map(normalize),
    })),
  );
  return cities;
}

/** Best matches: exact name, then names starting with the query, then containing it; bigger cities first. */
export function searchCities(all: City[], query: string, limit: number): City[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { c: City; score: number }[] = [];
  for (const c of all) {
    let score = 0;
    for (const k of c.keys) {
      if (k === q) score = Math.max(score, 3);
      else if (k.startsWith(q)) score = Math.max(score, 2);
      else if (k.includes(q)) score = Math.max(score, 1);
    }
    if (score) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || b.c.population - a.c.population);
  return scored.slice(0, limit).map((s) => s.c);
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** The city a position belongs to: the nearest place, preferring a large city when one is about as close. */
export function nearestCity(all: City[], lat: number, lng: number): { city: City; km: number } | null {
  let best: { city: City; km: number; score: number } | null = null;
  for (const c of all) {
    const km = distanceKm(lat, lng, c.lat, c.lng);
    // a metropolis 15 km away beats a small town 5 km away: distance shrinks with population
    const score = km / (1 + Math.log10(1 + c.population / 100000));
    if (!best || score < best.score) best = { city: c, km, score };
  }
  return best && { city: best.city, km: best.km };
}
