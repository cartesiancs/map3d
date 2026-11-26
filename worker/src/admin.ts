// Admin-only direct override API (phase 2): an escape hatch next to the review queue (contributions.ts),
// which writes through the same setOverride().

import type { Env } from "./index";
import { audit, requireUser } from "./auth";
import { json } from "./http";
import { InputError, OverrideInput, OverrideRow, removeOverride, setOverride } from "./overlay";
import { validateEdit } from "../../src/contrib/validate";

const requireAdmin = (req: Request, env: Env, write: boolean) => requireUser(req, env, { write, admin: true });

/** PUT /admin/overrides  { ref?, baseFootprint?, baseTags?, edit } */
export async function putOverride(req: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(req, env, true);
  if (auth.error) return auth.error;
  let input: OverrideInput;
  try {
    input = (await req.json()) as OverrideInput;
  } catch {
    return json(req, env, { error: "invalid JSON" }, 400);
  }
  const errors = input?.edit ? validateEdit(input.edit) : ["edit is required"];
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
