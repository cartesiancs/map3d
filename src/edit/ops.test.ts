import { describe, expect, it } from "vitest";
import { MeshData, meshTopology, meshVolume, normalizeMesh, validateMesh } from "@/contrib/mesh";
import * as ops from "./ops";
import { ElemSel, convertSelection, edgeKey, emptySelection, inMode, selectEverything, settle } from "./select";
import { boxMesh, rotateAbout, withHeight } from "./transform";
import { triangulateMesh } from "@/three/meshGeometry";

/** a closed solid that could be submitted */
function expectSolid(m: MeshData) {
  expect(validateMesh(normalizeMesh(m))).toEqual([]);
  expect(meshVolume(m)).toBeGreaterThan(0);
}

const box = () => boxMesh([126.978, 37.5665], 10, 10, 10);
const top = (m: MeshData) => {
  const h = Math.max(...m.verts.filter((_, i) => i % 3 === 1));
  return m.faces.findIndex((f) => f.length >= 3 && f.every((v) => m.verts[3 * v + 1] > h - 0.01));
};
const faces = (m: MeshData, ...f: number[]): ElemSel => settle(m, { ...emptySelection(), faces: new Set(f) }, "face");
const edges = (m: MeshData, ...e: [number, number][]): ElemSel => settle(m, { verts: new Set(), edges: new Set(e.map(([a, b]) => edgeKey(a, b))), faces: new Set() }, "edge");
const verts = (...v: number[]): ElemSel => ({ verts: new Set(v), edges: new Set(), faces: new Set() });
const moveSel = (m: MeshData, sel: ElemSel, d: [number, number, number]): MeshData => ({ ...m, verts: m.verts.map((v, i) => (sel.verts.has(Math.floor(i / 3)) ? v + d[i % 3] : v)) });
/** the edges of a box between ground and roof */
const verticalEdges = (m: MeshData) => {
  const out: [number, number][] = [];
  for (const f of m.faces)
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (a < b && m.verts[3 * a] === m.verts[3 * b] && m.verts[3 * a + 2] === m.verts[3 * b + 2]) out.push([a, b]);
    }
  return out;
};
const allEdges = (m: MeshData) => {
  const s = new Map<string, [number, number]>();
  for (const f of m.faces) for (let k = 0; k < f.length; k++) s.set(edgeKey(f[k], f[(k + 1) % f.length]), [f[k], f[(k + 1) % f.length]]);
  return [...s.values()];
};

