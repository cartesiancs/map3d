import { useEffect, useState } from 'react';
import type { Feature } from '../data/layers';
import type { SiteReport } from '../data/siteAnalysis';
const cache = new WeakMap<Feature[], { points: {lat: number; lng: number}[]; report: SiteReport }>();

export function useSiteAnalysis(points: { lat: number; lng: number }[], features: Feature[], enabled = true) {
  const [result, setResult] = useState<{ points: typeof points; features: Feature[]; report?: SiteReport; error?: string }>(() => {
    const saved = cache.get(features); return saved?.points === points ? { ...saved, features } : undefined;
  });
  const [progress, setProgress] = useState<{points: typeof points; features: Feature[]; phase: string}>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setResult(previous => previous?.points === points ? previous : undefined);
    if (!enabled || points.length < 3) return;
    const saved = cache.get(features);
    if (saved?.points === points) { setResult({ ...saved, features }); return; }
    let worker: Worker | undefined;
    let active = true;
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../data/siteAnalysis.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          if (!active) return;
          if (data.phase) { setProgress({points, features, phase: data.phase}); return; }
          if (data.debug) console.warn('Site analysis:', data.debug);
          if (data.report) cache.set(features, { points, report: data.report });
          setResult({ points, features, ...data }); worker?.terminate();
        };
        worker.onerror = () => { if (active) setResult({ points, features, error: 'Site analysis could not finish. Retry the calculation.' }); worker?.terminate(); };
        worker.postMessage([points, features]);
      } catch { if (active) setResult({ points, features, error: 'Your browser could not start site analysis. Retry the calculation.' }); }
    }, 200);
    return () => { active = false; clearTimeout(timer); worker?.terminate(); };
  }, [points, features, attempt, enabled]);
  return {
    // Do not present the initial empty calculation as zero-valued loaded data while
    // the first real source batch is still being analyzed.
    report: enabled && result?.points === points && (result.features.length > 0 || features.length === 0) ? result.report : undefined,
    error: enabled && result?.points === points && result.features === features ? result.error : undefined,
    calculating: enabled && (result?.points !== points || result.features !== features),
    phase: progress?.points === points && progress.features === features ? progress.phase : 'Calculating the selected site…',
    retry: () => { cache.delete(features); setResult(undefined); setAttempt(value => value + 1); },
  };
}
