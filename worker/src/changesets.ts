// Changesets (Edit mode): a signed-in user proposes changes to several buildings at once — new shapes (an
// extruded footprint or a free 3D mesh), heights, removals, new buildings — with one comment. Admins approve
// or reject the whole changeset; approving writes every override in one batch and publishes the overlay
// (overlay.ts), exactly like a direct admin edit.
//
// An item holds only the fields it changes. On approval they are laid over the building's current state:
// its override if it has one, else the original OSM footprint sent with the proposal (`base`).
// Conflicts: an item's `base_rev` is the override's updated_at when editing started ('osm' when there was
// none). If another change was approved since for any item, approval stops with 409 and the changeset
// becomes 'conflict'; the admin can then reject it or approve anyway (`force`).

import type { Env } from "./index";
import { audit, requireUser, SessionUser } from "./auth";
import { json } from "./http";
import { InputError, OverrideEdit, OverrideRow, newBuildingNumber, overrideStatement, publish } from "./overlay";
import { LngLat, validateEdit } from "../../src/contrib/validate";
import {
  EncodedMesh,
  MESH_LIMITS,
  classifyPrism,
  decodeMesh,
  encodeMesh,
  encodedBytes,
  encodedMeshError,
  meshHeight,
  meshOutline,
  validateMesh,
} from "../../src/contrib/mesh";
import { isEnglishText } from "../../src/utils/english";

export const RULES = {
  commentMin: 10,
  commentMax: 500,
  noteMax: 500,
  maxBodyBytes: 1_000_000,
  itemsPerChangeset: 50,
  itemsPerChangesetNewAccount: 10,
  pendingPerUser: 10,
  perDay: 20,
  perDayNewAccount: 3,
  newAccountDays: 7,
  /** an edited building must stay this close to where it was (no moving buildings across town) */
  maxMoveM: 200,
  /** the buildings of one changeset lie within a box this wide and tall */
  maxSpanM: 1000,
  maxBaseVertices: 2000,
  maxBaseTagsBytes: 20_000,
};

export type Proposal = {
  footprint?: LngLat[];
  height?: number | null;
  levels?: number | null;
  buildingType?: string | null;
  name?: string | null;
  /** a free 3D shape (src/contrib/mesh.ts); replaces footprint and height */
  mesh?: EncodedMesh;
};
type Base = { footprint: LngLat[]; tags: Record<string, string> };
type Status = "pending" | "approved" | "rejected" | "withdrawn" | "conflict";
type Kind = "modify" | "create" | "delete";

type ChangesetRow = {
  id: string;
  author_id: number;
  comment: string;
  status: Status;
  superseded_by: string | null;
  reviewer_id: number | null;
  review_note: string | null;
  lng: number;
  lat: number;
  bbox: string;
  item_count: number;
  created_at: string;
  reviewed_at: string | null;
};

type ItemRow = {
  changeset_id: string;
  seq: number;
  building_ref: string | null;
  client_id: string | null;
  kind: Kind;
  proposal: string;
  base: string | null;
  base_rev: string;
};

type ItemInput = {
  /** way:<id> or new:<n>; absent for a new building */
  ref?: string;
  /** the app's id for a new building (comes back with the changeset, for its drafts) */
  clientId?: string;
  kind: Kind;
  /** the building as the contributor saw it (required for a way that has no override yet) */
  base?: Base;
  /** overrides.updated_at the contributor started from ('osm': no override): tags["map3d:edited"] in the app */
  baseRev?: string;
  proposal?: Proposal;
};

type SubmitInput = {
  items: ItemInput[];
  comment: string;
  /** "contributions are published under ODbL 1.0", asked on the first contribution */
  acceptTerms?: boolean;
  /** the author's pending changesets this one replaces ("Edit my proposal"): withdrawn with it */
  supersedes?: string[];
};

const PROPOSAL_KEYS = ["footprint", "height", "levels", "buildingType", "name", "mesh"] as const;
const REF = /^(way|new):[1-9]\d{0,15}$/;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

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