describe("extrude", () => {
  it("a roof extruded up makes a tower", () => {
    const m = box();
    const out = ops.extrude({ mesh: m, sel: faces(m, top(m)), mode: "face" });
    expect(out.normal![1]).toBeGreaterThan(0.99);
    const up = moveSel(out.mesh, out.sel, [0, 5, 0]);
    expectSolid(up);
    expect(up.faces).toHaveLength(m.faces.length + 4);
    expect(meshVolume(up)).toBeGreaterThan(meshVolume(m));
  });

  it("a wall extruded out makes a bay", () => {
    const m = box();
    const wall = m.faces.findIndex((f, i) => i !== top(m) && f.some((v) => m.verts[3 * v + 1] > 5) && f.some((v) => m.verts[3 * v + 1] < 5));
    const out = ops.extrude({ mesh: m, sel: faces(m, wall), mode: "face" });
    expectSolid(moveSel(out.mesh, out.sel, out.normal!.map((c) => c * 3) as [number, number, number]));
  });

  it("the open rim of a roofless box grows walls, and F caps them: closed again", () => {
    const m = box();
    const open = ops.deleteElements({ mesh: m, sel: faces(m, top(m)), mode: "face" }, "faces").mesh;
    const rim = meshTopology(open).boundary;
    expect(rim).toHaveLength(4);
    const out = ops.extrude({ mesh: open, sel: edges(open, ...rim), mode: "edge" });
    expect(out.normal).toBeNull();
    const up = moveSel(out.mesh, out.sel, [0, 4, 0]);
    expect(meshTopology(up).boundary).toHaveLength(4); // still open at the new rim
    const capped = ops.fill({ mesh: up, sel: out.sel, mode: "edge" });
    expectSolid(capped.mesh);
    expect(Math.max(...capped.mesh.verts.filter((_, i) => i % 3 === 1))).toBeCloseTo(14, 6);
  });

  it("a lone vertex grows a loose edge; loose edges grow faces; F closes a loop of them", () => {
    const m = box();
    // build a separate triangle-ish fin out of nothing but vertex extrusions is not a solid: check the parts
    const e1 = ops.extrude({ mesh: m, sel: verts(0), mode: "vertex" });
    expect(meshTopology(e1.mesh).wire).toHaveLength(1);
    expect(e1.sel.verts.size).toBe(1);
    const wire = meshTopology(e1.mesh).wire[0];
    const e2 = ops.extrude({ mesh: e1.mesh, sel: edges(e1.mesh, wire), mode: "edge" });
    expect(meshTopology(e2.mesh).wire).toHaveLength(0); // the loose edge became a face's edge
    expect(e2.mesh.faces.length).toBe(m.faces.length + 1);
  });

  it("an edge between two faces grows a fin (flagged, not submittable)", () => {
    const m = box();
    const out = ops.extrude({ mesh: m, sel: edges(m, verticalEdges(m)[0]), mode: "edge" });
    const pulled = moveSel(out.mesh, out.sel, [3, 0, 0]);
    expect(meshTopology(pulled).nonManifold.length).toBeGreaterThan(0);
    expect(validateMesh(normalizeMesh(pulled)).length).toBeGreaterThan(0);
  });

  it("extruding nothing says so", () => {
    const m = box();
    expect(() => ops.extrude({ mesh: m, sel: emptySelection(), mode: "face" })).toThrow(ops.OpError);
  });
});

describe("fill and connect", () => {
  it("F on two corners of one face splits it (J too)", () => {
    const m = box();
    const r = m.faces[top(m)];
    const f = ops.fill({ mesh: m, sel: verts(r[0], r[2]), mode: "vertex" });
    expectSolid(f.mesh);
    expect(f.mesh.faces).toHaveLength(m.faces.length + 1);
    const j = ops.connect({ mesh: m, sel: verts(r[0], r[2]), mode: "vertex" });
    expect(j.mesh.faces).toHaveLength(m.faces.length + 1);
  });

  it("F on two vertices that share no face makes a loose edge", () => {
    const m = box();
    const low = m.faces[m.faces.findIndex((f) => f.every((v) => m.verts[3 * v + 1] === 0))];
    const r = m.faces[top(m)];
    // a bottom corner and the roof corner not above it nor beside it on a wall
    const a = low[0];
    const b = r.find((v) => !m.faces.some((f) => f.includes(a) && f.includes(v)))!;
    const out = ops.fill({ mesh: m, sel: verts(a, b), mode: "vertex" });
    expect(meshTopology(out.mesh).wire).toEqual([[a, b]]);
  });

  it("F on two vertices already joined says so", () => {
    const m = box();
    const r = m.faces[top(m)];
    expect(() => ops.fill({ mesh: m, sel: verts(r[0], r[1]), mode: "vertex" })).toThrow(/already joined/);
  });

  it("deleting the roof then F around the hole closes it", () => {
    const m = box();
    const open = ops.deleteElements({ mesh: m, sel: faces(m, top(m)), mode: "face" }, "faces").mesh;
    const hole = new Set(meshTopology(open).boundary.flat());
    expectSolid(ops.fill({ mesh: open, sel: { verts: hole, edges: new Set(), faces: new Set() }, mode: "vertex" }).mesh);
  });
});

