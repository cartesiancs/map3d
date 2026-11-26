import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, MapControls, PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { DEFAULT_AREA, DEFAULT_CENTER, NamedBuilding, ORIGIN, START_VIEW, useAreaStore } from "@/state/areaStore";
import { saveLastView } from "@/state/lastView";
import { useViewStore } from "@/state/viewStore";
import { useContribStore } from "@/state/contribStore";
import { LEVELS } from "./tiles/levels";
import { SCENE_COLORS, TileManager } from "./tiles/TileManager";
import { useThemeStore } from "@/state/theme";
import { fromScene, makeOrigin, toScene } from "./tiles/geo";
import { fetchOverlayIndex } from "@/api/overlay";


/** One manager for the whole session: tile meshes survive a Canvas remount (antialias change). */
export const tileManager = new TileManager(ORIGIN, LEVELS[useViewStore.getState().level]);
tileManager.setTheme(useThemeStore.getState().dark);
tileManager.onStats = (stats) => useAreaStore.getState().setStats(stats);
tileManager.onCenter = (center) => useAreaStore.getState().setCenter(center);
tileManager.onNamed = (tiles) => {
  const named: NamedBuilding[] = [];
  for (const t of tiles) {
    const d = t.data;
    if (d?.layer !== "building") continue;
    for (const [index, label, sub] of d.names) named.push({ key: t.key, index, id: d.ids[index], label, sub });
  }
  useAreaStore.getState().setNamed(named);
};
// a tile rebuilt with new edits renumbers its buildings: an open selection there would point at another one
tileManager.onReplaced = (keys) => {
  const view = useViewStore.getState();
  if (view.selected && keys.includes(view.selected.key)) view.select(null);
};

/** approved edits: poll the overlay index (changed tiles reload) */
const OVERLAY_POLL_MS = 120_000;
let overlayRev = -1;
let overlayFetching = false;
export async function refreshOverlay() {
  if (overlayFetching) return;
  overlayFetching = true;
  try {
    const index = await fetchOverlayIndex();
    if (!index) {
      // unreachable: keep the edits already shown; before the first index, show the OSM data meanwhile
      if (overlayRev < 0) tileManager.setOverlay({});
      return;
    }
    if (index.rev !== overlayRev) {
      overlayRev = index.rev;
      tileManager.setOverlay(index.tiles);
    }
  } finally {
    overlayFetching = false;
  }
}

/**
 * Show a place: fly there, or (more than ~44 km away) rebuild the scene around it and jump, instead of
 * flying across the globe. `distance` is the camera distance in scene units.
 */
export function goToPlace(lat: number, lng: number, distance: number) {
  const view = useViewStore.getState();
  const [x, z] = toScene(tileManager.origin, lat, lng);
  if (Math.hypot(x, z) > REBASE_DISTANCE) {
    view.select(null);
    tileManager.rebase(lat, lng);
    view.flyTo(0, 0, distance, true);
  } else {
    view.flyTo(x, z, distance);
  }
}

const [nex, nez] = toScene(makeOrigin(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng), DEFAULT_AREA.north, DEFAULT_AREA.east);
const DEFAULT_EXTENT = Math.max(Math.abs(nex), Math.abs(nez)) * 2;
/** first view: as the last visit left it (target at the origin, on the ground it was on), else over the default area */
const DEFAULT_TARGET = new THREE.Vector3(0, START_VIEW?.height ?? 0, 0);
const DEFAULT_CAMERA = START_VIEW
  ? new THREE.Vector3(...START_VIEW.offset).add(DEFAULT_TARGET)
  : new THREE.Vector3(0, DEFAULT_EXTENT * 0.55, DEFAULT_EXTENT * 0.6);

/** camera kept across Canvas remounts */
const savedView = { position: DEFAULT_CAMERA.clone(), target: DEFAULT_TARGET.clone() };

type Controls = THREE.EventDispatcher<{ start: object; change: object }> & {
  target: THREE.Vector3;
  update: () => void;
};

