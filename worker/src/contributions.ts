// Contributions (phase 3, CONTRIBUTION-DESIGN.md §4.5–4.6, §5): signed-in users propose a change to a
// building, admins approve or reject it in the review queue. Approving writes the override and publishes the
// overlay (overlay.ts), exactly like a direct admin edit.
//
// A proposal holds only the fields it changes. On approval they are laid over the building's current state:
// its override if it has one, else the original OSM footprint sent with the proposal (`base`).
// Conflicts: `base_rev` is the override's updated_at when editing started ('osm' when there was none). If
// another change was approved since, approval stops with 409 and the contribution becomes 'conflict'; the
// admin can then reject it or approve anyway (`force`).

import type { Env } from "./index";
import { audit, requireUser, SessionUser } from "./auth";
import { json } from "./http";
import { InputError, OverrideRow, setOverride } from "./overlay";
import { BuildingEdit, LngLat, validateEdit } from "../../src/contrib/validate";
import { isEnglishText } from "../../src/utils/english";

export const RULES = {
  commentMin: 10,
  commentMax: 500,
  noteMax: 500,
  pendingPerUser: 50,
  perDay: 100,
  perDayNewAccount: 10,
  newAccountDays: 7,
  /** an edited footprint must stay this close to the original (no moving buildings across town) */
  maxMoveM: 200,
  maxBaseVertices: 2000,
  maxBaseTagsBytes: 20_000,
};

export type Proposal = Partial<BuildingEdit>;
type Base = { footprint: LngLat[]; tags: Record<string, string> };
type Status = "pending" | "approved" | "rejected" | "withdrawn" | "conflict";

type Row = {
  id: string;
  building_ref: string | null;
  kind: "modify" | "create";
  proposal: string;
  base: string | null;
  base_rev: string;
  comment: string;
  author_id: number;
  status: Status;
  reviewer_id: number | null;
  review_note: string | null;
  lng: number;
  lat: number;
  created_at: string;
  reviewed_at: string | null;
};

type SubmitInput = {
  /** way:<id> or new:<n> to change a building; absent to add a new one */
  ref?: string;
  /** the building as the contributor saw it (required for a way that has no override yet) */
  base?: Base;
  proposal: Proposal;
  comment: string;
  /** "contributions are published under ODbL 1.0", asked on the first contribution */
  acceptTerms?: boolean;
};

const PROPOSAL_KEYS = ["footprint", "height", "levels", "buildingType", "name"] as const;

function centroid(ring: LngLat[]): LngLat {
  let x = 0;
  let y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

function distanceM([lng1, lat1]: LngLat, [lng2, lat2]: LngLat) {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lng2 - lng1) * k, lat2 - lat1) * 111_195;
}

const isPoints = (v: unknown): v is LngLat[] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)));

/** The full edit an approval writes: the current state with the proposal on top. */
function fullEdit(current: OverrideRow | null, base: Base | null, p: Proposal): BuildingEdit {
  const cur: BuildingEdit = current
    ? { footprint: JSON.parse(current.footprint), height: current.height, levels: current.levels, buildingType: current.building_type, name: current.name }
    : { footprint: base?.footprint ?? [], height: null, levels: null, buildingType: null, name: null };
  const pick = <K extends keyof BuildingEdit>(k: K) => (p[k] !== undefined ? p[k] : cur[k]) as BuildingEdit[K];
  return { footprint: pick("footprint"), height: pick("height"), levels: pick("levels"), buildingType: pick("buildingType"), name: pick("name") };
}

/** what the proposal sets, checked against the building it applies to */
function checkProposal(kind: Row["kind"], current: OverrideRow | null, base: Base | null, p: Proposal): string[] {
  if (!PROPOSAL_KEYS.some((k) => p[k] !== undefined)) return ["the proposal changes nothing"];
  if (kind === "create" && !p.footprint) return ["a new building needs a footprint"];
  const edit = fullEdit(current, base, p);
  const errors = validateEdit(edit, { checkShape: p.footprint !== undefined });
  if (!errors.length && kind === "modify" && p.footprint) {
    const before = current ? (JSON.parse(current.footprint) as LngLat[]) : base?.footprint;
    if (before?.length && distanceM(centroid(before), centroid(p.footprint)) > RULES.maxMoveM) {
      errors.push(`an edited building must stay within ${RULES.maxMoveM} m of where it was`);
    }
  }
  return errors;
}

