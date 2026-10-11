import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { geometryQuery, layerGroups, normalizeFeatures, type Feature, type GroupId, type OsmElement } from '../data/layers';
import { requestGeometry } from '../data/overpass';

type State = { status: 'idle' | 'queued' | 'loading' | 'waiting' | 'ready' | 'error' | 'cancelled'; message?: string };
const initialStates = () => Object.fromEntries(layerGroups.map(g => [g.id, { status: 'idle' }])) as Record<GroupId, State>;
type Points = { lat: number; lng: number }[];
type SceneData = { points: Points; states: Record<GroupId, State>; sources: Partial<Record<GroupId, OsmElement[]>>; started: boolean };
const emptySources: SceneData['sources'] = {};
const idleStates = initialStates();
const emptyData = (points: Points): SceneData => ({ points, states: idleStates, sources: emptySources, started: false });
export function useSceneLayers(points: { lat: number; lng: number }[]) {
  const [data, setData] = useState(() => emptyData(points));
  // Invalidate synchronously, before effects run or exports/menus can read an old site.
  const currentPoints = useRef(points); currentPoints.current = points;
  const { states, sources, started } = data.points === points ? data : emptyData(points);
  const request = useRef<AbortController | null>(null);
  const completed = useRef({points, at: 0});
  const currentData = useRef(data); currentData.current = data.points === points ? data : emptyData(points);
  useEffect(() => () => request.current?.abort(), [points]);
  const clear = useCallback(() => {
    request.current?.abort(); request.current = null;
    setData(emptyData(currentPoints.current));
  }, []);
  const load = useCallback(async (groups: GroupId[], reset = false) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const active = () => !controller.signal.aborted && request.current === controller && currentPoints.current === points;
    const update = (change: (previous: SceneData) => SceneData) => setData(previous => active() ? change(previous.points === points ? previous : emptyData(points)) : previous);
    update(previous => ({ ...(reset ? emptyData(points) : previous), started: true,
      states: { ...(reset ? idleStates : previous.states), ...Object.fromEntries(groups.map(id => [id, {status:'queued'}])) } }));
    // Keep public map-server requests sequential. Each batch appears immediately;
    // a failing batch cannot discard geometry received from the other batches.
    for (const id of groups) {
      if (!active()) break;
      update(previous => ({ ...previous, states: { ...previous.states, [id]: { status: 'loading', message: 'Loading…' } } }));
      try {
        const elements = await requestGeometry(geometryQuery(points, id), controller.signal, (message, progress) => {
          update(previous => ({ ...previous, states: { ...previous.states, [id]: { status: progress?.phase === 'waiting' ? 'waiting' : 'loading', message: progress?.phase === 'waiting' ? message : message.includes('backup') ? 'Loading from backup…' : 'Loading…' } } }));
        });
        if (!active()) break;
        update(previous => ({ ...previous, sources: { ...previous.sources, [id]: elements }, states: { ...previous.states, [id]: {status:'ready'} } }));
      } catch (error) {
        if (!active()) break;
        const message = error instanceof Error ? error.message : 'This layer could not load. Please retry.';
        update(previous => ({ ...previous, states: { ...previous.states, [id]: { status: 'error', message } } }));
      }
    }
    if (active()) completed.current = {points, at: Date.now()};
  }, [points]);
  const start = useCallback((priority: GroupId[] = layerGroups.map(g => g.id)) => {
    void load(priority, true);
  }, [load]);
  const cancel = useCallback(() => {
    request.current?.abort();
    setData(previous => previous.points !== currentPoints.current ? previous : { ...previous, states: Object.fromEntries(Object.entries(previous.states).map(([id, state]) => [id, state.status === 'queued' || state.status === 'loading' || state.status === 'waiting' ? { status: 'cancelled', message: 'Loading stopped. Already loaded features are kept.' } : state])) as Record<GroupId, State> });
  }, []);
  const featureCache = useRef(new Map<string, Feature>());
  const featureList = useRef<Feature[]>([]);
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
    featureCache.current = cache;
    if (featureList.current.length !== stable.length || stable.some((feature, index) => feature !== featureList.current[index])) featureList.current = stable;
    return featureList.current;
  }, [sources]);
  const loading = Object.values(states).some(s => s.status === 'queued' || s.status === 'loading' || s.status === 'waiting');
  const retry = useCallback((id: GroupId) => { if (!loading) void load([id]); }, [load, loading]);
  const retryFailed = useCallback(() => {
    if (!loading) void load(layerGroups.filter(g => ['error', 'cancelled'].includes(states[g.id].status)).map(g => g.id));
  }, [load, loading, states]);
  const refreshIfStale = useCallback(() => {
    const current = currentData.current;
    if (current.points !== points || !current.started || Object.values(current.states).some(state => ['queued','loading','waiting'].includes(state.status))) return;
    if (completed.current.points === points && completed.current.at && Date.now() - completed.current.at >= 5 * 60 * 1000) void load(layerGroups.map(group => group.id));
  }, [load, points]);
  return { features, sources, states, started, loading, start, clear, cancel, retry, retryFailed, refreshIfStale };
}