/** the same corners in the same cyclic order (either direction, any start) */
function sameRing(a: LngLat[], b: LngLat[]) {
  if (a.length !== b.length) return false;
  const k = (p: LngLat) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
  const A = a.map(k);
  const B = b.map(k);
  const start = B.indexOf(A[0]);
  if (start < 0) return false;
  const n = A.length;
  const forward = A.every((v, i) => v === B[(start + i) % n]);
  const backward = A.every((v, i) => v === B[(start - i + n) % n]);
  return forward || backward;
}

const parseOverride = (row: OverrideRow): OverrideEdit => ({
  footprint: JSON.parse(row.footprint),
  height: row.height,
  levels: row.levels,
  buildingType: row.building_type,
  name: row.name,
  mesh: row.mesh ? (JSON.parse(row.mesh) as EncodedMesh) : null,
  deleted: !!row.deleted,
});

/**
 * A proposal in its stored form: a mesh is checked, and kept as footprint + height when it is just an
 * extruded footprint (the OpenStreetMap way). A footprint that only changes where it starts is no change.
 */
export function canonicalProposal(p: Proposal, before: LngLat[] | null): { proposal: Proposal; errors: string[] } {
  const out: Proposal = {};
  for (const k of PROPOSAL_KEYS) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  if (out.mesh !== undefined) {
    const err = encodedMeshError(out.mesh);
    if (err) return { proposal: out, errors: [err] };
    if (encodedBytes(out.mesh) > MESH_LIMITS.maxBytes) return { proposal: out, errors: [`a mesh is at most ${MESH_LIMITS.maxBytes / 1000} KB`] };
    const m = decodeMesh(out.mesh);
    const errors = validateMesh(m);
    if (errors.length) return { proposal: out, errors };
    const prism = classifyPrism(m);
    if (prism) {
      delete out.mesh;
      out.footprint = prism.footprint;
      out.height = prism.height;
    } else {
      delete out.footprint;
      delete out.height;
    }
  }
  if (out.footprint !== undefined && !isPoints(out.footprint)) return { proposal: out, errors: ["footprint must be a list of [lng, lat] points"] };
  if (out.footprint && before && sameRing(out.footprint, before)) delete out.footprint;
  return { proposal: out, errors: [] };
}

