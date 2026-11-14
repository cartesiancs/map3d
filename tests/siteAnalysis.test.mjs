import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSite, clippedLineLength, measuredHeight } from '../src/data/siteAnalysis.ts';

const geo = ([x, y]) => ({ lon: x / 111320, lat: y / 111320 });
const boundary = coordinates => coordinates.map(p => ({ lng: geo(p).lon, lat: geo(p).lat }));
const rectangle = (x, y, w, h = w) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const site = boundary(rectangle(0, 0, 100).slice(0, -1));
const feature = (id, layer, coordinates, tags = {}, extra = {}) => ({ id, key: `way/${id}`, type: 'way', layer, kind: 'area', geometry: coordinates.map(geo), tags, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .001, `${actual} ≠ ${expected}`);
test('actual concave boundary, clipped overlaps and courtyard holes produce non-overlapping coverage', () => {
  const report = analyzeSite(boundary([[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]]), [
    feature(1, 'Buildings', rectangle(-10, -10, 70), { building: 'yes' }, { holes: [rectangle(10, 10, 10).map(geo)] }),
    feature(2, 'Buildings', rectangle(30, 0, 30), { building: 'yes' }),
    feature(3, 'Green spaces', rectangle(0, 0, 100), { leisure: 'park' }),
    feature(4, 'Green spaces', rectangle(20, 20, 80), { leisure: 'garden' }),
  ]);
  close(report.area, 7500);
  close(report.buildings.footprint, 3400); // 60², less 10² courtyard and 10² outside L boundary.
  close(report.covers.find(row => row.id === 'green').area, 4100);
  close(report.covers.reduce((sum, row) => sum + row.area, 0), report.area);
  close(report.perimeter, 400);
});
test('green coverage excludes buildings and water while land-use tags can overlap', () => {
  const report = analyzeSite(site, [
    feature(1, 'Buildings', rectangle(0, 0, 20), { building: 'yes' }),
    feature(2, 'Water', rectangle(40, 0, 20), { natural: 'water' }),
    feature(3, 'Green spaces', rectangle(0, 0, 100), { landuse: 'grass' }),
    feature(4, 'Land use', rectangle(0, 0, 100), { landuse: 'residential' }),
  ]);
  close(report.covers.find(row => row.id === 'green').area, 9200);
  close(report.landUses.find(row => row.id === 'grass').area, 10000);
  close(report.landUses.find(row => row.id === 'residential').area, 10000);
});
test('unknown heights exclude viewer defaults, feet convert and relation components count once', () => {
  const a = feature(1, 'Buildings', rectangle(0, 0, 10), { height: '30 ft' });
  const report = analyzeSite(site, [a,
    feature(2, 'Buildings', rectangle(20, 0, 10), { 'building:levels': '4' }),
    feature(3, 'Buildings', rectangle(40, 0, 10), { height: 'invalid' }),
    { ...a, key: 'way/1/1', geometry: rectangle(60, 0, 10).map(geo) },
    feature(4, 'Buildings', rectangle(200, 0, 10), { height: '100' }),
  ]);
  assert.equal(report.buildings.count, 3);
  assert.equal(report.buildings.knownHeights, 2);
  assert.equal(report.buildings.unknownHeights, 1);
  close(report.buildings.meanHeight, (9.144 + 12) / 2);
  close(report.buildings.maxHeight, 12);
  assert.equal(measuredHeight({ height: '-5' }), null);
  assert.equal(measuredHeight({ 'building:levels': '2;4' }), null);
});
test('indicative floor area merges overlapping building parts by vertical band and respects offsets', () => {
  const report = analyzeSite(site, [
    feature(1, 'Buildings', rectangle(0, 0, 20), { 'building:part': 'yes', 'building:levels': '2' }),
    feature(2, 'Buildings', rectangle(10, 0, 20), { 'building:part': 'yes', 'building:levels': '4', 'building:min_level': '1' }),
    feature(3, 'Buildings', rectangle(50, 50, 10), { building: 'yes' }),
  ]);
  close(report.buildings.footprint, 700);
  close(report.buildings.floorArea, 1800); // band 0–1: 400, 1–2: 600, 2–4: 800.
  close(report.buildings.floorAreaRatio, .18);
  close(report.buildings.floorSampleFootprint, 600);
});
test('missing floor data is unknown; an empty loaded dataset can have zero buildings', () => {
  const missing = analyzeSite(site, [feature(1, 'Buildings', rectangle(0, 0, 20), {})]);
  assert.equal(missing.buildings.floorArea, null);
  assert.equal(missing.buildings.floorAreaRatio, null);
  assert.equal(analyzeSite(site, []).buildings.floorArea, 0);
});
test('lengths clip to concave boundaries including collinear edges', () => {
  const ring = [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]];
  close(clippedLineLength([[-10, 75], [110, 75]], ring), 50);
  close(clippedLineLength([[-10, 0], [110, 0]], ring), 100);
  close(clippedLineLength([[-10, 50], [110, 50]], ring), 100);
  close(clippedLineLength([[75, 60], [75, 110]], ring), 0);
});
test('point counts exclude outside features and deduplicate POIs; bad geometry is reported', () => {
  const point = (id, layer, xy, tags) => feature(id, layer, [xy], tags, { kind: 'point', type: 'node' });
  const cafe = point(1, 'Points of interest', [50, 50], { amenity: 'cafe' });
  const report = analyzeSite(site, [cafe, { ...cafe, key: 'node/1/poi' },
    point(2, 'Points of interest', [150, 50], { amenity: 'cafe' }),
    point(3, 'Trees & woodland', [25, 25], { natural: 'tree' }),
    point(4, 'Transit', [0, 25], { highway: 'bus_stop' }),
    feature(5, 'Buildings', [[NaN, 0], [1, 1], [0, 1]], {}),
  ]);
  assert.deepEqual(report.amenities, [{ label: 'Cafés', count: 1 }]);
  assert.equal(report.treeCount, 1); assert.equal(report.transitPoints, 1);
  assert.equal(report.skipped, 1); assert.equal(report.includedFeatures, 3);
});
test('many disjoint buildings with distinct heights retain exact floor-area totals', () => {
  const features = Array.from({ length: 900 }, (_, i) => feature(i, 'Buildings', rectangle((i % 30) * 3, Math.floor(i / 30) * 3, 2), { height: String(3 + i / 10) }));
  const report = analyzeSite(site, features);
  close(report.buildings.footprint, 3600);
  close(report.buildings.floorArea, features.reduce((sum, f) => sum + Number(f.tags.height) / 3 * 4, 0));
  assert.equal(report.buildings.knownHeights, 900);
});
test('nearly coincident shared edges and holes extending outside an outline remain stable', () => {
  const report = analyzeSite(site, [
    feature(1, 'Buildings', rectangle(10, 10, 20), { height: '9' }),
    feature(2, 'Buildings', rectangle(10 + 1e-8, 10, 20), { height: '12' }),
    feature(3, 'Green spaces', rectangle(0, 0, 100), { leisure: 'park' }, { holes: [rectangle(90, 90, 30).map(geo)] }),
  ]);
  close(report.buildings.footprint, 400);
  close(report.buildings.floorArea, 1600);
  close(report.covers.find(row => row.id === 'green').area, 9500);
  close(report.covers.reduce((sum, row) => sum + row.area, 0), report.area);
});
