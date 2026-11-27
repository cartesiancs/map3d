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

/** Edit mode views, as Blender's numpad: from above, from the south (front), from the east (right), … */
export type ViewDirection = "top" | "bottom" | "front" | "back" | "right" | "left";

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
  /** look at the view target from one side (Edit mode) */
  viewRequest: { seq: number; direction: ViewDirection };
  /** put a sphere (scene coordinates) in view, keeping the viewing direction */
  frameRequest: { seq: number; x: number; y: number; z: number; radius: number };

  select: (building: SelectedBuilding | null) => void;
  setShowRoads: (show: boolean) => void;
  setTerrain: (on: boolean) => void;
  setGroundMap: (on: boolean) => void;
  setLevel: (level: PerfLevel) => void;
  zoom: (factor: number) => void;
  focusBuilding: (ref: BuildingRef) => void;
  flyTo: (x: number, z: number, distance: number, instant?: boolean) => void;
  view: (direction: ViewDirection) => void;
  frame: (x: number, y: number, z: number, radius: number) => void;
};

export const useViewStore = create<ViewStore>((set, get) => ({
  selected: null,
  showRoads: false,
  ...loadGround(),
  level: defaultLevel(),
  zoomRequest: { seq: 0, factor: 1 },
  focusRequest: { seq: 0, ref: null },
  flyRequest: { seq: 0, x: 0, z: 0, distance: 0, instant: false },
  viewRequest: { seq: 0, direction: "top" },
  frameRequest: { seq: 0, x: 0, y: 0, z: 0, radius: 0 },

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
  view: (direction) => set((s) => ({ viewRequest: { seq: s.viewRequest.seq + 1, direction } })),
  frame: (x, y, z, radius) => set((s) => ({ frameRequest: { seq: s.frameRequest.seq + 1, x, y, z, radius } })),
}));
