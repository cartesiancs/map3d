// End-to-end test of the sign-in flow against a mock GitHub: runs `wrangler dev` (local D1) and walks
// the browser's redirects with a small cookie jar.   node test/e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startMockGitHub } from "./mock-github.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const API = "http://localhost:8787";
const APP = "http://localhost:5173";
const PERSIST = ".wrangler/test-state";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

fs.rmSync(path.join(ROOT, PERSIST), { recursive: true, force: true });
const mig = spawnSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "map3d", "--local", "--persist-to", PERSIST], { cwd: ROOT, env, encoding: "utf8" });
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(1); }

const mock = await startMockGitHub();
const vars = { GITHUB_WEB_BASE: "http://localhost:8788", GITHUB_API_BASE: "http://localhost:8788", GITHUB_CLIENT_ID: "mock-client", GITHUB_CLIENT_SECRET: "mock-secret", ADMIN_GITHUB_IDS: "1001" };
const dev = spawn(process.execPath, [WRANGLER, "dev", "--port", "8787", "--persist-to", PERSIST, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: ROOT, env });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const sql = (q) => spawnSync(process.execPath, [WRANGLER, "d1", "execute", "map3d", "--local", "--persist-to", PERSIST, "--json", "--command", q], { cwd: ROOT, env, encoding: "utf8" });
const setCookies = (res) => res.headers.getSetCookie?.() ?? [];
const cookieValue = (res, name) => { for (const c of setCookies(res)) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (k.trim() === name) return decodeURIComponent(v ?? ""); } return null; };

