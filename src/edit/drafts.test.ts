import { describe, expect, it } from "vitest";
import { MeshData, normalizeMesh, prismToMesh, validateMesh } from "@/contrib/mesh";
import type { LngLat } from "@/contrib/validate";
import { Draft, changesetErrors, draftErrors, isChanged, movedM, onlyHeight, toItem } from "./drafts";
import { mapVerts, withHeight } from "./transform";

const ring = (lng: number, lat: number, d = 0.0002): LngLat[] => [
  [lng, lat],
  [lng + d, lat],
  [lng + d, lat + d],
  [lng, lat + d],
];

function draft(mesh: MeshData, original: MeshData | null = mesh, extra: Partial<Draft> = {}): Draft {
  return {
    id: "way:1",
    ref: "way:1",
    featureId: 1,
    kind: "modify",
    base: { footprint: ring(126.978, 37.5665), tags: {} },
    baseRev: "osm",
    tags: {},
    original,
    originalLevels: null,
    mesh,
    levels: null,
    deleted: false,
    ...extra,
  };
}

describe("what a draft submits", () => {
  it("unchanged: nothing", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    expect(isChanged(draft(m))).toBe(false);
  });

  it("only taller: just the height (the footprint is not sent through the shape rules)", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    expect(toItem(draft(withHeight(m, 14), m)).proposal).toEqual({ height: 14 });
  });

  it("an OSM ring with a repeated point, only taller: still just the height", () => {
    const r = ring(126.978, 37.5665);
    const m = prismToMesh([r[0], r[1], r[1], r[2], r[3]], 10); // a duplicate corner, as OSM sometimes has
    expect(toItem(draft(withHeight(m, 14), m)).proposal).toEqual({ height: 14 });
  });

  it("moved: footprint and height (still an extruded footprint)", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    const p = toItem(draft(mapVerts(m, null, ([x, y, z]) => [x + 3, y, z]), m)).proposal!;
    expect(Object.keys(p).sort()).toEqual(["footprint", "height"]);
  });

  it("a gable roof: a mesh", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    const bent = { ...m, verts: m.verts.map((v, i) => (i === 3 * 4 + 1 || i === 3 * 5 + 1 ? v + 3 : v)) };
    expect(toItem(draft(bent, m)).proposal!.mesh).toBeDefined();
  });

  it("removed: a delete with its base", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    const it = toItem(draft(m, m, { deleted: true }));
    expect(it.kind).toBe("delete");
    expect(it.base).toBeDefined();
  });
});

describe("limits checked before sending", () => {
  it("moved more than 200 m", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    const far = mapVerts(m, null, ([x, y, z]) => [x + 250, y, z]);
    expect(movedM(draft(far, m))).toBeCloseTo(250, 0);
    expect(draftErrors(draft(far, m)).join()).toMatch(/200 m/);
    expect(draftErrors(draft(mapVerts(m, null, ([x, y, z]) => [x + 50, y, z]), m))).toEqual([]);
  });

  it("buildings more than 1 km apart in one changeset", () => {
    const a = prismToMesh(ring(126.978, 37.5665), 10);
    const b = prismToMesh(ring(126.995, 37.5665), 10); // ≈ 1.5 km east
    const near = prismToMesh(ring(126.979, 37.5665), 10);
    expect(changesetErrors([draft(withHeight(a, 12), a), draft(withHeight(b, 12), b, { id: "way:2", ref: "way:2" })]).join()).toMatch(/1000 m/);
    expect(changesetErrors([draft(withHeight(a, 12), a), draft(withHeight(near, 12), near, { id: "way:3", ref: "way:3" })])).toEqual([]);
  });

  it("more than 50 buildings", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    const many = Array.from({ length: 51 }, (_, i) => draft(withHeight(m, 12), m, { id: `way:${i}`, ref: `way:${i}` }));
    expect(changesetErrors(many).join()).toMatch(/at most 50/);
  });
});

describe("Height editing", () => {
  it("onlyHeight: taller or lower, or not changed at all", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    expect(onlyHeight(draft(m))).toBe(true);
    expect(onlyHeight(draft(withHeight(m, 31.5), m))).toBe(true);
    expect(onlyHeight(draft(withHeight(m, 31.5), m, { levels: 9 }))).toBe(true);
  });

  it("onlyHeight: not when moved, reshaped, removed or new", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    expect(onlyHeight(draft(mapVerts(m, null, ([x, y, z]) => [x + 3, y, z]), m))).toBe(false);
    const bent = { ...m, verts: m.verts.map((v, i) => (i === 3 * 4 + 1 ? v + 3 : v)) };
    expect(onlyHeight(draft(bent, m))).toBe(false);
    expect(onlyHeight(draft(m, m, { deleted: true }))).toBe(false);
    expect(onlyHeight(draft(m, null, { kind: "create", ref: null, featureId: null, base: null }))).toBe(false);
  });

  it("a footprint the shape rules refuse (it crosses itself) can still be given a height", () => {
    const [lng, lat, d] = [126.978, 37.5665, 0.0002];
    const m = prismToMesh([[lng, lat], [lng + d, lat + d], [lng + d, lat], [lng, lat + d]], 10);
    expect(validateMesh(normalizeMesh(m)).length).toBeGreaterThan(0);
    const taller = draft(withHeight(m, 14), m);
    expect(draftErrors(taller)).toEqual([]);
    expect(toItem(taller).proposal).toEqual({ height: 14 });
  });

  it("…but only within the height limits", () => {
    const m = prismToMesh(ring(126.978, 37.5665), 10);
    expect(draftErrors(draft(withHeight(m, 950), m)).join()).toMatch(/between 2 and 900 m/);
  });
});
