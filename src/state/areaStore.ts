import { create } from "zustand";
import { BBox } from "@/api/osmSource";
import { makeOrigin } from "@/three/tiles/geo";

/** First view: the southern half of Central Park (59th to ~79th St) and the blocks beside it. */
export const DEFAULT_AREA: BBox = { south: 40.764, west: -73.981, north: 40.782, east: -73.9645 };

/** Scene origin (fixed for the session): center of the first view. */
export const ORIGIN = makeOrigin((DEFAULT_AREA.south + DEFAULT_AREA.north) / 2, (DEFAULT_AREA.west + DEFAULT_AREA.east) / 2);

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
