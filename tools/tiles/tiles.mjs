#!/usr/bin/env node
// map3d tiles: publish a data version as one CDN-cacheable object per tile. See README.md.
//
//   node tiles.mjs publish  --layer buildings [--src <local .pmtiles>] [--dry-run | --out <dir>]
//   node tiles.mjs verify   --layer buildings
//   node tiles.mjs manifest [--write | --remove]

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";
import { openArchive } from "./lib/archive.mjs";
import { publish } from "./lib/publish.mjs";
import { dirSink, makeSink, r2Sink } from "./lib/sinks.mjs";
import { FORMAT, INDEX_BYTES, baseOf, hasBit, indexKey, tileKey, tilesetKey } from "./lib/layout.mjs";

const LAYERS = ["buildings", "roads", "water"];
const HERE = fileURLToPath(new URL(".", import.meta.url)); // also on Windows, also with spaces

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    layer: { type: "string" },
    layers: { type: "string" },
    "archive-path": { type: "string" },
    src: { type: "string" },
    cdn: { type: "string", default: "https://cdn.map3d.fleet.im" },
    bucket: { type: "string", default: process.env.R2_BUCKET ?? "map3d-osm" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-check": { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    concurrency: { type: "string", default: "256" }, // uploads in flight: each one waits ~0.3 s for R2, so latency, not bandwidth, sets the pace
    threads: { type: "string" },
    bbox: { type: "string" },
    samples: { type: "string", default: "40" },
    origin: { type: "string", default: "https://map.fleet.im" },
    write: { type: "boolean", default: false },
    remove: { type: "boolean", default: false },
  },
});
const cdn = opt.cdn.replace(/\/+$/, "");
const sinkConfig = () => (opt.out ? { kind: "dir", root: opt.out } : opt["dry-run"] ? { kind: "null" } : { kind: "r2", bucket: opt.bucket });

async function liveManifest() {
  const res = await fetch(`${cdn}/manifest.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${cdn}/manifest.json: HTTP ${res.status}`);
  return res.json();
}

async function archivePathFor(layer) {
  if (opt["archive-path"]) return opt["archive-path"];
  if (!LAYERS.includes(layer)) throw new Error(`--layer must be one of ${LAYERS.join(", ")}`);
  const m = await liveManifest();
  if (!m[layer]) throw new Error(`the manifest has no ${layer} archive`);
  return m[layer];
}

/** a local copy must be byte-identical to the published archive (size + first 16 KB: header and root directory) */
async function checkSameArchive(local, url) {
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  const res = await fetch(url, { headers: { range: "bytes=0-16383" } });
  const remote = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  if (local.source.size !== size || local.fingerprint !== remote)
    throw new Error(`${opt.src} is not the archive published at ${url} (size ${local.source.size} vs ${size}); pass --no-check to publish it anyway`);
}

async function cmdPublish() {
  const archivePath = await archivePathFor(opt.layer);
  const base = baseOf(archivePath);
  const url = `${cdn}/${archivePath}`;
  const src = opt.src ?? url;
  const cfg = sinkConfig();
  const sink = makeSink({ ...cfg, concurrency: 2 }); // fails early without R2 credentials
  const archive = await openArchive(src);
  if (opt.src && !/^https?:/.test(opt.src) && !opt["no-check"]) await checkSameArchive(archive, url);
  const bbox = opt.bbox ? opt.bbox.split(",").map(Number) : null;
  if (bbox && (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)))) throw new Error("--bbox west,south,east,north");
  const h = archive.header;
  console.log(`${archivePath}: ${Number(h.numAddressedTiles).toLocaleString()} tiles at z${h.maxZoom}, ${(archive.source.size / 1e9).toFixed(1)} GB`);
  console.log(`reading ${src}`);
  console.log(`writing ${base}/… to ${sink.name}${bbox ? ` (only blocks touching ${bbox.join(",")})` : ""}`);
  // resume state per destination (bucket or folder) and archive
  const dest = opt.out ? `dir-${createHash("sha256").update(opt.out).digest("hex").slice(0, 8)}` : opt.bucket;
  const progressFile = opt["dry-run"] ? null : join(HERE, ".progress", `${dest}--${base.replace(/\//g, "--")}.json`);
  const { stats, tileset } = await publish({
    src,
    archive,
    archivePath,
    base,
    sinkConfig: cfg,
    concurrency: Number(opt.concurrency),
    ...(opt.threads ? { threads: Number(opt.threads) } : {}),
    bbox,
    progressFile,
    restart: opt.restart,
  });
  await archive.source.close();
  const s = (Date.now() - stats.t0) / 1000;
  console.log(
    `done in ${(s / 60).toFixed(1)} min: ${stats.tiles.toLocaleString()} tiles, ${(stats.bytes / 1e9).toFixed(2)} GB, ` +
      `${stats.indexFiles} index files + ${stats.emptyIndexFiles} empty ones` +
      (stats.skippedBlocks ? `, ${stats.skippedBlocks} blocks already done before` : ""),
  );
  if (tileset && cfg.kind !== "null") console.log(`complete: ${tilesetKey(base)} written. Next: node tiles.mjs verify --layer ${opt.layer ?? "<layer>"}`);
  if (tileset && cfg.kind === "null") console.log(`dry run complete: ${tileset.tiles.toLocaleString()} tiles in ${tileset.dataBlocks.length} blocks`);
}

