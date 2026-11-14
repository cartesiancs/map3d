import { useEffect, useRef } from 'react';
import { boundaryCenter, boundaryKey, boundaryLabel, type BoundaryPoint } from '../data/boundary';

const labels = new Map<string, string>();
let nextLookupAt = 0;
/** A site label belongs to a boundary, never to the last search or late response. */
export function useBoundaryLocation(points: BoundaryPoint[], location: string, locationBoundary: string | undefined, update: (data: {location: string; locationBoundary: string}) => void) {
  const key = boundaryKey(points), current = useRef(key); current.current = key;
  useEffect(() => {
    const center = boundaryCenter(points);
    if (!center || locationBoundary === key) return;
    const saved = labels.get(key);
    if (saved) { update({location: saved, locationBoundary: key}); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (controller.signal.aborted) return;
      nextLookupAt = Date.now() + 1100;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${center.lat}&lon=${center.lng}`, {signal: controller.signal});
        if (!response.ok) return;
        const data = await response.json(), address = data.address;
        const city = address && (address.city || address.town || address.village || address.municipality || address.county);
        const label = city ? [city, address.state || address.country].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(', ') : undefined;
        if (!label || controller.signal.aborted || current.current !== key) return;
        labels.set(key, label);
        while (labels.size > 20) labels.delete(labels.keys().next().value!);
        update({location: label, locationBoundary: key});
      } catch { /* Coordinates remain a truthful label if place lookup is unavailable. */ }
      finally { clearTimeout(timeout); }
    }, Math.max(0, nextLookupAt - Date.now()));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [points, key, locationBoundary, update]);
  return locationBoundary === key ? location : boundaryLabel(points);
}
