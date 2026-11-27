// map3d API (Cloudflare Worker): GitHub sign-in, changesets (Edit mode proposals) and their review, the
// published overlay (see H:\map3d-osm\CONTRIBUTION-DESIGN.md).

import { callback, login, logout, me } from "./auth";
import { deleteOverride, listOverrides, putOverride, republish } from "./admin";
import { approve, detail, mine, queue, reject, submit, withdraw } from "./changesets";
import { serveOverlay } from "./overlay";
import { cors, json } from "./http";

export interface Env {
  DB: D1Database;
  /** the map data bucket (map3d-osm): overlay/ is written here */
  DATA: R2Bucket;
  /** app origins allowed to call with credentials, comma-separated */
  APP_ORIGINS: string;
  /** numeric GitHub ids of the admins, comma-separated */
  ADMIN_GITHUB_IDS: string;
  GITHUB_CLIENT_ID: string;
  /** secret: `wrangler secret put GITHUB_CLIENT_SECRET` / .dev.vars */
  GITHUB_CLIENT_SECRET: string;
  SESSION_DAYS?: string;
  /** tests only: point the OAuth flow at a mock GitHub */
  GITHUB_WEB_BASE?: string;
  GITHUB_API_BASE?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "OPTIONS") {
        const headers = cors(req, env);
        if (!Object.keys(headers).length) return new Response(null, { status: 403 });
        return new Response(null, {
          status: 204,
          headers: { ...headers, "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" },
        });
      }
      if (req.method === "GET" && pathname === "/health") return json(req, env, { ok: true });
      if (req.method === "GET" && pathname === "/auth/login") return login(req, env);
      if (req.method === "GET" && pathname === "/auth/callback") return await callback(req, env, ctx);
      if (req.method === "POST" && pathname === "/auth/logout") return await logout(req, env);
      if (req.method === "GET" && pathname === "/me") return await me(req, env);
      if (req.method === "GET" && pathname.startsWith("/overlay/")) return await serveOverlay(env, pathname.slice("/overlay/".length));
      if (req.method === "POST" && pathname === "/changesets") return await submit(req, env);
      if (req.method === "GET" && pathname === "/changesets") return await queue(req, env);
      if (req.method === "GET" && pathname === "/me/changesets") return await mine(req, env);
      const one = req.method === "GET" && /^\/changesets\/([0-9a-f-]{36})$/.exec(pathname);
      if (one) return await detail(req, env, one[1]);
      const action = req.method === "POST" && /^\/changesets\/([0-9a-f-]{36})\/(withdraw|approve|reject)$/.exec(pathname);
      if (action) {
        const [, id, verb] = action;
        if (verb === "withdraw") return await withdraw(req, env, id);
        if (verb === "approve") return await approve(req, env, id);
        return await reject(req, env, id);
      }
      if (req.method === "GET" && pathname === "/admin/overrides") return await listOverrides(req, env);
      if (req.method === "PUT" && pathname === "/admin/overrides") return await putOverride(req, env);
      if (req.method === "POST" && pathname === "/admin/republish") return await republish(req, env);
      if (req.method === "DELETE" && pathname.startsWith("/admin/overrides/")) return await deleteOverride(req, env, decodeURIComponent(pathname.slice("/admin/overrides/".length)));
      return json(req, env, { error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json(req, env, { error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
