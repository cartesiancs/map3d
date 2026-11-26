// Contributions through the map3d API (worker/src/contributions.ts): propose a building change, follow your
// proposals, and (admins) review them.

import { API_URL } from "./auth";
import type { BuildingEdit, LngLat } from "@/contrib/validate";

export type Proposal = Partial<BuildingEdit>;
export type Status = "pending" | "approved" | "rejected" | "withdrawn" | "conflict";
export type BuildingBase = { footprint: LngLat[]; tags: Record<string, string> };

export type Contribution = {
  id: string;
  /** way:<id> | new:<n>; null for a new building that is not approved yet */
  ref: string | null;
  kind: "modify" | "create";
  proposal: Proposal;
  comment: string;
  status: Status;
  reviewNote: string | null;
  lng: number;
  lat: number;
  createdAt: string;
  reviewedAt: string | null;
};

export type ReviewItem = Contribution & {
  base: BuildingBase | null;
  current: (BuildingEdit & { updatedAt: string }) | null;
  /** another change was approved after this one was written */
  stale: boolean;
  author: { id: number; login: string; avatarUrl: string | null; githubSince: string | null; approved: number; reviewed: number };
};

export type SubmitRequest = { ref?: string; base?: BuildingBase; proposal: Proposal; comment: string; acceptTerms?: boolean };

/** an API refusal, with the reasons to show */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly errors: string[] = [],
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
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; errors?: string[] }) | null;
  if (!res.ok) {
    const code = data?.error ?? `HTTP ${res.status}`;
    throw new ApiError(data?.message ?? data?.errors?.[0] ?? code, res.status, code, data?.errors ?? []);
  }
  return data as T;
}

export const submitContribution = (req: SubmitRequest) => call<{ id: string; status: Status }>("POST", "/contributions", req);
export const fetchMyContributions = () => call<{ contributions: Contribution[] }>("GET", "/me/contributions").then((r) => r.contributions);
export const withdrawContribution = (id: string) => call<{ id: string }>("POST", `/contributions/${id}/withdraw`, {});
export const fetchReviewQueue = () => call<{ contributions: ReviewItem[] }>("GET", "/contributions").then((r) => r.contributions);
export const approveContribution = (id: string, force = false) =>
  call<{ id: string; ref: string; rev: number }>("POST", `/contributions/${id}/approve`, { force });
export const rejectContribution = (id: string, note: string) => call<{ id: string }>("POST", `/contributions/${id}/reject`, { note });

/** building id in the tiles -> API ref (added buildings have negative ids) */
export const refOf = (id: number) => (id < 0 ? `new:${-id}` : `way:${id}`);

/** one-line summary of what a contribution changes */
export function describeProposal(c: Pick<Contribution, "kind" | "proposal">): string {
  const p = c.proposal;
  const parts: string[] = [];
  if (c.kind === "create") parts.push("New building");
  else if (p.footprint) parts.push("Shape");
  if (p.height != null) parts.push(`Height ${p.height} m`);
  if (p.levels != null) parts.push(`${p.levels} levels`);
  if (p.buildingType) parts.push(`Type ${p.buildingType.replace(/_/g, " ")}`);
  if (p.name) parts.push(`Name “${p.name}”`);
  return parts.join(" · ") || "Change";
}
