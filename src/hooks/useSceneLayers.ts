import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geometryQuery, layerGroups, normalizeFeatures, type Feature, type GroupId, type OsmElement } from '../data/layers';
import { requestGeometry } from '../data/overpass';

type State = { status: 'idle' | 'queued' | 'loading' | 'waiting' | 'ready' | 'error' | 'cancelled'; message?: string };
const initialStates = () => Object.fromEntries(layerGroups.map(g => [g.id, { status: 'idle' }])) as Record<GroupId, State>;
export function useSceneLayers(points: { lat: number; lng: number }[]) {
  const [states, setStates] = useState(initialStates);
  const [sources, setSources] = useState<Partial<Record<GroupId, OsmElement[]>>>({});
  const [started, setStarted] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const clear = useCallback(() => {
    request.current?.abort(); request.current = null;
    setStarted(false); setStates(initialStates()); setSources({});
  }, []);
  const load = useCallback(async (groups: GroupId[]) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setStates(previous => {
      const next = { ...previous };
      for (const id of groups) next[id] = { status: 'queued' };
      return next;
    });
    // Keep public map-server requests sequential. Each batch appears immediately;
    // a failing batch cannot discard geometry received from the other batches.
    for (const id of groups) {
      if (controller.signal.aborted) break;
      setStates(previous => ({ ...previous, [id]: { status: 'loading', message: 'Loading…' } }));
      try {
        const elements = await requestGeometry(geometryQuery(points, id), controller.signal, (message, progress) => {
          if (!controller.signal.aborted) setStates(previous => ({ ...previous, [id]: { status: progress?.phase === 'waiting' ? 'waiting' : 'loading', message: progress?.phase === 'waiting' ? message : message.includes('backup') ? 'Loading from backup…' : 'Loading…' } }));
        });
        if (controller.signal.aborted) break;
        setSources(previous => ({ ...previous, [id]: elements }));
        setStates(previous => ({ ...previous, [id]: { status: 'ready' } }));
      } catch (error) {
        if (controller.signal.aborted) break;
        const message = error instanceof Error ? error.message : 'This layer could not load. Please retry.';
        setStates(previous => ({ ...previous, [id]: { status: 'error', message } }));
      }
    }
  }, [points]);
  const start = useCallback((priority: GroupId[] = layerGroups.map(g => g.id)) => {
    setStarted(true); setSources({});
    void load(priority);
  }, [load]);
  const cancel = useCallback(() => {
    request.current?.abort();
    setStates(previous => Object.fromEntries(Object.entries(previous).map(([id, state]) => [id, state.status === 'queued' || state.status === 'loading' || state.status === 'waiting' ? { status: 'cancelled', message: 'Loading stopped. Already loaded features are kept.' } : state])) as Record<GroupId, State>);
  }, []);
  const featureCache = useRef(new Map<string, Feature>());
  const features = useMemo(() => {
    const next = normalizeFeatures(layerGroups.flatMap(g => sources[g.id] || []));
    const previous = featureCache.current, cache = new Map<string, Feature>();
    const stable = next.map(feature => {
      const old = previous.get(feature.key);
      const sameTags = old && (old.tags === feature.tags || Object.keys(old.tags).length === Object.keys(feature.tags).length && Object.keys(feature.tags).every(key => old.tags[key] === feature.tags[key]));
      const sameGeometry = old && (old.geometry === feature.geometry || old.geometry.length === feature.geometry.length && old.geometry.every((p, i) => p.lat === feature.geometry[i].lat && p.lon === feature.geometry[i].lon));
      const sameHoles = old && (old.holes === feature.holes || JSON.stringify(old.holes) === JSON.stringify(feature.holes));
      const value = old && old.layer === feature.layer && old.kind === feature.kind && sameTags && sameGeometry && sameHoles ? old : feature;
      cache.set(feature.key, value); return value;
    });
    featureCache.current = cache; return stable;
  }, [sources]);
  const loading = Object.values(states).some(s => s.status === 'queued' || s.status === 'loading' || s.status === 'waiting');
  const retry = useCallback((id: GroupId) => { if (!loading) void load([id]); }, [load, loading]);
  const retryFailed = useCallback(() => {
    if (!loading) void load(layerGroups.filter(g => ['error', 'cancelled'].includes(states[g.id].status)).map(g => g.id));
  }, [load, loading, states]);
  return { features, sources, states, started, loading, start, clear, cancel, retry, retryFailed };
}
