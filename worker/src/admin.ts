// Admin-only direct override API (phase 2): an escape hatch next to the review queue (contributions.ts),
// which writes through the same setOverride().

import type { Env } from "./index";
import { audit, requireUser } from "./auth";
import { json } from "./http";
import { InputError, OverrideInput, OverrideRow, TILE_Z, publish, removeOverride, setOverride } from "./overlay";
import { validateEdit } from "../../src/contrib/validate";
import { MESH_LIMITS, decodeMesh, encodedBytes, encodedMeshError, meshHeight, meshOutline, validateMesh } from "../../src/contrib/mesh";

const requireAdmin = (req: Request, env: Env, write: boolean) => requireUser(req, env, { write, admin: true });

/** PUT /admin/overrides  { ref?, baseFootprint?, baseTags?, edit }: `edit.mesh` (wire format) sets a free 3D shape */
export async function putOverride(req: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(req, env, true);
  if (auth.error) return auth.error;
  let input: OverrideInput;
  try {
    input = (await req.json()) as OverrideInput;
  } catch {
    return json(req, env, { error: "invalid JSON" }, 400);
  }
  if (input?.edit?.mesh) {
    // a mesh: its outline is the footprint, its top the height
    const err = encodedMeshError(input.edit.mesh) ?? (encodedBytes(input.edit.mesh) > MESH_LIMITS.maxBytes ? "mesh is too large" : null);
    if (err) return json(req, env, { error: "invalid edit", errors: [err] }, 400);
    const m = decodeMesh(input.edit.mesh);
    const meshErrors = validateMesh(m);
    if (meshErrors.length) return json(req, env, { error: "invalid edit", errors: meshErrors }, 400);
    input.edit.footprint = meshOutline(m);
    input.edit.height = Math.round(meshHeight(m) * 1000) / 1000;
  }
  const errors = input?.edit ? validateEdit(input.edit, { checkShape: !input.edit.mesh }) : ["edit is required"];
  if (errors.length) return json(req, env, { error: "invalid edit", errors }, 400);
  try {
    const r = await setOverride(env, input, auth.user.id);
    await audit(env, auth.user.id, "override_set", { rev: r.rev, edit: input.edit }, r.ref);
    return json(req, env, r);
  } catch (err) {
    if (err instanceof InputError) return json(req, env, { error: err.message }, 400);
    throw err;
  }
}

/** DELETE /admin/overrides/<ref> */
export async function deleteOverride(req: Request, env: Env, ref: string): Promise<Response> {
  const auth = await requireAdmin(req, env, true);
  if (auth.error) return auth.error;
  const rev = await removeOverride(env, ref);
  if (rev == null) return json(req, env, { error: "not found" }, 404);
  await audit(env, auth.user.id, "override_removed", { rev }, ref);
  return json(req, env, { ref, rev });
}

/** GET /admin/overrides */
export async function listOverrides(req: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(req, env, false);
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare("SELECT * FROM overrides ORDER BY updated_at DESC LIMIT 500").all<OverrideRow>();
  return json(req, env, { overrides: results.map((r) => ({ ...r, footprint: JSON.parse(r.footprint) })) });
}

/** POST /admin/republish  { tiles: ["x/y", …] }: write those overlay tiles again (after a failed publish) */
export async function republish(req: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(req, env, true);
  if (auth.error) return auth.error;
  let tiles: unknown;
  try {
    tiles = ((await req.json()) as { tiles?: unknown })?.tiles;
  } catch {
    tiles = null;
  }
  if (!Array.isArray(tiles) || !tiles.length || tiles.length > 500 || !tiles.every((t) => typeof t === "string" && /^\d{1,5}\/\d{1,5}$/.test(t))) {
    return json(req, env, { error: `tiles must be a list of z${TILE_Z} "x/y" keys` }, 400);
  }
  const rev = await publish(env, tiles as string[]);
  await audit(env, auth.user.id, "overlay_republished", { rev, tiles });
  return json(req, env, { rev });
}
