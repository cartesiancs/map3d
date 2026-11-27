// Edit mode: a session in which several buildings are reshaped (free 3D meshes), raised, moved, removed or
// added, then sent for review together as one changeset (Contribute). The session holds the drafts
// (src/edit/drafts.ts), what is selected (whole buildings in Object mode; vertices, edges or faces in the
// other modes, across every building being edited) and an undo history of both.

import { create } from "zustand";
import type { ChangesetDetail } from "@/api/changesets";
import { fetchChangeset, pendingFor, refOf } from "@/api/changesets";
import type { LngLat } from "@/contrib/validate";
import { Draft, isChanged, newDraftId } from "@/edit/drafts";
import { draftsOf, loadDraft } from "@/edit/load";
import { Saved, loadSaved, save } from "@/edit/autosave";
import { ElemSel, convertSelection, emptySelection, selectEverything } from "@/edit/select";
import { boxMesh, withHeight } from "@/edit/transform";
import type { SnapTarget } from "@/three/edit/snapping";
import { useAuthStore } from "./authStore";
import { useContribStore } from "./contribStore";
import { useViewStore } from "./viewStore";
import { useCarStore } from "./carStore";

export type Mode = "object" | "vertex" | "edge" | "face";
export type Tool = "select" | "move" | "rotate" | "scale" | "height" | "extrude" | "inset" | "bevel" | "loopcut" | "knife" | "draw";
export type Pivot = "median" | "individual";
export type { ElemSel };

/** what undo / redo restore */
type Snapshot = {
  drafts: Map<string, Draft>;
  /** buildings selected (Object mode) — also the ones the element modes edit */
  objects: Set<string>;
  activeId: string | null;
  /** element selection per draft (vertex / edge / face modes) */
  elems: Map<string, ElemSel>;
};

const UNDO_STEPS = 100;

