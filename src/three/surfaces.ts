import type { Feature, VectorLayer } from '../data/layers.ts';

// Ground overlays are composited in this order, while terrain/buildings retain depth.
const order: Partial<Record<VectorLayer, number>> = {
  'Land use': 1, 'Green spaces': 2, 'Trees & woodland': 3,
  'Recreation & parking': 4, Water: 5,
};
export const isSurface = (feature: Feature) => feature.kind === 'area' && feature.layer !== 'Buildings';
export const surfaceOrder = (layer: VectorLayer) => order[layer] || 6;
export function footprintArea(feature: Feature) {
  const ringArea = (ring: Feature['geometry']) => {
    if (!ring.length) return 0;
    const origin = ring[0];
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[j].lon - origin.lon) * (ring[i].lat - origin.lat) - (ring[i].lon - origin.lon) * (ring[j].lat - origin.lat);
    }
    return Math.abs(sum / 2);
  };
  return Math.max(0, ringArea(feature.geometry) - (feature.holes || []).reduce((sum, ring) => sum + ringArea(ring), 0));
}
/** Broad polygons first, local details last, with a stable tie-break across reloads. */
export function compareSurfaces(a: Feature, b: Feature) {
  return surfaceOrder(a.layer) - surfaceOrder(b.layer) || footprintArea(b) - footprintArea(a) || a.key.localeCompare(b.key);
}
export function surfaceMaterial(selected = false) {
  // Use the ordered overlay pass, after the transparent reference grid. Opacity stays 1.
  return { transparent: true, opacity: 1, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: selected ? -2 : -1, polygonOffsetUnits: selected ? -2 : -1 };
}
