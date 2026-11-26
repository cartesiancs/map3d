// Sign-in with a GitHub OAuth App (no scopes: public profile only).
// The GitHub access token is used once to read the profile, then revoked and dropped; the app only keeps
// its own session (random token in an HttpOnly cookie, SHA-256 of it in D1).

import type { Env } from "./index";
import { allowedOrigins, cookie, cors, json, randomToken, readCookie, safeEqual, sha256Hex } from "./http";

const SESSION_COOKIE = "map3d_session";
const STATE_COOKIE = "map3d_oauth";
const USER_AGENT = "map3d-api";

export type SessionUser = {
  id: number;
  login: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  banned: boolean;
  /** ODbL agreement given (asked on the first contribution) */
  acceptedTerms: boolean;
  githubCreatedAt: string | null;
};

const githubWeb = (env: Env) => env.GITHUB_WEB_BASE ?? "https://github.com";
const githubApi = (env: Env) => env.GITHUB_API_BASE ?? "https://api.github.com";

export function isAdmin(env: Env, githubId: number): boolean {
  return env.ADMIN_GITHUB_IDS.split(",").map((s) => s.trim()).includes(String(githubId));
}

export async function audit(env: Env, actorId: number | null, action: string, detail: Record<string, unknown> = {}, target: string | null = null) {
  await env.DB.prepare("INSERT INTO audit_log (actor_id, action, detail, target) VALUES (?, ?, ?, ?)")
    .bind(actorId, action, JSON.stringify(detail), target)
    .run();
}

/** Back to the app page the user came from; only pages on the app's own origins. */
function safeReturnTo(env: Env, value: string | null): string {
  const origins = allowedOrigins(env);
  if (value) {
    try {
      const u = new URL(value);
      if (origins.includes(u.origin)) return u.toString();
    } catch {}
  }
  return origins[0] + "/";
}

function withParam(url: string, key: string, value: string) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** GET /auth/login?return_to=<app page> */
export function login(req: Request, env: Env): Response {
  if (!env.GITHUB_CLIENT_ID) return new Response("GITHUB_CLIENT_ID is not configured", { status: 500 });
  const url = new URL(req.url);
  const returnTo = safeReturnTo(env, url.searchParams.get("return_to"));
  const state = randomToken(24);
  const authorize = new URL(`${githubWeb(env)}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", new URL("/auth/callback", req.url).toString());
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "true");
  // no `scope`: read-only public profile, nothing else
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": cookie(STATE_COOKIE, `${state}|${returnTo}`, 600, "/auth"),
      "Cache-Control": "no-store",
    },
  });
}

/** GET /auth/callback?code&state (from GitHub) */
export async function callback(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const saved = readCookie(req, STATE_COOKIE) ?? "";
  const sep = saved.indexOf("|");
  const savedState = sep > 0 ? saved.slice(0, sep) : "";
  const returnTo = safeReturnTo(env, sep > 0 ? saved.slice(sep + 1) : null);
  const clearState = cookie(STATE_COOKIE, "", 0, "/auth");
  const back = (result: string) =>
    new Response(null, { status: 302, headers: { Location: withParam(returnTo, "auth", result), "Set-Cookie": clearState, "Cache-Control": "no-store" } });

  if (url.searchParams.get("error")) {
    await audit(env, null, "login_denied", { error: url.searchParams.get("error") });
    return back("denied"); // the user pressed Cancel on GitHub
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!code || !savedState || !safeEqual(state, savedState)) return back("error"); // CSRF / expired attempt

  // code -> token (server to server, with the client secret)
  const tokenRes = await fetch(`${githubWeb(env)}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/auth/callback", req.url).toString(),
    }),
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    await audit(env, null, "login_failed", { step: "token", error: tokenJson.error ?? tokenRes.status });
    return back("error");
  }
  const token = tokenJson.access_token;

  const userRes = await fetch(`${githubApi(env)}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
  });
  // the token is not needed any more: revoke it (best effort, after the response)
  ctx.waitUntil(
    fetch(`${githubApi(env)}/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => {}),
  );
  if (!userRes.ok) {
    await audit(env, null, "login_failed", { step: "user", status: userRes.status });
    return back("error");
  }
  const gh = (await userRes.json()) as { id: number; login: string; avatar_url?: string; created_at?: string };
  if (!Number.isInteger(gh.id) || !gh.login) return back("error");

  await env.DB.prepare(
    `INSERT INTO users (github_id, login, avatar_url, github_created_at, last_login_at)
     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(github_id) DO UPDATE SET login = ?2, avatar_url = ?3, github_created_at = ?4, last_login_at = excluded.last_login_at`,
  )
    .bind(gh.id, gh.login, gh.avatar_url ?? null, gh.created_at ?? null)
    .run();
  const row = await env.DB.prepare("SELECT banned FROM users WHERE github_id = ?").bind(gh.id).first<{ banned: number }>();
  if (row?.banned) {
    await audit(env, gh.id, "login_banned");
    return back("banned");
  }

  const days = Number(env.SESSION_DAYS ?? "30");
  const sessionToken = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
    env.DB.prepare(
      `INSERT INTO sessions (id_hash, github_id, expires_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`,
    ).bind(await sha256Hex(sessionToken), gh.id, `+${days} days`),
  ]);
  await audit(env, gh.id, "login", { login: gh.login });

  const headers = new Headers({ Location: withParam(returnTo, "auth", "ok"), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, sessionToken, days * 86400));
  return new Response(null, { status: 302, headers });
}

