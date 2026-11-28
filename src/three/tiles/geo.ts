// Scene coordinates: a fixed origin (lat/lng) at (0, 0, 0), x = east, z = south, y = up.
// 1 unit = 1 / SCALE degree of latitude (≈ 2.2 m); longitude is scaled by cos(origin latitude).

export const SCALE = 51000;
export const TILE_Z = 14;
const N = 2 ** TILE_Z;
const MAX_LAT = 85.0511287798066;

export type Origin = { lat: number; lng: number; cos: number };

export function makeOrigin(lat: number, lng: number): Origin {
  return { lat, lng, cos: Math.cos((lat * Math.PI) / 180) };
}

/** [x, z] in scene units */
export function toScene(o: Origin, lat: number, lng: number): [number, number] {
  return [(lng - o.lng) * SCALE * o.cos, -(lat - o.lat) * SCALE];
}

export function fromScene(o: Origin, x: number, z: number) {
  return { lat: o.lat - z / SCALE, lng: o.lng + x / (SCALE * o.cos) };
}

const clampTile = (v: number) => Math.max(0, Math.min(N - 1, v));

export function lngToTileX(lng: number) {
  return clampTile(Math.floor(((lng + 180) / 360) * N));
}

export function latToTileY(lat: number) {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return clampTile(Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N));
}

export const tileXToLng = (x: number) => (x / N) * 360 - 180;

export function tileYToLat(y: number) {
  const n = Math.PI - (2 * Math.PI * y) / N;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export const tileKey = (x: number, y: number) => `${x}/${y}`;

/** fractional Web Mercator tile coordinates at any zoom */
export const lngToTileXf = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;

export function latToTileYf(lat: number, z: number) {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export const tileXfToLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export function tileYfToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** meters per degree of latitude (the sphere of src/contrib/validate.ts) */
export const M_PER_DEG = (Math.PI * 6371008.8) / 180;
/**
 * meters per HORIZONTAL scene unit (≈ 2.18). Building heights are drawn in meters (1 vertical unit = 1 m, the
 * map's vertical exaggeration); the terrain is drawn at true scale (elevation ÷ H_UNIT_M, see terrain.ts).
 */
export const H_UNIT_M = M_PER_DEG / SCALE;

/**
 * Building vertices up to this high (m) stand on the ground. On terrain they go down to the LOWEST ground
 * under the building, every other vertex is lifted to the HIGHEST (the plinth stretches, the rest keeps
 * its shape): see computeBuildingBases.
 */
export const GROUND_EPS = 0.05;
/** 0: on the ground, 1: above it (the vertexClass of building tiles) */
export const groundClass = (y: number) => (y < GROUND_EPS ? 0 : 1);

/**
 * A building mesh is stored in meters around an anchor: x = east, y = up (0 = its lowest ground), z = south.
 * In the scene: x_s = ax + x·kx, y_s = y, z_s = az + z·kz (the map's vertical exaggeration is kept).
 */
export type MeshFrame = { ax: number; az: number; kx: number; kz: number };

export function meshFrame(o: Origin, anchorLat: number, anchorLng: number): MeshFrame {
  const [ax, az] = toScene(o, anchorLat, anchorLng);
  return { ax, az, kx: o.cos / (Math.cos((anchorLat * Math.PI) / 180) * H_UNIT_M), kz: 1 / H_UNIT_M };
}

/**
 * Height rule kept from the original app: building:levels × 2.2 wins over height, default 10.
 * An approved map3d edit that sets the height (map3d:height) wins over both.
 */
export function buildingHeight(tags: Record<string, string>) {
  const edited = parseFloat(tags["map3d:height"] || "");
  if (!isNaN(edited)) return edited;
  let height = parseFloat(tags.height || "");
  const levels = parseFloat(tags["building:levels"] || "");
  if (isNaN(height)) height = 10;
  if (!isNaN(levels)) height = levels * 2.2;
  return height;
}
