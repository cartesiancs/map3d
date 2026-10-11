import ClipperLib from 'clipper-lib';
import type { Feature } from './layers.ts';
import { featureSublayer } from './sublayers.ts';

type BoundaryPoint = { lat: number; lng: number };
type Pair = [number, number];
type Shape = Pair[][][];
// Millimetre integer coordinates avoid unstable classifications of nearly
// coincident edges. Traverse the result tree iteratively, preserving all holes.
function clip(operation: ClipperLib.ClipType, subject: Shape, masks: Shape[] = []): Shape {
  if (!subject.length) return [];
  const engine = new ClipperLib.Clipper(), tree = new ClipperLib.PolyTree();
  const paths = (shape: Shape) => shape.flatMap(polygon => polygon.map((ring, i) => {
    const path = ring.map(([x, y]) => ({ X: Math.round(x * 1000), Y: Math.round(y * 1000) }));
    if (ClipperLib.Clipper.Orientation(path) !== (i === 0)) path.reverse();
    return path;
  }));
  engine.AddPaths(paths(subject), ClipperLib.PolyType.ptSubject, true);
  for (const mask of masks) engine.AddPaths(paths(mask), operation === ClipperLib.ClipType.ctUnion ? ClipperLib.PolyType.ptSubject : ClipperLib.PolyType.ptClip, true);
  if (!engine.Execute(operation, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) throw new Error('Mapped polygon geometry could not be processed.');
  const result: Shape = [], pending = [...tree.Childs()];
  const ring = (node: ClipperLib.PolyNode): Pair[] => node.Contour().map(p => [p.X / 1000, p.Y / 1000]);
  while (pending.length) {
    const node = pending.pop()!;
    if (!node.IsHole()) result.push([ring(node), ...node.Childs().filter(child => child.IsHole()).map(ring)]);
    pending.push(...node.Childs());
  }
  return result;
}
const clipping = {
  union: (shape: Shape, ...rest: Shape[]) => clip(ClipperLib.ClipType.ctUnion, shape, rest),
  intersection: (shape: Shape, mask: Shape) => clip(ClipperLib.ClipType.ctIntersection, shape, [mask]),
  difference: (shape: Shape, mask: Shape) => clip(ClipperLib.ClipType.ctDifference, shape, [mask]),
};
export type AreaMetric = { id: string; label: string; area: number; color: string };
export type SiteReport = ReturnType<typeof analyzeSite>;
const humanize = (text: string) => text.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
const positive = (value: string | undefined) => {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value); return number > 0 ? number : null;
};
function metres(value: string | undefined) {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?$/i);
  if (!match) return null;
  const result = Number(match[1]) * (/^(ft|feet|')$/i.test(match[2] || '') ? .3048 : 1);
  return result > 0 ? result : null;
}
export function measuredHeight(tags: Record<string, string>) {
  const explicit = metres(tags.height), levels = positive(tags['building:levels']);
  if (explicit !== null) return { value: explicit, source: 'Mapped height' };
  if (levels !== null) return { value: levels * 3, source: 'Estimated from levels' };
  return null;
}
function ringArea(ring: Pair[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]; sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}
export function polygonArea(shape: Shape) {
  return shape.reduce((total, polygon) => total + Math.max(0, ringArea(polygon[0]) - polygon.slice(1).reduce((area, hole) => area + ringArea(hole), 0)), 0);
}
// Balanced unions avoid a huge function argument list and repeatedly scanning an expanding union.
function union(shapes: Shape[]): Shape {
  let active = shapes.filter(shape => shape.length);
  while (active.length > 1) {
    const next: Shape[] = [];
    for (let i = 0; i < active.length; i += 32) next.push(clipping.union(active[i], ...active.slice(i + 1, i + 32)));
    active = next;
  }
  return active[0] || [];
}
function subtract(shape: Shape, mask: Shape): Shape {
  return shape.length && mask.length ? clipping.difference(shape, mask) : shape;
}
const cross = (a: Pair, b: Pair) => a[0] * b[1] - a[1] * b[0];
const delta = (a: Pair, b: Pair): Pair => [a[0] - b[0], a[1] - b[1]];
function extent(ring: Pair[]) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) { bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); }
  return bounds;
}
function tileShapes(shapes: Shape[], bounds: number[], size: number) {
  const tiles = new Map<string, Shape[]>();
  for (const shape of shapes) for (const polygon of shape) {
    const box = extent(polygon[0]);
    for (let x = Math.floor((box[0] - bounds[0]) / size); x <= Math.floor((box[2] - bounds[0]) / size); x++) {
      for (let y = Math.floor((box[1] - bounds[1]) / size); y <= Math.floor((box[3] - bounds[1]) / size); y++) {
        const west = bounds[0] + x * size, south = bounds[1] + y * size;
        const whole = box[0] >= west && box[1] >= south && box[2] <= west + size && box[3] <= south + size;
        const clipped = whole ? [polygon] : clipping.intersection([polygon], [[[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]]]);
        if (!clipped.length) continue;
        const key = `${x}/${y}`, rows = tiles.get(key) || []; rows.push(clipped); tiles.set(key, rows);
      }
    }
  }
  return tiles;
}
function tiledUnionArea(shapes: Shape[], bounds: number[], size: number) {
  let area = 0;
  for (const rows of tileShapes(shapes, bounds, size).values()) area += polygonArea(union(rows));
  return area;
}
type FloorRow = { start: number; end: number; shape: Shape; bounds: number[] };
/** Only footprints with intersecting bounding boxes can share floor area. */
function floorComponents(rows: FloorRow[]) {
  const parents = rows.map((_, i) => i);
  const root = (index: number) => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].bounds[0] - rows[b].bounds[0]);
  let active: number[] = [];
  for (const index of order) {
    const bounds = rows[index].bounds;
    active = active.filter(i => rows[i].bounds[2] >= bounds[0]);
    for (const other of active) if (rows[other].bounds[3] >= bounds[1] && rows[other].bounds[1] <= bounds[3]) parents[root(index)] = root(other);
    active.push(index);
  }
  const groups = new Map<number, FloorRow[]>();
  for (let i = 0; i < rows.length; i++) { const key = root(i), group = groups.get(key) || []; group.push(rows[i]); groups.set(key, group); }
  return [...groups.values()];
}
function inside(point: Pair, ring: Pair[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], ab = delta(b, a), ap = delta(point, a);
    if (Math.abs(cross(ab, ap)) < 1e-6 && ap[0] * ab[0] + ap[1] * ab[1] >= 0 && ap[0] * ab[0] + ap[1] * ab[1] <= ab[0] ** 2 + ab[1] ** 2 && Math.hypot(...ab) > 0) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
/** Length inside a concave polygon. Split at every boundary crossing, including collinear edges. */
export function clippedLineLength(line: Pair[], boundary: Pair[]) {
  let length = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], r = delta(line[i], a), squared = r[0] ** 2 + r[1] ** 2;
    if (!squared) continue;
    const cuts = [0, 1];
    for (let j = 0; j < boundary.length; j++) {
      const b = boundary[j], s = delta(boundary[(j + 1) % boundary.length], b), ba = delta(b, a), denominator = cross(r, s);
      if (Math.abs(denominator) > 1e-9) {
        const t = cross(ba, s) / denominator, u = cross(ba, r) / denominator;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      } else if (Math.abs(cross(ba, r)) < 1e-6) {
        for (const p of [b, boundary[(j + 1) % boundary.length]]) {
          const d = delta(p, a), t = (d[0] * r[0] + d[1] * r[1]) / squared;
          if (t > 0 && t < 1) cuts.push(t);
        }
      }
    }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const midpoint = (cuts[j] + cuts[j - 1]) / 2;
      if (inside([a[0] + r[0] * midpoint, a[1] + r[1] * midpoint], boundary)) length += Math.sqrt(squared) * (cuts[j] - cuts[j - 1]);
    }
  }
  return length;
}
const greenLandUses = new Set(['grass', 'meadow', 'village_green', 'forest', 'orchard', 'vineyard', 'allotments']);
const isGreen = (f: Feature) => ['park', 'garden', 'nature_reserve'].includes(f.tags.leisure) || ['wood', 'grassland', 'scrub', 'heath'].includes(f.tags.natural) || greenLandUses.has(f.tags.landuse);

