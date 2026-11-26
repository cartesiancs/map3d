// Overlay: approved building edits drawn on top of the OSM tiles (CONTRIBUTION-DESIGN.md §3).
//
// R2 (same bucket as the tiles, public through cdn.map3d.fleet.im):
//   overlay/index.json      { v, rev, tiles: { "x/y": rev } }       tiles that have edits (max-age 30 s)
//   overlay/14/x/y.json     { v, z, x, y, rev, hide: [osm way ids], add: [features] }   (fetched with ?v=rev)
// `add` features use the building tile format ({ t: "w", id, tags, g }), so the app builds them with the same
// code as OSM buildings. A tile lists a building where the app builds it: the tile of its first vertex
// (owner rule of buildTile.ts) — `hide` in the original's owner tile, `add` in the edited footprint's.

import type { Env } from "./index";
import { latToTileY, lngToTileX } from "../../src/three/tiles/geo";
import type { BuildingEdit, LngLat } from "../../src/contrib/validate";

export const TILE_Z = 14;
const TILE_CACHE = "public, max-age=31536000, immutable"; // versioned by ?v=rev
const INDEX_CACHE = "public, max-age=30";

export type OverrideRow = {
  ref: string;
  osm_id: number | null;
  feature_id: number;
  footprint: string;
  height: number | null;
  levels: number | null;
  building_type: string | null;
  name: string | null;
  base_tags: string | null;
  hide_tile: string | null;
  owner_tile: string;
  updated_by: number | null;
  contribution_id: string | null;
  updated_at: string;
};

export const ownerTile = ([lng, lat]: LngLat) => `${lngToTileX(lng)}/${latToTileY(lat)}`;

