// Building meshes (src/contrib/mesh.ts) as triangles: used by the tile builder (worker), the edit and review
// layers and the GLB export.

import { ShapeUtils, Vector2 } from "three";
import type { MeshData } from "@/contrib/mesh";
import { MeshFrame, groundClass } from "./tiles/geo";

/**
 * Triangles of one polygon face (vertex indices, appended to `out`), wound like the face: the polygon is
 * projected onto the plane its normal points at most (Newell normal), then ear-clipped.
 */
export function triangulateFace(p: ArrayLike<number>, face: number[], out: number[]) {
  if (face.length < 3) return; // a loose edge: nothing to fill
  if (face.length === 3) {
    out.push(face[0], face[1], face[2]);
    return;
  }
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = 3 * face[i];
    const b = 3 * face[(i + 1) % face.length];
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  // drop the dominant axis; (u, v) cyclic so that the face is counter-clockwise when its normal is positive
  const [u, v, sign] = ax >= ay && ax >= az ? [1, 2, Math.sign(nx)] : ay >= az ? [2, 0, Math.sign(ny)] : [0, 1, Math.sign(nz)];
  const contour = face.map((i) => new Vector2(p[3 * i + u], p[3 * i + v]));
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
    const cross = (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) - (contour[b].y - contour[a].y) * (contour[c].x - contour[a].x);
    if (cross * (sign || 1) >= 0) out.push(face[a], face[b], face[c]);
    else out.push(face[a], face[c], face[b]);
  }
}

/** every face's triangles */
export function triangulateMesh(m: Pick<MeshData, "verts" | "faces">): number[] {
  const out: number[] = [];
  for (const f of m.faces) triangulateFace(m.verts, f, out);
  return out;
}

/**
 * Mesh vertices in scene coordinates (the map's vertical exaggeration kept: y in meters), with their ground
 * class (0: on the ground) and the horizontal bounds.
 */
export function meshToScene(m: Pick<MeshData, "verts">, frame: MeshFrame) {
  const n = m.verts.length / 3;
  const positions = new Float32Array(n * 3);
  const classes = new Uint8Array(n);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = 0;
  for (let i = 0; i < n; i++) {
    const x = frame.ax + m.verts[3 * i] * frame.kx;
    const y = m.verts[3 * i + 1];
    const z = frame.az + m.verts[3 * i + 2] * frame.kz;
    positions[3 * i] = x;
    positions[3 * i + 1] = y;
    positions[3 * i + 2] = z;
    classes[i] = groundClass(y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (y > maxY) maxY = y;
  }
  return { positions, classes, bounds: [minX, minZ, maxX, maxZ, maxY] as const };
}
