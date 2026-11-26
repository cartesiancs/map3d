import { create } from "zustand";
import { Contribution, ReviewItem, fetchMyContributions, fetchReviewQueue } from "@/api/contributions";

/** what was right-clicked in the 3D view */
export type MenuTarget =
  | { kind: "building"; key: string; index: number; id: number; tags: Record<string, string>; lat: number; lng: number }
  | { kind: "ground"; lat: number; lng: number; x: number; z: number; distance: number };

/** a building being given a new height (Set height…) */
export type HeightEdit = {
  key: string;
  index: number;
  id: number;
  tags: Record<string, string>;
  lat: number;
  lng: number;
  /** the height shown now (building height units) */
  height: number;
};

type ContribStore = {
  /** `seq` changes on every right-click, so the menu reopens at the new point */
  menu: { target: MenuTarget; x: number; y: number; seq: number } | null;
  heightEdit: HeightEdit | null;
  panel: "mine" | "review" | null;
  mine: Contribution[];
  queue: ReviewItem[];

  openMenu: (target: MenuTarget, x: number, y: number) => void;
  closeMenu: () => void;
  startHeightEdit: (edit: HeightEdit) => void;
  closeHeightEdit: () => void;
  setPanel: (panel: "mine" | "review" | null) => void;
  loadMine: () => Promise<void>;
  loadQueue: () => Promise<void>;
  clear: () => void;
};

export const useContribStore = create<ContribStore>((set) => ({
  menu: null,
  heightEdit: null,
  panel: null,
  mine: [],
  queue: [],

  openMenu: (target, x, y) => set((s) => ({ menu: { target, x, y, seq: (s.menu?.seq ?? 0) + 1 } })),
  closeMenu: () => set({ menu: null }),
  startHeightEdit: (heightEdit) => set({ heightEdit, menu: null }),
  closeHeightEdit: () => set({ heightEdit: null }),
  setPanel: (panel) => set({ panel }),
  loadMine: async () => {
    try {
      set({ mine: await fetchMyContributions() });
    } catch (err) {
      console.warn("my contributions:", err);
    }
  },
  loadQueue: async () => {
    try {
      set({ queue: await fetchReviewQueue() });
    } catch (err) {
      console.warn("review queue:", err);
    }
  },
  clear: () => set({ mine: [], queue: [], panel: null, heightEdit: null, menu: null }),
}));

/** my proposal for a building that still waits for review */
export const pendingFor = (mine: Contribution[], ref: string) => mine.find((c) => c.ref === ref && (c.status === "pending" || c.status === "conflict"));
