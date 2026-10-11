import {useEffect, useRef, useState} from 'react';
import {loadTerrain, type Terrain} from '../data/terrain';
import type {BoundaryPoint} from '../data/boundary';

type Result = {points: BoundaryPoint[]; value: Terrain | null; status: 'idle' | 'loading' | 'ready' | 'error'; error: string};
const empty = (points: BoundaryPoint[]): Result => ({points, value: null, status:'idle', error:''});
export function useSceneTerrain(points: BoundaryPoint[], enabled: boolean) {
  const [result, setResult] = useState(() => empty(points));
  const [attempt, setAttempt] = useState(0);
  const current = useRef(points); current.current = points;
  const data = result.points === points ? result : empty(points);
  const value = data.value;
  useEffect(() => {
    if (!enabled || points.length < 3 || value) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), 25000);
    setResult({...empty(points), status:'loading'});
    loadTerrain(points, controller.signal).then(terrain => {
      if (!controller.signal.aborted && current.current === points) setResult({points, value:terrain, status:'ready', error:''});
    }).catch(error => {
      if (current.current !== points || controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      setResult({...empty(points), status:'error', error:controller.signal.reason === 'timeout' ? 'Elevation request timed out.' : error instanceof Error ? error.message : 'Elevation could not load.'});
    }).finally(() => clearTimeout(timeout));
    return () => {clearTimeout(timeout); controller.abort();};
  }, [points, enabled, attempt, value]);
  return {...data, retry: () => setAttempt(previous => previous + 1)};
}
