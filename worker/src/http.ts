import type { Env } from "./index";

export function allowedOrigins(env: Env): string[] {
  return env.APP_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
}

/** CORS headers for a credentialed request from one of the app's origins (none otherwise). */
export function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
}

export function json(req: Request, env: Env, data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(cors(req, env))) headers.set(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** HttpOnly + Secure + SameSite=Lax (browsers accept Secure cookies from http://localhost too). */
export function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** constant-time string comparison (OAuth state) */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