/** set while CameraRig eases the camera; ground following waits for it */
let cameraAnimating = false;
/** past this distance from the origin (≈ 44 km) the scene is rebuilt around the camera target */
const REBASE_DISTANCE = 20000;
/** the camera never goes lower than this above the ground (scene units) */
const CAMERA_CLEARANCE = 12;

function TileLayer() {
  const { scene, gl, invalidate } = useThree();
  const showRoads = useViewStore((s) => s.showRoads);
  const terrain = useViewStore((s) => s.terrain);
  const groundMap = useViewStore((s) => s.groundMap);
  const level = useViewStore((s) => s.level);

  useEffect(() => {
    tileManager.onChange = () => invalidate();
    tileManager.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    scene.fog = new THREE.Fog(tileManager.colors.background, 1000, 2000);
    return () => {
      scene.fog = null;
    };
  }, [scene, gl, invalidate]);

  useEffect(() => {
    refreshOverlay();
    const timer = window.setInterval(refreshOverlay, OVERLAY_POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refreshOverlay();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    tileManager.setConfig(LEVELS[level]);
    invalidate();
  }, [level, invalidate]);

  useEffect(() => {
    tileManager.showRoads = showRoads;
    invalidate();
  }, [showRoads, invalidate]);

  useEffect(() => {
    tileManager.setGround(terrain, groundMap);
    invalidate();
  }, [terrain, groundMap, invalidate]);

  const dark = useThemeStore((s) => s.dark);
  useEffect(() => {
    tileManager.setTheme(dark);
    if (scene.fog) scene.fog.color.set(tileManager.colors.background);
    invalidate();
  }, [dark, scene, invalidate]);

  useFrame((state) => {
    const controls = state.controls as unknown as Controls | null;
    const camera = state.camera as THREE.PerspectiveCamera;
    const target = controls?.target ?? savedView.target;

    // keep coordinates small (float precision, projection accuracy): re-center after long pans
    if (controls && Math.hypot(target.x, target.z) > REBASE_DISTANCE && !cameraAnimating) {
      const ll = fromScene(tileManager.origin, target.x, target.z);
      tileManager.rebase(ll.lat, ll.lng);
      camera.position.x -= target.x;
      camera.position.z -= target.z;
      target.set(0, target.y, 0);
      controls.update();
      useViewStore.getState().select(null);
    }

    if (tileManager.update(camera, target, state.scene, performance.now())) invalidate();

    // the orbit target rests on the ground, and the camera stays above it
    if (controls && !cameraAnimating) {
      let moved = false;
      const gh = tileManager.groundHeightAt(target.x, target.z);
      if (gh !== null && Math.abs(gh - target.y) > 0.05) {
        const step = (gh - target.y) * 0.25;
        target.y += step;
        camera.position.y += step;
        moved = true;
      }
      const ch = tileManager.groundHeightAt(camera.position.x, camera.position.z);
      if (ch !== null && camera.position.y < ch + CAMERA_CLEARANCE) {
        camera.position.y = ch + CAMERA_CLEARANCE;
        moved = true;
      }
      if (moved) {
        controls.update();
        invalidate();
      }
    }
  });

  return <primitive object={tileManager.group} />;
}

/**
 * Hover highlight (mouse only), click-to-select and the right-click menu, with ray picking on per-building
 * boxes. A right-button drag rotates the view: the menu opens only for a short right click that did not move
 * (the native contextmenu event fires on press on macOS, so it is not used).
 */
function Picker() {
  const { gl, camera, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const select = useViewStore((s) => s.select);

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number; t: number; button: number; mouse: boolean } | null = null;
    let lastMove = 0;
    let pending: number | null = null;

    const pickAt = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return tileManager.pick(raycaster.ray);
    };
    const hoverAt = (x: number, y: number) => {
      const hit = pickAt(x, y);
      if (tileManager.setHover(hit)) invalidate();
      el.style.cursor = hit ? "pointer" : "";
    };

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, mouse: e.pointerType === "mouse" };
    };
    const openMenu = (clientX: number, clientY: number) => {
      const { openMenu } = useContribStore.getState();
      const hit = pickAt(clientX, clientY);
      if (hit) {
        const info = tileManager.describe(hit.tile.key, hit.index);
        if (!info) return;
        const { lat, lng } = fromScene(tileManager.origin, info.center.x, info.center.z);
        openMenu({ kind: "building", key: info.key, index: info.index, id: info.id, tags: info.tags, lat, lng }, clientX, clientY);
        return;
      }
      const p = tileManager.pickGround(raycaster.ray);
      if (!p) return;
      const { lat, lng } = fromScene(tileManager.origin, p.x, p.z);
      const distance = camera.position.distanceTo(controls?.target ?? p);
      openMenu({ kind: "ground", lat, lng, x: p.x, z: p.z, distance }, clientX, clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const elapsed = performance.now() - down.t;
      const { button, mouse } = down;
      down = null;
      if (button === 2) {
        if (mouse && moved <= 4 && elapsed < 500) openMenu(e.clientX, e.clientY);
        return;
      }
      if (button !== 0 || moved > 6 || elapsed >= 600) return; // that was a drag (pan / rotate)
      const hit = pickAt(e.clientX, e.clientY);
      if (!hit) return;
      const cur = useViewStore.getState().selected;
      if (cur && cur.key === hit.tile.key && cur.index === hit.index) {
        select(null);
        return;
      }
      const info = tileManager.describe(hit.tile.key, hit.index);
      if (info) select({ key: info.key, index: info.index, id: info.id, tags: info.tags });
    };
    // hover: mouse only, not while a button is held (dragging), throttled
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      const now = performance.now();
      if (now - lastMove < 50) {
        if (pending === null) {
          const { clientX, clientY } = e;
          pending = window.setTimeout(() => {
            pending = null;
            lastMove = performance.now();
            hoverAt(clientX, clientY);
          }, 50);
        }
        return;
      }
      lastMove = now;
      hoverAt(e.clientX, e.clientY);
    };
    const onLeave = () => {
      if (tileManager.setHover(null)) invalidate();
      el.style.cursor = "";
    };

    const noNativeMenu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", noNativeMenu);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("contextmenu", noNativeMenu);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (pending !== null) clearTimeout(pending);
    };
  }, [gl, camera, controls, invalidate, select]);

  const selected = useViewStore((s) => s.selected);
  useEffect(() => {
    tileManager.setSelected(selected ? { key: selected.key, index: selected.index } : null);
    invalidate();
  }, [selected, invalidate]);

  return null;
}