describe("merge", () => {
  it("at center, two roof corners: still a solid (bent walls split on submit)", () => {
    const m = box();
    const r = m.faces[top(m)];
    expectSolid(ops.mergeAt({ mesh: m, sel: verts(r[0], r[1]), mode: "vertex" }, "center").mesh);
  });

  it("at the active vertex: the others move onto it", () => {
    const m = box();
    const r = m.faces[top(m)];
    const sel = { ...verts(r[0], r[1]), active: r[1] };
    const out = ops.mergeAt({ mesh: m, sel, mode: "vertex" }, "active");
    const [kept] = [...out.sel.verts];
    expect(out.mesh.verts.slice(3 * kept, 3 * kept + 3)).toEqual(m.verts.slice(3 * r[1], 3 * r[1] + 3));
  });

  it("at the active vertex without one picked says so", () => {
    const m = box();
    expect(() => ops.mergeAt({ mesh: m, sel: verts(0, 1), mode: "vertex" }, "active")).toThrow(/last/);
  });

  it("at a point (the cursor)", () => {
    const m = box();
    const r = m.faces[top(m)];
    const out = ops.mergeAt({ mesh: m, sel: verts(r[0], r[1]), mode: "vertex" }, [0, 12, 0]);
    const [kept] = [...out.sel.verts];
    expect(out.mesh.verts.slice(3 * kept, 3 * kept + 3)).toEqual([0, 12, 0]);
  });

  it("by distance: vertices closer than the distance become one", () => {
    const m = box();
    // a copy of corner 0, 5 mm away, used by nothing but a loose edge to corner 1
    const near = { ...m, verts: [...m.verts, m.verts[0] + 0.005, m.verts[1], m.verts[2]], faces: [...m.faces, [8, 1]] };
    const out = ops.mergeByDistance({ mesh: near, sel: emptySelection(), mode: "vertex" }, 0.01);
    expect(out.merged).toBe(1);
    expect(out.mesh.verts.length / 3).toBe(8);
    expect(meshTopology(out.mesh).wire).toHaveLength(0); // the loose edge is now an edge of the box
    expect(ops.mergeByDistance({ mesh: m, sel: emptySelection(), mode: "vertex" }, 0.01).merged).toBe(0);
  });
});

describe("inset", () => {
  it("an inset roof extruded up makes a penthouse", () => {
    const m = box();
    const ins = ops.insetFaces({ mesh: m, sel: faces(m, top(m)), mode: "face" }, 2);
    expectSolid(ins.mesh);
    const out = ops.extrude({ mesh: ins.mesh, sel: ins.sel, mode: "face" });
    expectSolid(moveSel(out.mesh, out.sel, [0, 4, 0]));
  });
});

describe("bevel", () => {
  for (const seg of [1, 3]) {
    it(`a wall corner, ${seg} segment(s)`, () => {
      const m = box();
      const out = ops.bevelEdges({ mesh: m, sel: edges(m, verticalEdges(m)[0]), mode: "edge" }, 1.5, seg);
      expectSolid(out.mesh);
      expect(out.mesh.faces).toHaveLength(m.faces.length + seg);
      expect(out.sel.faces.size).toBe(seg);
    });
  }

  it("a roof edge, 2 segments", () => {
    const m = box();
    const r = m.faces[top(m)];
    expectSolid(ops.bevelEdges({ mesh: m, sel: edges(m, [r[0], r[1]]), mode: "edge" }, 2, 2).mesh);
  });

  it("the whole roof outline (corners where two beveled edges meet)", () => {
    const m = box();
    const r = m.faces[top(m)];
    for (const seg of [1, 3]) {
      const out = ops.bevelEdges({ mesh: m, sel: edges(m, ...r.map((v, i) => [v, r[(i + 1) % 4]] as [number, number])), mode: "edge" }, 1.5, seg);
      expectSolid(out.mesh);
      expect(meshVolume(out.mesh)).toBeLessThan(meshVolume(m));
      expect(out.mesh.faces).toHaveLength(6 + 4 * seg); // strips meet at the corners: no corner faces
    }
  });

  it("every edge of a box (corners where three beveled edges meet)", () => {
    const m = box();
    for (const seg of [1, 2]) {
      const out = ops.bevelEdges({ mesh: m, sel: edges(m, ...allEdges(m)), mode: "edge" }, 1, seg);
      expectSolid(out.mesh);
      expect(out.mesh.faces).toHaveLength(6 + 12 * seg + 8); // a corner face at each of the 8 corners
    }
  });

  it("an edge ending where four faces meet (after a loop cut)", () => {
    const m = box();
    const cut = ops.loopCut({ mesh: m, sel: emptySelection(), mode: "edge" }, verticalEdges(m)[0], 0.5);
    // the lower half of a vertical edge: from the ground to the cut
    const ve = verticalEdges(cut.mesh).find(([a, b]) => Math.min(cut.mesh.verts[3 * a + 1], cut.mesh.verts[3 * b + 1]) === 0)!;
    const out = ops.bevelEdges({ mesh: cut.mesh, sel: edges(cut.mesh, ve), mode: "edge" }, 1, 2);
    expectSolid(out.mesh);
    // 2 strips, and a corner face where four faces met (the floor end merges into the floor)
    expect(out.mesh.faces).toHaveLength(cut.mesh.faces.length + 2 + 1);
  });

  it("an edge that is not between two faces says so", () => {
    const m = box();
    const open = ops.deleteElements({ mesh: m, sel: faces(m, top(m)), mode: "face" }, "faces").mesh;
    expect(() => ops.bevelEdges({ mesh: open, sel: edges(open, meshTopology(open).boundary[0]), mode: "edge" }, 1, 1)).toThrow(ops.OpError);
  });
});

