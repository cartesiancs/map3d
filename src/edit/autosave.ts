// Unsubmitted Edit mode work survives a reload: the drafts are kept in IndexedDB (meshes can be larger than
// localStorage allows), one record per signed-in user, and offered back the next time Edit mode opens.

import type { Draft } from "./drafts";

export type Saved = { savedAt: string; drafts: Draft[]; supersedes: string[] };

const DB = "map3d-edit";
const STORE = "drafts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSaved(userId: number): Promise<Saved | null> {
  try {
    return ((await run("readonly", (s) => s.get(String(userId)))) as Saved | undefined) ?? null;
  } catch (err) {
    console.warn("edit autosave:", err);
    return null;
  }
}

export async function save(userId: number, data: Saved | null) {
  try {
    if (data) await run("readwrite", (s) => s.put(data, String(userId)));
    else await run("readwrite", (s) => s.delete(String(userId)));
  } catch (err) {
    console.warn("edit autosave:", err);
  }
}