/** Reads the published objects through the CDN like the app does and compares them with the archive. */
async function cmdVerify() {
  const layers = opt.layer ? [opt.layer] : opt.layers ? opt.layers.split(",") : LAYERS;
  const manifest = await liveManifest();
  let problems = 0;
  for (const layer of layers) {
    const archivePath = manifest[layer];
    if (!archivePath) continue;
    const base = baseOf(archivePath);
    const tsRes = await fetch(`${cdn}/${tilesetKey(base)}`, { cache: "no-store" });
    if (tsRes.status === 404) {
      console.log(`${layer}: not published (${tilesetKey(base)} missing)`);
      continue;
    }
    const ts = await tsRes.json();
    const issues = [];
    const note = (m) => issues.length < 20 && issues.push(m);
    if (ts.format !== FORMAT || !ts.complete || ts.source !== archivePath) note(`tileset.json does not describe ${archivePath} as complete`);
    const pm = new PMTiles(`${cdn}/${archivePath}`);
    const header = await pm.getHeader();
    if (Number(header.numAddressedTiles) !== ts.tiles) note(`tileset lists ${ts.tiles} tiles, the archive ${header.numAddressedTiles}`);

    const headers = { origin: opt.origin, "accept-encoding": "gzip" };
    const cf = { first: {}, second: {} };
    const times = [];
    const check = (res, what, type) => {
      if (res.status !== 200) return note(`${what}: HTTP ${res.status}`);
      const h = (k) => res.headers.get(k) ?? "";
      if (h("content-encoding") !== "gzip") note(`${what}: content-encoding "${h("content-encoding")}"`);
      if (!h("cache-control").includes("immutable")) note(`${what}: cache-control "${h("cache-control")}"`);
      if (!h("content-type").startsWith(type)) note(`${what}: content-type "${h("content-type")}"`);
      const acao = h("access-control-allow-origin");
      if (acao !== "*" && acao !== opt.origin) note(`${what}: access-control-allow-origin "${acao}"`);
    };
    const get = async (path, round) => {
      const t = performance.now();
      const res = await fetch(`${cdn}/${path}`, { headers });
      const body = Buffer.from(await res.arrayBuffer());
      times.push(performance.now() - t);
      const s = res.headers.get("cf-cache-status") ?? "none";
      cf[round][s] = (cf[round][s] ?? 0) + 1;
      return { res, body };
    };

    const want = Number(opt.samples);
    const blocks = [...ts.dataBlocks].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.ceil(want / 3)));
    let tiles = 0;
    let empties = 0;
    for (const b of blocks) {
      const [bx, by] = b.split("/").map(Number);
      const { res, body } = await get(indexKey(base, ts.indexZoom, bx, by), "first");
      check(res, `index ${b}`, "application/octet-stream");
      if (body.length !== INDEX_BYTES) {
        note(`index ${b}: ${body.length} bytes`);
        continue;
      }
      const set = [];
      const unset = [];
      for (let i = 0; i < 400 && (set.length < 3 || unset.length < 1); i++) {
        const x = bx * 256 + Math.floor(Math.random() * 256);
        const y = by * 256 + Math.floor(Math.random() * 256);
        (hasBit(body, x, y) ? set : unset).push([x, y]);
      }
      // dense blocks: also walk the bits for set ones
      for (let i = 0; set.length < 3 && i < INDEX_BYTES * 8; i++) if (body[i >> 3] & (1 << (i & 7))) set.push([bx * 256 + (i % 256), by * 256 + Math.floor(i / 256)]);
      for (const [x, y] of set.slice(0, 3)) {
        const path = tileKey(base, ts.zoom, x, y);
        const a = await get(path, "first");
        check(a.res, `tile ${x}/${y}`, "application/json");
        const ref = await pm.getZxy(ts.zoom, x, y);
        if (!ref) note(`tile ${x}/${y}: in the index, not in the archive`);
        else if (!Buffer.from(ref.data).equals(a.body)) note(`tile ${x}/${y}: bytes differ from the archive`);
        await get(path, "second");
        tiles++;
      }
      for (const [x, y] of unset.slice(0, 1)) {
        if (await pm.getZxy(ts.zoom, x, y)) note(`tile ${x}/${y}: in the archive, not in the index`);
        empties++;
      }
    }
    // a block without data has an (empty) index too
    for (let i = 0; i < 3; i++) {
      const side = 2 ** ts.indexZoom;
      const bx = Math.floor(Math.random() * side);
      const by = Math.floor(Math.random() * side);
      if (ts.dataBlocks.includes(`${bx}/${by}`)) continue;
      const { res, body } = await get(indexKey(base, ts.indexZoom, bx, by), "first");
      check(res, `empty index ${bx}/${by}`, "application/octet-stream");
      if (body.length !== INDEX_BYTES || body.some((v) => v !== 0)) note(`empty index ${bx}/${by}: not ${INDEX_BYTES} zero bytes`);
    }
    times.sort((a, b) => a - b);
    console.log(
      `${layer}: ${tiles} tiles compared with the archive, ${empties} empty tiles checked, ${blocks.length} index files; ` +
        `latency p50 ${times[times.length >> 1]?.toFixed(0)} ms; cf-cache-status 1st ${JSON.stringify(cf.first)} 2nd ${JSON.stringify(cf.second)}`,
    );
    for (const m of issues) console.log(`  PROBLEM ${m}`);
    if (!issues.length) console.log("  ok");
    problems += issues.length;
    if (cf.second.HIT === undefined) console.log("  note: no cache HIT on the second read: is the Cache Rule for this host in place?");
  }
  if (problems) process.exitCode = 1;
}