/** browser-like sign-in: /auth/login -> GitHub -> /auth/callback -> app; returns the final Location and session */
async function signIn(returnTo = `${APP}/somewhere?x=1`) {
  const r1 = await fetch(`${API}/auth/login?return_to=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  const stateCookie = cookieValue(r1, "map3d_oauth");
  const r2 = await fetch(r1.headers.get("location"), { redirect: "manual" });
  const r3 = await fetch(r2.headers.get("location"), { redirect: "manual", headers: { Cookie: `map3d_oauth=${encodeURIComponent(stateCookie)}` } });
  return { authorize: r1.headers.get("location"), final: r3.headers.get("location"), session: cookieValue(r3, "map3d_session"), r3 };
}
const me = async (session, origin = APP) => fetch(`${API}/me`, { headers: { Origin: origin, ...(session ? { Cookie: `map3d_session=${session}` } : {}) } });

try {
  check("health", (await fetch(`${API}/health`)).ok);

  // 1. admin signs in
  const a = await signIn();
  const authorizeUrl = new URL(a.authorize);
  check("authorize: client id, callback, no scope", authorizeUrl.searchParams.get("client_id") === "mock-client" && authorizeUrl.searchParams.get("redirect_uri") === `${API}/auth/callback` && !authorizeUrl.searchParams.has("scope"));
  check("callback returns to the app page with auth=ok", a.final === `${APP}/somewhere?x=1&auth=ok`, a.final);
  const sc = setCookies(a.r3).find((c) => c.startsWith("map3d_session="));
  check("session cookie is HttpOnly, Secure, SameSite=Lax", !!sc && /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc), sc?.replace(/=[^;]+/, "=…"));
  const m1 = await me(a.session);
  const j1 = await m1.json();
  check("/me: admin user", j1.user?.id === 1001 && j1.user?.login === "octo-admin" && j1.user?.isAdmin === true, JSON.stringify(j1.user));
  check("/me: CORS for the app origin with credentials", m1.headers.get("access-control-allow-origin") === APP && m1.headers.get("access-control-allow-credentials") === "true");
  await new Promise((r) => setTimeout(r, 300));
  check("GitHub token revoked after reading the profile", mock.state.revoked >= 1 && mock.state.tokens.size === 0, `revoked ${mock.state.revoked}`);

  // 2. stored sessions are hashes, not the cookie value
  const rows = JSON.parse(sql("SELECT id_hash FROM sessions").stdout)[0].results;
  check("D1 stores only the session hash", rows.length === 1 && rows[0].id_hash !== a.session && /^[0-9a-f]{64}$/.test(rows[0].id_hash));

  // 3. a contributor (not admin)
  mock.state.user = { id: 2002, login: "octo-user", avatar_url: null, created_at: "2024-01-01T00:00:00Z" };
  const b = await signIn();
  const j2 = await (await me(b.session)).json();
  check("/me: non-admin user", j2.user?.id === 2002 && j2.user?.isAdmin === false);

  // 4. CORS and CSRF
  const evil = await me(a.session, "https://evil.example");
  check("/me from another origin: no CORS headers", !evil.headers.get("access-control-allow-origin"));
  const pre = await fetch(`${API}/me`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
  check("preflight from another origin: 403", pre.status === 403);
  const lo1 = await fetch(`${API}/auth/logout`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: `map3d_session=${a.session}` } });
  check("logout from another origin: 403, session kept", lo1.status === 403 && (await (await me(a.session)).json()).user?.id === 1001);

  // 5. forged / missing state, cancel on GitHub, open redirect
  const r1 = await fetch(`${API}/auth/login`, { redirect: "manual" });
  const r2 = await fetch(r1.headers.get("location"), { redirect: "manual" });
  const forged = await fetch(r2.headers.get("location"), { redirect: "manual", headers: { Cookie: "map3d_oauth=wrong-state%7Chttp%3A%2F%2Flocalhost%3A5173%2F" } });
  check("forged state: no session, auth=error", !cookieValue(forged, "map3d_session") && /auth=error/.test(forged.headers.get("location")));
  const noCookie = await fetch(r2.headers.get("location"), { redirect: "manual" });
  check("callback without the state cookie: auth=error", /auth=error/.test(noCookie.headers.get("location")) && !cookieValue(noCookie, "map3d_session"));
  const r1b = await fetch(`${API}/auth/login?return_to=${encodeURIComponent(`${APP}/`)}`, { redirect: "manual" });
  const st = cookieValue(r1b, "map3d_oauth");
  const cancel = await fetch(`${API}/auth/callback?error=access_denied&state=${encodeURIComponent(st.split("|")[0])}`, { redirect: "manual", headers: { Cookie: `map3d_oauth=${encodeURIComponent(st)}` } });
  check("cancel on GitHub: auth=denied", /auth=denied/.test(cancel.headers.get("location")) && !cookieValue(cancel, "map3d_session"));
  const open = await signIn("https://evil.example/steal");
  check("return_to outside the app is ignored", open.final.startsWith("https://map.fleet.im/") && !open.final.includes("evil"), open.final);
  // replaying a callback URL (code already exchanged) with a fresh, valid state must not sign in
  const s1 = await fetch(`${API}/auth/login`, { redirect: "manual" });
  const sState = cookieValue(s1, "map3d_oauth");
  const sCallback = (await fetch(s1.headers.get("location"), { redirect: "manual" })).headers.get("location");
  const first = await fetch(sCallback, { redirect: "manual", headers: { Cookie: `map3d_oauth=${encodeURIComponent(sState)}` } });
  const replay = await fetch(sCallback, { redirect: "manual", headers: { Cookie: `map3d_oauth=${encodeURIComponent(sState)}` } });
  check("replayed authorization code: refused", !!cookieValue(first, "map3d_session") && /auth=error/.test(replay.headers.get("location")) && !cookieValue(replay, "map3d_session"));

  // 5b. overrides -> overlay tiles in R2 (admin only)
  const tileOf = (lng, lat) => { const n = 2 ** 14, r = (lat * Math.PI) / 180; return `${Math.floor(((lng + 180) / 360) * n)}/${Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)}`; };
  const put = (session, body, origin = APP) => fetch(`${API}/admin/overrides`, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/json", ...(session ? { Cookie: `map3d_session=${session}` } : {}) }, body: JSON.stringify(body) });
  const getJson = async (p) => { const r = await fetch(`${API}${p}`); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
  const square = (lng, lat, d = 0.0002) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d]];
  const base = square(-73.9700, 40.7700);
  const edited = square(-73.97005, 40.77002, 0.00025);
  const edit = { ref: "way:123", baseFootprint: base, baseTags: { building: "yes", name: "Old Name", "building:levels": "3" }, edit: { footprint: edited, height: 50, name: "Test Tower" } };
  check("override: no session -> 401", (await put(null, edit)).status === 401);
  check("override: contributor -> 403", (await put(b.session, edit)).status === 403);
  check("override: admin from another origin -> 403", (await put(a.session, edit, "https://evil.example")).status === 403);
  const bowtie = await put(a.session, { ...edit, edit: { footprint: [[-73.97, 40.77], [-73.9698, 40.7702], [-73.9698, 40.77], [-73.97, 40.7702]], height: 20 } });
  const bowtieBody = await bowtie.json();
  check("override: self-intersecting footprint -> 400", bowtie.status === 400 && bowtieBody.errors.some((e) => /cross/.test(e)), bowtieBody.errors?.join("; "));
  const tooTall = await put(a.session, { ...edit, edit: { footprint: edited, height: 5000 } });
  check("override: height out of range -> 400", tooTall.status === 400);
  const noBase = await put(a.session, { ref: "way:456", edit: { footprint: edited, height: 10 } });
  check("override: first edit of a way needs its original footprint", noBase.status === 400);

  const o1 = await put(a.session, edit);
  const o1b = await o1.json();
  const T1 = tileOf(-73.97, 40.77);
  let idx = await getJson("/overlay/index.json");
  check("override saved and published", o1.status === 200 && o1b.ref === "way:123" && idx.body?.tiles[T1] === o1b.rev, JSON.stringify(idx.body));
  let t1 = await getJson(`/overlay/14/${T1}.json`);
  const f = t1.body?.add?.[0];
  const decodeFirst = (g) => [g[0][0][0] / 1e7, g[0][0][1] / 1e7];
  check("overlay tile hides the OSM way and adds the edited one", t1.body?.hide?.includes(123) && f?.id === 123 && f?.tags["map3d:height"] === "50" && f?.tags["name:en"] === "Test Tower" && f?.tags.name === "Old Name" && f?.tags["building:levels"] === "3", JSON.stringify(f?.tags));
  const firstPt = decodeFirst(f.g);
  check("overlay geometry is the edited footprint (closed ring, 1e-7)", Math.abs(firstPt[0] - edited[0][0]) < 1e-7 && Math.abs(firstPt[1] - edited[0][1]) < 1e-7 && f.g[0][0].length === (edited.length + 1) * 2);

  // a new building elsewhere
  const o2 = await put(a.session, { edit: { footprint: square(126.978, 37.5665), height: 12, buildingType: "house", name: "New Place" } });
  const o2b = await o2.json();
  const T2 = tileOf(126.978, 37.5665);
  const t2 = await getJson(`/overlay/14/${T2}.json`);
  check("new building gets a new ref and a negative feature id", o2b.ref === "new:1" && t2.body?.add?.[0]?.id === -1 && t2.body.add[0].tags.name === "New Place" && t2.body.hide.length === 0);

  // moving the edited way into another tile: the old tile keeps only the hide
  const moved = square(-73.9500, 40.7800);
  const T3 = tileOf(-73.95, 40.78);
  await put(a.session, { ref: "way:123", edit: { footprint: moved, height: 50 } });
  t1 = await getJson(`/overlay/14/${T1}.json`);
  const t3 = await getJson(`/overlay/14/${T3}.json`);
  check("moved building: hide stays in the original tile, add moves", T1 !== T3 && t1.body?.hide?.includes(123) && t1.body.add.length === 0 && t3.body?.add?.[0]?.id === 123);

  // revert
  const del = await fetch(`${API}/admin/overrides/${encodeURIComponent("way:123")}`, { method: "DELETE", headers: { Origin: APP, Cookie: `map3d_session=${a.session}` } });
  idx = await getJson("/overlay/index.json");
  check("revert: tiles without edits are removed from R2 and the index", del.status === 200 && !(T1 in idx.body.tiles) && !(T3 in idx.body.tiles) && (await getJson(`/overlay/14/${T1}.json`)).status === 404 && T2 in idx.body.tiles, JSON.stringify(idx.body));
  const list = await (await fetch(`${API}/admin/overrides`, { headers: { Origin: APP, Cookie: `map3d_session=${a.session}` } })).json();
  check("admin list shows the remaining override", list.overrides?.length === 1 && list.overrides[0].ref === "new:1");
  check("overlay files are public (CORS *)", (await fetch(`${API}/overlay/index.json`)).headers.get("access-control-allow-origin") === "*");

  // 5c. contributions: submit -> review queue -> approve / reject, conflicts, withdraw, limits
  const call = (method, p, session, body, origin = APP) =>
    fetch(`${API}${p}`, { method, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: `map3d_session=${session}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const callJson = async (...args) => { const r = await call(...args); return { status: r.status, body: await r.json().catch(() => null) }; };
  const wayBase = { footprint: square(-73.9600, 40.7650), tags: { building: "yes", "building:levels": "2", name: "Corner Shop" } };
  const heightProposal = { ref: "way:777", base: wayBase, proposal: { height: 120 }, comment: "Height from the city survey, roof is at 120 m." };
  check("contribution: no session -> 401", (await call("POST", "/contributions", null, heightProposal)).status === 401);
  check("contribution: another origin -> 403", (await call("POST", "/contributions", b.session, heightProposal, "https://evil.example")).status === 403);
  const noTerms = await callJson("POST", "/contributions", b.session, heightProposal);
  check("contribution: first one needs the ODbL agreement", noTerms.status === 400 && noTerms.body?.error === "terms");
  const withTerms = (x) => ({ ...x, acceptTerms: true });
  const bad = async (x) => (await callJson("POST", "/contributions", b.session, withTerms(x)));
  const short = await bad({ ...heightProposal, comment: "taller" });
  check("contribution: comment too short -> 400", short.status === 400 && short.body.errors.some((e) => /describe/.test(e)));
  const korean = await bad({ ...heightProposal, comment: "높이를 수정했습니다 120미터" });
  check("contribution: non-English comment -> 400", korean.status === 400);
  check("contribution: height out of range -> 400", (await bad({ ...heightProposal, proposal: { height: 5000 } })).status === 400);
  check("contribution: empty proposal -> 400", (await bad({ ...heightProposal, proposal: {} })).status === 400);
  check("contribution: OSM way without its base -> 400", (await bad({ ...heightProposal, base: undefined })).status === 400);
  const far = await bad({ ...heightProposal, proposal: { footprint: square(-73.9500, 40.7650) } });
  check("contribution: footprint moved > 200 m -> 400", far.status === 400 && far.body.errors.some((e) => /200 m/.test(e)), far.body?.errors?.join("; "));
  const ugly = await bad({ ...heightProposal, base: { ...wayBase, footprint: [[-73.96, 40.765], [-73.96, 40.765000001], [-73.95999, 40.765]] } });
  check("contribution: height-only edit ignores the original's shape problems", ugly.status === 201, JSON.stringify(ugly.body));

  const c1 = await callJson("POST", "/contributions", b.session, withTerms(heightProposal));
  check("contribution submitted (201, pending)", c1.status === 201 && c1.body.status === "pending");
  check("/me: ODbL agreement recorded", (await (await me(b.session)).json()).user?.acceptedTerms === true);
  const mineList = await callJson("GET", "/me/contributions", b.session);
  const byId = (list, id) => list.find((c) => c.id === id);
  check("a new proposal replaces the author's pending one for the same building", byId(mineList.body.contributions, c1.body.id)?.status === "pending" && byId(mineList.body.contributions, ugly.body.id)?.status === "withdrawn");
  check("review queue: contributor -> 403", (await call("GET", "/contributions", b.session)).status === 403);
  check("approve: contributor -> 403", (await call("POST", `/contributions/${c1.body.id}/approve`, b.session, {})).status === 403);
  const q1 = await callJson("GET", "/contributions", a.session);
  const q1c = byId(q1.body.contributions, c1.body.id);
  check("review queue lists it with author, base and no conflict", q1c?.author.login === "octo-user" && q1c.base.tags.name === "Corner Shop" && q1c.stale === false && q1c.proposal.height === 120 && !byId(q1.body.contributions, ugly.body.id));
  const ap1 = await callJson("POST", `/contributions/${c1.body.id}/approve`, a.session, {});
  const T4 = tileOf(-73.96, 40.765);
  const t4 = await getJson(`/overlay/14/${T4}.json`);
  const f777 = t4.body?.add?.find((x) => x.id === 777);
  check("approve: override published (height wins, OSM tags kept)", ap1.status === 200 && ap1.body.ref === "way:777" && t4.body.hide.includes(777) && f777?.tags["map3d:height"] === "120" && f777.tags.name === "Corner Shop" && f777.tags["building:levels"] === "2", JSON.stringify(f777?.tags));
  check("approve twice -> 409", (await call("POST", `/contributions/${c1.body.id}/approve`, a.session, {})).status === 409);
  check("author sees it approved", byId((await callJson("GET", "/me/contributions", b.session)).body.contributions, c1.body.id)?.status === "approved");

  // conflict: the building changes between proposal and approval
  const c2 = await callJson("POST", "/contributions", b.session, { ref: "way:777", proposal: { levels: 30 }, comment: "It has thirty floors in total." });
  await new Promise((r) => setTimeout(r, 5));
  await put(a.session, { ref: "way:777", edit: { footprint: wayBase.footprint, height: 99 } });
  const q2 = await callJson("GET", "/contributions", a.session);
  check("review queue flags a proposal whose building changed since", byId(q2.body.contributions, c2.body.id)?.stale === true);
  const ap2 = await callJson("POST", `/contributions/${c2.body.id}/approve`, a.session, {});
  check("approve after a change -> 409 conflict", ap2.status === 409 && ap2.body.error === "conflict" && byId((await callJson("GET", "/me/contributions", b.session)).body.contributions, c2.body.id)?.status === "conflict");
  const ap2f = await callJson("POST", `/contributions/${c2.body.id}/approve`, a.session, { force: true });
  const f777b = (await getJson(`/overlay/14/${T4}.json`)).body.add.find((x) => x.id === 777);
  check("approve anyway: only the proposed field changes", ap2f.status === 200 && f777b.tags["building:levels"] === "30" && f777b.tags["map3d:height"] === "99", JSON.stringify(f777b.tags));

  // reject, withdraw, new building
  const newHall = { proposal: { footprint: square(-73.9580, 40.7660), height: 15, buildingType: "commercial", name: "Park Kiosk" }, comment: "A kiosk that is missing from the map." };
  const c3 = await callJson("POST", "/contributions", b.session, newHall);
  check("reject without a reason -> 400", (await call("POST", `/contributions/${c3.body.id}/reject`, a.session, {})).status === 400);
  const rj = await callJson("POST", `/contributions/${c3.body.id}/reject`, a.session, { note: "Duplicate of the kiosk next door" });
  const c3mine = byId((await callJson("GET", "/me/contributions", b.session)).body.contributions, c3.body.id);
  check("rejected with the reason shown to the author", rj.status === 200 && c3mine?.status === "rejected" && c3mine.reviewNote === "Duplicate of the kiosk next door");
  const c4 = await callJson("POST", "/contributions", b.session, newHall);
  check("withdraw by another user -> 404", (await call("POST", `/contributions/${c4.body.id}/withdraw`, a.session, {})).status === 404);
  check("withdraw by the author", (await callJson("POST", `/contributions/${c4.body.id}/withdraw`, b.session, {})).body?.status === "withdrawn");
  check("approve a withdrawn one -> 409", (await call("POST", `/contributions/${c4.body.id}/approve`, a.session, {})).status === 409);
  const c5 = await callJson("POST", "/contributions", b.session, newHall);
  const ap5 = await callJson("POST", `/contributions/${c5.body.id}/approve`, a.session, {});
  const t5 = await getJson(`/overlay/14/${tileOf(-73.958, 40.766)}.json`);
  const added = t5.body?.add?.find((x) => x.id < 0);
  check("approved new building gets a new: ref and a negative id", ap5.status === 200 && /^new:\d+$/.test(ap5.body.ref) && added?.tags.name === "Park Kiosk" && added.tags.building === "commercial");
  check("its contribution now points at the building", byId((await callJson("GET", "/me/contributions", b.session)).body.contributions, c5.body.id)?.ref === ap5.body.ref);

  // limits: a GitHub account younger than 7 days gets 10 a day
  mock.state.user = { id: 3003, login: "octo-new", avatar_url: null, created_at: new Date().toISOString() };
  const n = await signIn();
  let lastStatus = 0;
  for (let i = 0; i < 11; i++) lastStatus = (await call("POST", "/contributions", n.session, withTerms({ ...heightProposal, ref: "way:888", proposal: { height: 20 + i } }))).status;
  check("new GitHub account: 11th contribution of the day -> 429", lastStatus === 429);
  mock.state.user = { id: 2002, login: "octo-user", avatar_url: null, created_at: "2024-01-01T00:00:00Z" };

  // 6. logout
  const lo2 =await fetch(`${API}/auth/logout`, { method: "POST", headers: { Origin: APP, Cookie: `map3d_session=${a.session}` } });
  const cleared = setCookies(lo2).find((c) => c.startsWith("map3d_session="));
  check("logout: 200 and cookie cleared", lo2.status === 200 && /Max-Age=0/.test(cleared ?? ""));
  check("after logout /me is signed out", (await (await me(a.session)).json()).user === null);

  // 7. banned user: existing session stops working, new sign-in refused
  sql("UPDATE users SET banned = 1 WHERE github_id = 2002");
  check("banned: existing session signed out", (await (await me(b.session)).json()).user === null);
  const banned = await signIn();
  check("banned: sign-in refused (auth=banned)", /auth=banned/.test(banned.final) && !banned.session);

  // 8. audit log
  const actions = JSON.parse(sql("SELECT action FROM audit_log ORDER BY id").stdout)[0].results.map((r) => r.action);
  check("audit log records sign-ins, overrides and contributions", ["login", "logout", "login_denied", "login_banned", "override_set", "override_removed", "terms_accepted", "contribution_submitted", "contribution_approved", "contribution_rejected", "contribution_withdrawn"].every((x) => actions.includes(x)), actions.join(","));
} catch (err) {
  check("unexpected error", false, err.stack);
  console.error(devLog.slice(-3000));
} finally {
  dev.kill();
  mock.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