/** The full state an approval writes: the current state with the proposal on top. */
function fullEdit(kind: Kind, current: OverrideRow | null, base: Base | null, p: Proposal): OverrideEdit {
  const cur: OverrideEdit = current
    ? parseOverride(current)
    : { footprint: base?.footprint ?? [], height: null, levels: null, buildingType: null, name: null, mesh: null, deleted: false };
  if (kind === "delete") return { ...cur, deleted: true };
  const out: OverrideEdit = { ...cur, deleted: false };
  if (p.mesh) {
    const m = decodeMesh(p.mesh);
    out.mesh = p.mesh;
    out.footprint = meshOutline(m);
    out.height = Math.round(meshHeight(m) * 1000) / 1000;
  } else if (p.footprint !== undefined) {
    out.footprint = p.footprint;
    out.mesh = null;
  }
  if (p.height !== undefined && !p.mesh) {
    if (out.mesh && p.height != null) {
      // a mesh building given a new height: scaled up from its ground, as the app previews it
      const m = decodeMesh(out.mesh);
      const h0 = meshHeight(m);
      if (h0 > 0) for (let i = 1; i < m.verts.length; i += 3) m.verts[i] *= p.height / h0;
      out.mesh = encodeMesh(m);
    }
    out.height = p.height;
  }
  for (const k of ["levels", "buildingType", "name"] as const) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

/** what an item sets, checked against the building it applies to */
function checkItem(kind: Kind, current: OverrideRow | null, base: Base | null, p: Proposal): string[] {
  if (current?.deleted && kind !== "create") return ["the building was removed"];
  if (kind === "delete") return current || base ? [] : ["unknown building"];
  if (!PROPOSAL_KEYS.some((k) => p[k] !== undefined)) return ["the proposal changes nothing"];
  if (kind === "create" && !p.mesh && !(p.footprint && p.height != null)) return ["a new building needs a shape and a height"];
  const edit = fullEdit(kind, current, base, p);
  const errors = validateEdit(edit, { checkShape: p.footprint !== undefined && !p.mesh });
  if (!errors.length && kind === "modify" && (p.footprint || p.mesh)) {
    const before = current ? (JSON.parse(current.footprint) as LngLat[]) : base?.footprint;
    if (before?.length && distanceM(centroid(before), centroid(edit.footprint)) > RULES.maxMoveM) {
      errors.push(`an edited building must stay within ${RULES.maxMoveM} m of where it was`);
    }
  }
  return errors;
}

const getOverride = (env: Env, ref: string | null) =>
  ref ? env.DB.prepare("SELECT * FROM overrides WHERE ref = ?").bind(ref).first<OverrideRow>() : Promise.resolve(null);

const isNewAccount = (user: SessionUser) => {
  const created = user.githubCreatedAt ? Date.parse(user.githubCreatedAt) : NaN;
  return !Number.isFinite(created) || Date.now() - created < RULES.newAccountDays * 86_400_000;
};

async function rateLimited(env: Env, user: SessionUser): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT SUM(status = 'pending' OR status = 'conflict') AS pending,
            SUM(created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS today
     FROM changesets WHERE author_id = ?`,
  )
    .bind(user.id)
    .first<{ pending: number | null; today: number | null }>();
  if ((r?.pending ?? 0) >= RULES.pendingPerUser) return `you have ${RULES.pendingPerUser} changesets waiting for review: please wait for those first`;
  const perDay = isNewAccount(user) ? RULES.perDayNewAccount : RULES.perDay;
  if ((r?.today ?? 0) >= perDay) return `daily limit reached (${perDay} changesets)`;
  return null;
}

/** POST /changesets */
export async function submit(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env, { write: true });
  if (auth.error) return auth.error;
  const user = auth.user;
  const text = await req.text();
  if (text.length > RULES.maxBodyBytes) return json(req, env, { error: "too large", message: `a changeset is at most ${RULES.maxBodyBytes / 1_000_000} MB` }, 413);
  let input: SubmitInput;
  try {
    input = JSON.parse(text) as SubmitInput;
  } catch {
    return json(req, env, { error: "invalid request" }, 400);
  }
  if (!input || typeof input !== "object" || !Array.isArray(input.items)) return json(req, env, { error: "invalid request" }, 400);
  if (!user.acceptedTerms && input.acceptTerms !== true) {
    return json(req, env, { error: "terms", message: "Contributions are published under the ODbL 1.0: accept this to continue." }, 400);
  }

  const errors: string[] = [];
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if (comment.length < RULES.commentMin || comment.length > RULES.commentMax || !isEnglishText(comment)) {
    errors.push(`describe the change in English (${RULES.commentMin}–${RULES.commentMax} characters)`);
  }
  const maxItems = isNewAccount(user) ? RULES.itemsPerChangesetNewAccount : RULES.itemsPerChangeset;
  if (!input.items.length) errors.push("the changeset changes no building");
  if (input.items.length > maxItems) errors.push(`a changeset has at most ${maxItems} buildings`);
  if (errors.length) return json(req, env, { error: "invalid changeset", errors }, 400);

  // the author's pending changesets: replaced ones, and the buildings that are in the others
  const asked = Array.isArray(input.supersedes) ? [...new Set(input.supersedes.filter((s) => typeof s === "string"))].slice(0, RULES.pendingPerUser) : [];
  const { results: pendingItems } = await env.DB.prepare(
    `SELECT c.id, i.building_ref FROM changesets c JOIN changeset_items i ON i.changeset_id = c.id
     WHERE c.author_id = ? AND c.status IN ('pending', 'conflict')`,
  )
    .bind(user.id)
    .all<{ id: string; building_ref: string | null }>();
  const mineOpen = new Set(pendingItems.map((r) => r.id));
  const supersedes: string[] = [];
  for (const id of asked) {
    if (mineOpen.has(id)) {
      supersedes.push(id);
      continue;
    }
    // one of mine decided meanwhile (approved, rejected, withdrawn) has nothing left to replace
    const own = await env.DB.prepare("SELECT 1 AS ok FROM changesets WHERE id = ? AND author_id = ?").bind(id, user.id).first();
    if (!own) errors.push(`changeset ${id} is not one of your changesets`);
  }
  const lockedBy = new Map(pendingItems.filter((r) => r.building_ref && !supersedes.includes(r.id)).map((r) => [r.building_ref!, r.id]));

  const rows: { ref: string | null; clientId: string | null; kind: Kind; proposal: Proposal; base: Base | null; baseRev: string; where: LngLat }[] = [];
  const refs = new Set<string>();
  const stale: string[] = [];
  for (const [n, item] of input.items.entries()) {
    const at = `building ${n + 1}`;
    const kind: Kind = item?.kind;
    if (kind !== "modify" && kind !== "create" && kind !== "delete") {
      errors.push(`${at}: unknown kind`);
      continue;
    }
    let ref: string | null = null;
    let current: OverrideRow | null = null;
    let base: Base | null = null;
    if (kind === "create") {
      if (item.ref !== undefined) {
        errors.push(`${at}: a new building has no ref`);
        continue;
      }
    } else {
      if (typeof item.ref !== "string" || !REF.test(item.ref)) {
        errors.push(`${at}: bad ref`);
        continue;
      }
      ref = item.ref;
      if (refs.has(ref)) {
        errors.push(`${at}: ${ref} is in the changeset twice`);
        continue;
      }
      refs.add(ref);
      if (lockedBy.has(ref)) {
        errors.push(`${at}: ${ref} is in your pending changeset ${lockedBy.get(ref)}: edit that one instead`);
        continue;
      }
      current = await getOverride(env, ref);
      if (ref.startsWith("new:") && !current) {
        errors.push(`${at}: unknown building`);
        continue;
      }
      if (item.base !== undefined) {
        const b = item.base;
        const tagsOk = b && typeof b.tags === "object" && b.tags !== null && !Array.isArray(b.tags) && Object.values(b.tags).every((v) => typeof v === "string");
        if (!b || !isPoints(b.footprint) || b.footprint.length < 3 || b.footprint.length > RULES.maxBaseVertices || !tagsOk || JSON.stringify(b.tags).length > RULES.maxBaseTagsBytes) {
          errors.push(`${at}: invalid base`);
          continue;
        }
        base = { footprint: b.footprint, tags: b.tags };
      }
      if (!current && !base) {
        errors.push(`${at}: base is required to edit an OSM building`);
        continue;
      }
      // started from what is live now?
      if (typeof item.baseRev === "string" && item.baseRev !== (current?.updated_at ?? "osm")) stale.push(ref);
    }
    const before = current ? (JSON.parse(current.footprint) as LngLat[]) : base?.footprint ?? null;
    const c = kind === "delete" ? { proposal: {}, errors: [] } : canonicalProposal(item.proposal ?? {}, before);
    const itemErrors = c.errors.length ? c.errors : checkItem(kind, current, base, c.proposal);
    if (itemErrors.length) {
      errors.push(...itemErrors.map((e) => `${at}: ${e}`));
      continue;
    }
    const edit = fullEdit(kind, current, base, c.proposal);
    rows.push({
      ref,
      clientId: typeof item.clientId === "string" ? item.clientId.slice(0, 64) : null,
      kind,
      proposal: c.proposal,
      base,
      baseRev: current?.updated_at ?? (kind === "create" ? "new" : "osm"),
      where: centroid(edit.footprint),
    });
  }
  if (errors.length) return json(req, env, { error: "invalid changeset", errors }, 400);
  if (stale.length) return json(req, env, { error: "stale", message: "These buildings changed since you started editing: reload them.", refs: stale }, 409);

  const lngs = rows.map((r) => r.where[0]);
  const lats = rows.map((r) => r.where[1]);
  const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  if (distanceM([bbox[0], bbox[1]], [bbox[2], bbox[1]]) > RULES.maxSpanM || distanceM([bbox[0], bbox[1]], [bbox[0], bbox[3]]) > RULES.maxSpanM) {
    return json(req, env, { error: "invalid changeset", errors: [`the buildings of a changeset must lie within ${RULES.maxSpanM} m of each other`] }, 400);
  }

  const limited = await rateLimited(env, user);
  if (limited) return json(req, env, { error: "rate limited", message: limited }, 429);

  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  if (!user.acceptedTerms) stmts.push(env.DB.prepare(`UPDATE users SET accepted_terms_at = ${now} WHERE github_id = ?`).bind(user.id));
  stmts.push(
    env.DB.prepare(`INSERT INTO changesets (id, author_id, comment, lng, lat, bbox, item_count) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      user.id,
      comment,
      (bbox[0] + bbox[2]) / 2,
      (bbox[1] + bbox[3]) / 2,
      JSON.stringify(bbox),
      rows.length,
    ),
  );
  rows.forEach((r, seq) =>
    stmts.push(
      env.DB.prepare(
        `INSERT INTO changeset_items (changeset_id, seq, building_ref, client_id, kind, proposal, base, base_rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, seq, r.ref, r.clientId, r.kind, JSON.stringify(r.proposal), r.base && JSON.stringify(r.base), r.baseRev),
    ),
  );
  for (const old of supersedes) {
    stmts.push(
      env.DB.prepare(`UPDATE changesets SET status = 'withdrawn', superseded_by = ?, reviewed_at = ${now} WHERE id = ? AND author_id = ? AND status IN ('pending', 'conflict')`).bind(
        id,
        old,
        user.id,
      ),
    );
  }
  await env.DB.batch(stmts);
  if (!user.acceptedTerms) await audit(env, user.id, "terms_accepted", { license: "ODbL-1.0" });
  await audit(env, user.id, "changeset_submitted", { items: rows.map((r) => ({ ref: r.ref, kind: r.kind, fields: Object.keys(r.proposal) })), supersedes }, id);
  return json(req, env, { id, status: "pending" }, 201);
}

// ---------------------------------------------------------------------------------------------------------
// reading

const fieldsOf = (kind: Kind, p: Proposal) => (kind === "delete" ? [] : Object.keys(p).map((k) => (k === "mesh" || k === "footprint" ? "shape" : k)));

function summary(c: ChangesetRow, items: ItemRow[]) {
  return {
    id: c.id,
    status: c.status,
    comment: c.comment,
    reviewNote: c.review_note,
    supersededBy: c.superseded_by,
    lng: c.lng,
    lat: c.lat,
    bbox: JSON.parse(c.bbox) as [number, number, number, number],
    createdAt: c.created_at,
    reviewedAt: c.reviewed_at,
    items: items.map((i) => ({ seq: i.seq, ref: i.building_ref, clientId: i.client_id, kind: i.kind, fields: [...new Set(fieldsOf(i.kind, JSON.parse(i.proposal)))] })),
  };
}

async function itemsOf(env: Env, ids: string[]): Promise<Map<string, ItemRow[]>> {
  const out = new Map<string, ItemRow[]>();
  if (!ids.length) return out;
  // bound parameters in chunks (statement size and parameter count limits)
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT * FROM changeset_items WHERE changeset_id IN (${chunk.map(() => "?").join(",")}) ORDER BY seq`)
      .bind(...chunk)
      .all<ItemRow>();
    for (const r of results) {
      let list = out.get(r.changeset_id);
      if (!list) out.set(r.changeset_id, (list = []));
      list.push(r);
    }
  }
  return out;
}

