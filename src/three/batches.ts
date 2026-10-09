import { sceneColors } from './palette.ts';
import * as THREE from 'three';
import { buildingDimensions, type Feature, type VectorLayer } from '../data/layers.ts';
import { terrainHeight, type Terrain } from '../data/terrain.ts';
import { buildFeatureGeometries, featureColor } from './geometry.ts';
import { compareSurfaces, isSurface } from './surfaces.ts';
import { featureSublayer } from '../data/sublayers.ts';
export type Origin = { lat: number; lng: number };
export type Range = { start: number; end: number; feature: number; name: string };
export type Batch = {
  key: string; layer: VectorLayer; sublayer: string; kind: 'mesh' | 'line' | 'instances';
  positions?: Float32Array; normals?: Float32Array; colors?: Uint8Array;
  matrices?: Float32Array; indices?: Uint32Array;
  form?: 'trunk' | 'crown' | 'stem' | 'marker'; color?: string;
  ranges: Range[]; bounds: number[];
};
export function projection(origin: Origin) {
  const longitudeScale = 111320 * Math.cos(origin.lat * Math.PI / 180);
  return (p: { lat: number; lon: number }) => new THREE.Vector2((p.lon - origin.lng) * longitudeScale, (p.lat - origin.lat) * 111320);
}
export function featureAt(ranges: Range[], vertex: number) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, range = ranges[mid];
    if (vertex < range.start) hi = mid - 1;
    else if (vertex >= range.end) lo = mid + 1;
    else return range.feature;
  }
  return undefined;
}
type Part = { positions: Float32Array; normals?: Float32Array; color: THREE.Color; feature: number; name: string };
/** 500 m chunks retain frustum culling and bound the cost of click picking. */
export function buildBatches(features: Feature[], origin: Origin, terrain: Terrain | null): Batch[] {
  const project = projection(origin);
  const groups = new Map<string, { layer: VectorLayer; sublayer: string; kind: 'mesh' | 'line'; parts: Part[]; vertices: number }>();
  const points = new Map<string, { layer: VectorLayer; sublayer: string; form: Batch['form']; color: string; data: number[]; indices: number[] }>();
  const ordered = features.map((feature, index) => ({ feature, index }));
  ordered.sort((a, b) => isSurface(a.feature) && isSurface(b.feature) ? compareSurfaces(a.feature, b.feature) : Number(isSurface(b.feature)) - Number(isSurface(a.feature)));
  ordered.forEach(({feature, index}) => {
    const center = feature.geometry.reduce((p, v) => ({ lat: p.lat + v.lat / feature.geometry.length, lon: p.lon + v.lon / feature.geometry.length }), { lat: 0, lon: 0 });
    const anchor = project(center), ground = terrainHeight(terrain, center);
    const sublayer = featureSublayer(feature).id;
    const tile = `${feature.layer}/${encodeURIComponent(sublayer)}/${Math.floor(anchor.x / 500)}/${Math.floor(anchor.y / 500)}`;
    if (feature.kind === 'point') {
      const tree = feature.tags.natural === 'tree';
      for (const form of (tree ? ['trunk', 'crown'] : ['stem', 'marker']) as Batch['form'][]) {
        const key = `${tile}/${form}`;
        let group = points.get(key);
        if (!group) { group = { layer: feature.layer, sublayer, form, color: form === 'trunk' ? sceneColors.trunk : featureColor(feature), data: [], indices: [] }; points.set(key, group); }
        group.data.push(anchor.x, ground + (form === 'trunk' || form === 'stem' ? 2 : form === 'crown' ? 6 : 5), -anchor.y);
        group.indices.push(index);
      }
      return;
    }
    const geometries = buildFeatureGeometries(feature, project, terrain);
    geometries.forEach((original, partIndex) => {
      const kind = feature.kind === 'line' ? 'line' : 'mesh';
      let positions: Float32Array, normals: Float32Array | undefined;
      if (kind === 'line') {
        const source = original.getAttribute('position');
        positions = new Float32Array(Math.max(0, source.count - 1) * 6);
        for (let i = 0; i < source.count - 1; i++) for (let j = 0; j < 2; j++) positions.set([source.getX(i+j), source.getY(i+j), source.getZ(i+j)], (i*2+j)*3);
        original.dispose();
      } else {
        const dimensions = buildingDimensions(feature.tags);
        if (partIndex) original.translate(0, 0, dimensions.bodyHeight);
        original.rotateX(-Math.PI / 2);
        if (feature.layer === 'Buildings') original.translate(0, ground + dimensions.base + .2, 0);
        const geometry = original.index ? original.toNonIndexed() : original;
        positions = geometry.getAttribute('position').array as Float32Array;
        normals = geometry.getAttribute('normal').array as Float32Array;
        geometry.dispose(); if (geometry !== original) original.dispose();
      }
      const baseKey = `${tile}/${kind}`;
      let suffix = 0, key = baseKey, group = groups.get(key);
      while (group && group.vertices + positions.length / 3 > 120000 && group.vertices > 0) { key = `${baseKey}/${++suffix}`; group = groups.get(key); }
      if (!group) { group = { layer: feature.layer, sublayer, kind, parts: [], vertices: 0 }; groups.set(key, group); }
      group.parts.push({ positions, normals, color: new THREE.Color(featureColor(feature, partIndex > 0)), feature: index, name: feature.key + (partIndex ? '/roof' : '') });
      group.vertices += positions.length / 3;
    });
  });
  const result: Batch[] = [];
  for (const [key, group] of groups) {
    const positions = new Float32Array(group.vertices * 3);
    const normals = group.kind === 'mesh' ? new Float32Array(positions.length) : undefined;
    const colors = new Uint8Array(positions.length);
    const ranges: Range[] = [], bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let offset = 0;
    for (const part of group.parts) {
      positions.set(part.positions, offset);
      if (normals && part.normals) normals.set(part.normals, offset);
      for (let i = 0; i < part.positions.length; i += 3) {
        colors[offset+i] = Math.round(part.color.r * 255); colors[offset+i+1] = Math.round(part.color.g * 255); colors[offset+i+2] = Math.round(part.color.b * 255);
        for (let axis = 0; axis < 3; axis++) { bounds[axis] = Math.min(bounds[axis], part.positions[i+axis]); bounds[axis+3] = Math.max(bounds[axis+3], part.positions[i+axis]); }
      }
      ranges.push({ start: offset / 3, end: (offset + part.positions.length) / 3, feature: part.feature, name: part.name });
      offset += part.positions.length;
    }
    result.push({ key, layer: group.layer, sublayer: group.sublayer, kind: group.kind, positions, normals, colors, ranges, bounds });
  }
  for (const [key, group] of points) {
    const matrices = new Float32Array(group.indices.length * 16), bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < group.indices.length; i++) {
      const o = i * 16; matrices[o] = matrices[o+5] = matrices[o+10] = matrices[o+15] = 1;
      for (let axis = 0; axis < 3; axis++) { const value = group.data[i*3+axis]; matrices[o+12+axis] = value; bounds[axis] = Math.min(bounds[axis], value - 5); bounds[axis+3] = Math.max(bounds[axis+3], value + 5); }
    }
    result.push({ key, layer: group.layer, sublayer: group.sublayer, kind: 'instances', form: group.form, color: group.color, matrices, indices: new Uint32Array(group.indices), ranges: [], bounds });
  }
  return result;
}
export function transferBuffers(batches: Batch[]) {
  return batches.flatMap(batch => [batch.positions, batch.normals, batch.colors, batch.matrices, batch.indices].filter(Boolean).map(array => array!.buffer as ArrayBuffer));
}