/** The signed-in user of a request, or null (no / unknown / expired session, banned user). */
export async function currentUser(req: Request, env: Env): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.github_id, u.login, u.avatar_url, u.banned, u.accepted_terms_at, u.github_created_at FROM sessions s JOIN users u ON u.github_id = s.github_id
     WHERE s.id_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(await sha256Hex(token))
    .first<{ github_id: number; login: string; avatar_url: string | null; banned: number; accepted_terms_at: string | null; github_created_at: string | null }>();
  if (!row || row.banned) return null;
  return {
    id: row.github_id,
    login: row.login,
    avatarUrl: row.avatar_url,
    isAdmin: isAdmin(env, row.github_id),
    banned: false,
    acceptedTerms: !!row.accepted_terms_at,
    githubCreatedAt: row.github_created_at,
  };
}

/**
 * The signed-in user, or the error response to send. Writes also need one of the app's origins (CSRF: the
 * session cookie is SameSite=Lax, and a cross-site page cannot send a JSON body with an allowed Origin).
 */
export async function requireUser(
  req: Request,
  env: Env,
  opts: { write?: boolean; admin?: boolean } = {},
): Promise<{ user: SessionUser; error?: undefined } | { error: Response; user?: undefined }> {
  if (opts.write && !Object.keys(cors(req, env)).length) return { error: new Response("forbidden", { status: 403 }) };
  const user = await currentUser(req, env);
  if (!user) return { error: json(req, env, { error: "sign in first" }, 401) };
  if (opts.admin && !user.isAdmin) return { error: json(req, env, { error: "admins only" }, 403) };
  return { user };
}

/** GET /me */
export async function me(req: Request, env: Env): Promise<Response> {
  const user = await currentUser(req, env);
  return json(req, env, {
    user: user && { id: user.id, login: user.login, avatarUrl: user.avatarUrl, isAdmin: user.isAdmin, acceptedTerms: user.acceptedTerms },
  });
}

/** POST /auth/logout (from the app: the Origin must be one of the app's) */
export async function logout(req: Request, env: Env): Promise<Response> {
  if (!Object.keys(cors(req, env)).length) return new Response("forbidden", { status: 403 });
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    const row = await env.DB.prepare("SELECT github_id FROM sessions WHERE id_hash = ?").bind(hash).first<{ github_id: number }>();
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(hash).run();
    if (row) await audit(env, row.github_id, "logout");
  }
  return json(req, env, { ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
}
