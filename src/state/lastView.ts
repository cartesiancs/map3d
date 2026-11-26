// The last place looked at, so the next visit opens there (this browser only: localStorage).
// Stored as the lat/lng under the camera target plus the camera's offset from the target in scene units, which
// keeps the distance and the viewing angle; the scene origin itself changes between sessions.

const KEY = "map3d.lastView";

export type LastView = { lat: number; lng: number; offset: [number, number, number] };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** a stored view that is safe to start from, or null */
export function loadLastView(): LastView | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || v.v !== 1 || !finite(v.lat) || !finite(v.lng) || !Array.isArray(v.offset) || v.offset.length !== 3 || !v.offset.every(finite)) return null;
    if (Math.abs(v.lat) > 85 || Math.abs(v.lng) > 180) return null;
    const [x, y, z] = v.offset as [number, number, number];
    const d = Math.hypot(x, y, z);
    if (y <= 0 || d < 20 || d > 5000) return null; // camera above the target, within the zoom limits
    return { lat: v.lat, lng: v.lng, offset: [x, y, z] };
  } catch {
    return null;
  }
}

let last = "";
/** stores the view when it changed (cheap to call often) */
export function saveLastView(view: LastView) {
  const s = JSON.stringify({
    v: 1,
    lat: +view.lat.toFixed(6),
    lng: +(((((view.lng + 180) % 360) + 360) % 360) - 180).toFixed(6), // past the antimeridian
    offset: view.offset.map((n) => +n.toFixed(1)),
  });
  if (s === last) return;
  last = s;
  try {
    localStorage.setItem(KEY, s);
  } catch {}
}
