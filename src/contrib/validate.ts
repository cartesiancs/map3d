// Building edit rules, shared by the app (live feedback while editing) and the API (the real check).
// Pure functions only: imported by worker/src as well.

import { isEnglishText } from "../utils/english";

export type LngLat = [number, number];

export type BuildingEdit = {
  /** open ring (first point not repeated), WGS84 */
  footprint: LngLat[];
  /** meters above the highest ground under the footprint; wins over building:levels */
  height?: number | null;
  levels?: number | null;
  buildingType?: string | null;
  /** English (Latin script) only */
  name?: string | null;
};

export const LIMITS = {
  minVertices: 3,
  maxVertices: 500,
  minAreaM2: 4,
  maxAreaM2: 100_000,
  minEdgeM: 0.3,
  minHeight: 2,
  maxHeight: 900,
  maxLevels: 200,
  maxNameLength: 120,
};

const R = 6371008.8;

/** local metric coordinates (equirectangular around the first point) — fine at building scale */
function toMeters(ring: LngLat[]): [number, number][] {
  const [lng0, lat0] = ring[0];
  const k = Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lng, lat]) => [((lng - lng0) * Math.PI * R * k) / 180, ((lat - lat0) * Math.PI * R) / 180]);
}

export function areaM2(ring: LngLat[]): number {
  const m = toMeters(ring);
  let a = 0;
  for (let i = 0; i < m.length; i++) {
    const j = (i + 1) % m.length;
    a += m[i][0] * m[j][1] - m[j][0] * m[i][1];
  }
  return Math.abs(a) / 2;
}

function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  const on = (p: number[], q: number[], r: number[]) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/** two non-adjacent edges touching or crossing */
export function selfIntersects(ring: LngLat[]): boolean {
  const m = toMeters(ring);
  const n = m.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // adjacent edges share a point
      if (segmentsCross(m[i], m[(i + 1) % n], m[j], m[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** footprint geometry: closed by the reader, minimum edge, area, no crossing edges */
function shapeErrors(fp: LngLat[], errors: string[]) {
  if (fp[0][0] === fp[fp.length - 1][0] && fp[0][1] === fp[fp.length - 1][1]) errors.push("footprint must not repeat its first point");
  const m = toMeters(fp);
  for (let i = 0; i < m.length; i++) {
    const j = (i + 1) % m.length;
    if (Math.hypot(m[j][0] - m[i][0], m[j][1] - m[i][1]) < LIMITS.minEdgeM) {
      errors.push(`edges must be at least ${LIMITS.minEdgeM} m long`);
      break;
    }
  }
  const area = areaM2(fp);
  if (area < LIMITS.minAreaM2) errors.push(`footprint is smaller than ${LIMITS.minAreaM2} m²`);
  if (area > LIMITS.maxAreaM2) errors.push(`footprint is larger than ${LIMITS.maxAreaM2.toLocaleString("en")} m²`);
  if (selfIntersects(fp)) errors.push("footprint edges cross each other");
}

/**
 * Returns the problems (empty when the edit is valid). `checkShape: false` skips the footprint geometry rules
 * (an unchanged OSM footprint may break them: its height can still be set).
 */
export function validateEdit(e: BuildingEdit, opts: { checkShape?: boolean } = {}): string[] {
  const errors: string[] = [];
  const fp = e.footprint;
  if (!Array.isArray(fp) || fp.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    return ["footprint must be a list of [lng, lat] points"];
  }
  if (fp.some(([lng, lat]) => lng < -180 || lng > 180 || lat < -85 || lat > 85)) errors.push("footprint is outside the map");
  if (fp.length < LIMITS.minVertices) errors.push(`footprint needs at least ${LIMITS.minVertices} points`);
  const checkShape = opts.checkShape !== false;
  if (checkShape && fp.length > LIMITS.maxVertices) errors.push(`footprint has more than ${LIMITS.maxVertices} points`);
  if (errors.length) return errors;
  if (checkShape) shapeErrors(fp, errors);
  if (e.height != null && !(e.height >= LIMITS.minHeight && e.height <= LIMITS.maxHeight)) {
    errors.push(`height must be between ${LIMITS.minHeight} and ${LIMITS.maxHeight} m`);
  }
  if (e.levels != null && !(Number.isInteger(e.levels) && e.levels >= 1 && e.levels <= LIMITS.maxLevels)) {
    errors.push(`levels must be a whole number from 1 to ${LIMITS.maxLevels}`);
  }
  if (e.buildingType != null && !/^[a-z][a-z_]{1,30}$/.test(e.buildingType)) errors.push("building type must be an OSM value like house or apartments");
  if (e.name != null && e.name !== "" && (!isEnglishText(e.name) || e.name.length > LIMITS.maxNameLength)) {
    errors.push(`name must be English text up to ${LIMITS.maxNameLength} characters`);
  }
  return errors;
}