export function analyzeSite(points: BoundaryPoint[], features: Feature[], onProgress?: (phase: string) => void) {
  if (points.length < 3) throw new Error('Select a boundary with at least three points.');
  const origin = points[0], latScale = 111320, lonScale = latScale * Math.cos(points.reduce((sum, p) => sum + p.lat, 0) / points.length * Math.PI / 180);
  const project = (p: { lat: number; lon: number }): Pair => [(p.lon - origin.lng) * lonScale, (p.lat - origin.lat) * latScale];
  const boundary = points.map(p => project({ lat: p.lat, lon: p.lng }));
  if (!boundary.every(p => p.every(Number.isFinite))) throw new Error('The boundary has invalid coordinates.');
  const site = clipping.union([[boundary]]), area = polygonArea(site);
  if (area < .01) throw new Error('The boundary has no measurable area. Draw a larger boundary.');
  const perimeter = boundary.reduce((sum, p, i) => sum + Math.hypot(...delta(p, boundary[(i + 1) % boundary.length])), 0);
  const bounds = extent(boundary);
  const categories: Record<string, Shape[]> = { buildings: [], water: [], green: [], recreation: [], other: [] };
  const uses = new Map<string, Shape[]>(), buildingRows = new Map<string, { feature: Feature; shapes: Shape[] }>();
  const amenities = new Map<string, Set<string>>(), trees = new Set<string>(), stops = new Set<string>(), included = new Set<string>();
  const lengths = { roads: 0, paths: 0, waterways: 0, rail: 0 };
  let skipped = 0;
  let processed = 0;
  onProgress?.('Clipping mapped features to the boundary…');
  for (const feature of features) {
    if (++processed % 2000 === 0) onProgress?.(`Clipping features · ${processed.toLocaleString()} of ${features.length.toLocaleString()}`);
    const key = `${feature.type}/${feature.id}`;
    const geometry = feature.geometry.map(project);
    if (!geometry.length || !geometry.every(p => p.every(Number.isFinite))) { skipped++; continue; }
    const featureBounds = extent(geometry);
    if (featureBounds[2] < bounds[0] || featureBounds[0] > bounds[2] || featureBounds[3] < bounds[1] || featureBounds[1] > bounds[3]) continue;
    if (feature.kind === 'area') {
      let shape: Shape;
      try {
        if (geometry.length < 3) { skipped++; continue; }
        const rings = [geometry, ...(feature.holes || []).map(hole => hole.map(project))];
        if (!rings.every(ring => ring.every(p => p.every(Number.isFinite)))) { skipped++; continue; }
        shape = clipping.intersection([[geometry]], site);
        if (rings.length > 1) shape = clipping.difference(shape, rings.slice(1).map(hole => [hole]));
      } catch { skipped++; continue; }
      if (polygonArea(shape) < .001) continue;
      included.add(key);
      const category = feature.layer === 'Buildings' ? 'buildings' : feature.layer === 'Water' ? 'water' : isGreen(feature) ? 'green' : feature.layer === 'Recreation & parking' ? 'recreation' : 'other';
      categories[category].push(shape);
      if (feature.tags.landuse) {
        const rows = uses.get(feature.tags.landuse) || []; rows.push(shape); uses.set(feature.tags.landuse, rows);
      }
      if (feature.layer === 'Buildings') {
        const row = buildingRows.get(key) || { feature, shapes: [] }; row.shapes.push(shape); buildingRows.set(key, row);
      }
    } else if (feature.kind === 'line') {
      const length = clippedLineLength(geometry, boundary);
      if (!length) continue;
      included.add(key);
      if (feature.layer === 'Roads') lengths.roads += length;
      if (feature.layer === 'Walking & cycling') lengths.paths += length;
      if (feature.layer === 'Waterways') lengths.waterways += length;
      if (feature.layer === 'Transit' && feature.tags.railway) lengths.rail += length;
    } else if (inside(geometry[0], boundary)) {
      included.add(key);
      if (feature.tags.natural === 'tree') trees.add(key);
      if (feature.layer === 'Transit') stops.add(key);
      if (feature.layer === 'Points of interest') {
        const label = featureSublayer(feature).label, ids = amenities.get(label) || new Set<string>(); ids.add(key); amenities.set(label, ids);
      }
    }
  }
  // Disjoint analysis tiles bound the size of individual Boolean operations.
  // Their interiors never overlap, so summing exact clipped areas adds no seams
  // or sampling approximation and avoids deep recursion on city-sized inputs.
  const tileSize = Math.max(100, Math.sqrt((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) / 64));
  const covers: AreaMetric[] = [['buildings', 'Building footprints', '#8981c7'], ['water', 'Water', '#5596b7'], ['green', 'Green-designated space', '#719c7a'], ['recreation', 'Recreation & parking', '#c2a273'], ['other', 'Other mapped areas', '#8e9fbd']].map(([id, label, color]) => ({ id, label, color, area: 0 }));
  onProgress?.('Dividing coverage analysis into manageable tiles…');
  const categoryTiles = Object.fromEntries(Object.entries(categories).map(([id, shapes]) => [id, tileShapes(shapes, bounds, tileSize)]));
  const tileKeys = [...new Set(Object.values(categoryTiles).flatMap(tiles => [...tiles.keys()]))];
  for (let i = 0; i < tileKeys.length; i++) {
    onProgress?.(`Merging coverage areas · tile ${i + 1} of ${tileKeys.length}`);
    let occupied: Shape = [];
    for (const cover of covers) {
      const shape = subtract(union(categoryTiles[cover.id].get(tileKeys[i]) || []), occupied);
      cover.area += polygonArea(shape); occupied = union([occupied, shape]);
    }
  }
  covers.push({ id: 'unclassified', label: 'Unclassified in loaded data', area: Math.max(0, area - covers.reduce((sum, cover) => sum + cover.area, 0)), color: '#c6cadc' });
  const footprint = covers[0].area;
  const buildings = [...buildingRows.values()];
  const heights = buildings.map(({ feature }) => ({ id: `${feature.type}/${feature.id}`, name: feature.tags.name || (feature.tags['building:part'] ? 'Unnamed building part' : 'Unnamed building'), ...measuredHeight(feature.tags) })).filter(row => row.value !== undefined) as { id: string; name: string; value: number; source: string }[];
  heights.sort((a, b) => a.value - b.value);
  // Analyze only spatially connected footprints together. Most buildings do not
  // overlap, so they need no repeated union across the site's many height bands.
  const floorRows: FloorRow[] = [];
  onProgress?.('Calculating building heights and floor area…');
  for (const { feature, shapes } of buildings) {
    const height = measuredHeight(feature.tags), levels = positive(feature.tags['building:levels']);
    const end = levels ?? (height ? height.value / 3 : null);
    const start = positive(feature.tags['building:min_level']) ?? (metres(feature.tags.min_height) || 0) / 3;
    if (end === null || end <= start || end > 300) continue;
    const shape = union(shapes);
    floorRows.push({ start, end, shape, bounds: extent(shape.flatMap(polygon => polygon[0])) });
  }
  let floorArea = 0;
  const components = floorComponents(floorRows);
  for (let index = 0; index < components.length; index++) {
    if (index % 500 === 0) onProgress?.(`Calculating floor areas · ${index.toLocaleString()} of ${components.length.toLocaleString()} building groups`);
    const rows = components[index];
    if (rows.length === 1) { floorArea += polygonArea(rows[0].shape) * (rows[0].end - rows[0].start); continue; }
    const levels = [...new Set(rows.flatMap(row => [row.start, row.end]))].sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i++) {
      const midpoint = (levels[i] + levels[i - 1]) / 2;
      floorArea += polygonArea(union(rows.filter(row => row.start < midpoint && row.end > midpoint).map(row => row.shape))) * (levels[i] - levels[i - 1]);
    }
  }
  const bins = [[0, 6], [6, 12], [12, 24], [24, 48], [48, Infinity]].map(([min, max]) => ({ label: max === Infinity ? '48+ m' : `${min}–${max} m`, count: heights.filter(h => h.value >= min && h.value < max).length }));
  onProgress?.('Calculating land-use allocation…');
  return {
    area, perimeter, boundary, includedFeatures: included.size, skipped,
    covers, landUses: [...uses].map(([id, shapes]) => ({ id, label: humanize(id), area: tiledUnionArea(shapes, bounds, tileSize), color: '#8175d1' })).sort((a, b) => b.area - a.area),
    buildings: {
      count: buildings.length, parts: buildings.filter(row => row.feature.tags['building:part']).length,
      footprint, density: buildings.length / (area / 10000),
      knownHeights: heights.length, mappedHeights: heights.filter(h => h.source === 'Mapped height').length, estimatedHeights: heights.filter(h => h.source !== 'Mapped height').length,
      unknownHeights: buildings.length - heights.length,
      meanHeight: heights.length ? heights.reduce((sum, h) => sum + h.value, 0) / heights.length : null,
      medianHeight: heights.length ? (heights[Math.floor((heights.length - 1) / 2)].value + heights[Math.floor(heights.length / 2)].value) / 2 : null,
      maxHeight: heights[heights.length - 1]?.value ?? null,
      floorArea: floorRows.length || !buildings.length ? floorArea : null,
      floorAreaRatio: floorRows.length || !buildings.length ? floorArea / area : null,
      floorSampleFootprint: tiledUnionArea(floorRows.map(row => row.shape), bounds, tileSize),
      bins, tallest: heights.slice(-6).reverse(),
    },
    lengths, treeCount: trees.size, transitPoints: stops.size,
    amenities: [...amenities].map(([label, ids]) => ({ label, count: ids.size })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}