/** closed ring, 1e-7 degree integers, first point absolute then deltas (format.mjs / buildTile.ts) */
function encodeRing(open: LngLat[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [lng, lat] of [...open, open[0]]) {
    const x = Math.round(lng * 1e7);
    const y = Math.round(lat * 1e7);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

/** OSM tags of the original, with the edit on top */
export function mergedTags(row: OverrideRow): Record<string, string> {
  const tags: Record<string, string> = row.base_tags ? JSON.parse(row.base_tags) : {};
  tags.building = row.building_type ?? tags.building ?? "yes";
  if (row.height != null) {
    tags.height = String(row.height);
    tags["map3d:height"] = String(row.height); // explicit height: wins over building:levels in the app
  }
  if (row.levels != null) tags["building:levels"] = String(row.levels);
  if (row.name) {
    tags["name:en"] = row.name;
    if (row.osm_id == null) tags.name = row.name;
  }
  tags["map3d:edited"] = row.updated_at;
  return tags;
}

function feature(row: OverrideRow) {
  return { t: "w", id: row.feature_id, tags: mergedTags(row), g: [[encodeRing(JSON.parse(row.footprint) as LngLat[])]] };
}

async function nextRev(env: Env): Promise<number> {
  const r = await env.DB.prepare("UPDATE overlay_meta SET v = v + 1 WHERE k = 'rev' RETURNING v").first<{ v: number }>();
  return r!.v;
}

/** Rewrite the overlay tiles that changed, then the index. */
export async function publish(env: Env, tiles: Iterable<string>): Promise<number> {
  const rev = await nextRev(env);
  for (const tile of new Set(tiles)) {
    const [x, y] = tile.split("/").map(Number);
    const { results } = await env.DB.prepare("SELECT * FROM overrides WHERE hide_tile = ?1 OR owner_tile = ?1").bind(tile).all<OverrideRow>();
    const hide = results.filter((r) => r.hide_tile === tile && r.osm_id != null).map((r) => r.osm_id!);
    const add = results.filter((r) => r.owner_tile === tile).map(feature);
    const key = `overlay/${TILE_Z}/${x}/${y}.json`;
    if (!hide.length && !add.length) {
      await env.DATA.delete(key);
      await env.DB.prepare("DELETE FROM overlay_tiles WHERE tile = ?").bind(tile).run();
      continue;
    }
    await env.DATA.put(key, JSON.stringify({ v: 1, z: TILE_Z, x, y, rev, hide, add }), {
      httpMetadata: { contentType: "application/json", cacheControl: TILE_CACHE },
    });
    await env.DB.prepare("INSERT INTO overlay_tiles (tile, rev) VALUES (?1, ?2) ON CONFLICT(tile) DO UPDATE SET rev = ?2").bind(tile, rev).run();
  }
  const { results } = await env.DB.prepare("SELECT tile, rev FROM overlay_tiles").all<{ tile: string; rev: number }>();
  await env.DATA.put("overlay/index.json", JSON.stringify({ v: 1, rev, tiles: Object.fromEntries(results.map((r) => [r.tile, r.rev])) }), {
    httpMetadata: { contentType: "application/json", cacheControl: INDEX_CACHE },
  });
  return rev;
}

export type OverrideInput = {
  /** way:<id> to edit an OSM building, new:<n> to change an added one, absent to add a new building */
  ref?: string;
  /** the original OSM footprint (required the first time a way is edited: decides which tile hides it) */
  baseFootprint?: LngLat[];
  /** the original OSM tags (kept under the edit) */
  baseTags?: Record<string, string>;
  edit: BuildingEdit;
  /** the approved contribution this comes from (none: written directly by an admin) */
  contributionId?: string;
};

/** Create or replace an override and publish the affected tiles. Returns the ref and the new revision. */
export async function setOverride(env: Env, input: OverrideInput, actorId: number): Promise<{ ref: string; rev: number }> {
  let ref = input.ref;
  let osmId: number | null = null;
  let featureId: number;
  const previous = ref ? await env.DB.prepare("SELECT * FROM overrides WHERE ref = ?").bind(ref).first<OverrideRow>() : null;
  if (!ref) {
    const n = (await env.DB.prepare("INSERT INTO new_buildings DEFAULT VALUES RETURNING n").first<{ n: number }>())!.n;
    ref = `new:${n}`;
    featureId = -n;
  } else if (ref.startsWith("way:")) {
    osmId = Number(ref.slice(4));
    if (!Number.isSafeInteger(osmId) || osmId <= 0) throw new InputError("bad ref");
    featureId = osmId;
  } else if (ref.startsWith("new:")) {
    if (!previous) throw new InputError("unknown building");
    featureId = previous.feature_id;
  } else {
    throw new InputError("bad ref");
  }

  let hideTile = previous?.hide_tile ?? null;
  let baseTags = previous?.base_tags ?? null;
  if (osmId != null && !previous) {
    if (!input.baseFootprint?.length) throw new InputError("baseFootprint is required to edit an OSM building");
    hideTile = ownerTile(input.baseFootprint[0]);
    baseTags = JSON.stringify(input.baseTags ?? {});
  }
  const e = input.edit;
  const owner = ownerTile(e.footprint[0]);
  await env.DB.prepare(
    `INSERT INTO overrides (ref, osm_id, feature_id, footprint, height, levels, building_type, name, base_tags, hide_tile, owner_tile, updated_by, contribution_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(ref) DO UPDATE SET footprint = ?4, height = ?5, levels = ?6, building_type = ?7, name = ?8,
       owner_tile = ?11, updated_by = ?12, contribution_id = ?13, updated_at = excluded.updated_at`,
  )
    .bind(ref, osmId, featureId, JSON.stringify(e.footprint), e.height ?? null, e.levels ?? null, e.buildingType ?? null, e.name || null, baseTags, hideTile, owner, actorId, input.contributionId ?? null)
    .run();
  const tiles = [owner, hideTile, previous?.owner_tile, previous?.hide_tile].filter((t): t is string => !!t);
  return { ref, rev: await publish(env, tiles) };
}

/** Drop an override: the OSM building comes back (or the added building disappears). */
export async function removeOverride(env: Env, ref: string): Promise<number | null> {
  const row = await env.DB.prepare("DELETE FROM overrides WHERE ref = ? RETURNING *").bind(ref).first<OverrideRow>();
  if (!row) return null;
  return publish(env, [row.owner_tile, row.hide_tile].filter((t): t is string => !!t));
}

export class InputError extends Error {}

/** GET /overlay/… straight from R2 (local development; production reads the CDN). */
export async function serveOverlay(env: Env, path: string): Promise<Response> {
  const obj = await env.DATA.get(`overlay/${path}`);
  const headers: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
  if (!obj) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...headers, "Content-Type": "application/json" } });
  return new Response(obj.body, {
    headers: { ...headers, "Content-Type": obj.httpMetadata?.contentType ?? "application/json", "Cache-Control": obj.httpMetadata?.cacheControl ?? "no-store" },
  });
}
