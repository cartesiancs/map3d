export type PerfLevel = "low" | "medium" | "high";

export type LevelConfig = {
  /** highest device pixel ratio rendered (adaptive DPR may go lower) */
  dpr: number;
  antialias: boolean;
  /** max view radius around the camera target, scene units (1 unit ≈ 2.2 m) */
  radius: number;
  /** tiles drawn at once / kept in memory */
  maxTiles: number;
  cacheTiles: number;
  /** concurrent tile requests */
  inFlight: number;
  /** new tile meshes handed to the GPU per frame (spreads buffer uploads) */
  uploadsPerFrame: number;
  /** image-based lighting (MeshStandardMaterial + Environment) or cheap Lambert lighting */
  pbr: boolean;
  maxDistance: number;
  /** z13 ground tiles (terrain / ground map) drawn at once */
  groundTiles: number;
};

export const LEVELS: Record<PerfLevel, LevelConfig> = {
  low: { dpr: 1, antialias: false, radius: 1300, maxTiles: 9, cacheTiles: 16, inFlight: 4, uploadsPerFrame: 1, pbr: false, maxDistance: 1500, groundTiles: 9 },
  medium: { dpr: 1.5, antialias: true, radius: 2200, maxTiles: 20, cacheTiles: 32, inFlight: 6, uploadsPerFrame: 1, pbr: true, maxDistance: 2600, groundTiles: 16 },
  high: { dpr: 2, antialias: true, radius: 3600, maxTiles: 40, cacheTiles: 64, inFlight: 8, uploadsPerFrame: 2, pbr: true, maxDistance: 4200, groundTiles: 30 },
};

const STORAGE_KEY = "map3d.perfLevel";

export function defaultLevel(): PerfLevel {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "low" || saved === "medium" || saved === "high") return saved;
  } catch {}
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
  const memory = (navigator as any).deviceMemory as number | undefined;
  if (mobile) return memory !== undefined && memory <= 3 ? "low" : "medium";
  return memory !== undefined && memory <= 4 ? "medium" : "high";
}

export function saveLevel(level: PerfLevel) {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {}
}
