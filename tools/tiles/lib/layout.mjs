// Object layout of a published tile set. The app reads it in src/api/tileFiles.ts: keep both in step.
//
//   <base>/<z>/<x>/<y>.json              one tile: the archive's gzip JSON as is (Content-Encoding: gzip)
//   <base>/index/<iz>/<ix>/<iy>.bin      which tiles of a 256 x 256 block exist (gzip, 8192 bytes raw)
//   <base>/tileset.json                  written last: the upload is complete
//
// <base> is the archive path without ".pmtiles" (v20261116/buildings.pmtiles -> v20261116/buildings), so
// every data version has its own immutable objects. iz = z - 8. Every block of the world has an index file,
// empty ones included, so the app never asks for a tile that is not there and never gets a 404 by design.
// Index bit of tile (x, y): b = (y % 256) * 256 + (x % 256), in byte b >> 3, mask 1 << (b & 7).

export const BLOCK_SHIFT = 8;
export const BLOCK_SIDE = 1 << BLOCK_SHIFT;
export const INDEX_BYTES = (BLOCK_SIDE * BLOCK_SIDE) / 8;
/** objects never change under a versioned path */
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const FORMAT = "map3d-tiles";
export const FORMAT_VERSION = 1;

export const baseOf = (archivePath) => {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.pmtiles$/.test(archivePath) || archivePath.split("/").includes(".."))
    throw new Error(`unexpected archive path ${archivePath}`);
  return archivePath.replace(/\.pmtiles$/, "");
};
export const tileKey = (base, z, x, y) => `${base}/${z}/${x}/${y}.json`;
export const indexKey = (base, iz, bx, by) => `${base}/index/${iz}/${bx}/${by}.bin`;
export const tilesetKey = (base) => `${base}/tileset.json`;

export function setBit(bits, x, y) {
  const b = (y & (BLOCK_SIDE - 1)) * BLOCK_SIDE + (x & (BLOCK_SIDE - 1));
  bits[b >> 3] |= 1 << (b & 7);
}
export function hasBit(bits, x, y) {
  const b = (y & (BLOCK_SIDE - 1)) * BLOCK_SIDE + (x & (BLOCK_SIDE - 1));
  return (bits[b >> 3] & (1 << (b & 7))) !== 0;
}
