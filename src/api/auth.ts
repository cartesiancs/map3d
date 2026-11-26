// Sign-in with GitHub through the map3d API (worker/). The session is an HttpOnly cookie on the API's domain;
// the app only asks /me who is signed in.

export const API_URL = (
  import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:8787" : "https://api.map3d.fleet.im")
).replace(/\/+$/, "");

/** `acceptedTerms`: agreed that contributions are published under the ODbL (asked on the first one) */
export type AuthUser = { id: number; login: string; avatarUrl: string | null; isAdmin: boolean; acceptedTerms: boolean };

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch(`${API_URL}/me`, { credentials: "include" });
  if (!res.ok) throw new Error(`/me: HTTP ${res.status}`);
  return ((await res.json()) as { user: AuthUser | null }).user;
}

/** Full-page redirect to GitHub; the API sends the browser back to `returnTo` with ?auth=ok|denied|error|banned. */
export function signInUrl(returnTo = window.location.href): string {
  const url = new URL(returnTo);
  url.searchParams.delete("auth");
  return `${API_URL}/auth/login?return_to=${encodeURIComponent(url.toString())}`;
}

export async function signOut(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
}