/** GET /me/changesets */
export async function mine(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env);
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare("SELECT * FROM changesets WHERE author_id = ? ORDER BY created_at DESC LIMIT 100").bind(auth.user.id).all<ChangesetRow>();
  const items = await itemsOf(env, results.map((r) => r.id));
  return json(req, env, { changesets: results.map((c) => summary(c, items.get(c.id) ?? [])) });
}

type AuthorRow = { author_login: string; author_avatar: string | null; author_since: string | null; author_approved: number; author_reviewed: number };
const AUTHOR_SQL = `u.login AS author_login, u.avatar_url AS author_avatar, u.github_created_at AS author_since,
  (SELECT COUNT(*) FROM changesets x WHERE x.author_id = c.author_id AND x.status = 'approved') AS author_approved,
  (SELECT COUNT(*) FROM changesets x WHERE x.author_id = c.author_id AND x.status IN ('approved', 'rejected')) AS author_reviewed`;
const author = (c: ChangesetRow & AuthorRow) => ({
  id: c.author_id,
  login: c.author_login,
  avatarUrl: c.author_avatar,
  githubSince: c.author_since,
  approved: c.author_approved,
  reviewed: c.author_reviewed,
});

/** GET /changesets (admin): the review queue, oldest first */
export async function queue(req: Request, env: Env): Promise<Response> {
  const auth = await requireUser(req, env, { admin: true });
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare(
    `SELECT c.*, ${AUTHOR_SQL} FROM changesets c JOIN users u ON u.github_id = c.author_id
     WHERE c.status IN ('pending', 'conflict') ORDER BY c.created_at ASC LIMIT 200`,
  ).all<ChangesetRow & AuthorRow>();
  const items = await itemsOf(env, results.map((r) => r.id));
  // stale: an item's building changed since (one query for the whole queue)
  const { results: staleRows } = await env.DB.prepare(
    `SELECT DISTINCT i.changeset_id FROM changeset_items i JOIN changesets c ON c.id = i.changeset_id LEFT JOIN overrides o ON o.ref = i.building_ref
     WHERE c.status IN ('pending', 'conflict') AND i.kind != 'create' AND i.base_rev != COALESCE(o.updated_at, 'osm')`,
  ).all<{ changeset_id: string }>();
  const staleIds = new Set(staleRows.map((r) => r.changeset_id));
  return json(req, env, { changesets: results.map((c) => ({ ...summary(c, items.get(c.id) ?? []), stale: staleIds.has(c.id), author: author(c) })) });
}

