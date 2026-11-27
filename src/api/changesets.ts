// Changesets through the map3d API (worker/src/changesets.ts): propose changes to several buildings at once
// (Edit mode), follow your proposals, and (admins) review them, all or nothing.

import { API_URL } from "./auth";
import type { LngLat } from "@/contrib/validate";
import type { EncodedMesh } from "@/contrib/mesh";

export type Status = "pending" | "approved" | "rejected" | "withdrawn" | "conflict";
export type Kind = "modify" | "create" | "delete";

/** the fields an item changes; `mesh` (a free 3D shape) replaces footprint and height */
export type Proposal = {
  footprint?: LngLat[];
  height?: number | null;
  levels?: number | null;
  buildingType?: string | null;
  name?: string | null;
  mesh?: EncodedMesh;
};
export type BuildingBase = { footprint: LngLat[]; tags: Record<string, string> };

export type ItemSummary = {
  seq: number;
  /** way:<id> | new:<n>; null for a new building that is not approved yet */
  ref: string | null;
  /** the app's id of a new building */
  clientId: string | null;
  kind: Kind;
  /** "shape", "height", "levels", … */
  fields: string[];
};

export type Changeset = {
  id: string;
  status: Status;
  comment: string;
  reviewNote: string | null;
  /** the changeset that replaced this one ("Edit my proposal") */
  supersededBy: string | null;
  lng: number;
  lat: number;
  /** [west, south, east, north] of the changed buildings */
  bbox: [number, number, number, number];
  createdAt: string;
  reviewedAt: string | null;
  items: ItemSummary[];
};

export type Author = { id: number; login: string; avatarUrl: string | null; githubSince: string | null; approved: number; reviewed: number };

export type ReviewSummary = Changeset & {
  /** another change was approved after this one was written */
  stale: boolean;
  author: Author;
};

/** a building as it is approved now */
export type CurrentState = {
  footprint: LngLat[];
  height: number | null;
  levels: number | null;
  buildingType: string | null;
  name: string | null;
  mesh: EncodedMesh | null;
  deleted: boolean;
  updatedAt: string;
};

export type ItemDetail = ItemSummary & {
  proposal: Proposal;
  base: BuildingBase | null;
  baseRev: string;
  current: CurrentState | null;
  stale: boolean;
};

export type ChangesetDetail = Omit<Changeset, "items"> & { items: ItemDetail[]; stale: boolean; author: Author };

export type ItemInput = {
  ref?: string;
  clientId?: string;
  kind: Kind;
  base?: BuildingBase;
  /** the building's map3d:edited tag when editing started ('osm': never edited) */
  baseRev?: string;
  proposal?: Proposal;
};
export type SubmitRequest = { items: ItemInput[]; comment: string; acceptTerms?: boolean; supersedes?: string[] };

/** an API refusal, with the reasons to show */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly errors: string[] = [],
    /** buildings named by a conflict */
    readonly refs: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach the map3d server", 0, "network");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; errors?: string[]; refs?: string[] }) | null;
  if (!res.ok) {
    const code = data?.error ?? `HTTP ${res.status}`;
    throw new ApiError(data?.message ?? data?.errors?.[0] ?? code, res.status, code, data?.errors ?? [], data?.refs ?? []);
  }
  return data as T;
}

export const submitChangeset = (req: SubmitRequest) => call<{ id: string; status: Status }>("POST", "/changesets", req);
export const fetchMyChangesets = () => call<{ changesets: Changeset[] }>("GET", "/me/changesets").then((r) => r.changesets);
export const fetchChangeset = (id: string) => call<ChangesetDetail>("GET", `/changesets/${id}`);
export const withdrawChangeset = (id: string) => call<{ id: string }>("POST", `/changesets/${id}/withdraw`, {});
export const fetchReviewQueue = () => call<{ changesets: ReviewSummary[] }>("GET", "/changesets").then((r) => r.changesets);
export const approveChangeset = (id: string, force = false) =>
  call<{ id: string; rev: number; items: { seq: number; ref: string; kind: Kind }[] }>("POST", `/changesets/${id}/approve`, { force });
export const rejectChangeset = (id: string, note: string) => call<{ id: string }>("POST", `/changesets/${id}/reject`, { note });

/** building id in the tiles -> API ref (added buildings have negative ids) */
export const refOf = (id: number) => (id < 0 ? `new:${-id}` : `way:${id}`);
/** API ref -> building id in the tiles */
export const buildingIdOf = (ref: string | null) => (!ref ? null : ref.startsWith("new:") ? -Number(ref.slice(4)) : Number(ref.slice(4)));

const FIELD_LABEL: Record<string, string> = { shape: "Shape", height: "Height", levels: "Levels", buildingType: "Type", name: "Name" };

/** one-line summary of what an item changes */
export function describeItem(i: Pick<ItemSummary, "kind" | "fields">): string {
  if (i.kind === "delete") return "Removed";
  const fields = i.fields.map((f) => FIELD_LABEL[f] ?? f);
  if (i.kind === "create") return ["New building", ...fields.filter((f) => f !== "Shape" && f !== "Height")].join(" · ");
  return fields.join(" · ") || "Change";
}

/** one-line summary of a changeset: "3 buildings · Shape, Height" or the single item's summary */
export function describeChangeset(c: Pick<Changeset, "items">): string {
  if (c.items.length === 1) return describeItem(c.items[0]);
  const what = new Set<string>();
  for (const i of c.items) {
    if (i.kind === "delete") what.add("Removed");
    else if (i.kind === "create") what.add("New");
    else for (const f of i.fields) what.add(FIELD_LABEL[f] ?? f);
  }
  return `${c.items.length} buildings · ${[...what].join(", ")}`;
}

/** my changeset with this building that still waits for review */
export const pendingFor = (mine: Changeset[], ref: string) =>
  mine.find((c) => (c.status === "pending" || c.status === "conflict") && c.items.some((i) => i.ref === ref));
