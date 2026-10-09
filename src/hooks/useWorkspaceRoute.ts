import { useCallback, useEffect, useRef, useState } from 'react';
import type { Point } from '../components/map/SelectMap';

type Snapshot = { points: Point[]; location: string };
type WorkspaceRoute = Snapshot & { view: 'map' | '3d' };
const storageKey = 'map3d.workspace';
const empty: Snapshot = { points: [], location: 'Manhattan, New York' };

function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Snapshot;
  if (typeof candidate.location !== 'string' || !Array.isArray(candidate.points)) return null;
  if (candidate.points.length > 0 && candidate.points.length < 3) return null;
  if (!candidate.points.every(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180)) return null;
  return { location: candidate.location, points: candidate.points.map(p => ({ lat: p.lat, lng: p.lng })) };
}
function readRoute(): WorkspaceRoute {
  let saved: Snapshot | null = null;
  try { saved = snapshot(JSON.parse(sessionStorage.getItem(storageKey) || 'null')); } catch { /* Storage is optional. */ }
  const data = snapshot(window.history.state?.map3d) || saved || empty;
  return { ...data, view: window.location.pathname === '/viewer' && data.points.length >= 3 ? '3d' : 'map' };
}
function writeRoute(route: WorkspaceRoute, replace: boolean) {
  const data: Snapshot = { points: route.points, location: route.location };
  const path = route.view === '3d' ? '/viewer' : '/map';
  window.history[replace ? 'replaceState' : 'pushState']({ ...window.history.state, map3d: data }, '', path);
  try { sessionStorage.setItem(storageKey, JSON.stringify(data)); } catch { /* Navigation still works without storage. */ }
}
function sameBoundary(a: Point[], b: Point[]) {
  return a.length === b.length && a.every((p, i) => p.lat === b[i].lat && p.lng === b[i].lng);
}

/** Two client routes; keep a boundary snapshot on each browser history entry. */
export function useWorkspaceRoute() {
  const [route, setRoute] = useState(readRoute);
  const current = useRef(route);
  useEffect(() => {
    writeRoute(current.current, true);
    // Initial normalization also handles / and /viewer without a valid boundary.
    // Navigation and edits write explicitly; popstate restores and normalizes its own entry.
  }, []);
  useEffect(() => {
    const restore = () => {
      const next = readRoute();
      const restored = { ...next, points: sameBoundary(current.current.points, next.points) ? current.current.points : next.points };
      current.current = restored;
      writeRoute(restored, true);
      setRoute(restored);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const navigate = useCallback((view: WorkspaceRoute['view']) => {
    const previous = current.current;
    if (previous.view === view || view === '3d' && previous.points.length < 3) return;
    const next = { ...previous, view };
    writeRoute(next, false);
    current.current = next;
    setRoute(next);
  }, []);
  const update = useCallback((data: Partial<Snapshot>) => {
    const next = { ...current.current, ...data };
    writeRoute(next, true);
    current.current = next;
    setRoute(next);
  }, []);
  return { ...route, navigate, update };
}
