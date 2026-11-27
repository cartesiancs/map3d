import { getArchives } from "@/api/osmSource";
import { Origin, TILE_Z } from "./geo";
import { TileData, TileFeature, buildBuildingTile, buildRoadTile, transferables } from "./buildTile";
import { GroundTileData, computeBuildingBases, computeRoadHeights, getGrid, loadGroundTile } from "./terrain";
import { WaterResult, loadWaterSdf } from "./water";
import { OverlayTile, applyOverlay, fetchOverlayTile } from "@/api/overlay";

export type TileRequest = {
  layer: "building" | "road";
  x: number;
  y: number;
  origin: Origin;
  /** also place the tile on the ground (same job, no second round trip) */
  terrain?: boolean;
  /** buildings: the tile has approved edits at this revision (from the overlay index) */
  overlayRev?: number;
};

export type WorkerJob =
  | { kind: "tile"; req: TileRequest }
  | { kind: "ground"; x: number; y: number; origin: Origin; flat: boolean }
  | { kind: "water"; x: number; y: number }
  | { kind: "bases"; positions: Float32Array; ranges: Uint32Array; vertexClass: Uint8Array; origin: Origin }
  | { kind: "roadHeights"; positions: Float32Array; origin: Origin };

export type BasesResult = { bases: Float32Array; vertexBase: Float32Array };
export type RoadHeightsResult = { positions: Float32Array; heights: Float32Array };
export type JobResult = TileData | GroundTileData | WaterResult | BasesResult | RoadHeightsResult;

const decoder = new TextDecoder();

/** fetch (Range request via PMTiles) + decode + build. Same code in the worker and on the main thread. */
export async function loadTile(req: TileRequest): Promise<TileData> {
  const t0 = performance.now();
  // with terrain, start downloading the elevation (z13 parent + neighbours) alongside the OSM tile
  if (req.terrain) getGrid(req.x >> 1, req.y >> 1).catch(() => {});
  const overlay: Promise<OverlayTile | null> =
    req.layer === "building" && req.overlayRev !== undefined
      ? fetchOverlayTile(req.x, req.y, req.overlayRev).catch((err) => {
          console.warn("overlay tile:", err);
          return null; // OSM data as is rather than no tile
        })
      : Promise.resolve(null);
  const archives = await getArchives();
  const archive = req.layer === "building" ? archives.buildings : archives.roads;
  const tile = await archive.getZxy(TILE_Z, req.x, req.y);
  const edits = await overlay;
  const t1 = performance.now();
  const features = applyOverlay<TileFeature>(tile ? JSON.parse(decoder.decode(tile.data)).f : [], edits);
  const data =
    req.layer === "building"
      ? buildBuildingTile(features, req.x, req.y, req.origin)
      : buildRoadTile(features, req.x, req.y, req.origin);
  data.stats.fetchMs = t1 - t0;
  data.stats.buildMs = performance.now() - t1;
  data.stats.bytes = tile?.data.byteLength ?? 0;
  if (req.terrain) {
    const t2 = performance.now();
    if (data.layer === "building") {
      const r = await computeBuildingBases(data.positions, data.ranges, data.vertexClass, req.origin);
      data.terrain = { ...r, ms: performance.now() - t2 };
    } else {
      const r = await computeRoadHeights(data.positions, req.origin);
      data.terrain = { ...r, ms: performance.now() - t2 };
    }
  }
  return data;
}

export function handle(job: WorkerJob): Promise<JobResult> {
  switch (job.kind) {
    case "tile":
      return loadTile(job.req);
    case "ground":
      return loadGroundTile(job.x, job.y, job.origin, job.flat);
    case "water":
      return loadWaterSdf(job.x, job.y);
    case "bases":
      return computeBuildingBases(job.positions, job.ranges, job.vertexClass, job.origin);
    case "roadHeights":
      return computeRoadHeights(job.positions, job.origin);
  }
}

export function transferList(r: JobResult): Transferable[] {
  if ("kind" in r) return r.kind === "mixed" ? [r.sdf.buffer] : [];
  if ("layer" in r) {
    if (r.layer === "ground") return [r.positions.buffer, r.normals.buffer, r.uvs.buffer, r.index.buffer, ...(r.heights ? [r.heights.buffer] : [])];
    return transferables(r);
  }
  if ("vertexBase" in r) return [r.bases.buffer, r.vertexBase.buffer];
  const roads = r as RoadHeightsResult;
  return [roads.positions.buffer, roads.heights.buffer];
}
