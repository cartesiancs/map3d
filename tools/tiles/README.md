# map3d tiles: one CDN-cacheable object per tile

The app used to read every tile with a range request into a large PMTiles archive on R2. Cloudflare cannot
cache those (a file over 512 MB is never cached), so each read was a billed R2 Class B operation and took
three round trips for a new area. This tool publishes a data version as one object per tile, which the CDN
caches at the edge and the browser keeps on disk:

```
<base>/<z>/<x>/<y>.json            the archive's gzip JSON tile as is (Content-Encoding: gzip)
<base>/index/<z-8>/<bx>/<by>.bin   which tiles of a 256 x 256 block exist: 1 bit per tile (gzip, 8192 bytes)
<base>/tileset.json                written last: the upload is complete
```

`<base>` is the archive path without `.pmtiles` (`v20261116/buildings.pmtiles` → `v20261116/buildings`), so every
data version has its own objects and they never change (`Cache-Control: public, max-age=31536000, immutable`).
Every block of the world has an index file (empty ones too), so the app never asks for a tile that does not exist,
and a missing index is an error rather than an empty map. Layout: `lib/layout.mjs` (the app: `src/api/tileFiles.ts`).

The app uses a layer's tiles only when `manifest.json` lists them for that very archive:

```json
"tiles": { "buildings": { "source": "v20261116/buildings.pmtiles", "base": "v20261116/buildings", "zoom": 14, "indexZoom": 6 } }
```

Any other layer, or a manifest written by the pipeline for a new version (no `tiles`, or `tiles` of an older
archive), keeps working from the PMTiles archive. Rolling back is removing `tiles` (`manifest --remove`).

## Measured (v20261116)

| layer | tiles | data | blocks with data / empty | full read of the archive |
|---|---|---|---|---|
| buildings | 4,521,389 | 28.4 GB | 1,277 / 2,819 | all tiles valid gzip, 6.3 min from the CDN |
| roads | 14,977,159 | 37.5 GB | 1,254 / 2,842 | all tiles valid gzip, 10.8 min from the CDN |
| water (z10) | 637,322 | 0.2 GB | 16 / 0 | all tiles valid gzip (deduplicated archive) |

Reading an archive from the CDN costs about one R2 read per 32 MB (~2,000 for roads). Uploading is the slow
part: R2 bills 4.50 USD per million writes (the first million each month are free), so a version costs about
20 USD (buildings) + 67 USD (roads) + 3 USD (water). Each upload costs 0.5–0.8 ms of CPU (request signing, HTTP), so the tool spreads blocks over
worker threads (`--threads`, default: cores - 1, at most 8); the network upload speed is the other limit
(28 GB + 37.5 GB).

## One-time Cloudflare setup

1. **R2 API token**: R2 → Manage R2 API Tokens → Create, permission *Object Read & Write*, bucket `map3d-osm`.
   Keep the Access Key ID and Secret Access Key (shown once). The account id is on the R2 overview page.
2. **Cache Rule** for the data host (zone fleet.im → Caching → Cache Rules → Create rule):
   - When: `http.host eq "cdn.map3d.fleet.im"`
   - Then: *Eligible for cache*; Edge TTL: *Use cache-control header if present* (tiles: 1 year, manifest
     5 min, overlay index 30 s); Browser TTL: *Respect origin*.
   - Large `.pmtiles` files stay uncached by themselves (over the 512 MB limit).
3. Optional: Caching → Tiered Cache → *Smart Tiered Caching* (fewer misses reach R2).

## Publishing a data version

Node 20 or newer, in `tools/tiles`: `npm install`. Credentials in the environment (PowerShell: `$env:NAME = "…"`):

```
R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
```

1. Publish each layer (the archive path comes from the live `manifest.json`). Reading the local copy the pipeline
   built is fastest; it is checked to be the same file as the published one (size, header, root directory):

   ```
   node tiles.mjs publish --layer buildings --src H:\map3d-osm\…\buildings.pmtiles
   node tiles.mjs publish --layer water     --src H:\map3d-osm\…\water.pmtiles
   node tiles.mjs publish --layer roads     --src H:\map3d-osm\…\roads.pmtiles
   ```

   Without `--src` it reads the archive from the CDN. An interrupted run continues where it stopped when started
   again (state in `.progress/`; `--restart` starts over). `--dry-run` reads and checks everything and uploads
   nothing.
2. Check what the CDN serves, compared byte by byte with the archive (also headers, CORS, cache hits):

   ```
   node tiles.mjs verify --layer buildings
   ```

3. Switch the app over (stores `manifest.json` with `tiles` for every layer whose upload is complete; the old
   manifest is saved in `.backup/`). Without `--write` it only shows the change:

   ```
   node tiles.mjs manifest --write
   ```

   Browsers pick it up within the manifest's cache time (5 min). Rollback: `node tiles.mjs manifest --remove`.

A new data version from the pipeline starts on PMTiles (its manifest has no `tiles`) until steps 1–3 run for it.
