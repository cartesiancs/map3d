// Fetches, decodes and triangulates off the main thread; arrays and bitmaps are transferred, not copied.
import { handle, WorkerJob, transferList } from "./tileLoader";

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<{ id: number; job: WorkerJob }>) => {
  const { id, job } = e.data;
  try {
    const result = await handle(job);
    ctx.postMessage({ id, result }, transferList(result));
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