const getOverride = (env: Env, ref: string | null) =>
  ref ? env.DB.prepare("SELECT * FROM overrides WHERE ref = ?").bind(ref).first<OverrideRow>() : Promise.resolve(null);

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function rateLimited(env: Env, user: SessionUser): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT SUM(status = 'pending') AS pending,
            SUM(created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS today
     FROM contributions WHERE author_id = ?`,
  )
    .bind(user.id)
    .first<{ pending: number | null; today: number | null }>();
  if ((r?.pending ?? 0) >= RULES.pendingPerUser) return `you have ${RULES.pendingPerUser} contributions waiting for review: please wait for those first`;
  const created = user.githubCreatedAt ? Date.parse(user.githubCreatedAt) : NaN;
  const isNew = !Number.isFinite(created) || Date.now() - created < RULES.newAccountDays * 86_400_000;
  const perDay = isNew ? RULES.perDayNewAccount : RULES.perDay;
  if ((r?.today ?? 0) >= perDay) return `daily limit reached (${perDay} contributions)`;
  return null;
}

/** POST /contributions */
export async function submit(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env, { write: true });
  if (auth.error) return auth.error;
  const user = auth.user;
  const input = await readJson<SubmitInput>(req);
  if (!input || typeof input !== "object" || !input.proposal || typeof input.proposal !== "object") {
    return json(req, env, { error: "invalid request" }, 400);
  }
  if (!user.acceptedTerms && input.acceptTerms !== true) {
    return json(req, env, { error: "terms", message: "Contributions are published under the ODbL 1.0: accept this to continue." }, 400);
  }

  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  const errors: string[] = [];
  if (comment.length < RULES.commentMin || comment.length > RULES.commentMax || !isEnglishText(comment)) {
    errors.push(`describe the change in English (${RULES.commentMin}–${RULES.commentMax} characters)`);
  }

  const proposal: Proposal = {};
  for (const k of PROPOSAL_KEYS) if (input.proposal[k] !== undefined) (proposal as Record<string, unknown>)[k] = input.proposal[k];

  let kind: Row["kind"];
  let ref: string | null = null;
  let base: Base | null = null;
  let current: OverrideRow | null = null;
  if (input.ref === undefined) {
    kind = "create";
  } else if (typeof input.ref === "string" && /^(way|new):[1-9]\d{0,15}$/.test(input.ref)) {
    kind = "modify";
    ref = input.ref;
    current = await getOverride(env, ref);
    if (ref.startsWith("new:") && !current) return json(req, env, { error: "unknown building" }, 404);
    if (input.base !== undefined) {
      const b = input.base;
      const tagsOk = b && typeof b.tags === "object" && b.tags !== null && !Array.isArray(b.tags) && Object.values(b.tags).every((v) => typeof v === "string");
      if (!b || !isPoints(b.footprint) || b.footprint.length < 3 || b.footprint.length > RULES.maxBaseVertices || !tagsOk || JSON.stringify(b.tags).length > RULES.maxBaseTagsBytes) {
        return json(req, env, { error: "invalid base" }, 400);
      }
      base = { footprint: b.footprint, tags: b.tags };
    }
    if (!current && !base) return json(req, env, { error: "base is required to edit an OSM building" }, 400);
  } else {
    return json(req, env, { error: "bad ref" }, 400);
  }

  errors.push(...checkProposal(kind, current, base, proposal));
  if (errors.length) return json(req, env, { error: "invalid contribution", errors }, 400);

  const limited = await rateLimited(env, user);
  if (limited) return json(req, env, { error: "rate limited", message: limited }, 429);

  if (!user.acceptedTerms) {
    await env.DB.prepare("UPDATE users SET accepted_terms_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE github_id = ?").bind(user.id).run();
    await audit(env, user.id, "terms_accepted", { license: "ODbL-1.0" });
  }
  // a new proposal for the same building replaces the author's pending one ("Edit my proposal")
  if (ref) {
    await env.DB.prepare(
      "UPDATE contributions SET status = 'withdrawn', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_id = ? AND building_ref = ? AND status IN ('pending', 'conflict')",
    )
      .bind(user.id, ref)
      .run();
  }
  const where = centroid(fullEdit(current, base, proposal).footprint);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO contributions (id, building_ref, kind, proposal, base, base_rev, comment, author_id, lng, lat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, ref, kind, JSON.stringify(proposal), base && JSON.stringify(base), current?.updated_at ?? (kind === "create" ? "new" : "osm"), comment, user.id, where[0], where[1])
    .run();
  await audit(env, user.id, "contribution_submitted", { kind, proposal }, id);
  return json(req, env, { id, status: "pending" }, 201);
}

const publicRow = (r: Row) => ({
  id: r.id,
  ref: r.building_ref,
  kind: r.kind,
  proposal: JSON.parse(r.proposal) as Proposal,
  comment: r.comment,
  status: r.status,
  reviewNote: r.review_note,
  lng: r.lng,
  lat: r.lat,
  createdAt: r.created_at,
  reviewedAt: r.reviewed_at,
});

/** GET /me/contributions */
export async function mine(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare("SELECT * FROM contributions WHERE author_id = ? ORDER BY created_at DESC LIMIT 100").bind(auth.user.id).all<Row>();
  return json(req, env, { contributions: results.map(publicRow) });
}

/** POST /contributions/<id>/withdraw (the author, while it waits for review) */
export async function withdraw(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true });
  if (auth.error) return auth.error;
  const row = await env.DB.prepare(
    "UPDATE contributions SET status = 'withdrawn', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_id = ? AND status IN ('pending', 'conflict') RETURNING id",
  )
    .bind(id, auth.user.id)
    .first();
  if (!row) return json(req, env, { error: "nothing to withdraw" }, 404);
  await audit(env, auth.user.id, "contribution_withdrawn", {}, id);
  return json(req, env, { id, status: "withdrawn" });
}

/** GET /contributions (admin): the review queue, oldest first, with what is needed to judge each one */
export async function queue(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env, { admin: true });
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.login AS author_login, u.avatar_url AS author_avatar, u.github_created_at AS author_since,
       (SELECT COUNT(*) FROM contributions x WHERE x.author_id = c.author_id AND x.status = 'approved') AS author_approved,
       (SELECT COUNT(*) FROM contributions x WHERE x.author_id = c.author_id AND x.status IN ('approved', 'rejected')) AS author_reviewed
     FROM contributions c JOIN users u ON u.github_id = c.author_id
     WHERE c.status IN ('pending', 'conflict') ORDER BY c.created_at ASC LIMIT 200`,
  ).all<Row & { author_login: string; author_avatar: string | null; author_since: string | null; author_approved: number; author_reviewed: number }>();
  const items = await Promise.all(
    results.map(async (r) => {
      const current = await getOverride(env, r.building_ref);
      return {
        ...publicRow(r),
        base: r.base ? (JSON.parse(r.base) as Base) : null,
        current: current && { footprint: JSON.parse(current.footprint) as LngLat[], height: current.height, levels: current.levels, buildingType: current.building_type, name: current.name, updatedAt: current.updated_at },
        /** another change was approved after this one was written */
        stale: r.kind === "modify" && r.base_rev !== (current?.updated_at ?? "osm"),
        author: { id: r.author_id, login: r.author_login, avatarUrl: r.author_avatar, githubSince: r.author_since, approved: r.author_approved, reviewed: r.author_reviewed },
      };
    }),
  );
  return json(req, env, { contributions: items });
}

