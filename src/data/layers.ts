export type GeoPoint = { lat: number; lon: number };
export const vectorLayers = ['Buildings', 'Roads', 'Walking & cycling', 'Transit', 'Trees & woodland', 'Water', 'Waterways', 'Green spaces', 'Land use', 'Points of interest', 'Recreation & parking'] as const;
export type VectorLayer = typeof vectorLayers[number];
export type LayerName = VectorLayer | 'Terrain';
export type Feature = {
  id: number;
  key: string;
  type: 'node' | 'way' | 'relation';
  tags: Record<string, string>;
  geometry: GeoPoint[];
  holes?: GeoPoint[][];
  layer: VectorLayer;
  kind: 'point' | 'line' | 'area';
};
export type OsmElement = {
  id: number; type?: Feature['type']; tags?: Record<string, string>; lat?: number; lon?: number;
  geometry?: GeoPoint[];
  members?: { type: string; ref: number; role: string; geometry?: GeoPoint[] }[];
};
export const initialLayers: Record<LayerName, boolean> = {
  Buildings: true, Roads: true, 'Walking & cycling': true, Transit: true,
  'Trees & woodland': true, Water: true, Waterways: true, 'Green spaces': true,
  'Land use': false, 'Points of interest': false, 'Recreation & parking': true, Terrain: false,
};
const active = (value?: string) => !!value && value !== 'no';
export const isBuilding = (tags: Record<string, string>) => active(tags.building) || active(tags['building:part']);
function classify(tags: Record<string, string>): VectorLayer | null {
  if (isBuilding(tags)) return 'Buildings';
  if (tags.natural === 'tree' || tags.natural === 'wood' || tags.landuse === 'forest' || tags.natural === 'tree_row') return 'Trees & woodland';
  if (tags.highway && ['footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway'].includes(tags.highway)) return 'Walking & cycling';
  if (tags.railway || tags.public_transport || tags.highway === 'bus_stop' || tags.route === 'ferry') return 'Transit';
  if (tags.highway) return 'Roads';
  if (tags.waterway) return 'Waterways';
  if (tags.natural === 'water' || tags.landuse === 'reservoir') return 'Water';
  if (tags.leisure === 'park' || tags.leisure === 'garden' || ['grass', 'meadow', 'village_green'].includes(tags.landuse)) return 'Green spaces';
  if (tags.leisure || ['parking', 'bicycle_parking'].includes(tags.amenity)) return 'Recreation & parking';
  if (tags.landuse) return 'Land use';
  if (tags.amenity || tags.shop || tags.tourism || tags.historic) return 'Points of interest';
  return null;
}
const same = (a: GeoPoint, b: GeoPoint) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
export function contains(point: GeoPoint, ring: GeoPoint[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
/** Join reversed or fragmented relation members before creating polygon rings. */
function joinRings(segments: GeoPoint[][]) {
  const pending = segments.filter(s => s.length > 1).map(s => [...s]);
  const rings: GeoPoint[][] = [];
  while (pending.length) {
    let ring = pending.shift()!;
    while (!same(ring[0], ring[ring.length - 1])) {
      const index = pending.findIndex(s => same(ring[ring.length - 1], s[0]) || same(ring[ring.length - 1], s[s.length - 1]) || same(ring[0], s[0]) || same(ring[0], s[s.length - 1]));
      if (index < 0) break;
      const next = pending.splice(index, 1)[0];
      if (same(ring[ring.length - 1], next[0])) ring.push(...next.slice(1));
      else if (same(ring[ring.length - 1], next[next.length - 1])) ring.push(...next.reverse().slice(1));
      else if (same(ring[0], next[next.length - 1])) ring = [...next.slice(0, -1), ...ring];
      else ring = [...next.reverse().slice(0, -1), ...ring];
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
export function normalizeFeatures(elements: OsmElement[]): Feature[] {
  const result: Feature[] = [];
  const relationWays = new Set<number>();
  for (const e of elements) {
    if (e.type === 'relation' && e.tags?.type === 'multipolygon' && classify(e.tags) && joinRings((e.members || []).filter(m => m.role === 'outer' || !m.role).map(m => m.geometry || [])).length) {
      for (const m of e.members || []) if (m.type === 'way') relationWays.add(m.ref);
    }
  }
  const seen = new Set<string>();
  for (const e of elements) {
    const tags = e.tags || {}, type = e.type || 'way', layer = classify(tags);
    const key = `${type}/${e.id}`;
    if (!layer || seen.has(key) || (type === 'way' && relationWays.has(e.id))) continue;
    seen.add(key);
    const add = (geometry: GeoPoint[], kind: Feature['kind'], suffix = '', holes?: GeoPoint[][]) => {
      if (!geometry.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))) return;
      result.push({ id: e.id, key: key + suffix, type, tags, layer, kind, geometry, holes });
    };
    if (type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)) add([{ lat: e.lat!, lon: e.lon! }], 'point');
    else if (type === 'relation' && tags.type === 'multipolygon') {
      const outer = joinRings((e.members || []).filter(m => m.role === 'outer' || !m.role).map(m => m.geometry || []));
      const inner = joinRings((e.members || []).filter(m => m.role === 'inner').map(m => m.geometry || []));
      outer.forEach((ring, i) => add(ring, 'area', `/${i}`, inner.filter(h => contains(h[0], ring))));
    } else if (e.geometry?.length >= 2) {
      const areaLayer = ['Buildings', 'Water', 'Green spaces', 'Land use', 'Trees & woodland', 'Recreation & parking'].includes(layer);
      const closed = e.geometry.length >= 4 && same(e.geometry[0], e.geometry[e.geometry.length - 1]);
      add(e.geometry, closed && (areaLayer || tags.area === 'yes') ? 'area' : 'line');
    }
  }
  // Replace the outer volume with individually mapped building parts.
  const parts = result.filter(f => f.layer === 'Buildings' && active(f.tags['building:part']) && f.kind === 'area');
  const parentCells = new Map<string, Feature[]>(), replaced = new Set<Feature>();
  const cell = (value: number) => Math.floor(value * 1000);
  if (parts.length) for (const feature of result) {
    if (feature.layer !== 'Buildings' || active(feature.tags['building:part'])) continue;
    const xs = feature.geometry.map(p => cell(p.lon)), ys = feature.geometry.map(p => cell(p.lat));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    // Exceptionally large outlines use a separate candidate bucket.
    if ((maxX-minX+1)*(maxY-minY+1) > 1000) { const bucket = parentCells.get('large') || []; bucket.push(feature); parentCells.set('large', bucket); continue; }
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) { const key = `${x}/${y}`, bucket = parentCells.get(key) || []; bucket.push(feature); parentCells.set(key, bucket); }
  }
  for (const part of parts) {
    const p = part.geometry[0];
    const candidates = [...(parentCells.get(`${cell(p.lon)}/${cell(p.lat)}`) || []), ...(parentCells.get('large') || [])];
    const parents = candidates.filter(feature => contains(p, feature.geometry));
    const parent = parents[0];
    if (parent) {
      parents.forEach(outline => replaced.add(outline));
      const inherited = Object.fromEntries(Object.entries(parent.tags).filter(([key]) => ['name', 'building', 'amenity', 'shop', 'tourism', 'building:colour'].includes(key) || key.startsWith('addr:')));
      part.tags = { ...inherited, ...part.tags };
    }
  }
  const filtered = result.filter(feature => !replaced.has(feature));
  // Amenity-tagged buildings and grounds also appear as inspectable POI markers.
  const pois = filtered.filter(f => f.layer !== 'Points of interest' && (f.tags.shop || f.tags.tourism || f.tags.historic || (f.tags.amenity && !['parking', 'bicycle_parking'].includes(f.tags.amenity)))).map(f => {
    const ring = f.kind === 'area' ? f.geometry.slice(0, -1) : f.geometry;
    return { ...f, key: `${f.key}/poi`, layer: 'Points of interest' as const, kind: 'point' as const, holes: undefined, geometry: [{ lat: ring.reduce((n,p) => n + p.lat, 0) / ring.length, lon: ring.reduce((n,p) => n + p.lon, 0) / ring.length }] };
  });
  return [...filtered, ...pois];
}
export const layerGroups = [
  { id: 'buildings', label: 'Buildings', layers: ['Buildings'], selectors: ['["building"]', '["building:part"]'] },
  { id: 'transport', label: 'Transport', layers: ['Roads', 'Walking & cycling', 'Transit'], selectors: ['["highway"]', '["railway"]', '["public_transport"]'] },
  { id: 'landscape', label: 'Landscape', layers: ['Trees & woodland', 'Water', 'Waterways', 'Green spaces', 'Land use'], selectors: ['["natural"~"^(water|wood|tree|tree_row)$"]', '["waterway"]', '["landuse"]', '["leisure"~"^(park|garden)$"]'] },
  { id: 'places', label: 'Places & recreation', layers: ['Points of interest', 'Recreation & parking'], selectors: ['["leisure"]["leisure"!~"^(park|garden)$"]', '["amenity"]', '["shop"]', '["tourism"]', '["historic"]'] },
] as const;
export type GroupId = typeof layerGroups[number]['id'];
export const groupForLayer = (name: VectorLayer) => layerGroups.find(g => (g.layers as readonly string[]).includes(name))!;
export function geometryQuery(points: { lat: number; lng: number }[], group?: GroupId) {
  const polygon = points.map(p => `${p.lat} ${p.lng}`).join(' ');
  const selectors = layerGroups.filter(g => !group || g.id === group).flatMap(g => [...g.selectors]);
  const bbox = [Math.min(...points.map(p => p.lat)), Math.min(...points.map(p => p.lng)), Math.max(...points.map(p => p.lat)), Math.max(...points.map(p => p.lng))].join(',');
  // Restrict relations to polygons; route/site relations may span entire regions.
  const selection = selectors.map(s => {
    const nodeSelector = s === '["highway"]' ? '["highway"="bus_stop"]' : s === '["railway"]' ? '["railway"~"^(station|halt|tram_stop|subway_entrance)$"]' : s;
    return `node${nodeSelector}(poly:"${polygon}");way${s}(poly:"${polygon}");relation["type"="multipolygon"]${s}(poly:"${polygon}");`;
  }).join('');
  return `[out:json][timeout:25][maxsize:134217728][bbox:${bbox}];(${selection});out body geom;`;
}
export function buildingDimensions(tags: Record<string, string>) {
  const metres = (value?: string) => { const n = parseFloat(value || ''); return /(?:ft|')\s*$/.test(value || '') ? n * .3048 : n; };
  const explicit = metres(tags.height), levels = parseFloat(tags['building:levels']);
  const height = Number.isFinite(explicit) && explicit > 0 ? explicit : Number.isFinite(levels) && levels > 0 ? levels * 3 : 10;
  const min = metres(tags.min_height), minLevels = parseFloat(tags['building:min_level']);
  const base = Math.max(0, Math.min(height - .1, Number.isFinite(min) ? min : Number.isFinite(minLevels) ? minLevels * 3 : 0));
  const supported = ['gabled', 'pyramidal'].includes(tags['roof:shape']);
  const roof = metres(tags['roof:height']), roofLevels = parseFloat(tags['roof:levels']);
  const roofHeight = supported ? Math.min(height - base - .1, Math.max(.1, Number.isFinite(roof) ? roof : Number.isFinite(roofLevels) ? roofLevels * 3 : 2)) : 0;
  return { height, base, roofHeight, bodyHeight: height - base - roofHeight, estimated: !Number.isFinite(explicit) || explicit <= 0, roofEstimated: supported && !Number.isFinite(roof) && !Number.isFinite(roofLevels) };
}
