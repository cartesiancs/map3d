// The last place looked at, so the next visit opens there (this browser only: localStorage).
// Stored as the lat/lng under the camera target, the target's height (ground elevation in scene units, which
// does not depend on the origin) and the camera's offset from the target in scene units, which keeps the
// distance and the viewing angle; the scene origin itself changes between sessions.

const KEY = "map3d.lastView";

export type LastView = { lat: number; lng: number; height: number; offset: [number, number, number] };

/** the camera distance limits of MapControls (minDistance, the largest maxDistance of the levels) */
const MIN_DISTANCE = 20;
const MAX_DISTANCE = 5000;
/** ground elevation range in scene units (1 unit ≈ 2.2 m): the Dead Sea shore to above Everest */
const MAX_HEIGHT = 5000;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** a stored view that is safe to start from, or null */
export function loadLastView(): LastView | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || v.v !== 1 || !finite(v.lat) || !finite(v.lng) || !Array.isArray(v.offset) || v.offset.length !== 3 || !v.offset.every(finite)) return null;
    if (Math.abs(v.lat) > 85 || Math.abs(v.lng) > 180) return null;
    // saved before the height was kept: the target starts on y = 0 and settles onto the ground
    const height = finite(v.height) && Math.abs(v.height) <= MAX_HEIGHT ? v.height : 0;
    let [x, y, z] = v.offset as [number, number, number];
    const d = Math.hypot(x, y, z);
    if (y <= 0 || d < 1) return null; // the camera is always above the target
    // a view zoomed all the way in or out sits on a limit, and the rounding when saving can put it just past it
    const k = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, d)) / d;
    [x, y, z] = [x * k, y * k, z * k];
    return { lat: v.lat, lng: v.lng, height, offset: [x, y, z] };
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
    height: +view.height.toFixed(1),
    offset: view.offset.map((n) => +n.toFixed(1)),
  });
  if (s === last) return;
  last = s;
  try {
    localStorage.setItem(KEY, s);
  } catch {}
}