describe("loop cut, knife, dissolve", () => {
  it("a loop cut around the walls, then dissolved again", () => {
    const m = box();
    const lc = ops.loopCut({ mesh: m, sel: emptySelection(), mode: "edge" }, verticalEdges(m)[0], 0.4);
    expectSolid(lc.mesh);
    expect(lc.mesh.faces).toHaveLength(m.faces.length + 4);
    expect(lc.sel.edges.size).toBe(4);
    expectSolid(ops.dissolve({ mesh: lc.mesh, sel: lc.sel, mode: "edge" }).mesh);
  });

  it("a loop cut over the roof raised into a gable", () => {
    const m = box();
    const r = m.faces[top(m)];
    const lc = ops.loopCut({ mesh: m, sel: emptySelection(), mode: "edge" }, [r[0], r[1]], 0.5);
    expectSolid({ ...lc.mesh, verts: lc.mesh.verts.map((v, i) => (i % 3 === 1 && lc.sel.verts.has((i - 1) / 3) && v > 5 ? v + 4 : v)) });
  });

  it("the knife across the roof, edge to edge and corner to corner", () => {
    const m = box();
    const r = m.faces[top(m)];
    const a = ops.knife({ mesh: m, sel: emptySelection(), mode: "vertex" }, [{ a: r[0], b: r[1], t: 0.5 }, { a: r[2], b: r[3], t: 0.5 }]);
    expectSolid(a.mesh);
    expect(a.mesh.faces).toHaveLength(m.faces.length + 1);
    expectSolid(ops.knife({ mesh: m, sel: emptySelection(), mode: "vertex" }, [{ vertex: r[0] }, { vertex: r[2] }]).mesh);
  });

  it("the knife through points inside the roof", () => {
    const m = box();
    const r = m.faces[top(m)];
    const out = ops.knife({ mesh: m, sel: emptySelection(), mode: "vertex" }, [{ a: r[0], b: r[1], t: 0.5 }, { inside: [1, 10, 1] }, { inside: [-1, 10, -1] }, { a: r[2], b: r[3], t: 0.5 }]);
    expectSolid(out.mesh);
    expect(out.mesh.faces).toHaveLength(m.faces.length + 1);
    expect(out.mesh.verts.length / 3).toBe(8 + 4);
  });

  it("the knife ending inside a face says so", () => {
    const m = box();
    const r = m.faces[top(m)];
    expect(() => ops.knife({ mesh: m, sel: emptySelection(), mode: "vertex" }, [{ a: r[0], b: r[1], t: 0.5 }, { inside: [1, 10, 1] }])).toThrow(/End the knife/);
  });

  it("dissolving the knife's end vertex joins its faces", () => {
    const m = box();
    const r = m.faces[top(m)];
    const kn = ops.knife({ mesh: m, sel: emptySelection(), mode: "vertex" }, [{ a: r[0], b: r[1], t: 0.5 }, { a: r[2], b: r[3], t: 0.5 }]);
    const v = [...kn.sel.verts][0];
    expect(ops.dissolve({ mesh: kn.mesh, sel: verts(v), mode: "vertex" }).mesh.faces.length).toBeLessThan(kn.mesh.faces.length);
  });
});