type EditStore = Snapshot & {
  active: boolean;
  mode: Mode;
  tool: Tool;
  pivot: Pivot;
  snap: boolean;
  /** what snapping snaps to */
  snapTo: SnapTarget[];
  /** pending changesets of mine this session replaces when submitted */
  supersedes: string[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** buildings being read into the session */
  loading: number;
  /** shown above the view while a modal operation runs ("Move · X · 5 m") */
  hint: string | null;
  dialog: "contribute" | "exit" | null;
  /** an earlier unsubmitted session, offered back on entering */
  restore: Saved | null;

  /** open Edit mode, optionally with a building (feature id) */
  enter: (featureId?: number) => Promise<void>;
  /** close, asking first when something changed */
  requestExit: () => void;
  /** close and discard (or keep the changes on this device, offered again next time) */
  exit: (keepSaved?: boolean) => void;
  /** a pending changeset of mine back into Edit mode (submitting replaces it) */
  reopen: (detail: ChangesetDetail) => Promise<void>;
  restoreSaved: (accept: boolean) => void;
  /** a building of the map into the session (and the selection) */
  addBuilding: (featureId: number, additive: boolean) => Promise<string | null>;

  select: (ids: string[], additive: boolean) => void;
  selectAll: () => void;
  deselectAll: () => void;
  setElems: (elems: Map<string, ElemSel>) => void;
  setMode: (mode: Mode) => void;
  setTool: (tool: Tool) => void;
  setPivot: (pivot: Pivot) => void;
  toggleSnap: () => void;
  setSnapTo: (to: SnapTarget[]) => void;
  setHint: (hint: string | null) => void;
  setDialog: (dialog: EditStore["dialog"]) => void;

  /** replace drafts (and optionally the selection) as one undo step */
  commit: (next: Partial<Snapshot>) => void;
  /** live changes of a modal operation: shown, not recorded until endModal(true) */
  beginModal: () => void;
  previewModal: (next: Partial<Snapshot>) => void;
  endModal: (keep: boolean) => void;
  undo: () => void;
  redo: () => void;

  deleteSelected: () => void;
  /** copies of the selected buildings (selected instead); `preview`: inside a modal operation already begun */
  duplicateSelected: (preview?: boolean) => string[];
  addBox: (at: LngLat) => string;
  addDraft: (draft: Draft) => void;
  setHeight: (id: string, height: number) => void;
  setLevels: (id: string, levels: number | null) => void;
  revert: (id: string) => void;
  /** after a successful Contribute */
  finish: () => void;
};

const snapshot = (s: Snapshot): Snapshot => ({ drafts: s.drafts, objects: s.objects, activeId: s.activeId, elems: s.elems });
let modalStart: Snapshot | null = null;

const EMPTY: Snapshot & Pick<EditStore, "mode" | "supersedes" | "undoStack" | "redoStack" | "loading" | "hint" | "dialog" | "restore"> = {
  drafts: new Map(),
  objects: new Set(),
  activeId: null,
  elems: new Map(),
  mode: "object",
  supersedes: [],
  undoStack: [],
  redoStack: [],
  loading: 0,
  hint: null,
  dialog: null,
  restore: null,
};

const notify = (text: string) => useAuthStore.getState().notify(text);

export const useEditStore = create<EditStore>((set, get) => {
  /** record the current state, then apply `next` */
  const record = (next: Partial<Snapshot>) =>
    set((s) => ({ ...next, undoStack: [...s.undoStack.slice(-(UNDO_STEPS - 1)), snapshot(s)], redoStack: [] }));

  const merge = (drafts: Draft[], supersede: string | null) => {
    const s = get();
    const map = new Map(s.drafts);
    for (const d of drafts) map.set(d.id, d);
    record({ drafts: map, objects: new Set(drafts.map((d) => d.id)), activeId: drafts[0]?.id ?? null });
    if (supersede && !s.supersedes.includes(supersede)) set({ supersedes: [...s.supersedes, supersede] });
  };

  return {
    ...EMPTY,
    active: false,
    tool: "move",
    pivot: "median",
    snap: false,
    snapTo: ["vertex", "edge"],

    enter: async (featureId) => {
      const user = useAuthStore.getState().user;
      if (!user) return;
      if (!get().active) {
        set({ ...EMPTY, drafts: new Map(), objects: new Set(), elems: new Map(), active: true, tool: "move" });
        // Edit mode owns the screen: other panels close
        useContribStore.getState().setPanel(null);
        useContribStore.getState().closeMenu();
        useViewStore.getState().select(null);
        useCarStore.getState().setThirdMode(false);
        // which of my changesets still wait for review (a review may have happened since the list was read)
        void useContribStore.getState().loadMine();
        // keys belong to the editor now: a button that kept the focus must not take Enter or Space
        (document.activeElement as HTMLElement | null)?.blur?.();
        const saved = await loadSaved(user.id);
        if (saved?.drafts.some(isChanged) && get().active) set({ restore: saved });
      }
      if (featureId !== undefined) await get().addBuilding(featureId, false);
    },

    requestExit: () => {
      if (modalStart) return;
      if ([...get().drafts.values()].some(isChanged)) set({ dialog: "exit" });
      else get().exit();
    },

    exit: (keepSaved = false) => {
      const user = useAuthStore.getState().user;
      const changed = [...get().drafts.values()].filter(isChanged);
      if (user) void save(user.id, keepSaved && changed.length ? { savedAt: new Date().toISOString(), drafts: changed, supersedes: get().supersedes } : null);
      modalStart = null;
      set({ ...EMPTY, drafts: new Map(), objects: new Set(), elems: new Map(), active: false });
    },

    reopen: async (detail) => {
      if (!get().active) await get().enter();
      if (!get().active) return;
      merge(draftsOf(detail), detail.id);
      notify("Your proposal is open: submitting replaces it");
    },

    restoreSaved: (accept) => {
      const saved = get().restore;
      set({ restore: null });
      if (!saved) return;
      if (!accept) {
        const user = useAuthStore.getState().user;
        if (user && !changedDrafts(get()).length) void save(user.id, null);
        return;
      }
      merge(saved.drafts.filter(isChanged), null);
      set((s) => ({ supersedes: [...new Set([...s.supersedes, ...saved.supersedes])] }));
    },

    addBuilding: async (featureId, additive) => {
      const id = refOf(featureId);
      if (get().drafts.has(id)) {
        get().select([id], additive);
        return id;
      }
      set((s) => ({ loading: s.loading + 1 }));
      try {
        // in one of my pending changesets: that whole changeset is reopened (submitting replaces it)
        const pending = pendingFor(useContribStore.getState().mine, id);
        if (pending && !get().supersedes.includes(pending.id)) {
          const detail = await fetchChangeset(pending.id);
          if (detail.status === "pending" || detail.status === "conflict") {
            await get().reopen(detail);
            return get().drafts.has(id) ? id : null;
          }
          // decided meanwhile (the list was old): edit the building as it is now
          void useContribStore.getState().loadMine();
        }
        const draft = await loadDraft(featureId);
        if (!get().active) return null;
        const drafts = new Map(get().drafts);
        drafts.set(id, draft);
        // loading a building into the session is not an edit: no undo step of its own
        set({ drafts });
        get().select([id], additive);
        return id;
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        set((s) => ({ loading: s.loading - 1 }));
      }
    },

    select: (ids, additive) => {
      const s = get();
      const objects = new Set(additive ? s.objects : []);
      for (const id of ids) {
        if (additive && objects.has(id) && ids.length === 1) objects.delete(id); // Shift+click toggles
        else objects.add(id);
      }
      const activeId = ids.length && objects.has(ids[ids.length - 1]) ? ids[ids.length - 1] : [...objects].pop() ?? null;
      set({ objects, activeId });
    },
    selectAll: () => {
      const s = get();
      if (s.mode === "object") return set({ objects: new Set([...s.drafts.values()].filter((d) => !d.deleted).map((d) => d.id)) });
      const elems = new Map(s.elems);
      for (const id of s.objects) {
        const d = s.drafts.get(id);
        if (d) elems.set(id, selectEverything(d.mesh, s.mode));
      }
      set({ elems });
    },
    deselectAll: () => {
      const s = get();
      if (s.mode === "object") set({ objects: new Set(), activeId: null });
      else set({ elems: new Map([...s.elems.keys()].map((k) => [k, emptySelection()])) });
    },
    setElems: (elems) => set({ elems }),

    setMode: (mode) => {
      const s = get();
      if (mode === s.mode || modalStart) return;
      if (mode !== "object") {
        const editable = [...s.objects].filter((id) => !s.drafts.get(id)?.deleted);
        if (!editable.length) return notify("Select a building first");
        const elems = new Map<string, ElemSel>();
        for (const id of editable) {
          const d = s.drafts.get(id)!;
          const prev = s.elems.get(id);
          elems.set(id, prev && s.mode !== "object" ? convertSelection(d.mesh, prev, s.mode, mode) : emptySelection());
        }
        const tool = ["height", "draw"].includes(s.tool) ? "move" : s.tool;
        return set({ mode, elems, objects: new Set(editable), tool });
      }
      const tool = ["extrude", "inset", "bevel", "loopcut", "knife"].includes(s.tool) ? "move" : s.tool;
      set({ mode, tool });
    },
    setTool: (tool) => set({ tool }),
    setPivot: (pivot) => set({ pivot }),
    toggleSnap: () => set((s) => ({ snap: !s.snap })),
    setSnapTo: (snapTo) => set({ snapTo, snap: snapTo.length > 0 }),
    setHint: (hint) => set({ hint }),
    setDialog: (dialog) => set({ dialog }),

    commit: (next) => record(next),
    beginModal: () => {
      modalStart = snapshot(get());
    },
    previewModal: (next) => {
      if (modalStart) set(next);
    },
    endModal: (keep) => {
      const start = modalStart;
      modalStart = null;
      if (!start) return;
      if (!keep) return set({ ...start, hint: null });
      set((s) => ({ undoStack: [...s.undoStack.slice(-(UNDO_STEPS - 1)), start], redoStack: [], hint: null }));
    },
    undo: () => {
      const s = get();
      if (modalStart || !s.undoStack.length) return;
      const prev = s.undoStack[s.undoStack.length - 1];
      set({ ...prev, undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, snapshot(s)] });
    },
    redo: () => {
      const s = get();
      if (modalStart || !s.redoStack.length) return;
      const next = s.redoStack[s.redoStack.length - 1];
      set({ ...next, redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, snapshot(s)] });
    },

    deleteSelected: () => {
      const s = get();
      if (!s.objects.size) return;
      const drafts = new Map(s.drafts);
      for (const id of s.objects) {
        const d = drafts.get(id);
        if (!d) continue;
        if (d.kind === "create") drafts.delete(id); // never submitted: just gone
        else drafts.set(id, { ...d, deleted: true });
      }
      record({ drafts, objects: new Set(), activeId: null });
    },
    duplicateSelected: (preview = false) => {
      const s = get();
      const drafts = new Map(s.drafts);
      const ids: string[] = [];
      for (const id of s.objects) {
        const d = drafts.get(id);
        if (!d || d.deleted) continue;
        const copy: Draft = { id: newDraftId(), ref: null, featureId: null, kind: "create", base: null, baseRev: "new", tags: {}, original: null, originalLevels: null, mesh: d.mesh, levels: d.levels, deleted: false };
        drafts.set(copy.id, copy);
        ids.push(copy.id);
      }
      if (ids.length) {
        const next = { drafts, objects: new Set(ids), activeId: ids[ids.length - 1] };
        if (preview) get().previewModal(next);
        else record(next);
      }
      return ids;
    },
    addBox: (at) => {
      const draft: Draft = { id: newDraftId(), ref: null, featureId: null, kind: "create", base: null, baseRev: "new", tags: {}, original: null, originalLevels: null, mesh: boxMesh(at), levels: null, deleted: false };
      get().addDraft(draft);
      return draft.id;
    },
    addDraft: (draft) => {
      const drafts = new Map(get().drafts);
      drafts.set(draft.id, draft);
      record({ drafts, objects: new Set([draft.id]), activeId: draft.id });
    },
    setHeight: (id, height) => {
      const d = get().drafts.get(id);
      if (!d || !(height > 0)) return;
      const drafts = new Map(get().drafts);
      drafts.set(id, { ...d, mesh: withHeight(d.mesh, height) });
      record({ drafts });
    },
    setLevels: (id, levels) => {
      const d = get().drafts.get(id);
      if (!d) return;
      const drafts = new Map(get().drafts);
      drafts.set(id, { ...d, levels });
      record({ drafts });
    },
    revert: (id) => {
      const s = get();
      const d = s.drafts.get(id);
      if (!d) return;
      const drafts = new Map(s.drafts);
      const objects = new Set(s.objects);
      if (d.kind === "create") {
        drafts.delete(id);
        objects.delete(id);
      } else drafts.set(id, { ...d, mesh: d.original!, levels: d.originalLevels, deleted: false });
      const elems = new Map(s.elems);
      elems.delete(id);
      record({ drafts, objects, elems, activeId: objects.has(s.activeId ?? "") ? s.activeId : null });
    },
    finish: () => {
      const user = useAuthStore.getState().user;
      if (user) void save(user.id, null);
      modalStart = null;
      set({ ...EMPTY, drafts: new Map(), objects: new Set(), elems: new Map(), active: false });
    },
  };
});

// keep unsubmitted work across reloads (debounced; the last state wins)
let saveTimer: number | undefined;
useEditStore.subscribe((s, prev) => {
  if (!s.active || (s.drafts === prev.drafts && s.supersedes === prev.supersedes)) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const user = useAuthStore.getState().user;
    const now = useEditStore.getState();
    if (!user || !now.active) return;
    const changed = [...now.drafts.values()].filter(isChanged);
    void save(user.id, changed.length ? { savedAt: new Date().toISOString(), drafts: changed, supersedes: now.supersedes } : null);
  }, 800);
});

/** the buildings that would be submitted */
export const changedDrafts = (s: Pick<Snapshot, "drafts">) => [...s.drafts.values()].filter(isChanged);
