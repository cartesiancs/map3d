// Approved building edits drawn over the OSM tiles (worker/src/overlay.ts writes them; CONTRIBUTION-DESIGN.md §3).
//   <OVERLAY_URL>/index.json            { rev, tiles: { "x/y": rev } }   z14 tiles that have edits
//   <OVERLAY_URL>/14/x/y.json?v=<rev>   { hide: [osm way ids], add: [building features] }
// Production reads the CDN (R2, like the tiles); development reads the local API, which serves the same files.
// Used on the main thread and in the tile worker.

import { API_URL } from "./auth";
import { fetchBytes } from "./retry";
import type { EncodedMesh } from "@/contrib/mesh";

const DATA_URL = (import.meta.env.VITE_OSM_DATA_URL ?? "https://cdn.map3d.fleet.im").replace(/\/+$/, "");
export const OVERLAY_URL = (import.meta.env.VITE_OVERLAY_URL ?? (import.meta.env.DEV ? `${API_URL}/overlay` : `${DATA_URL}/overlay`)).replace(/\/+$/, "");

export type OverlayIndex = { rev: number; tiles: Record<string, number> };
/** `m`: a free 3D shape (src/contrib/mesh.ts wire format); `g` is then its outline */
export type OverlayFeature = { t: "w" | "r"; id: number; tags: Record<string, string>; g: number[][][]; m?: EncodedMesh };
export type OverlayTile = { hide: number[]; add: OverlayFeature[] };

const EMPTY_INDEX: OverlayIndex = { rev: 0, tiles: {} };
const decoder = new TextDecoder();

/** The current index (none published yet: no edits), or null when it cannot be read right now. */
export async function fetchOverlayIndex(): Promise<OverlayIndex | null> {
  try {
    const buf = await fetchBytes(`${OVERLAY_URL}/index.json`, { allow404: true, init: { cache: "no-cache" } });
    if (!buf) return EMPTY_INDEX;
    const j = JSON.parse(decoder.decode(buf)) as OverlayIndex;
    return { rev: j.rev ?? 0, tiles: j.tiles ?? {} };
  } catch (err) {
    console.warn("overlay index unavailable:", err);
    return null;
  }
}

export async function fetchOverlayTile(x: number, y: number, rev: number): Promise<OverlayTile> {
  const buf = await fetchBytes(`${OVERLAY_URL}/14/${x}/${y}.json?v=${rev}`, { allow404: true });
  if (!buf) return { hide: [], add: [] };
  const j = JSON.parse(decoder.decode(buf)) as OverlayTile;
  return { hide: j.hide ?? [], add: j.add ?? [] };
}

/** OSM features of one tile with the edits applied: edited / replaced ways hidden, edited and new ones added. */
export function applyOverlay<F extends { t: string; id: number }>(features: F[], overlay: OverlayTile | null): F[] {
  if (!overlay || (!overlay.hide.length && !overlay.add.length)) return features;
  const hidden = new Set(overlay.hide);
  return [...features.filter((f) => !(f.t === "w" && hidden.has(f.id))), ...(overlay.add as unknown as F[])];
}

// main thread: a short-lived cached index for one-off area queries (export, Edit mode reading a building)
let cached: { at: number; index: Promise<OverlayIndex> } | null = null;

/** the index the map just switched to: area queries use it too (an edit approved a moment ago is in it) */
export function primeOverlayIndex(index: OverlayIndex) {
  cached = { at: performance.now(), index: Promise.resolve(index) };
}
export function overlayIndexCached(maxAgeMs = 30000): Promise<OverlayIndex> {
  if (!cached || performance.now() - cached.at > maxAgeMs) cached = { at: performance.now(), index: fetchOverlayIndex().then((i) => i ?? EMPTY_INDEX) };
  return cached.index;
}