describe("normals and problems", () => {
  it("recalculating normals fixes an inside-out or mixed box", () => {
    const m = box();
    expect(validateMesh({ ...m, faces: m.faces.map((f) => [...f].reverse()) }).length).toBeGreaterThan(0);
    expectSolid(ops.recalcNormals({ ...m, faces: m.faces.map((f) => [...f].reverse()) }));
    expectSolid(ops.recalcNormals({ ...m, faces: m.faces.map((f, i) => (i % 2 ? [...f].reverse() : f)) }));
  });

  it("select problems finds the hole and the loose edges", () => {
    const m = box();
    const open = ops.deleteElements({ mesh: m, sel: faces(m, top(m)), mode: "face" }, "faces").mesh;
    expect(ops.selectNonManifold(open, "edge").edges.size).toBe(4);
    const wired = { ...m, faces: [...m.faces, [0, 6]] };
    expect(ops.selectNonManifold(wired, "edge").edges.has(edgeKey(0, 6))).toBe(true);
  });
});

describe("selection and transforms", () => {
  it("select everything and convert between modes", () => {
    const m = box();
    const all = selectEverything(m, "face");
    expect(all.faces.size).toBe(6);
    expect(all.verts.size).toBe(8);
    const r = m.faces[top(m)];
    const e = convertSelection(m, verts(...r), "vertex", "edge");
    expect(e.edges.size).toBe(4);
    const f = convertSelection(m, e, "edge", "face");
    expect([...f.faces]).toEqual([top(m)]);
  });

  it("an operation's result in the mode one works in: a bevel in edge mode selects the new strip's edges", () => {
    const m = box();
    const r = m.faces[top(m)];
    const out = ops.bevelEdges({ mesh: m, sel: edges(m, [r[0], r[1]]), mode: "edge" }, 1, 2);
    expect(out.sel.edges.size).toBe(0); // it gives faces
    const e = inMode(out.mesh, out.sel, "edge");
    expect(e.verts).toEqual(out.sel.verts);
    expect(e.edges.size).toBeGreaterThan(0);
    for (const k of e.edges) for (const v of k.split("-").map(Number)) expect(out.sel.verts.has(v)).toBe(true);
    // a result that already fits is kept as it is
    const cut = ops.loopCut({ mesh: m, sel: emptySelection(), mode: "edge" }, verticalEdges(m)[0], 0.5);
    expect(inMode(cut.mesh, cut.sel, "edge").edges).toEqual(cut.sel.edges);
  });

  it("loose edges are never selected as faces", () => {
    const m = { ...box(), faces: [...box().faces, [0, 6]] };
    expect(selectEverything(m, "face").faces.size).toBe(6);
  });

  it("rotation follows the right hand around the UI axes (X east, Y north, Z up)", () => {
    const r = rotateAbout([1, 0, 0], [0, 0, 0], "z", Math.PI / 2);
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[2]).toBeCloseTo(-1, 9); // east -> north
    const x = rotateAbout([0, 0, -1], [0, 0, 0], "x", Math.PI / 2);
    expect(x[1]).toBeCloseTo(1, 9); // north -> up
  });

  it("withHeight scales from the ground", () => {
    const h = withHeight(box(), 25);
    expect(Math.max(...h.verts.filter((_, i) => i % 3 === 1))).toBe(25);
    expectSolid(h);
  });

  it("triangles keep the faces' winding (same volume)", () => {
    const m = box();
    const tris = triangulateMesh(m);
    let vol = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]].map((k) => m.verts.slice(3 * k, 3 * k + 3));
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    expect(vol).toBeCloseTo(meshVolume(m), 6);
  });
});