/** GET /changesets/<id> (its author or an admin): every item in full, with the building as it is now */
export async function detail(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env);
  if (auth.error) return auth.error;
  const c = await env.DB.prepare(`SELECT c.*, ${AUTHOR_SQL} FROM changesets c JOIN users u ON u.github_id = c.author_id WHERE c.id = ?`)
    .bind(id)
    .first<ChangesetRow & AuthorRow>();
  if (!c || (c.author_id !== auth.user.id && !auth.user.isAdmin)) return json(req, env, { error: "not found" }, 404);
  const rows = (await itemsOf(env, [id])).get(id) ?? [];
  const items = await Promise.all(
    rows.map(async (i) => {
      const current = await getOverride(env, i.building_ref);
      return {
        ...summary(c, [i]).items[0],
        proposal: JSON.parse(i.proposal) as Proposal,
        base: i.base ? (JSON.parse(i.base) as Base) : null,
        baseRev: i.base_rev,
        current: current && { ...parseOverride(current), updatedAt: current.updated_at },
        stale: i.kind !== "create" && i.base_rev !== (current?.updated_at ?? "osm"),
      };
    }),
  );
  return json(req, env, { ...summary(c, rows), items, stale: items.some((i) => i.stale), author: author(c) });
}

// ---------------------------------------------------------------------------------------------------------
// decisions

