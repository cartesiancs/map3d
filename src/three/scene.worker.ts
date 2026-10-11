import { buildBatches, transferBuffers, type Origin } from './batches';
import type { Feature, VectorLayer } from '../data/layers';
import type { Terrain } from '../data/terrain';
self.onmessage = (event: MessageEvent<{ id: number; layer: VectorLayer; features: Feature[]; origin: Origin; terrain: Terrain | null }>) => {
  const { id, layer, features, origin, terrain } = event.data;
  try {
    const batches = buildBatches(features, origin, terrain);
    self.postMessage({ id, layer, batches }, { transfer: transferBuffers(batches) });
  } catch (error) {
    self.postMessage({ id, layer, error: error instanceof Error ? error.message : 'Could not prepare layer geometry.' });
  }
};
