import { create } from "zustand";
import { BBox } from "@/api/osmSource";
import { makeOrigin } from "@/three/tiles/geo";
import { loadLastView } from "./lastView";

/** First view: the southern half of Central Park (59th to ~79th St) and the blocks beside it. */
export const DEFAULT_AREA: BBox = { south: 40.764, west: -73.981, north: 40.782, east: -73.9645 };

export const DEFAULT_CENTER = { lat: (DEFAULT_AREA.south + DEFAULT_AREA.north) / 2, lng: (DEFAULT_AREA.west + DEFAULT_AREA.east) / 2 };

/** where this browser's last visit left off (null on the first visit): the session starts there */
export const START_VIEW = loadLastView();

/** Scene origin (moved only after long travels, see TileManager.rebase): center of the first view. */
export const ORIGIN = makeOrigin(START_VIEW?.lat ?? DEFAULT_CENTER.lat, START_VIEW?.lng ?? DEFAULT_CENTER.lng);

export type NamedBuilding = { key: string; index: number; id: number; label: string; sub: string };

type AreaStore = {
  /** lat/lng under the camera target */
  center: { lat: number; lng: number };
  stats: { tiles: number; buildings: number; loading: number; failed: number };
  /** named buildings in the loaded tiles (for search) */
  named: NamedBuilding[];

  setCenter: (center: { lat: number; lng: number }) => void;
  setStats: (stats: AreaStore["stats"]) => void;
  setNamed: (named: NamedBuilding[]) => void;
};

export const useAreaStore = create<AreaStore>((set) => ({
  center: { lat: ORIGIN.lat, lng: ORIGIN.lng },
  stats: { tiles: 0, buildings: 0, loading: 0, failed: 0 },
  named: [],
  setCenter: (center) => set({ center }),
  setStats: (stats) => set({ stats }),
  setNamed: (named) => set({ named }),
}));
