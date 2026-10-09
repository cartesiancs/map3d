import * as THREE from 'three';
import { buildingDimensions, type Feature, type GeoPoint } from '../data/layers.ts';
import { terrainHeight, type Terrain } from '../data/terrain.ts';
export type Projection = (p: GeoPoint) => THREE.Vector2;
import { palette, landColors, sceneColors } from './palette.ts';
export { palette, landColors } from './palette.ts';
export const safeColor = (value: string | undefined, fallback: string) => value && (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) || Object.prototype.hasOwnProperty.call(THREE.Color.NAMES, value.toLowerCase())) ? value : fallback;
function makeShape(feature: Feature, project: Projection) {
  const shape = new THREE.Shape(feature.geometry.map(project));
  for (const hole of feature.holes || []) shape.holes.push(new THREE.Path(hole.map(project)));
  return shape;
}
/** Roof mesh splits triangles at a gable ridge so its peak survives triangulation. */
function roofGeometry(shape: THREE.Shape, height: number, tags: Record<string, string>) {
  const { shape: outline, holes } = shape.extractPoints(12);
  const triangles = THREE.ShapeUtils.triangulateShape(outline, holes);
  const vertices = [...outline, ...holes.flat()];
  const box = new THREE.Box2().setFromPoints(outline), center = box.getCenter(new THREE.Vector2());
  const size = box.getSize(new THREE.Vector2());
  const direction = parseFloat(tags['roof:direction']);
  const axis = Number.isFinite(direction) ? new THREE.Vector2(Math.sin(direction * Math.PI / 180), Math.cos(direction * Math.PI / 180)) : size.x > size.y ? new THREE.Vector2(0, 1) : new THREE.Vector2(1, 0);
  if (tags['roof:orientation'] === 'across' && !Number.isFinite(direction)) axis.set(axis.y, axis.x);
  const span = Math.max(.1, ...outline.map(p => Math.abs(p.clone().sub(center).dot(axis))));
  const raised = (p: THREE.Vector2) => {
    const ratio = tags['roof:shape'] === 'pyramidal' ? Math.max(Math.abs(p.x - center.x) / Math.max(.1, size.x / 2), Math.abs(p.y - center.y) / Math.max(.1, size.y / 2)) : Math.abs(p.clone().sub(center).dot(axis)) / span;
    return height * Math.max(0, 1 - ratio);
  };
  const positions: number[] = [];
  const append = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) => { for (const p of [a,b,c]) positions.push(p.x, p.y, raised(p)); };
  for (const triangle of triangles) {
    const polygon = triangle.map(i => vertices[i]);
    // Clip both halves of each triangle against the ridge, preserving concave outlines and holes.
    if (tags['roof:shape'] === 'gabled') {
      for (const side of [-1, 1]) {
        const clipped: THREE.Vector2[] = [];
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i], b = polygon[(i + 1) % polygon.length];
          const da = a.clone().sub(center).dot(axis) * side, db = b.clone().sub(center).dot(axis) * side;
          if (da >= 0) clipped.push(a);
          if ((da < 0) !== (db < 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
        }
        for (let i = 1; i < clipped.length - 1; i++) append(clipped[0], clipped[i], clipped[i + 1]);
      }
    } else {
      // Split at both pyramid center axes so the apex appears on rectangular footprints.
      let polys = [polygon];
      for (const axis of ['x', 'y'] as const) {
        polys = polys.flatMap(poly => [-1, 1].map(side => {
          const clipped: THREE.Vector2[] = [];
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length], da = (a[axis] - center[axis]) * side, db = (b[axis] - center[axis]) * side;
            if (da >= 0) clipped.push(a);
            if ((da < 0) !== (db < 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
          }
          return clipped;
        }).filter(p => p.length >= 3));
      }
      for (const poly of polys) for (let i = 1; i < poly.length - 1; i++) append(poly[0], poly[i], poly[i + 1]);
    }
  }
  // Vertical gable ends close the roof volume above the walls.
  for (const ring of [outline, ...holes]) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const edge = [a];
    const da = a.clone().sub(center).dot(axis), db = b.clone().sub(center).dot(axis);
    if (tags['roof:shape'] === 'gabled' && da * db < 0) edge.push(a.clone().lerp(b, da / (da - db)));
    edge.push(b);
    for (let j = 0; j < edge.length - 1; j++) {
      const p = edge[j], q = edge[j + 1];
      positions.push(p.x,p.y,0, q.x,q.y,0, q.x,q.y,raised(q), p.x,p.y,0, q.x,q.y,raised(q), p.x,p.y,raised(p));
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals(); return geometry;
}
export function featureColor(feature: Feature, roof = false) {
  if (feature.layer === 'Buildings') return safeColor(feature.tags[roof ? 'roof:colour' : 'building:colour'], roof ? sceneColors.roof : palette.Buildings);
  return feature.layer === 'Land use' ? landColors[feature.tags.landuse] || palette['Land use'] : palette[feature.layer];
}
export function buildFeatureGeometries(feature: Feature, project: Projection, terrain: Terrain | null) {
  const building = feature.layer === 'Buildings';
  const center = feature.geometry.reduce((p,v) => ({ lat: p.lat + v.lat / feature.geometry.length, lon: p.lon + v.lon / feature.geometry.length }), { lat: 0, lon: 0 });
  const anchor = project(center);
  const dimensions = buildingDimensions(feature.tags);

    if (feature.kind === 'point') return [];
    if (feature.kind === 'line') {
      // Add intermediate samples so long road segments follow elevation.
      const linePoints: THREE.Vector3[] = [];
      for (let i = 0; i < feature.geometry.length - 1; i++) {
        const a = feature.geometry[i], b = feature.geometry[i + 1];
        const segments = terrain ? Math.min(100, Math.max(1, Math.ceil(project(a).distanceTo(project(b)) / 40))) : 1;
        for (let j = 0; j < segments; j++) {
          const p = { lat: a.lat + (b.lat - a.lat) * j / segments, lon: a.lon + (b.lon - a.lon) * j / segments }, v = project(p);
          linePoints.push(new THREE.Vector3(v.x, terrainHeight(terrain, p) + .8, -v.y));
        }
      }
      const p = feature.geometry[feature.geometry.length - 1], v = project(p); linePoints.push(new THREE.Vector3(v.x, terrainHeight(terrain,p) + .8, -v.y));
      return [new THREE.BufferGeometry().setFromPoints(linePoints)];
    }
    const shape = makeShape(feature, project);
    if (building) return [new THREE.ExtrudeGeometry(shape, { depth: dimensions.bodyHeight, bevelEnabled: false }), ...(dimensions.roofHeight ? [roofGeometry(shape, dimensions.roofHeight, feature.tags)] : [])];
    const geometry = new THREE.ShapeGeometry(shape);
    // Flat area triangles are subdivided to follow the sampled terrain mesh.
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const sourcePositions = source.getAttribute('position');
    const box = new THREE.Box2().setFromPoints(feature.geometry.map(project));
    const subdivisions = terrain ? Math.min(8, Math.max(1, Math.ceil(box.getSize(new THREE.Vector2()).length() / 60))) : 1, out: number[] = [];
    const inverse = (v: THREE.Vector2) => ({ lat: center.lat + (v.y - anchor.y) / 111320, lon: center.lon + (v.x - anchor.x) / (111320 * Math.cos(center.lat * Math.PI / 180)) });
    const emit = (p: THREE.Vector2) => { out.push(p.x, p.y, terrainHeight(terrain, inverse(p)) + (feature.layer === 'Land use' ? .12 : .35)); };
    for (let i = 0; i < sourcePositions.count; i += 3) {
      const a = new THREE.Vector2(sourcePositions.getX(i), sourcePositions.getY(i)), b = new THREE.Vector2(sourcePositions.getX(i+1), sourcePositions.getY(i+1)), c = new THREE.Vector2(sourcePositions.getX(i+2), sourcePositions.getY(i+2));
      const at = (x: number, y: number) => a.clone().add(b.clone().sub(a).multiplyScalar(x / subdivisions)).add(c.clone().sub(a).multiplyScalar(y / subdivisions));
      for (let x = 0; x < subdivisions; x++) for (let y = 0; y < subdivisions - x; y++) {
        emit(at(x,y)); emit(at(x+1,y)); emit(at(x,y+1));
        if (x + y < subdivisions - 1) { emit(at(x+1,y)); emit(at(x+1,y+1)); emit(at(x,y+1)); }
      }
    }
    if (source !== geometry) source.dispose(); geometry.dispose();
    const draped = new THREE.BufferGeometry(); draped.setAttribute('position', new THREE.Float32BufferAttribute(out,3)); draped.computeVertexNormals(); return [draped];

}
