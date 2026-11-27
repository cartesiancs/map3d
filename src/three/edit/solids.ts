// Building meshes drawn outside the tiles (edit mode, review): kept in their own meters (x east, y up,
// z south) under an object matrix that places them in the scene, so a rebase only changes the matrix.
// On terrain the ground offset is baked into the geometry (ground vertices on the lowest ground under
// the building, the rest on the highest), the rule of the tiles (terrain.ts computeBuildingBases).

import * as THREE from "three";
import type { MeshData } from "@/contrib/mesh";
import type { LngLat } from "@/contrib/validate";
import type { TileManager } from "../tiles/TileManager";
import { Origin, groundClass, meshFrame } from "../tiles/geo";
import { triangulateMesh } from "../meshGeometry";

/** mesh meters -> scene */
export function frameMatrix(origin: Origin, anchor: LngLat, target = new THREE.Matrix4()) {
  const f = meshFrame(origin, anchor[1], anchor[0]);
  return target.set(f.kx, 0, 0, f.ax, 0, 1, 0, 0, 0, 0, f.kz, f.az, 0, 0, 0, 1);
}

const _p = new THREE.Vector3();

/**
 * [lowest, highest] ground under the vertices a mesh stands on (any vertex when none does): [0, 0] without
 * terrain, null while a ground tile it needs is not loaded.
 */
export function groundUnder(tm: TileManager, verts: ArrayLike<number>, matrix: THREE.Matrix4): [number, number] | null {
  if (!tm.terrain) return [0, 0];
  let low = Infinity;
  let high = -Infinity;
  for (const onlyGround of [true, false]) {
    for (let i = 0; i < verts.length; i += 3) {
      if (onlyGround && groundClass(verts[i + 1]) !== 0) continue;
      _p.set(verts[i], 0, verts[i + 2]).applyMatrix4(matrix);
      const g = tm.groundHeightAt(_p.x, _p.z);
      if (g === null) return null;
      low = Math.min(low, g);
      high = Math.max(high, g);
    }
    if (low !== Infinity) break;
  }
  return low === Infinity ? [0, 0] : [low, high];
}

/** y of a vertex on the ground under it */
export const placedY = (y: number, [low, high]: [number, number]) => y + (groundClass(y) === 0 ? low : high);

/** the mesh as an indexed geometry in its meters, ground offset baked in */
export function solidGeometry(mesh: Pick<MeshData, "verts" | "faces">, ground: [number, number], triangles = triangulateMesh(mesh)) {
  const n = mesh.verts.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[3 * i] = mesh.verts[3 * i];
    pos[3 * i + 1] = placedY(mesh.verts[3 * i + 1], ground);
    pos[3 * i + 2] = mesh.verts[3 * i + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(triangles);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** lit like the tile buildings (flat shading: no normal buffer needed) */
export function solidMaterial(pbr: boolean, params: THREE.MeshLambertMaterialParameters) {
  const p = { flatShading: true, ...params };
  return pbr ? new THREE.MeshStandardMaterial(p as THREE.MeshStandardMaterialParameters) : new THREE.MeshLambertMaterial(p);
}

/** dispose every geometry under `group` and empty it (materials are shared and kept) */
export function clearGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) g.dispose();
  });
  group.clear();
}