/** Adds (or with --remove drops) `tiles` in manifest.json for the layers whose upload is complete. */
async function cmdManifest() {
  const sink = opt.out ? dirSink(opt.out) : r2Sink({ bucket: opt.bucket, concurrency: 4 });
  const cur = await sink.get("manifest.json");
  if (!cur) throw new Error("manifest.json not found in the bucket");
  const manifest = JSON.parse(cur.body.toString("utf8"));
  const next = structuredClone(manifest);
  if (opt.remove) delete next.tiles;
  else {
    const tiles = {};
    for (const layer of opt.layers ? opt.layers.split(",") : LAYERS) {
      const archivePath = manifest[layer];
      if (!archivePath) continue;
      const base = baseOf(archivePath);
      const ts = await sink.get(tilesetKey(base));
      if (!ts) {
        console.log(`${layer}: not published (${tilesetKey(base)} missing), stays on ${archivePath}`);
        continue;
      }
      const t = JSON.parse(ts.body.toString("utf8"));
      if (t.format !== FORMAT || t.complete !== true || t.source !== archivePath) throw new Error(`${tilesetKey(base)} does not describe a complete upload of ${archivePath}`);
      tiles[layer] = { source: archivePath, base, zoom: t.zoom, indexZoom: t.indexZoom };
    }
    if (Object.keys(tiles).length) next.tiles = tiles;
    else delete next.tiles;
  }
  console.log("tiles now:  ", JSON.stringify(manifest.tiles ?? null));
  console.log("tiles after:", JSON.stringify(next.tiles ?? null));
  if (JSON.stringify(manifest) === JSON.stringify(next)) return console.log("no change");
  if (!opt.write && !opt.remove) return console.log("dry run: add --write to store it");
  const backup = join(HERE, ".backup", `manifest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await mkdir(join(HERE, ".backup"), { recursive: true });
  await writeFile(backup, cur.body);
  await sink.put("manifest.json", Buffer.from(JSON.stringify(next, null, 2)), {
    contentType: cur.contentType ?? "application/json",
    cacheControl: cur.cacheControl ?? "public, max-age=300",
  });
  console.log(`manifest.json stored (previous copy: ${backup}). The app switches within the manifest's cache time.`);
}

const commands = { publish: cmdPublish, verify: cmdVerify, manifest: cmdManifest };
const cmd = commands[positionals[0]];
if (!cmd) {
  console.log("usage: node tiles.mjs publish|verify|manifest [options]   (README.md)");
  process.exit(2);
}
cmd().catch((err) => {
  console.error(`error: ${err?.stack ?? err}`);
  process.exit(1);
});
