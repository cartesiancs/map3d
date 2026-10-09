import type { GeoPoint } from './layers';
export type Terrain = {
  south: number; north: number; west: number; east: number;
  size: number; elevations: number[]; baseline: number;
};
export function tilePosition(p: GeoPoint, zoom: number) {
  const lat = Math.max(-85.05, Math.min(85.05, p.lat)) * Math.PI / 180;
  const n = 2 ** zoom;
  return { x: (p.lon + 180) / 360 * n, y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * n };
}
export const decodeElevation = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;
export function terrainHeight(terrain: Terrain | null, point: GeoPoint) {
  if (!terrain) return 0;
  const { size, elevations, south, north, west, east, baseline } = terrain;
  const x = Math.max(0, Math.min(size - 1, (point.lon - west) / (east - west) * (size - 1)));
  const y = Math.max(0, Math.min(size - 1, (north - point.lat) / (north - south) * (size - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
  const top = elevations[y0 * size + x0] * (1 - (x - x0)) + elevations[y0 * size + x1] * (x - x0);
  const bottom = elevations[y1 * size + x0] * (1 - (x - x0)) + elevations[y1 * size + x1] * (x - x0);
  return top * (1 - (y - y0)) + bottom * (y - y0) - baseline;
}
/** Terrarium PNGs: https://github.com/tilezen/joerd/blob/master/docs/formats.md */
export async function loadTerrain(points: { lat: number; lng: number }[], signal: AbortSignal): Promise<Terrain> {
  const south = Math.min(...points.map(p => p.lat)), north = Math.max(...points.map(p => p.lat));
  const west = Math.min(...points.map(p => p.lng)), east = Math.max(...points.map(p => p.lng));
  if (south < -85.05 || north > 85.05) throw new Error('Terrain is unavailable at this latitude.');
  // Adapt zoom to keep even long thin boundaries within nine tile requests.
  let zoom = 14;
  const tileBounds = () => [tilePosition({ lat: north, lon: west }, zoom), tilePosition({ lat: south, lon: east }, zoom)];
  while (zoom > 0) {
    const [a,b] = tileBounds();
    if ((Math.floor(b.x) - Math.floor(a.x) + 1) * (Math.floor(b.y) - Math.floor(a.y) + 1) <= 9) break;
    zoom--;
  }
  const [a,b] = tileBounds();
  const tiles = new Map<string, ImageData>();
  const jobs: Promise<void>[] = [];
  for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) {
    jobs.push((async () => {
      const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`, { signal });
      if (!response.ok) throw new Error(`Elevation service returned ${response.status}.`);
      const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
      try {
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Could not decode elevation tiles.');
        context.drawImage(bitmap, 0, 0); tiles.set(`${x}/${y}`, context.getImageData(0, 0, bitmap.width, bitmap.height));
      } finally { bitmap.close(); }
    })());
  }
  await Promise.all(jobs);
  signal.throwIfAborted();
  const size = 49, elevations: number[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const position = tilePosition({ lat: north + (south - north) * y / (size - 1), lon: west + (east - west) * x / (size - 1) }, zoom);
    const tile = tiles.get(`${Math.floor(position.x)}/${Math.floor(position.y)}`)!;
    const px = Math.min(tile.width - 1, Math.floor((position.x % 1) * tile.width));
    const py = Math.min(tile.height - 1, Math.floor((position.y % 1) * tile.height));
    const i = (py * tile.width + px) * 4;
    const elevation = decodeElevation(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
    if (!tile.data[i + 3] || elevation < -12000) throw new Error('Elevation data is missing for this area.');
    elevations.push(elevation);
  }
  return { south, north, west, east, size, elevations, baseline: Math.min(...elevations) };
}
