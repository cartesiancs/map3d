import { describe, expect, it } from "vitest";
import type { MeshData } from "@/contrib/mesh";
import { selfIntersections, trianglesCross } from "./intersect";
import { boxMesh, extrudeFootprint } from "./transform";

const box = (dx = 0, dz = 0, size = 10): MeshData => {
  const b = boxMesh([126.978, 37.5665], size, size, 10);
  return { ...b, verts: b.verts.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 2 ? v + dz : v)) };
};
/** two meshes as one */
const join = (a: MeshData, b: MeshData): MeshData => {
  const n = a.verts.length / 3;
  return { anchor: a.anchor, verts: [...a.verts, ...b.verts], faces: [...a.faces, ...b.faces.map((f) => f.map((v) => v + n))] };
};

describe("self-intersection", () => {
  it("a box does not cut itself", () => {
    expect(selfIntersections(box()).size).toBe(0);
  });

  it("an L-shaped building does not cut itself", () => {
    const l = extrudeFootprint([126.978, 37.5665], [[0, 0], [20, 0], [20, -8], [8, -8], [8, -20], [0, -20]], 12);
    expect(selfIntersections(l).size).toBe(0);
  });

  it("two boxes pushed into each other cut through each other", () => {
    expect(selfIntersections(join(box(), box(5, 5))).size).toBeGreaterThan(0);
  });

  it("two boxes side by side, touching, do not count", () => {
    expect(selfIntersections(join(box(), box(10, 0))).size).toBe(0);
  });

  it("crossing and touching triangles", () => {
    expect(trianglesCross([0, 0, 0], [2, 0, 0], [0, 2, 0], [0.5, 0.5, -1], [0.5, 0.5, 1], [1.5, 0.5, 0])).toBe(true);
    // a corner on the other triangle's face: touching
    expect(trianglesCross([0, 0, 0], [2, 0, 0], [0, 2, 0], [0.5, 0.5, 0], [0.5, 0.5, 1], [1.5, 0.5, 1])).toBe(false);
    // apart
    expect(trianglesCross([0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 5], [2, 0, 5], [0, 2, 5])).toBe(false);
  });
});