/** POST /changesets/<id>/withdraw (the author, while it waits for review) */
export async function withdraw(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true });
  if (auth.error) return auth.error;
  const row = await env.DB.prepare(
    `UPDATE changesets SET status = 'withdrawn', reviewed_at = ${now} WHERE id = ? AND author_id = ? AND status IN ('pending', 'conflict') RETURNING id`,
  )
    .bind(id, auth.user.id)
    .first();
  if (!row) return json(req, env, { error: "nothing to withdraw" }, 404);
  await audit(env, auth.user.id, "changeset_withdrawn", {}, id);
  return json(req, env, { id, status: "withdrawn" });
}

/** POST /changesets/<id>/approve  { force?, note? } (admin): every building or none */
export async function approve(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true, admin: true });
  if (auth.error) return auth.error;
  let body: { force?: boolean; note?: string } = {};
  try {
    body = ((await req.json()) as typeof body) ?? {};
  } catch {
    // no body
  }
  const c = await env.DB.prepare("SELECT * FROM changesets WHERE id = ?").bind(id).first<ChangesetRow>();
  if (!c) return json(req, env, { error: "not found" }, 404);
  if (c.status !== "pending" && c.status !== "conflict") return json(req, env, { error: `already ${c.status}` }, 409);
  const items = (await itemsOf(env, [id])).get(id) ?? [];

  // 1. check everything, write nothing
  const plans: { item: ItemRow; current: OverrideRow | null; base: Base | null; edit: OverrideEdit }[] = [];
  const stale: string[] = [];
  const errors: string[] = [];
  for (const item of items) {
    const current = await getOverride(env, item.building_ref);
    if (item.kind !== "create" && item.base_rev !== (current?.updated_at ?? "osm")) stale.push(item.building_ref!);
    if (item.building_ref?.startsWith("new:") && !current) {
      errors.push(`${item.building_ref}: the building was removed`);
      continue;
    }
    const base = item.base ? (JSON.parse(item.base) as Base) : null;
    const proposal = JSON.parse(item.proposal) as Proposal;
    const e = checkItem(item.kind, current, base, proposal);
    if (e.length) errors.push(...e.map((m) => `${item.building_ref ?? "new building"}: ${m}`));
    else plans.push({ item, current, base, edit: fullEdit(item.kind, current, base, proposal) });
  }
  if (stale.length && body.force !== true) {
    await env.DB.prepare("UPDATE changesets SET status = 'conflict' WHERE id = ?").bind(id).run();
    return json(req, env, { error: "conflict", message: "Some buildings changed after this was proposed. Compare, then reject or approve anyway.", refs: stale }, 409);
  }
  if (errors.length) return json(req, env, { error: "invalid changeset", errors }, 400);

  // 2. one batch: every override, the new buildings' refs, the decision
  const note = typeof body.note === "string" ? body.note.trim().slice(0, RULES.noteMax) || null : null;
  try {
    const stmts: D1PreparedStatement[] = [];
    const tiles: string[] = [];
    const written: { seq: number; ref: string; kind: Kind }[] = [];
    for (const p of plans) {
      const newNumber = p.item.building_ref ? undefined : await newBuildingNumber(env);
      const r = overrideStatement(
        env,
        { ref: p.item.building_ref ?? undefined, baseFootprint: p.base?.footprint, baseTags: p.base?.tags, edit: p.edit, contributionId: id },
        p.current,
        auth.user.id,
        newNumber,
      );
      stmts.push(r.stmt);
      if (!p.item.building_ref) stmts.push(env.DB.prepare("UPDATE changeset_items SET building_ref = ? WHERE changeset_id = ? AND seq = ?").bind(r.ref, id, p.item.seq));
      tiles.push(...r.tiles);
      written.push({ seq: p.item.seq, ref: r.ref, kind: p.item.kind });
    }
    stmts.push(
      env.DB.prepare(`UPDATE changesets SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = ${now} WHERE id = ? AND status IN ('pending', 'conflict')`).bind(
        auth.user.id,
        note,
        id,
      ),
    );
    await env.DB.batch(stmts);
    // 3. publish (R2 is not transactional: publishing again rewrites the same tiles, see /admin/republish)
    const rev = await publish(env, tiles);
    await audit(env, auth.user.id, "changeset_approved", { rev, forced: body.force === true, items: written }, id);
    return json(req, env, { id, status: "approved", rev, items: written });
  } catch (err) {
    if (err instanceof InputError) return json(req, env, { error: err.message }, 400);
    throw err;
  }
}

/** POST /changesets/<id>/reject  { note } (admin; the reason is shown to the author) */
export async function reject(req: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireUser(req, env, { write: true, admin: true });
  if (auth.error) return auth.error;
  let note = "";
  try {
    const body = (await req.json()) as { note?: string } | null;
    note = typeof body?.note === "string" ? body.note.trim() : "";
  } catch {
    // no body
  }
  if (note.length < 3 || note.length > RULES.noteMax) return json(req, env, { error: "a reason is required" }, 400);
  const row = await env.DB.prepare(
    `UPDATE changesets SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = ${now} WHERE id = ? AND status IN ('pending', 'conflict') RETURNING id`,
  )
    .bind(auth.user.id, note, id)
    .first();
  if (!row) return json(req, env, { error: "not pending" }, 409);
  await audit(env, auth.user.id, "changeset_rejected", { note }, id);
  return json(req, env, { id, status: "rejected" });
}
