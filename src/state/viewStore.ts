import { create } from "zustand";
import { PerfLevel, defaultLevel, saveLevel } from "@/three/tiles/levels";

export type SelectedBuilding = {
  key: string;
  index: number;
  id: number;
  tags: Record<string, string>;
};

/** A building reference from search: tile key + index inside that tile. */
export type BuildingRef = { key: string; index: number };

const GROUND_KEY = "map3d.ground";

function loadGround(): { terrain: boolean; groundMap: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(GROUND_KEY) ?? "null");
    if (v && typeof v.terrain === "boolean" && typeof v.groundMap === "boolean") return { terrain: v.terrain, groundMap: v.groundMap };
  } catch {}
  return { terrain: true, groundMap: true };
}

function saveGround(v: { terrain: boolean; groundMap: boolean }) {
  try {
    localStorage.setItem(GROUND_KEY, JSON.stringify(v));
  } catch {}
}

type ViewStore = {
  selected: SelectedBuilding | null;
  showRoads: boolean;
  /** terrain relief under the city (buildings and roads follow it) */
  terrain: boolean;
  /** land / sea map on the ground only */
  groundMap: boolean;
  level: PerfLevel;
  /** each request bumps `seq`; the camera inside the Canvas applies it once */
  zoomRequest: { seq: number; factor: number };
  focusRequest: { seq: number; ref: BuildingRef | null };
  /** scene coordinates; `instant` jumps instead of flying (used after moving the origin) */
  flyRequest: { seq: number; x: number; z: number; distance: number; instant: boolean };

  select: (building: SelectedBuilding | null) => void;
  setShowRoads: (show: boolean) => void;
  setTerrain: (on: boolean) => void;
  setGroundMap: (on: boolean) => void;
  setLevel: (level: PerfLevel) => void;
  zoom: (factor: number) => void;
  focusBuilding: (ref: BuildingRef) => void;
  flyTo: (x: number, z: number, distance: number, instant?: boolean) => void;
};

export const useViewStore = create<ViewStore>((set, get) => ({
  selected: null,
  showRoads: false,
  ...loadGround(),
  level: defaultLevel(),
  zoomRequest: { seq: 0, factor: 1 },
  focusRequest: { seq: 0, ref: null },
  flyRequest: { seq: 0, x: 0, z: 0, distance: 0, instant: false },

  select: (selected) => set({ selected }),
  setShowRoads: (showRoads) => set({ showRoads }),
  setTerrain: (terrain) => {
    saveGround({ terrain, groundMap: get().groundMap });
    set({ terrain });
  },
  setGroundMap: (groundMap) => {
    saveGround({ terrain: get().terrain, groundMap });
    set({ groundMap });
  },
  setLevel: (level) => {
    saveLevel(level);
    set({ level });
  },
  zoom: (factor) => set((s) => ({ zoomRequest: { seq: s.zoomRequest.seq + 1, factor } })),
  focusBuilding: (ref) => set((s) => ({ focusRequest: { seq: s.focusRequest.seq + 1, ref } })),
  flyTo: (x, z, distance, instant = false) =>
    set((s) => ({ flyRequest: { seq: s.flyRequest.seq + 1, x, z, distance, instant } })),
}));
