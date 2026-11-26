# map3d API (Cloudflare Worker)

Building contributions (design: `H:\map3d-osm\CONTRIBUTION-DESIGN.md`). Phase 1: sign-in with GitHub, sessions,
`/me`, admins by GitHub id. Phase 2: approved building edits, published as an overlay on top of the OSM tiles.
Phase 3: contributions (proposals) and the admin review queue; approving one publishes it like a direct edit.

| Route | |
|---|---|
| `GET /auth/login?return_to=<app page>` | redirect to GitHub (no scopes: public profile only) |
| `GET /auth/callback` | GitHub returns here; creates the session, goes back to the app with `?auth=ok\|denied\|error\|banned` |
| `POST /auth/logout` | ends the session (only from the app's origins) |
| `GET /me` | `{ user: { id, login, avatarUrl, isAdmin, acceptedTerms } \| null }` |
| `GET /health` | `{ ok: true }` |
| `POST /contributions` | signed in: propose a change `{ ref?, base?, proposal, comment, acceptTerms? }` → 201 `{ id }` (no `ref`: a new building) |
| `GET /me/contributions` | signed in: my last 100 contributions with their status and the reviewer's note |
| `POST /contributions/:id/withdraw` | the author, while it waits for review |
| `GET /contributions` | admin: the review queue (pending and conflicts, oldest first) with author stats, base and current state |
| `POST /contributions/:id/approve` | admin: `{ force?, note? }` → writes the override and publishes; 409 `conflict` if the building changed since |
| `POST /contributions/:id/reject` | admin: `{ note }` (required, shown to the author) |
| `PUT /admin/overrides` | admin: set an edit directly `{ ref?, baseFootprint?, baseTags?, edit: { footprint, height?, levels?, buildingType?, name? } }` (no `ref`: a new building) → `{ ref, rev }` |
| `DELETE /admin/overrides/:ref` | admin: revert an edit (`way:<id>`) or remove an added building (`new:<n>`) |
| `GET /admin/overrides` | admin: all edits |
| `GET /overlay/*` | the published overlay (development; production reads it from the CDN) |

The GitHub token is used once to read the profile, then revoked. The session is a random token in an
HttpOnly, Secure, SameSite=Lax cookie; D1 stores only its SHA-256.

**Overlay.** Every change rewrites the affected z14 tiles in the R2 bucket (`overlay/14/x/y.json`:
`{ hide: [OSM way ids], add: [features] }`, immutable, fetched with `?v=<rev>`), then `overlay/index.json`
(`{ rev, tiles: { "x/y": rev } }`, max-age 30 s). The app polls the index (every 2 min and whenever the tab
becomes visible), reloads the building tiles whose revision changed, and applies the same overlay to downloads.
An edit hides the OSM way in the tile that owns its first vertex and adds the edited footprint in its own owner
tile. Added buildings get negative ids (`map3d_new_<n>` in a GLB). Tags gain `map3d:height` (wins over
`building:levels`), `name:en` and `map3d:edited`. Before the first edit there is no index (404); the app treats
that as "no edits".

**Contributions.** A proposal stores only the fields it changes (`height`, `levels`, `buildingType`, `name`,
`footprint`). Approval lays them over the building's current state: its override, else the OSM footprint and
tags sent as `base` when the contributor started. `base_rev` remembers that state (the override's `updated_at`,
or `osm`); if another change was approved since, approval returns 409 and marks the contribution `conflict`, and
the admin rejects it or approves anyway (`force`, which still changes only the proposed fields). Rules
(`src/contributions.ts`, `../src/contrib/validate.ts`, shared with the app): English description of 10–500
characters, the ODbL agreement on the first contribution, the edit limits of validate.ts (an unchanged OSM
footprint is not shape-checked, so any building can get a height), an edited footprint within 200 m of the
original; at most 50 pending per user and 100 a day (10 a day for GitHub accounts younger than 7 days). A new
proposal for the same building replaces the author's pending one. Every step is in `audit_log`.

## One-time setup (production)

1. **GitHub OAuth App** — github.com → Settings → Developer settings → OAuth Apps → New OAuth App
   - Homepage URL: `https://map.fleet.im`
   - Authorization callback URL: `https://api.map3d.fleet.im/auth/callback`
   - Copy the **Client ID** into `wrangler.toml` → `[vars] GITHUB_CLIENT_ID` (it is public).
   - Generate a **client secret** and keep it for step 4 (never commit it).
2. **Cloudflare login** (opens the browser): `npx wrangler login`
3. **D1 database**: `npx wrangler d1 create map3d` → put the printed `database_id` into `wrangler.toml`,
   then `npm run db:migrate:remote`.
4. **Secret**: `npx wrangler secret put GITHUB_CLIENT_SECRET` (paste the secret at the prompt).
5. **Admins**: your numeric GitHub id (`https://api.github.com/users/<login>` → `"id"`) in
   `[vars] ADMIN_GITHUB_IDS` (comma-separated).
6. **R2**: the `DATA` binding is the map data bucket (`map3d-osm`). The CDN serves the overlay from it like the
   tiles, so the bucket's CORS policy must allow the app origin (it already does for the tiles).
7. **Domain**: uncomment the `routes` line in `wrangler.toml` (`api.map3d.fleet.im`, same zone as the CDN).
8. **Deploy**: `npm run deploy`, then `https://api.map3d.fleet.im/health` → `{"ok":true}`.

The app (`src/api/auth.ts`) calls `https://api.map3d.fleet.im` in production and `http://localhost:8787` in
development (`VITE_API_URL` overrides both). While the API cannot be reached, the app simply hides the
account button.

## Local development

- Real GitHub: create a second OAuth App with callback `http://localhost:8787/auth/callback` (an OAuth App has
  one callback URL), copy `.dev.vars.example` to `.dev.vars` and fill it in, then
  `npm install`, `npm run db:migrate:local`, `npm run dev`. The app on `http://localhost:5173` signs in against it.
- Without GitHub: `npm run test:e2e` runs the whole flow against a mock GitHub (66 checks: sign-in, admin /
  contributor, CORS, CSRF, forged state, cancel, replayed code, open redirect, edits and the published overlay,
  contributions: terms, validation, permissions, approve, conflicts, reject, withdraw, rate limits; logout,
  banned users, audit log).
  `node test/run-mock.mjs` + `wrangler dev` with the `--var` overrides in that file lets you click through it in
  a browser. The mock signs in as @octo-admin (id 1001); open `http://localhost:8788/__mock/as?id=2002&login=octo-user`
  before signing in to be a contributor instead.