/** POST /contributions/<id>/approve  { force?, note? } (admin) */
export async function approve(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true, admin: true });
  if (auth.error) return auth.error;
  const body = (await readJson<{ force?: boolean; note?: string }>(req)) ?? {};
  const row = await env.DB.prepare("SELECT * FROM contributions WHERE id = ?").bind(id).first<Row>();
  if (!row) return json(req, env, { error: "not found" }, 404);
  if (row.status !== "pending" && row.status !== "conflict") return json(req, env, { error: `already ${row.status}` }, 409);

  const current = await getOverride(env, row.building_ref);
  if (row.kind === "modify" && row.base_rev !== (current?.updated_at ?? "osm") && body.force !== true) {
    await env.DB.prepare("UPDATE contributions SET status = 'conflict' WHERE id = ?").bind(id).run();
    return json(req, env, { error: "conflict", message: "The building changed after this was proposed. Compare, then reject or approve anyway." }, 409);
  }
  const base = row.base ? (JSON.parse(row.base) as Base) : null;
  const proposal = JSON.parse(row.proposal) as Proposal;
  if (row.building_ref?.startsWith("new:") && !current) return json(req, env, { error: "the building was removed" }, 409);
  const errors = checkProposal(row.kind, current, base, proposal);
  if (errors.length) return json(req, env, { error: "invalid contribution", errors }, 400);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, RULES.noteMax) || null : null;
  try {
    const r = await setOverride(
      env,
      { ref: row.building_ref ?? undefined, baseFootprint: base?.footprint, baseTags: base?.tags, edit: fullEdit(current, base, proposal), contributionId: id },
      auth.user.id,
    );
    await env.DB.prepare(
      "UPDATE contributions SET status = 'approved', building_ref = ?, reviewer_id = ?, review_note = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(r.ref, auth.user.id, note, id)
      .run();
    await audit(env, auth.user.id, "contribution_approved", { ref: r.ref, rev: r.rev, forced: body.force === true }, id);
    return json(req, env, { id, status: "approved", ref: r.ref, rev: r.rev });
  } catch (err) {
    if (err instanceof InputError) return json(req, env, { error: err.message }, 400);
    throw err;
  }
}

/** POST /contributions/<id>/reject  { note } (admin; the reason is shown to the author) */
export async function reject(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true, admin: true });
  if (auth.error) return auth.error;
  const body = await readJson<{ note?: string }>(req);
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (note.length < 3 || note.length > RULES.noteMax) return json(req, env, { error: "a reason is required" }, 400);
  const row = await env.DB.prepare(
    "UPDATE contributions SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status IN ('pending', 'conflict') RETURNING id",
  )
    .bind(auth.user.id, note, id)
    .first();
  if (!row) return json(req, env, { error: "not pending" }, 409);
  await audit(env, auth.user.id, "contribution_rejected", { note }, id);
  return json(req, env, { id, status: "rejected" });
}
