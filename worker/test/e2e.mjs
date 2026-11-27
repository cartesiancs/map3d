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
const dev = spawn(process.execPath, [WRANGLER, "dev", "--port", "8787", "--local-upstream", "localhost:8787", "--persist-to", PERSIST, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: ROOT, env });
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

  // 5c. changesets: several buildings at once -> review queue -> approve all / reject, conflicts, withdraw, limits
  const call = (method, p, session, body, origin = APP) =>
    fetch(`${API}${p}`, { method, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: `map3d_session=${session}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const callJson = async (...args) => { const r = await call(...args); return { status: r.status, body: await r.json().catch(() => null) }; };
  const byId = (list, id) => list.find((c) => c.id === id);
  const mineOf = async (session) => (await callJson("GET", "/me/changesets", session)).body.changesets;
  const tileJson = async (lng, lat) => (await getJson(`/overlay/14/${tileOf(lng, lat)}.json`)).body;
  // wire format of src/contrib/mesh.ts: anchor in 1e-7°, vertices in mm (each the difference to the previous one), [n, i…] faces
  const encode = (anchor, verts, faces) => {
    const v = [];
    let prev = [0, 0, 0];
    for (let i = 0; i < verts.length; i += 3) {
      const q = [0, 1, 2].map((k) => Math.round(verts[i + k] * 1000));
      v.push(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      prev = q;
    }
    return { a: [Math.round(anchor[0] * 1e7), Math.round(anchor[1] * 1e7)], q: 1, v, f: faces.flatMap((f) => [f.length, ...f]) };
  };
  // a house with a gable roof (x east, y up, z south): 10 × 10 m, eaves at 5 m, ridge at 8 m
  const houseVerts = [0, 0, 0, 10, 0, 0, 10, 0, -10, 0, 0, -10, 0, 5, 0, 10, 5, 0, 10, 5, -10, 0, 5, -10, 5, 8, 0, 5, 8, -10];
  const houseFaces = [[3, 2, 1, 0], [0, 1, 5, 8, 4], [2, 3, 7, 9, 6], [1, 2, 6, 5], [3, 0, 4, 7], [5, 6, 9, 8], [7, 4, 8, 9]];
  const houseAt = [-73.9585, 40.7655];
  const house = encode(houseAt, houseVerts, houseFaces);
  // a plain box: stored as footprint + height
  const boxVerts = [0, 0, 0, 8, 0, 0, 8, 0, -8, 0, 0, -8, 0, 6, 0, 8, 6, 0, 8, 6, -8, 0, 6, -8];
  const boxFaces = [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const boxAt = [-73.9575, 40.7658];

  const wayBase = { footprint: square(-73.9600, 40.7650), tags: { building: "yes", "building:levels": "2", name: "Corner Shop" } };
  const shedBase = { footprint: square(-73.9590, 40.7652, 0.0001), tags: { building: "shed" } };
  const items1 = [
    { ref: "way:777", kind: "modify", base: wayBase, baseRev: "osm", proposal: { height: 120 } },
    { kind: "create", clientId: "draft-house", proposal: { mesh: house } },
    { ref: "way:999", kind: "delete", base: shedBase, baseRev: "osm" },
  ];
  const cs = (items, extra = {}) => ({ items, comment: "Surveyed the block on site, see the city 3D model.", ...extra });
  check("changeset: no session -> 401", (await call("POST", "/changesets", null, cs(items1))).status === 401);
  check("changeset: another origin -> 403", (await call("POST", "/changesets", b.session, cs(items1), "https://evil.example")).status === 403);
  const needsTerms = await callJson("POST", "/changesets", b.session, cs(items1));
  check("changeset: the first one needs the ODbL agreement", needsTerms.status === 400 && needsTerms.body?.error === "terms");
  const submitB = (items, extra = {}) => callJson("POST", "/changesets", b.session, cs(items, { acceptTerms: true, ...extra }));
  const errorsOf = (r) => r.body?.errors?.join("; ") ?? JSON.stringify(r.body);
  const shortC = await submitB(items1, { comment: "taller" });
  check("changeset: comment too short -> 400", shortC.status === 400 && shortC.body.errors.some((e) => /describe/.test(e)));
  check("changeset: non-English comment -> 400", (await submitB(items1, { comment: "높이를 수정했습니다 120미터" })).status === 400);
  check("changeset: height out of range -> 400", (await submitB([{ ...items1[0], proposal: { height: 5000 } }])).status === 400);
  check("changeset: empty proposal -> 400", (await submitB([{ ...items1[0], proposal: {} }])).status === 400);
  check("changeset: OSM way without its base -> 400", (await submitB([{ ...items1[0], base: undefined }])).status === 400);
  const farC = await submitB([{ ...items1[0], proposal: { footprint: square(-73.9500, 40.7650) } }]);
  check("changeset: footprint moved > 200 m -> 400", farC.status === 400 && farC.body.errors.some((e) => /200 m/.test(e)), errorsOf(farC));
  check("changeset: the same building twice -> 400", (await submitB([items1[0], { ...items1[0], proposal: { levels: 4 } }])).status === 400);
  check("changeset: 51 buildings -> 400", (await submitB(Array.from({ length: 51 }, (_, i) => ({ ...items1[0], ref: `way:${5000 + i}` })))).status === 400);
  const spread = await submitB([items1[0], { kind: "create", proposal: { footprint: square(-73.9400, 40.7650), height: 10 } }]);
  check("changeset: buildings more than 1 km apart -> 400", spread.status === 400 && spread.body.errors.some((e) => /1000 m/.test(e)), errorsOf(spread));
  const holed = await submitB([{ kind: "create", proposal: { mesh: encode(houseAt, houseVerts, houseFaces.slice(1)) } }]);
  check("mesh with a hole -> 400", holed.status === 400 && holed.body.errors.some((e) => /not closed/.test(e)), errorsOf(holed));
  const inverted = await submitB([{ kind: "create", proposal: { mesh: encode(houseAt, houseVerts, houseFaces.map((f) => [...f].reverse())) } }]);
  check("mesh turned inside out -> 400", inverted.status === 400 && inverted.body.errors.some((e) => /inwards/.test(e)), errorsOf(inverted));
  const floating = await submitB([{ kind: "create", proposal: { mesh: encode(houseAt, houseVerts.map((v, i) => (i % 3 === 1 ? v + 3 : v)), houseFaces) } }]);
  check("mesh above the ground -> 400", floating.status === 400 && floating.body.errors.some((e) => /ground/.test(e)), errorsOf(floating));
  const badFace = await submitB([{ kind: "create", proposal: { mesh: { ...house, f: [3, 0, 1, 99] } } }]);
  check("mesh face pointing at a missing vertex -> 400", badFace.status === 400);
  check("changeset: started from an old version of the building -> 409", (await submitB([{ ...items1[0], baseRev: "2020-01-01T00:00:00.000Z" }])).status === 409);
  const ugly = await submitB([{ ref: "way:778", kind: "modify", base: { ...wayBase, footprint: [[-73.96, 40.765], [-73.96, 40.765000001], [-73.95999, 40.765]] }, proposal: { height: 30 } }]);
  check("changeset: height-only edit ignores the original's shape problems", ugly.status === 201, JSON.stringify(ugly.body));

  const c1 = await submitB(items1);
  check("changeset submitted (201, pending)", c1.status === 201 && c1.body.status === "pending", JSON.stringify(c1.body));
  check("/me: ODbL agreement recorded", (await (await me(b.session)).json()).user?.acceptedTerms === true);
  const mc1 = byId(await mineOf(b.session), c1.body.id);
  check("my changesets list it with its buildings", mc1?.status === "pending" && mc1.items.length === 3 && mc1.items[1].clientId === "draft-house" && mc1.items[0].fields.includes("height") && mc1.items[1].fields.includes("shape") && mc1.items[2].kind === "delete", JSON.stringify(mc1));
  const locked = await submitB([{ ...items1[0], proposal: { height: 121 } }]);
  check("a building in my pending changeset can't go into another one", locked.status === 400 && locked.body.errors.some((e) => /pending changeset/.test(e)), errorsOf(locked));
  check("review queue: contributor -> 403", (await call("GET", "/changesets", b.session)).status === 403);
  check("approve: contributor -> 403", (await call("POST", `/changesets/${c1.body.id}/approve`, b.session, {})).status === 403);
  const q1 = byId((await callJson("GET", "/changesets", a.session)).body.changesets, c1.body.id);
  check("review queue lists it with its author and no conflict", q1?.author.login === "octo-user" && q1.stale === false && q1.items.length === 3);
  const d1 = await callJson("GET", `/changesets/${c1.body.id}`, a.session);
  check("changeset detail: full proposals, the OSM base and the mesh", d1.status === 200 && d1.body.items[0].base.tags.name === "Corner Shop" && d1.body.items[0].proposal.height === 120 && d1.body.items[1].proposal.mesh?.v.length === 30 && d1.body.items[2].kind === "delete", JSON.stringify(d1.body?.items?.map((i) => i.proposal)));
  const ap1 = await callJson("POST", `/changesets/${c1.body.id}/approve`, a.session, {});
  const f777 = (await tileJson(-73.96, 40.765))?.add?.find((x) => x.id === 777);
  check("approve: every building published (height wins, OSM tags kept)", ap1.status === 200 && f777?.tags["map3d:height"] === "120" && f777.tags.name === "Corner Shop" && f777.tags["building:levels"] === "2", JSON.stringify(ap1.body));
  const houseRef = ap1.body.items?.find((i) => i.kind === "create")?.ref;
  const fHouse = (await tileJson(...houseAt))?.add?.find((x) => x.id < 0);
  check("approved new mesh building: new: ref, negative id, mesh and outline in the tile", /^new:\d+$/.test(houseRef ?? "") && fHouse?.m?.f.length === house.f.length && fHouse.tags["map3d:mesh"] === "1" && fHouse.tags["map3d:height"] === "8" && fHouse.g[0][0].length === 10, JSON.stringify(fHouse?.tags));
  const tShed = await tileJson(-73.959, 40.7652);
  check("approved removal: the OSM way is hidden and nothing is added", tShed?.hide.includes(999) && !tShed.add.some((x) => x.id === 999), JSON.stringify(tShed));
  check("approve twice -> 409", (await call("POST", `/changesets/${c1.body.id}/approve`, a.session, {})).status === 409);
  const m1b = byId(await mineOf(b.session), c1.body.id);
  check("author sees it approved, with the new building's ref", m1b?.status === "approved" && m1b.items[1].ref === houseRef);
  check("a removed building can't be edited", (await submitB([{ ref: "way:999", kind: "modify", proposal: { height: 10 } }])).status === 400);

  // a box is kept as an extruded footprint; resubmitting replaces my pending changeset
  const c2 = await submitB([{ kind: "create", proposal: { mesh: encode(boxAt, boxVerts, boxFaces), levels: 2 } }]);
  const d2 = await callJson("GET", `/changesets/${c2.body.id}`, b.session);
  const p2 = d2.body?.items?.[0]?.proposal;
  check("a box mesh is stored as footprint + height", c2.status === 201 && p2?.mesh === undefined && p2?.footprint?.length === 4 && p2.height === 6 && p2.levels === 2, JSON.stringify(p2));
  check("superseding a changeset that is not mine -> 400", (await submitB([{ kind: "create", proposal: { footprint: square(-73.9570, 40.7660), height: 9 } }], { supersedes: ["00000000-0000-4000-8000-000000000000"] })).status === 400);
  const c3 = await submitB([{ kind: "create", proposal: { mesh: encode(boxAt, boxVerts.map((v, i) => (i % 3 === 1 && v ? 9 : v)), boxFaces) } }], { supersedes: [c2.body.id] });
  const mine3 = await mineOf(b.session);
  check("resubmitting replaces my pending changeset", c3.status === 201 && byId(mine3, c2.body.id)?.status === "withdrawn" && byId(mine3, c2.body.id)?.supersededBy === c3.body.id, JSON.stringify(c3.body));

  // replacing my own changeset that was decided meanwhile: nothing left to replace, the new one goes in
  const c6x = await submitB([{ kind: "create", proposal: { footprint: square(-73.9572, 40.7661), height: 9 } }]);
  await callJson("POST", `/changesets/${c6x.body.id}/reject`, a.session, { note: "Not there" });
  const c7x = await submitB([{ kind: "create", proposal: { footprint: square(-73.9572, 40.7661), height: 9 } }], { supersedes: [c6x.body.id] });
  const m7x = await mineOf(b.session);
  check("superseding my changeset that was already rejected: accepted, the rejection stays", c7x.status === 201 && byId(m7x, c6x.body.id)?.status === "rejected" && !byId(m7x, c6x.body.id)?.supersededBy, JSON.stringify(c7x.body));
  await callJson("POST", `/changesets/${c7x.body.id}/withdraw`, b.session, {});

  // conflict: a building changes between proposal and approval
  const c4 = await submitB([{ ref: "way:777", kind: "modify", baseRev: f777.tags["map3d:edited"], proposal: { levels: 30 } }]);
  await new Promise((r) => setTimeout(r, 5));
  await put(a.session, { ref: "way:777", edit: { footprint: wayBase.footprint, height: 99 } });
  check("review queue flags a changeset whose building changed since", c4.status === 201 && byId((await callJson("GET", "/changesets", a.session)).body.changesets, c4.body.id)?.stale === true, JSON.stringify(c4.body));
  const ap4 = await callJson("POST", `/changesets/${c4.body.id}/approve`, a.session, {});
  check("approve after a change -> 409 conflict, naming the building", ap4.status === 409 && ap4.body.error === "conflict" && ap4.body.refs?.includes("way:777") && byId(await mineOf(b.session), c4.body.id)?.status === "conflict");
  const ap4f = await callJson("POST", `/changesets/${c4.body.id}/approve`, a.session, { force: true });
  const f777b = (await tileJson(-73.96, 40.765)).add.find((x) => x.id === 777);
  check("approve anyway: only the proposed field changes", ap4f.status === 200 && f777b.tags["building:levels"] === "30" && f777b.tags["map3d:height"] === "99", JSON.stringify(f777b.tags));

  // a new height for a mesh building scales it up from its ground
  const c5 = await submitB([{ ref: houseRef, kind: "modify", baseRev: fHouse.tags["map3d:edited"], proposal: { height: 16 } }]);
  const ap5 = await callJson("POST", `/changesets/${c5.body.id}/approve`, a.session, {});
  const fHouse2 = (await tileJson(...houseAt)).add.find((x) => x.id < 0);
  const ridgeY = fHouse2?.m?.v.filter((_, i) => i % 3 === 1).reduce((s, d) => s + d, 0); // last vertex: the north ridge end
  check("mesh building given a new height: scaled from its ground", c5.status === 201 && ap5.status === 200 && fHouse2.tags["map3d:height"] === "16" && ridgeY === 16000, `${JSON.stringify(c5.body)} ${ridgeY}`);

  // reject, withdraw
  const kiosk = [{ kind: "create", proposal: { footprint: square(-73.9580, 40.7660), height: 15 } }];
  const c6 = await submitB(kiosk);
  check("reject without a reason -> 400", (await call("POST", `/changesets/${c6.body.id}/reject`, a.session, {})).status === 400);
  const rj = await callJson("POST", `/changesets/${c6.body.id}/reject`, a.session, { note: "Duplicate of the kiosk next door" });
  const c6mine = byId(await mineOf(b.session), c6.body.id);
  check("rejected with the reason shown to the author", rj.status === 200 && c6mine?.status === "rejected" && c6mine.reviewNote === "Duplicate of the kiosk next door");
  const c7 = await submitB(kiosk);
  check("withdraw by another user -> 404", (await call("POST", `/changesets/${c7.body.id}/withdraw`, a.session, {})).status === 404);
  check("withdraw by the author", (await callJson("POST", `/changesets/${c7.body.id}/withdraw`, b.session, {})).body?.status === "withdrawn");
  check("approve a withdrawn one -> 409", (await call("POST", `/changesets/${c7.body.id}/approve`, a.session, {})).status === 409);

  // admin direct edit with a mesh
  const pm = await put(a.session, { edit: { mesh: encode([126.9790, 37.5670], houseVerts, houseFaces) } });
  const fpm = (await tileJson(126.979, 37.567))?.add?.find((x) => x.m);
  check("admin override with a mesh: published with its outline", pm.status === 200 && fpm?.tags["map3d:height"] === "8" && fpm.g[0][0].length === 10);

  // limits: a GitHub account younger than 7 days
  mock.state.user = { id: 3003, login: "octo-new", avatar_url: null, created_at: new Date().toISOString() };
  const n = await signIn();
  check("changeset detail: someone else's -> 404", (await call("GET", `/changesets/${c1.body.id}`, n.session)).status === 404);
  const tooMany = await callJson("POST", "/changesets", n.session, cs(Array.from({ length: 11 }, (_, i) => ({ ref: `way:${6000 + i}`, kind: "modify", base: wayBase, proposal: { height: 20 } })), { acceptTerms: true }));
  check("new GitHub account: 11 buildings in one changeset -> 400", tooMany.status === 400, errorsOf(tooMany));
  let lastStatus = 0;
  for (let i = 0; i < 4; i++) lastStatus = (await call("POST", "/changesets", n.session, cs([{ ref: `way:${7000 + i}`, kind: "modify", base: wayBase, proposal: { height: 20 + i } }], { acceptTerms: true }))).status;
  check("new GitHub account: 4th changeset of the day -> 429", lastStatus === 429);
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
  check("audit log records sign-ins, overrides and changesets", ["login", "logout", "login_denied", "login_banned", "override_set", "override_removed", "terms_accepted", "changeset_submitted", "changeset_approved", "changeset_rejected", "changeset_withdrawn"].every((x) => actions.includes(x)), actions.join(","));
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
