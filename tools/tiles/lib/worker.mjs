// Worker thread: stores the blocks the main thread hands it (publish.mjs). Uploading is CPU-bound (request
// signing, HTTP), about 0.5-0.8 ms per object on one core, so blocks are spread over several threads.

import { parentPort, workerData } from "node:worker_threads";
import { ByteSource } from "./archive.mjs";
import { blockStore } from "./block.mjs";
import { makeSink } from "./sinks.mjs";

const d = workerData;
const source = await ByteSource.open(d.src);
const sink = makeSink(d.sink);
let tiles = 0;
let bytes = 0;
const store = blockStore({ ...d.store, source, sink, onTiles: (n, b) => ((tiles += n), (bytes += b)) });

// tiles stored so far, for the progress line
const ticker = setInterval(() => {
  if (!tiles) return;
  parentPort.postMessage({ tick: tiles, bytes });
  tiles = 0;
  bytes = 0;
}, 1000);
ticker.unref();

parentPort.on("message", async (m) => {
  if (m.close) {
    clearInterval(ticker);
    if (tiles) parentPort.postMessage({ tick: tiles, bytes });
    await source.close();
    parentPort.postMessage({ closed: true });
    return;
  }
  try {
    const r = m.flat ? await store.block(m.bx, m.by, m.flat) : await store.empty(m.bx, m.by);
    parentPort.postMessage({ id: m.id, ...r });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err?.stack ?? err) });
  }
});
parentPort.postMessage({ ready: true });
