import { create } from "zustand";
import { Changeset, ReviewSummary, fetchMyChangesets, fetchReviewQueue } from "@/api/changesets";

/** what was right-clicked in the 3D view (in Edit mode: the edit menu, or X's delete menu) */
export type MenuTarget =
  | { kind: "building"; key: string; index: number; id: number; tags: Record<string, string>; lat: number; lng: number }
  | { kind: "ground"; lat: number; lng: number; x: number; z: number; distance: number }
  | { kind: "edit"; lat: number | null; lng: number | null }
  | { kind: "delete" }
  /** M: merge; `cursor` is the surface (or ground) point the mouse was on (scene coordinates) */
  | { kind: "merge"; cursor: [number, number, number] | null };

type ContribStore = {
  /** `seq` changes on every right-click, so the menu reopens at the new point */
  menu: { target: MenuTarget; x: number; y: number; seq: number } | null;
  panel: "mine" | "review" | null;
  /** my changesets, newest first */
  mine: Changeset[];
  /** admins: changesets waiting for review, oldest first */
  queue: ReviewSummary[];

  openMenu: (target: MenuTarget, x: number, y: number) => void;
  closeMenu: () => void;
  setPanel: (panel: "mine" | "review" | null) => void;
  loadMine: () => Promise<void>;
  loadQueue: () => Promise<void>;
  clear: () => void;
};

export const useContribStore = create<ContribStore>((set) => ({
  menu: null,
  panel: null,
  mine: [],
  queue: [],

  openMenu: (target, x, y) => set((s) => ({ menu: { target, x, y, seq: (s.menu?.seq ?? 0) + 1 } })),
  closeMenu: () => set({ menu: null }),
  setPanel: (panel) => set({ panel }),
  loadMine: async () => {
    try {
      set({ mine: await fetchMyChangesets() });
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
  clear: () => set({ mine: [], queue: [], panel: null, menu: null }),
}));
