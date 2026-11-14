export type BoundaryPoint = { lat: number; lng: number };
export function boundaryKey(points: BoundaryPoint[]) {
  return points.map(point => `${point.lat},${point.lng}`).join(';');
}
export function boundaryCenter(points: BoundaryPoint[]): BoundaryPoint | null {
  if (points.length < 3) return null;
  return {
    lat: (Math.min(...points.map(p => p.lat)) + Math.max(...points.map(p => p.lat))) / 2,
    lng: (Math.min(...points.map(p => p.lng)) + Math.max(...points.map(p => p.lng))) / 2,
  };
}
export function boundaryLabel(points: BoundaryPoint[]) {
  const center = boundaryCenter(points);
  return center ? `Selected site · ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}` : 'Choose a location';
}