/** Eased camera moves: +/- zoom, fly to a searched building or a downloaded area. Dragging cancels them. */
function CameraRig() {
  const { camera, invalidate } = useThree();
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const zoomRequest = useViewStore((s) => s.zoomRequest);
  const focusRequest = useViewStore((s) => s.focusRequest);
  const flyRequest = useViewStore((s) => s.flyRequest);
  const select = useViewStore((s) => s.select);
  const goal = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (!controls) return;
    camera.position.copy(savedView.position);
    controls.target.copy(savedView.target);
    controls.update();
    const cancel = () => (goal.current = null);
    controls.addEventListener("start", cancel);
    return () => controls.removeEventListener("start", cancel);
  }, [controls, camera]);

  // remember the view for the next visit: each second, and when the page is hidden or left. During an eased
  // move that is where it is heading (leaving right after a search still opens the searched place next time).
  // The target and the origin change together (rebase), so reading both here is always consistent.
  useEffect(() => {
    if (!controls) return;
    const save = () => {
      const t = goal.current?.target ?? controls.target;
      const p = goal.current?.position ?? camera.position;
      const ll = fromScene(tileManager.origin, t.x, t.z);
      saveLastView({ lat: ll.lat, lng: ll.lng, height: t.y, offset: [p.x - t.x, p.y - t.y, p.z - t.z] });
    };
    const timer = window.setInterval(save, 1000);
    const onVisibility = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [controls, camera]);

  const go = (position: THREE.Vector3, target: THREE.Vector3) => {
    goal.current = { position, target };
    invalidate();
  };

  useEffect(() => {
    if (!zoomRequest.seq || !controls) return;
    const target = goal.current?.target ?? controls.target.clone();
    const from = goal.current?.position ?? camera.position;
    const offset = from.clone().sub(target).multiplyScalar(zoomRequest.factor);
    const max = LEVELS[useViewStore.getState().level].maxDistance;
    offset.setLength(Math.min(max, Math.max(20, offset.length())));
    go(target.clone().add(offset), target);
  }, [zoomRequest]);

  useEffect(() => {
    if (!focusRequest.seq || !controls || !focusRequest.ref) return;
    const info = tileManager.describe(focusRequest.ref.key, focusRequest.ref.index);
    if (!info) return;
    select({ key: info.key, index: info.index, id: info.id, tags: info.tags });
    const dir = camera.position.clone().sub(controls.target).normalize();
    go(info.center.clone().addScaledVector(dir, Math.max(info.height * 4, 150)), info.center);
  }, [focusRequest]);

  useEffect(() => {
    if (!flyRequest.seq || !controls) return;
    const d = flyRequest.distance;
    const y = tileManager.groundHeightAt(flyRequest.x, flyRequest.z) ?? controls.target.y;
    const target = new THREE.Vector3(flyRequest.x, y, flyRequest.z);
    const position = new THREE.Vector3(flyRequest.x, y + d * 0.55, flyRequest.z + d * 0.6);
    if (flyRequest.instant) {
      goal.current = null;
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      invalidate();
      return;
    }
    go(position, target);
  }, [flyRequest]);

  useFrame(() => {
    const g = goal.current;
    if (g) {
      camera.position.lerp(g.position, 0.15);
      if (controls) {
        controls.target.lerp(g.target, 0.15);
        controls.update();
      }
      if (camera.position.distanceTo(g.position) < 0.5) goal.current = null;
      invalidate();
    }
    cameraAnimating = goal.current !== null;
    savedView.position.copy(camera.position);
    if (controls) savedView.target.copy(controls.target);
  });

  return null;
}

