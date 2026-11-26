// Fetches, decodes and triangulates off the main thread; arrays and bitmaps are transferred, not copied.
import { handle, WorkerJob, transferList } from "./tileLoader";
import { acceptReply } from "@/api/pmtilesShared";

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<{ id: number; job: WorkerJob }>) => {
  if (acceptReply(e.data)) return; // answer to a manifest / header / directory request (pmtilesShared.ts)
  const { id, job } = e.data;
  try {
    const result = await handle(job);
    ctx.postMessage({ id, result }, transferList(result));
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
