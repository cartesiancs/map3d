# CLAUDE.md

## Paid cloud resources: estimate the cost first

This project runs on paid Cloudflare services: R2 (bucket `map3d-osm`, public at `cdn.map3d.fleet.im`), Workers
(`api.map3d.fleet.im`) and D1. In November 2026 an upload tool written by Claude (`tools/tiles`, one R2 object per
tile) made about 5.18 million R2 Class A writes in one day (22.50 USD), because its cost was not shown to the user
before it ran.

Rules for every session:

1. Before writing or running anything that calls a paid service, count the requests it will make (writes, reads,
   lists) and show the user the count and the cost in USD. Run it only after the user confirms.
2. Do not design jobs whose request count grows with the number of items (one object per tile, one write per row).
   Bundle items into large objects or batches.
3. A tool that calls a paid service prints its request count and cost estimate before it starts, and does not start
   a large job without an explicit flag.
4. For code that serves end users, state the cost per user action and what happens when traffic surges or a client
   misbehaves (cache misses, retries, bots, cache-busting query strings). Keep that cost bounded with CDN caching
   and rate limits.

## Cost model (checked 2026-11-27)

R2 Standard: Class A (writes, lists) 4.50 USD per million, Class B (reads, HEAD) 0.36 USD per million, storage
0.015 USD per GB-month. Free each month: 1 M Class A, 10 M Class B, 10 GB-month. Usage is rounded up to the next
whole billing unit (1 M operations). Requests answered from the Cloudflare cache do not reach R2.

What app users cost:

- Buildings and water tiles are one immutable file each (`manifest.json` → `tiles`), cached at the edge: an R2 read
  only on a cache miss (the first request at a data center, or after eviction).
- Roads are read with Range requests from `v20261116/roads.pmtiles` (37.5 GB). Cloudflare does not cache a file over
  512 MB (`cf-cache-status: DYNAMIC`), so every roads tile a user loads is one R2 Class B read.
- A query string bypasses the cache (`?anything` gives `MISS`), so any client can turn any request into an R2 read.
- `manifest.json` (max-age 300 s) and `overlay/index.json` (max-age 30 s, polled every 120 s per tab): at most one R2
  read per data center per cache period.
- `/me` on every page load: one Worker request and one D1 query.
- Elevation (AWS open data) and the OSM raster map are not billed to this project.