/** dev only: lets the benchmark script drive the camera and read tile stats */
function DevHook() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window as any, { __r3f: { get }, __tiles: tileManager, __areaStore: useAreaStore, __viewStore: useViewStore });
  }, [get]);
  return null;
}

export function Space() {
  const level = useViewStore((s) => s.level);
  const dark = useThemeStore((s) => s.dark);
  const background = SCENE_COLORS[dark ? "dark" : "light"].background;
  // a night scene: dimmer lights, so dark materials stay dark under the bright city environment
  const light = dark ? SCENE_COLORS.dark.light : 1;
  const cfg = LEVELS[level];
  const maxDpr = Math.min(cfg.dpr, window.devicePixelRatio || 1);
  const [dpr, setDpr] = useState(maxDpr);
  useEffect(() => setDpr(maxDpr), [maxDpr]);
  const glOptions = useMemo(() => ({ antialias: cfg.antialias, powerPreference: "high-performance" as const }), [cfg.antialias]);

  return (
    <Canvas
      // a new WebGL context is needed to switch antialiasing
      key={cfg.antialias ? "aa" : "no-aa"}
      frameloop="demand"
      dpr={dpr}
      gl={glOptions}
      camera={{ fov: 60, near: 1, far: 6000, position: DEFAULT_CAMERA.toArray() }}
    >
      {/* adaptive resolution: lower the pixel ratio while frames are slow, restore it when they recover */}
      <PerformanceMonitor
        onDecline={() => setDpr((d) => Math.max(1, +(d * 0.75).toFixed(2)))}
        onIncline={() => setDpr((d) => Math.min(maxDpr, +(d * 1.25).toFixed(2)))}
      />
      <color attach="background" args={[background]} />
      <ambientLight intensity={(Math.PI / 2) * light} />
      <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} decay={0} intensity={Math.PI * light} />
      <pointLight position={[-10, -10, -10]} decay={0} intensity={Math.PI * light} />
      {!cfg.pbr && <directionalLight position={[300, 800, 400]} intensity={1.2 * light} />}
      <MapControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        screenSpacePanning={false}
        maxPolarAngle={1.35}
        minDistance={20}
        maxDistance={cfg.maxDistance}
      />
      <TileLayer />
      <Picker />
      <CameraRig />
      <DevHook />
      {cfg.pbr && <Environment preset="city" environmentIntensity={light} />}
    </Canvas>
  );
}
