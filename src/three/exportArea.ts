// GLB export of a selected area, independent of what is streamed into the view, following the settings:
// - buildings: one extruded mesh each (as before)
// - roads: only when Roads is on
// - terrain on: the terrain mesh of the area, and buildings / roads placed on it exactly as in the 3D view
//   (walls from the lowest ground under the footprint, roof `height` above the highest; roads split along
//   the terrain triangles). The terrain is the very grid the view draws (cells of ≈ 58 m that cover the
//   selection), so nothing floats or sinks in the file either.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/Addons.js";
import { BBox, fetchBuildings, fetchRoads, wayGeometry } from "@/api/osmSource";
import { buildingHeight, latToTileYf, lngToTileXf, makeOrigin, tileXfToLng, tileYfToLat, toScene } from "./tiles/geo";
import { GRID, TERRAIN_Z, computeRoadHeights, getGrid, sampler } from "./tiles/terrain";
import { BUILDING_COLOR, GROUND_COLOR, ROAD_COLOR } from "./tiles/TileManager";

export type ExportOptions = { roads: boolean; terrain: boolean };

/** roads drawn this much above the ground (scene units), as in the view */
const ROAD_LIFT = 0.8;

/** Terrain cells (the view's z13 grid) covering the bbox, as one mesh in the export's coordinates. */
async function terrainMesh(bbox: BBox, o: ReturnType<typeof makeOrigin>) {
  const G = GRID;
  const u0 = Math.floor(lngToTileXf(bbox.west, TERRAIN_Z) * G);
  const u1 = Math.ceil(lngToTileXf(bbox.east, TERRAIN_Z) * G);
  const v0 = Math.floor(latToTileYf(bbox.north, TERRAIN_Z) * G);
  const v1 = Math.ceil(latToTileYf(bbox.south, TERRAIN_Z) * G);
  const grids = new Map<string, Float32Array>();
  const tx0 = Math.floor(u0 / G), tx1 = Math.floor(u1 / G), ty0 = Math.floor(v0 / G), ty1 = Math.floor(v1 / G);
  const jobs: Promise<void>[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push(getGrid(tx, ty).then((g) => void grids.set(`${tx}/${ty}`, g.heights)));
  await Promise.all(jobs);

  const W = u1 - u0 + 1;
  const H = v1 - v0 + 1;
  const pos = new Float32Array(W * H * 3);
  for (let r = 0; r < H; r++) {
    const v = v0 + r;
    const z = toScene(o, tileYfToLat(v / G, TERRAIN_Z), o.lng)[1];
    for (let c = 0; c < W; c++) {
      const u = u0 + c;
      const x = toScene(o, o.lat, tileXfToLng(u / G, TERRAIN_Z))[0];
      // a vertex on a tile edge exists in both tiles with the same height (seamless grids)
      const tx = Math.min(tx1, Math.floor(u / G));
      const ty = Math.min(ty1, Math.floor(v / G));
      const h = grids.get(`${tx}/${ty}`)![(v - ty * G) * (G + 1) + (u - tx * G)];
      pos.set([x, h, z], (r * W + c) * 3);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const a = r * W + c;
      const b = a + 1;
      const cc = a + W;
      const d = cc + 1;
      index.push(a, cc, b, b, cc, d); // same diagonal as the view's terrain
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: GROUND_COLOR }));
  mesh.name = "terrain";
  return mesh;
}

export async function exportAreaGLB(bbox: BBox, options: ExportOptions, fileName = "scene.glb") {
  const [buildings, roads] = await Promise.all([fetchBuildings(bbox), options.roads ? fetchRoads(bbox) : Promise.resolve([])]);
  const o = makeOrigin((bbox.south + bbox.north) / 2, (bbox.west + bbox.east) / 2);
  const root = new THREE.Group();

  // footprints in scene coordinates (x, z); the shape plane is (x, north) with north = −z
  const footprints: { id: number; tags: Record<string, string>; xz: [number, number][] }[] = [];
  for (const f of buildings) {
    const g = wayGeometry(f);
    if (!g || g.length < 3) continue;
    footprints.push({ id: f.id, tags: f.tags, xz: g.map((p) => toScene(o, p.lat, p.lon)) });
  }
  const ground = options.terrain
    ? await sampler(o, footprints.flatMap((f) => f.xz.flatMap(([x, z]) => [x, 0, z])), 3)
    : null;

  const material = new THREE.MeshStandardMaterial({ color: BUILDING_COLOR });
  for (const f of footprints) {
    const pts = f.xz.map(([x, z]) => new THREE.Vector2(x, -z));
    if (!pts[0].equals(pts[pts.length - 1])) pts.push(pts[0]);
    const depth = buildingHeight(f.tags);
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { steps: 1, depth, bevelEnabled: false });
    if (ground) {
      // walls from the lowest ground under the footprint, roof `depth` above the highest (as in the view)
      let low = Infinity;
      let high = -Infinity;
      for (const [x, z] of f.xz) {
        const h = ground(x, z);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
      const p = geometry.getAttribute("position");
      for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) < depth / 2 ? low : high + depth); // local z → world y
      geometry.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.name = `way_${f.id}`; // OSM way id ("/" is rewritten by several glTF loaders)
    root.add(mesh);
  }

  if (options.roads) {
    let positions: number[] | Float32Array = [];
    const segs: number[] = [];
    for (const f of roads) {
      const g = wayGeometry(f);
      if (!g) continue;
      for (let i = 0; i < g.length - 1; i++) {
        const [ax, az] = toScene(o, g[i].lat, g[i].lon);
        const [bx, bz] = toScene(o, g[i + 1].lat, g[i + 1].lon);
        segs.push(ax, 0.1, az, bx, 0.1, bz);
      }
    }
    positions = segs;
    if (options.terrain && segs.length) {
      const r = await computeRoadHeights(new Float32Array(segs), o);
      positions = r.positions;
      for (let v = 0; v < r.heights.length; v++) positions[v * 3 + 1] += r.heights[v] + ROAD_LIFT;
    }
    if (positions.length) {
      const roadGeometry = new THREE.BufferGeometry();
      roadGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const lines = new THREE.LineSegments(roadGeometry, new THREE.LineBasicMaterial({ color: ROAD_COLOR }));
      lines.name = "roads";
      root.add(lines);
    }
  }

  if (options.terrain) {
    // features crossing the selection edge are exported whole: the terrain covers them too
    const ext = { ...bbox };
    const grow = (lat: number, lng: number) => {
      ext.south = Math.min(ext.south, lat);
      ext.north = Math.max(ext.north, lat);
      ext.west = Math.min(ext.west, lng);
      ext.east = Math.max(ext.east, lng);
    };
    for (const f of buildings) wayGeometry(f)?.forEach((p) => grow(p.lat, p.lon));
    for (const f of roads) wayGeometry(f)?.forEach((p) => grow(p.lat, p.lon));
    root.add(await terrainMesh(ext, o));
  }

  const result = await new GLTFExporter().parseAsync(root, { binary: true });
  root.traverse((obj) => (obj as THREE.Mesh).geometry?.dispose());
  if (!(result instanceof ArrayBuffer)) throw new Error("GLB export failed");

  const url = URL.createObjectURL(new Blob([result], { type: "model/gltf-binary" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { buildings: footprints.length, roads: options.roads ? roads.length : 0, terrain: options.terrain, bytes: result.byteLength };
}
