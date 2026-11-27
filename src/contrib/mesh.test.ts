import { describe, expect, it } from "vitest";
import {
  classifyPrism,
  decodeMesh,
  encodeMesh,
  encodedMeshError,
  groundArea,
  groundCenter,
  meshTopology,
  meshVolume,
  normalizeMesh,
  prismToMesh,
  toLocal,
  validateMesh,
} from "./mesh";
import type { LngLat } from "./validate";

const square: LngLat[] = [
  [126.978, 37.5665],
  [126.9782, 37.5665],
  [126.9782, 37.5667],
  [126.978, 37.5667],
];

describe("prisms", () => {
  it("an extruded footprint is a valid closed solid with its volume outside", () => {
    const m = prismToMesh(square, 20);
    expect(validateMesh(m)).toEqual([]);
    expect(meshVolume(m)).toBeGreaterThan(0);
  });

  it("a clockwise footprint is turned around", () => {
    expect(validateMesh(prismToMesh([...square].reverse(), 12))).toEqual([]);
  });

  it("classifies back to the same footprint and height", () => {
    const c = classifyPrism(prismToMesh(square, 20))!;
    expect(c.height).toBe(20);
    expect(c.footprint).toHaveLength(4);
    for (const p of c.footprint) expect(square.some((q) => Math.abs(q[0] - p[0]) < 1e-7 && Math.abs(q[1] - p[1]) < 1e-7)).toBe(true);
  });

  it("ground area and center are the footprint's", () => {
    const m = prismToMesh(square, 9);
    const [w] = toLocal(square[0], square[1]);
    const [, h] = toLocal(square[0], square[3]);
    expect(groundArea(m)).toBeCloseTo(Math.abs(w * h), 2); // anchors differ: the projection differs by a hair
    const c = groundCenter(m);
    expect(c[0]).toBeCloseTo(126.9781, 7);
    expect(c[1]).toBeCloseTo(37.5666, 7);
  });
});

describe("wire format", () => {
  it("round-trips to the millimeter", () => {
    const m = prismToMesh(square, 20);
    const d = decodeMesh(encodeMesh(m));
    d.verts.forEach((v, i) => expect(Math.abs(v - m.verts[i])).toBeLessThan(6e-4));
    expect(d.faces).toEqual(m.faces);
  });

  it("refuses malformed data", () => {
    expect(encodedMeshError({ a: [0, 0], q: 1, v: [0, 0], f: [] })).toMatch(/vertices/);
    expect(encodedMeshError({ a: [0, 0], q: 1, v: [0, 0, 0], f: [3, 0, 1, 2] })).toMatch(/missing/);
    expect(encodedMeshError({ a: [0, 0], q: 2, v: [], f: [] })).toMatch(/quantum/);
  });
});

describe("checks", () => {
  it("an open, an inverted and a floating mesh are refused", () => {
    const m = prismToMesh(square, 20);
    expect(validateMesh({ ...m, faces: m.faces.slice(1) }).join()).toMatch(/not closed/);
    expect(validateMesh({ ...m, faces: m.faces.map((f) => [...f].reverse()) }).join()).toMatch(/inwards/);
    expect(validateMesh({ ...m, verts: m.verts.map((v, i) => (i % 3 === 1 ? v + 3 : v)) }).join()).toMatch(/ground/);
  });

  it("loose edges are named, and left out on submission", () => {
    const m = prismToMesh(square, 20);
    const wired = { ...m, faces: [...m.faces, [0, 6]] };
    expect(meshTopology(wired).wire).toEqual([[0, 6]]);
    expect(validateMesh(wired).join()).toMatch(/loose edges/);
    expect(validateMesh(normalizeMesh(wired))).toEqual([]);
  });

  it("a bent face is split on submission (a quad along its shorter diagonal)", () => {
    const m = prismToMesh(square, 20);
    const bent = { ...m, verts: m.verts.map((v, i) => (i === 3 * 4 + 1 ? v + 3 : v)) }; // one roof corner up
    expect(validateMesh(bent).join()).toMatch(/not flat/);
    const clean = normalizeMesh(bent);
    expect(validateMesh(clean)).toEqual([]);
  });
});
