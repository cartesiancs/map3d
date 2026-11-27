import * as THREE from "three";
import { tileClient } from "./tileClient";
import type { BuildingTileData, RoadTileData } from "./buildTile";
import { Origin, SCALE, fromScene, latToTileY, latToTileYf, lngToTileX, lngToTileXf, makeOrigin, tileKey, tileXToLng, tileXfToLng, tileYToLat, tileYfToLat, toScene } from "./geo";
import { LevelConfig } from "./levels";
import { GroundTileData, TERRAIN_Z, TerrainGrid, sampleGrid, terrainTileOf } from "./terrain";
import type { BasesResult, RoadHeightsResult } from "./tileLoader";
import { SDF_SIZE, SDF_SPREAD, WaterResult } from "./water";

export const BUILDING_COLOR = "#a9acb1";
export const HOVER_COLOR = "#7aa7f7";
export const SELECTED_COLOR = "#3d83f7";
export const ROAD_COLOR = "#34f516";
/** relief without the ground map */
export const GROUND_COLOR = "#e6e7ea";
/** ground map: land and sea */
export const LAND_COLOR = "#eceef1";
export const SEA_COLOR = "#9cc2e8";
/** the scene in each theme (exports always use the light colors above) */
export const SCENE_COLORS = {
  // edit*: Edit mode (edges and vertices, the selected ones); review*: a changeset drawn for review
  light: {
    background: "#f6f7f8", building: BUILDING_COLOR, hover: HOVER_COLOR, selected: SELECTED_COLOR, ground: GROUND_COLOR, land: LAND_COLOR, sea: SEA_COLOR, light: 1,
    editEdge: "#1f2937", editSelected: "#f97316", review: "#ef4444", reviewGhostEdge: "#64748b",
  },
  // with the lights at `light` × their day intensity (Space.tsx)
  dark: {
    background: "#1a1b1e", building: "#8a8f98", hover: "#6a9cf5", selected: "#3d83f7", ground: "#3a3c42", land: "#3a3c42", sea: "#253447", light: 0.45,
    editEdge: "#e5e7eb", editSelected: "#fb923c", review: "#f87171", reviewGhostEdge: "#94a3b8",
  },
};
export type SceneColors = (typeof SCENE_COLORS)["light"];

/** roads drawn this much above the ground they follow (scene units), so they don't flicker into it */
const ROAD_LIFT = 0.8;

type Layer = "building" | "road";

export type Tile = {
  key: string;
  layer: Layer;
  x: number;
  y: number;
  state: "loading" | "ready" | "error";
  data?: BuildingTileData | RoadTileData;
  object?: THREE.Mesh | THREE.LineSegments;
  box?: THREE.Box3;
  tags?: Record<string, string>[];
  lastWanted: number;
  failedAt?: number;
  /** buildings: overlay revision the tile was built with (undefined: no edits) */
  overlayRev?: number;
  /** ground under each building: [lowest, highest] corner (terrain on); null until computed */
  bases?: Float32Array | null;
  /** per-vertex ground offset (the aBase attribute array) */
  vertexBase?: Float32Array;
  terrainState?: "pending" | "ready" | "error";
  terrainFailedAt?: number;
  /** buildings: feature id -> index (built on first use) */
  idIndex?: Map<number, number>;
  /** masked buildings (see setMasked): their original triangle indices, by building index */
  maskSaved?: Map<number, Uint16Array | Uint32Array>;
};

type GroundTile = {
  key: string; // "t:x/y" relief, "f:x/y" flat
  x: number;
  y: number;
  flat: boolean;
  state: "loading" | "ready" | "error";
  mesh?: THREE.Mesh;
  grid?: TerrainGrid;
  lastWanted: number;
  failedAt?: number;
  box?: THREE.Box3;
};

/** land / sea map of one z13 tile: all land, all sea, or a coastline SDF texture */
type GroundMap = {
  state: "loading" | "ready" | "error";
  kind?: "land" | "sea" | "mixed";
  texture?: THREE.DataTexture;
  material?: THREE.Material;
  lastUsed: number;
  failedAt?: number;
};

export type Hit = { tile: Tile; index: number; distance: number };

export type ManagerStats = { tiles: number; buildings: number; loading: number; failed: number; ground: number };

/** what the current view needs (building / road tiles, ground tiles, land / sea maps) and how much of it is drawn */
export type LoadProgress = { done: number; total: number };

/** a failed load is tried again after 2 s, 4 s, 8 s … up to a minute (network retries happen first, see retry.ts) */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60000;
/** buildings wait this long for the first overlay index, then load without it (and reload once it arrives) */
const OVERLAY_WAIT_MS = 1500;
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hit = new THREE.Vector3();

/**
 * Buildings and roads are lifted onto the terrain in the vertex shader: aBase (ground height per vertex)
 * × uGround (1 with terrain, 0 without). Toggling terrain is a uniform change, no geometry rebuild.
 */
function withGroundOffset<M extends THREE.Material>(material: M, uniforms: { uGround: { value: number }; uLift: { value: number } }, lift: boolean) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGround = uniforms.uGround;
    shader.uniforms.uLift = uniforms.uLift;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aBase;\nuniform float uGround;\nuniform float uLift;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\ntransformed.y += aBase * uGround${lift ? " + uLift" : ""};`);
  };
  material.customProgramCacheKey = () => (lift ? "map3d-ground-lift" : "map3d-ground");
  return material;
}

/**
 * Land / sea colouring from the coastline distance field in `map` (red channel, 0.5 = coastline, sea above).
 * The edge is anti-aliased over one screen pixel with fwidth, so it stays sharp at any zoom.
 */
function withCoastline(material: THREE.Material, uniforms: { uLand: { value: THREE.Color }; uSea: { value: THREE.Color } }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLand = uniforms.uLand;
    shader.uniforms.uSea = uniforms.uSea;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uLand;\nuniform vec3 uSea;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          // texel centers sit on i / (SIZE − 1): see water.ts
          vec2 sdfUv = vMapUv * ${((SDF_SIZE - 1) / SDF_SIZE).toFixed(8)} + ${(0.5 / SDF_SIZE).toFixed(8)};
          float sd = (texture2D(map, sdfUv).r - 0.5) * ${(2 * SDF_SPREAD).toFixed(1)}; // texels from the coast, sea > 0
          float aa = max(fwidth(sd), 1e-4);
          diffuseColor.rgb *= mix(uLand, uSea, smoothstep(-0.5 * aa, 0.5 * aa, sd));
        #endif`,
      );
  };
  material.customProgramCacheKey = () => "map3d-coastline";
  return material;
}

/**
 * Streams z14 tiles around the camera target, Google Earth style:
 * tiles inside a radius that grows with camera distance (capped per performance level) and inside the view
 * frustum are loaded nearest-first; the rest stay cached (LRU) until the cache is full.
 * The ground (terrain relief and/or the land / sea map) streams the same way in z13 tiles.
 */
export class TileManager {
  readonly group = new THREE.Group();
  readonly tiles: Record<Layer, Map<string, Tile>> = { building: new Map(), road: new Map() };
  readonly ground = new Map<string, GroundTile>();
  readonly maps = new Map<string, GroundMap>();
  origin: Origin;
  /** bumps on every rebase; results computed for an older origin are dropped */
  originId = 0;
  config: LevelConfig;
  showRoads = false;
  terrain = false;
  /** land / sea ground map (else plain relief) */
  mapOn = false;
  anisotropy = 1;
  /** called when something async changed and a new frame is needed */
  onChange: () => void = () => {};
  onStats: (s: ManagerStats) => void = () => {};
  onNamed: (tiles: Tile[]) => void = () => {};
  onCenter: (c: { lat: number; lng: number }) => void = () => {};
  /** called after a frame in which the progress changed */
  onProgress: (p: LoadProgress) => void = () => {};
  private lastProgress = "";

  private uploadQueue: Tile[] = [];
  private inFlight = 0;
  /** ground + ground map requests have their own budget, so they never hold back the buildings */
  private groundInFlight = 0;
  private groundBudget() {
    return Math.max(2, Math.ceil(this.config.inFlight / 2));
  }
  private terrainJobs = 0;
  private wanted = new Map<string, number>(); // key -> priority (drawn)
  private prefetch: string[] = []; // loaded but not drawn yet: where the camera is heading
  private groundWanted = new Set<string>(); // "x/y" at z13
  private lastTarget = new THREE.Vector3();
  private lastTime = 0;
  private velocity = new THREE.Vector3(); // target movement, units / s (smoothed)
  private uniforms = { uGround: { value: 0 }, uLift: { value: 0 } };
  private buildingMaterial!: THREE.Material;
  private hoverMaterial!: THREE.Material;
  private selectMaterial!: THREE.Material;
  private roadMaterial = withGroundOffset(new THREE.LineBasicMaterial({ color: ROAD_COLOR }), this.uniforms, true);
  private plainGround!: THREE.Material;
  private landGround!: THREE.Material;
  private seaGround!: THREE.Material;
  private mapUniforms = { uLand: { value: new THREE.Color(LAND_COLOR) }, uSea: { value: new THREE.Color(SEA_COLOR) } };
  /** light or dark scene colors (Settings → Appearance) */
  colors: SceneColors = SCENE_COLORS.light;
  private hover: { mesh: THREE.Mesh; tile: Tile; index: number } | null = null;
  private selected: { mesh: THREE.Mesh; key: string; index: number } | null = null;
  /** buildings drawn by another layer (edit mode, review): not drawn in their tile, not pickable */
  private masked = new Set<number>();
  private maskOwners = new Map<string, Set<number>>();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private box = new THREE.Box3();
  private namedDirty = false;
  private lastPublish = 0;
  private lastStats = "";
  private lastCenter = new THREE.Vector3(Infinity, 0, 0);
  radius = 0;
  /** consecutive failures per load ("building:x/y", "terrain:road:x/y", "ground:t:x/y", "map:x/y") */
  private failures = new Map<string, number>();
  private retryTimer: number | null = null;
  private retryAt = 0;
  /** approved edits: z14 tiles that have an overlay, with its revision (null until the first index) */
  private overlayTiles: Record<string, number> | null = null;
  private overlayWaitUntil = performance.now() + OVERLAY_WAIT_MS;
  /** building tiles dropped for a newer overlay (their indices are no longer valid) */
  onReplaced: (keys: string[]) => void = () => {};

  constructor(origin: Origin, config: LevelConfig) {
    this.origin = origin;
    this.config = config;
    this.makeMaterials();
  }

  private makeMaterials() {
    const pbr = this.config.pbr;
    const make = (color: string, overlay = false) => {
      const params = {
        color,
        flatShading: true, // face normals from screen-space derivatives: no normal buffer needed
        ...(overlay ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 } : {}),
      };
      return withGroundOffset(pbr ? new THREE.MeshStandardMaterial(params) : new THREE.MeshLambertMaterial(params), this.uniforms, false);
    };
    const c = this.colors;
    this.buildingMaterial = make(c.building);
    this.hoverMaterial = make(c.hover, true);
    this.selectMaterial = make(c.selected, true);
    this.plainGround = this.groundMat(c.ground);
    this.landGround = this.groundMat(c.land);
    this.seaGround = this.groundMat(c.sea);
  }

  /** switch the scene to the light or dark colors (materials are recolored in place) */
  setTheme(dark: boolean) {
    const c = (this.colors = dark ? SCENE_COLORS.dark : SCENE_COLORS.light);
    const set = (m: THREE.Material, color: string) => (m as THREE.MeshLambertMaterial).color.set(color);
    set(this.buildingMaterial, c.building);
    set(this.hoverMaterial, c.hover);
    set(this.selectMaterial, c.selected);
    set(this.plainGround, c.ground);
    set(this.landGround, c.land);
    set(this.seaGround, c.sea);
    this.mapUniforms.uLand.value.set(c.land);
    this.mapUniforms.uSea.value.set(c.sea);
    this.onChange();
  }

  /** lit ground (the relief shows through the shading) */
  private groundMat(color: string, sdf?: THREE.Texture) {
    const params = { color: sdf ? "#ffffff" : color, side: THREE.DoubleSide, ...(sdf ? { map: sdf } : {}) };
    const m = this.config.pbr ? new THREE.MeshStandardMaterial(params) : new THREE.MeshLambertMaterial(params);
    if (sdf) withCoastline(m, this.mapUniforms);
    return m;
  }

  setConfig(config: LevelConfig) {
    const pbrChanged = config.pbr !== this.config.pbr;
    this.config = config;
    for (const map of this.maps.values()) if (map.texture) this.applyAnisotropy(map.texture);
    if (!pbrChanged) return;
    for (const m of [this.buildingMaterial, this.hoverMaterial, this.selectMaterial, this.plainGround, this.landGround, this.seaGround]) m.dispose();
    this.makeMaterials();
    for (const map of this.maps.values()) {
      if (!map.texture) continue;
      map.material?.dispose();
      map.material = this.groundMat(LAND_COLOR, map.texture);
    }
    for (const t of this.tiles.building.values()) if (t.object) t.object.material = this.buildingMaterial;
    if (this.hover) this.hover.mesh.material = this.hoverMaterial;
    if (this.selected) this.selected.mesh.material = this.selectMaterial;
    for (const g of this.ground.values()) if (g.mesh) g.mesh.material = this.groundMaterial(g);
  }

  setGround(terrain: boolean, map: boolean) {
    const terrainChanged = terrain !== this.terrain;
    this.terrain = terrain;
    this.mapOn = map;
    this.uniforms.uGround.value = terrain ? 1 : 0;
    this.uniforms.uLift.value = terrain || map ? ROAD_LIFT : 0;
    for (const g of this.ground.values()) if (g.mesh) g.mesh.material = this.groundMaterial(g);
    if (terrainChanged) {
      // overlays carry their own copy of the vertices: rebuild them with / without the ground offset
      const sel = this.selected && { key: this.selected.key, index: this.selected.index };
      this.setSelected(null);
      this.setSelected(sel);
      this.setHover(null);
    }
  }

  /** Move the scene origin (far jumps / long pans): every tile is rebuilt around the new origin. */
  rebase(lat: number, lng: number) {
    this.origin = makeOrigin(lat, lng);
    this.originId++;
    this.setHover(null);
    this.setSelected(null);
    for (const map of Object.values(this.tiles)) {
      for (const t of map.values()) if (t.object) t.object.geometry.dispose();
      map.clear();
    }
    for (const g of this.ground.values()) g.mesh?.geometry.dispose();
    this.ground.clear();
    this.group.clear();
    this.uploadQueue = [];
    this.namedDirty = true;
    this.lastCenter.set(Infinity, 0, 0);
  }

  /** Called every rendered frame. Returns true while more frames are needed (uploads or loads pending). */
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, scene: THREE.Scene, now: number): boolean {
    const cfg = this.config;
    const dist = camera.position.distanceTo(target);
    const R = Math.min(cfg.radius, Math.max(700, dist * 1.8));
    this.radius = R;

    const far = R * 1.3 + dist;
    if (Math.abs(camera.far - far) / far > 0.02) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    // fog is measured from the camera: clear up to the target, fading out at the edge of the loaded radius
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = dist + R * 0.45;
      scene.fog.far = dist + R;
    }

    const dt = (now - this.lastTime) / 1000;
    if (dt > 0 && dt < 0.25) this.velocity.lerp(_v0.subVectors(target, this.lastTarget).divideScalar(dt), 0.25);
    else this.velocity.set(0, 0, 0); // first frame after an idle period
    this.lastTarget.copy(target);
    this.lastTime = now;

    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.selectTiles(target, R, now);
    this.selectPrefetch(target, R, now);
    this.selectGround(target, R, now);
    this.requestGround(now); // few z13 tiles, large visual impact: first
    this.requestTiles(now);
    this.requestTerrainForTiles(now);

    // hand at most N new meshes to the GPU per frame, so buffer uploads don't stack into one long frame
    for (let n = 0; n < cfg.uploadsPerFrame && this.uploadQueue.length; n++) {
      const t = this.uploadQueue.shift()!;
      if (t.object && this.tiles[t.layer].get(t.key) === t) this.group.add(t.object);
    }

    // with terrain on, a tile is only drawn once it sits on the ground (no flash of sunken buildings)
    const onGround = (t: Tile) => !this.terrain || t.terrainState === "ready";
    for (const t of this.tiles.building.values()) if (t.object) t.object.visible = this.wanted.has(t.key) && onGround(t);
    for (const t of this.tiles.road.values()) if (t.object) t.object.visible = this.showRoads && this.wanted.has(t.key) && onGround(t);
    const groundOn = this.terrain || this.mapOn;
    for (const g of this.ground.values()) {
      if (g.mesh) g.mesh.visible = groundOn && g.flat === !this.terrain && this.groundWanted.has(`${g.x}/${g.y}`);
    }

    this.evict();
    this.publish(target, now);
    this.measureProgress();
    this.scheduleRetries(now);
    // keep frames coming while buildings wait for the overlay index, so they start when the wait ends
    return this.uploadQueue.length > 0 || (!this.overlayTiles && now < this.overlayWaitUntil);
  }

  private selectTiles(target: THREE.Vector3, R: number, now: number) {
    const o = this.origin;
    const c = fromScene(o, target.x, target.z);
    const dLat = R / SCALE;
    const dLng = R / (SCALE * o.cos);
    const x0 = lngToTileX(c.lng - dLng);
    const x1 = lngToTileX(c.lng + dLng);
    const y0 = latToTileY(c.lat + dLat);
    const y1 = latToTileY(c.lat - dLat);

    const cands: { key: string; pri: number }[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const [ax, az] = toScene(o, tileYToLat(y), tileXToLng(x));
        const [bx, bz] = toScene(o, tileYToLat(y + 1), tileXToLng(x + 1));
        const dx = Math.max(ax - target.x, 0, target.x - bx);
        const dz = Math.max(az - target.z, 0, target.z - bz);
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        this.box.min.set(ax, -50, az);
        this.box.max.set(bx, 1500, bz); // tall enough for terrain + towers
        const inView = this.frustum.intersectsBox(this.box);
        if (!inView && d > R * 0.25) continue; // keep a small ring around the target for quick rotations
        cands.push({ key: tileKey(x, y), pri: d + (inView ? 0 : R) });
      }
    }
    cands.sort((a, b) => a.pri - b.pri);
    this.wanted.clear();
    for (const cnd of cands.slice(0, this.config.maxTiles)) this.wanted.set(cnd.key, cnd.pri);
    for (const layer of ["building", "road"] as Layer[]) {
      for (const key of this.wanted.keys()) {
        const t = this.tiles[layer].get(key);
        if (t) t.lastWanted = now;
      }
    }
  }

  /** While panning, also load the tiles around where the target will be in ~1 s. */
  private selectPrefetch(target: THREE.Vector3, R: number, now: number) {
    this.prefetch = [];
    const lead = _v1.copy(this.velocity).multiplyScalar(1.0);
    if (lead.length() < 50) return;
    if (lead.length() > R) lead.setLength(R);
    const ax = target.x + lead.x;
    const az = target.z + lead.z;
    const r = R * 0.6;
    const o = this.origin;
    const c = fromScene(o, ax, az);
    const x0 = lngToTileX(c.lng - r / (SCALE * o.cos));
    const x1 = lngToTileX(c.lng + r / (SCALE * o.cos));
    const y0 = latToTileY(c.lat + r / SCALE);
    const y1 = latToTileY(c.lat - r / SCALE);
    const cands: { key: string; d: number }[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = tileKey(x, y);
        if (this.wanted.has(key)) continue;
        const [tx0, tz0] = toScene(o, tileYToLat(y), tileXToLng(x));
        const [tx1, tz1] = toScene(o, tileYToLat(y + 1), tileXToLng(x + 1));
        const d = Math.hypot(Math.max(tx0 - ax, 0, ax - tx1), Math.max(tz0 - az, 0, az - tz1));
        if (d <= r) cands.push({ key, d });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    this.prefetch = cands.slice(0, Math.ceil(this.config.maxTiles * 0.4)).map((p) => p.key);
    for (const key of this.prefetch) {
      const t = this.tiles.building.get(key);
      if (t) t.lastWanted = now;
    }
  }

  /** z13 ground tiles in the same radius / view as the buildings (the target's own tile always). */
  private selectGround(target: THREE.Vector3, R: number, now: number) {
    this.groundWanted.clear();
    if (!this.terrain && !this.mapOn) return;
    const o = this.origin;
    const c = fromScene(o, target.x, target.z);
    const z = TERRAIN_Z;
    const x0 = Math.floor(lngToTileXf(c.lng - R / (SCALE * o.cos), z));
    const x1 = Math.floor(lngToTileXf(c.lng + R / (SCALE * o.cos), z));
    const y0 = Math.floor(latToTileYf(c.lat + R / SCALE, z));
    const y1 = Math.floor(latToTileYf(c.lat - R / SCALE, z));
    const cands: { key: string; pri: number }[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const [ax, az] = toScene(o, tileYfToLat(y, z), tileXfToLng(x, z));
        const [bx, bz] = toScene(o, tileYfToLat(y + 1, z), tileXfToLng(x + 1, z));
        const d = Math.hypot(Math.max(ax - target.x, 0, target.x - bx), Math.max(az - target.z, 0, target.z - bz));
        if (d > R) continue;
        this.box.min.set(ax, -50, az);
        this.box.max.set(bx, 1500, bz);
        const inView = this.frustum.intersectsBox(this.box);
        if (!inView && d > 0) continue;
        cands.push({ key: `${x}/${y}`, pri: d });
      }
    }
    cands.sort((a, b) => a.pri - b.pri);
    for (const cnd of cands.slice(0, this.config.groundTiles)) {
      this.groundWanted.add(cnd.key);
      const g = this.ground.get(`${this.terrain ? "t" : "f"}:${cnd.key}`);
      if (g) g.lastWanted = now;
      const img = this.maps.get(cnd.key);
      if (img) img.lastUsed = now;
    }
  }

  /**
   * New overlay index: building tiles built with another revision of their edits are dropped and load again
   * (nearest first, like any missing tile).
   */
  setOverlay(tiles: Record<string, number>) {
    this.overlayTiles = tiles;
    const replaced: string[] = [];
    const map = this.tiles.building;
    for (const t of [...map.values()]) {
      if (t.overlayRev === tiles[t.key]) continue;
      if (t.object) {
        this.group.remove(t.object);
        t.object.geometry.dispose();
      }
      if (this.hover?.tile === t) this.setHover(null);
      if (this.selected?.key === t.key) this.setSelected(null);
      map.delete(t.key); // a load still in flight is dropped when it returns
      replaced.push(t.key);
    }
    if (replaced.length) {
      this.namedDirty = true;
      this.onReplaced(replaced);
    }
    this.onChange();
  }

  private requestTiles(now: number) {
    const layers: Layer[] = this.showRoads ? ["building", "road"] : ["building"];
    if (!this.overlayTiles && now < this.overlayWaitUntil) layers.shift(); // edits first, so a tile is built once
    const order = [...this.wanted].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    for (const key of [...order, ...this.prefetch]) {
      for (const layer of layers) {
        if (this.inFlight >= this.config.inFlight) return;
        const existing = this.tiles[layer].get(key);
        if (existing && !(existing.state === "error" && this.retryDue(`${layer}:${key}`, existing.failedAt, now))) continue;
        this.load(layer, key, now);
      }
    }
  }

  private load(layer: Layer, key: string, now: number) {
    const [x, y] = key.split("/").map(Number);
    const overlayRev = layer === "building" ? this.overlayTiles?.[key] : undefined;
    const tile: Tile = { key, layer, x, y, state: "loading", lastWanted: now, overlayRev };
    this.tiles[layer].set(key, tile);
    this.inFlight++;
    tileClient
      .request({ layer, x, y, origin: this.origin, terrain: this.terrain, overlayRev })
      .then((data) => {
        if (this.tiles[layer].get(key) !== tile) return; // evicted or rebased meanwhile
        tile.data = data;
        tile.state = "ready";
        tile.object = this.makeObject(tile);
        if (layer === "building") this.applyMask(tile);
        // placed on the ground in the same worker job (terrain was on when it was requested)
        if (data.terrain) this.applyTerrain(tile, data.terrain as BasesResult | RoadHeightsResult);
        this.uploadQueue.push(tile);
        if (layer === "building") this.namedDirty = true;
        this.failures.delete(`${layer}:${key}`);
      })
      .catch((err) => {
        if (this.tiles[layer].get(key) !== tile) return;
        console.error(`tile ${layer} ${key}:`, err);
        tile.state = "error";
        tile.failedAt = performance.now();
        this.noteFailure(`${layer}:${key}`);
      })
      .finally(() => {
        this.inFlight--;
        this.onChange();
      });
  }

  private makeObject(tile: Tile) {
    const g = new THREE.BufferGeometry();
    const d = tile.data!;
    g.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute("aBase", new THREE.BufferAttribute(new Float32Array(d.positions.length / 3), 1));
    let obj: THREE.Mesh | THREE.LineSegments;
    if (d.layer === "building") {
      g.setIndex(new THREE.BufferAttribute(d.index, 1));
      tile.box = this.buildingBox(d, null);
      g.boundingBox = tile.box.clone();
      g.boundingSphere = tile.box.getBoundingSphere(new THREE.Sphere());
      obj = new THREE.Mesh(g, this.buildingMaterial);
    } else {
      g.computeBoundingBox();
      g.boundingBox!.max.y += 2000; // roads move up with the terrain in the shader
      g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
      obj = new THREE.LineSegments(g, this.roadMaterial);
    }
    obj.matrixAutoUpdate = false;
    obj.visible = false;
    return obj;
  }

  /** bounds from the per-building boxes (cheap) instead of scanning every vertex */
  private buildingBox(d: BuildingTileData, bases: Float32Array | null) {
    const b = d.bounds;
    const box = new THREE.Box3();
    for (let i = 0, k = 0; i < b.length; i += 5, k++) {
      const low = bases ? bases[2 * k] : 0;
      const high = bases ? bases[2 * k + 1] : 0;
      box.expandByPoint(_v0.set(b[i], low, b[i + 1]));
      box.expandByPoint(_v0.set(b[i + 2], high + b[i + 4], b[i + 3]));
    }
    if (box.isEmpty()) box.set(_v0.set(0, 0, 0), _v1.set(0, 0, 0));
    return box;
  }

  /** With terrain on: ground height under every building / road vertex, computed in the worker. */
  private requestTerrainForTiles(now: number) {
    if (!this.terrain) return;
    const order = [...this.wanted].sort((a, b) => a[1] - b[1]).map(([key]) => key);
    for (const key of order) {
      for (const layer of ["building", "road"] as Layer[]) {
        if (this.terrainJobs >= 3) return;
        const t = this.tiles[layer].get(key);
        if (!t || t.state !== "ready") continue;
        // a failed placement is tried again: until it succeeds the tile is not drawn at all
        if (t.terrainState && !(t.terrainState === "error" && this.retryDue(`terrain:${layer}:${key}`, t.terrainFailedAt, now))) continue;
        this.requestTerrainFor(t);
      }
    }
  }

  private requestTerrainFor(t: Tile) {
    const d = t.data!;
    const originId = this.originId;
    const route = (t.x >> 1) * 31 + (t.y >> 1); // same worker as its z13 ground tile (shared elevation cache)
    t.terrainState = "pending";
    this.terrainJobs++;
    const job =
      d.layer === "building"
        ? tileClient.run<BasesResult>({ kind: "bases", positions: d.positions, ranges: d.ranges, vertexClass: d.vertexClass, origin: this.origin }, route)
        : tileClient.run<RoadHeightsResult>({ kind: "roadHeights", positions: d.positions, origin: this.origin }, route);
    job
      .then((r) => {
        if (originId !== this.originId || this.tiles[t.layer].get(t.key) !== t || !t.object) return;
        this.applyTerrain(t, r);
        this.failures.delete(`terrain:${t.layer}:${t.key}`);
      })
      .catch((err) => {
        console.error(`terrain for ${t.layer} ${t.key}:`, err);
        t.terrainState = "error";
        t.terrainFailedAt = performance.now();
        this.noteFailure(`terrain:${t.layer}:${t.key}`);
      })
      .finally(() => {
        this.terrainJobs--;
        this.onChange();
      });
  }

  /** put a tile on the ground: per-vertex offsets for buildings, ground-following segments for roads */
  private applyTerrain(t: Tile, r: BasesResult | RoadHeightsResult) {
    const d = t.data!;
    const geom = t.object!.geometry;
    if ("vertexBase" in r) {
      (geom.getAttribute("aBase").array as Float32Array).set(r.vertexBase);
      geom.getAttribute("aBase").needsUpdate = true;
      t.bases = r.bases;
      t.vertexBase = geom.getAttribute("aBase").array as Float32Array;
      t.box = this.buildingBox(d as BuildingTileData, r.bases);
      geom.boundingBox = t.box.clone();
      geom.boundingSphere = t.box.getBoundingSphere(new THREE.Sphere());
    } else {
      // roads: segments split to follow the ground
      geom.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
      geom.setAttribute("aBase", new THREE.BufferAttribute(r.heights, 1));
      geom.computeBoundingBox();
      geom.boundingBox!.max.y += 2000;
      geom.boundingSphere = geom.boundingBox!.getBoundingSphere(new THREE.Sphere());
    }
    t.terrainState = "ready";
  }

  private requestGround(now: number) {
    if (!this.terrain && !this.mapOn) return;
    for (const key of this.groundWanted) {
      const [x, y] = key.split("/").map(Number);
      const gKey = `${this.terrain ? "t" : "f"}:${key}`;
      const g = this.ground.get(gKey);
      if ((!g || (g.state === "error" && this.retryDue(`ground:${gKey}`, g.failedAt, now))) && this.groundInFlight < this.groundBudget()) {
        this.loadGround(gKey, x, y, !this.terrain, now);
      }
      if (this.mapOn) {
        const img = this.maps.get(key);
        if ((!img || (img.state === "error" && this.retryDue(`map:${key}`, img.failedAt, now))) && this.groundInFlight < this.groundBudget()) {
          this.loadMap(key, x, y, now);
        }
      }
    }
  }

  private loadGround(key: string, x: number, y: number, flat: boolean, now: number) {
    const g: GroundTile = { key, x, y, flat, state: "loading", lastWanted: now };
    const originId = this.originId;
    this.ground.set(key, g);
    this.groundInFlight++;
    tileClient
      .run<GroundTileData>({ kind: "ground", x, y, origin: this.origin, flat }, x * 31 + y)
      .then((d) => {
        if (originId !== this.originId || this.ground.get(key) !== g) return;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(d.positions, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(d.normals, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(d.uvs, 2));
        geom.setIndex(new THREE.BufferAttribute(d.index, 1));
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
        g.box = geom.boundingBox!.clone();
        if (d.heights) g.grid = { x, y, heights: d.heights };
        g.mesh = new THREE.Mesh(geom, this.groundMaterial(g));
        g.mesh.matrixAutoUpdate = false;
        g.mesh.visible = false;
        g.mesh.renderOrder = -1;
        g.state = "ready";
        this.group.add(g.mesh);
        this.failures.delete(`ground:${key}`);
      })
      .catch((err) => {
        if (this.ground.get(key) !== g) return;
        console.error(`ground ${key}:`, err);
        g.state = "error";
        g.failedAt = performance.now();
        this.noteFailure(`ground:${key}`);
      })
      .finally(() => {
        this.groundInFlight--;
        this.onChange();
      });
  }

  private loadMap(key: string, x: number, y: number, now: number) {
    const map: GroundMap = { state: "loading", lastUsed: now };
    this.maps.set(key, map);
    this.groundInFlight++;
    tileClient
      .run<WaterResult>({ kind: "water", x, y }, x * 31 + y)
      .then((r) => {
        if (this.maps.get(key) !== map) return;
        map.kind = r.kind;
        if (r.kind === "mixed") {
          // the distance field is data, not a color: no color space conversion, linear filtering + mipmaps
          const texture = new THREE.DataTexture(r.sdf, r.size, r.size, THREE.RedFormat, THREE.UnsignedByteType);
          texture.flipY = false; // row 0 is the north edge = v 0, matching the ground UVs
          texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.generateMipmaps = true;
          texture.unpackAlignment = 1;
          this.applyAnisotropy(texture);
          texture.needsUpdate = true;
          map.texture = texture;
          map.material = this.groundMat(LAND_COLOR, texture);
        }
        map.state = "ready";
        this.failures.delete(`map:${key}`);
        for (const g of this.ground.values()) if (g.mesh && `${g.x}/${g.y}` === key) g.mesh.material = this.groundMaterial(g);
      })
      .catch((err) => {
        if (this.maps.get(key) !== map) return;
        console.error(`ground map ${key}:`, err);
        map.state = "error";
        map.failedAt = performance.now();
        this.noteFailure(`map:${key}`);
      })
      .finally(() => {
        this.groundInFlight--;
        this.onChange();
      });
  }

  private applyAnisotropy(texture: THREE.Texture) {
    const a = this.config.pbr ? this.anisotropy : 1;
    if (texture.anisotropy !== a) {
      texture.anisotropy = a;
      texture.needsUpdate = true;
    }
  }

  /** land / sea map when on (land colour until its tile is known), otherwise the plain relief */
  private groundMaterial(g: GroundTile): THREE.Material {
    if (!this.mapOn) return this.plainGround;
    const map = this.maps.get(`${g.x}/${g.y}`);
    if (map?.kind === "sea") return this.seaGround;
    if (map?.kind === "mixed" && map.material) return map.material;
    return this.landGround;
  }

  /** Height of the rendered ground at scene (x, z): 0 without terrain, null while its tile is not loaded. */
  groundHeightAt(x: number, z: number): number | null {
    if (!this.terrain) return 0;
    const { tx, ty } = terrainTileOf(this.origin, x, z);
    const g = this.ground.get(`t:${tx}/${ty}`);
    return g?.grid ? sampleGrid(g.grid, this.origin, x, z) : null;
  }

  private evict() {
    for (const layer of ["building", "road"] as Layer[]) {
      const map = this.tiles[layer];
      if (map.size <= this.config.cacheTiles) continue;
      const old = [...map.values()]
        .filter((t) => t.state !== "loading" && t.terrainState !== "pending" && !this.wanted.has(t.key) && !this.prefetch.includes(t.key))
        .sort((a, b) => a.lastWanted - b.lastWanted);
      for (const t of old.slice(0, map.size - this.config.cacheTiles)) {
        if (t.object) {
          this.group.remove(t.object);
          t.object.geometry.dispose();
        }
        map.delete(t.key);
        if (layer === "building") this.namedDirty = true;
        if (this.hover?.tile === t) this.setHover(null);
      }
    }
    const maxGround = this.config.groundTiles * 2;
    if (this.ground.size > maxGround) {
      const active = this.terrain ? "t" : "f";
      const old = [...this.ground.values()]
        .filter((g) => g.state !== "loading" && !(g.key[0] === active && this.groundWanted.has(`${g.x}/${g.y}`)))
        .sort((a, b) => a.lastWanted - b.lastWanted);
      for (const g of old.slice(0, this.ground.size - maxGround)) {
        if (g.mesh) {
          this.group.remove(g.mesh);
          g.mesh.geometry.dispose();
        }
        this.ground.delete(g.key);
      }
    }
    if (this.maps.size > maxGround) {
      const old = [...this.maps.entries()]
        .filter(([key, map]) => map.state !== "loading" && !this.groundWanted.has(key))
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [key, map] of old.slice(0, this.maps.size - maxGround)) {
        this.maps.delete(key);
        for (const g of this.ground.values()) if (g.mesh && `${g.x}/${g.y}` === key) g.mesh.material = this.groundMaterial(g);
        map.material?.dispose();
        map.texture?.dispose();
      }
    }
  }

  private publish(target: THREE.Vector3, now: number) {
    if (now - this.lastPublish < 300) return;
    this.lastPublish = now;
    let tiles = 0;
    let buildings = 0;
    let failed = 0;
    for (const t of this.tiles.building.values()) {
      if (t.state === "error") failed++;
      if (t.state === "ready" && this.wanted.has(t.key)) {
        tiles++;
        buildings += (t.data as BuildingTileData).ids.length;
      }
    }
    let ground = 0;
    for (const g of this.ground.values()) if (g.mesh?.visible) ground++;
    const stats = { tiles, buildings, loading: this.inFlight + this.groundInFlight, failed, ground };
    const s = JSON.stringify(stats);
    if (s !== this.lastStats) {
      this.lastStats = s;
      this.onStats(stats);
    }
    if (this.namedDirty) {
      this.namedDirty = false;
      this.onNamed([...this.tiles.building.values()].filter((t) => t.state === "ready"));
    }
    if (this.lastCenter.distanceTo(target) > 20) {
      this.lastCenter.copy(target);
      this.onCenter(fromScene(this.origin, target.x, target.z));
    }
  }

  /**
   * Of everything the view needs, how much is on screen: a tile counts once its mesh is in the scene and shown
   * (with terrain on, once it sits on the ground), a ground tile once its mesh is shown, a land / sea map once
   * it is known. Loading, waiting for upload, failed (retried later) all count as not yet.
   * Every frame, not throttled: the last change has to reach the UI, and no frame may follow it.
   */
  private measureProgress() {
    let done = 0;
    let total = 0;
    const shown = (o: THREE.Object3D | undefined) => !!o && o.visible && o.parent === this.group;
    const layers: Layer[] = this.showRoads ? ["building", "road"] : ["building"];
    for (const key of this.wanted.keys()) {
      for (const layer of layers) {
        total++;
        if (shown(this.tiles[layer].get(key)?.object)) done++;
      }
    }
    const kind = this.terrain ? "t" : "f";
    for (const key of this.groundWanted) {
      total++;
      if (shown(this.ground.get(`${kind}:${key}`)?.mesh)) done++;
      if (this.mapOn) {
        total++;
        if (this.maps.get(key)?.state === "ready") done++;
      }
    }
    const s = `${done}/${total}`;
    if (s === this.lastProgress) return;
    this.lastProgress = s;
    this.onProgress({ done, total });
  }

  /** [wall bottom, roof base] of a building: its lowest and highest ground with terrain on, else 0 */
  private baseOf(tile: Tile, index: number): [number, number] {
    return this.terrain && tile.bases ? [tile.bases[2 * index], tile.bases[2 * index + 1]] : [0, 0];
  }

  /** Nearest building hit by the ray: per-building boxes first, exact triangles only for box hits. */
  pick(ray: THREE.Ray): Hit | null {
    let best: Hit | null = null;
    const o = ray.origin;
    const inv = [1 / ray.direction.x, 1 / ray.direction.y, 1 / ray.direction.z];
    for (const tile of this.tiles.building.values()) {
      if (tile.state !== "ready" || !tile.object?.visible || !tile.box || !ray.intersectsBox(tile.box)) continue;
      const d = tile.data as BuildingTileData;
      const b = d.bounds;
      for (let i = 0; i < d.ids.length; i++) {
        if (tile.maskSaved?.has(i)) continue;
        const [low, high] = this.baseOf(tile, i);
        const y0 = low;
        const y1 = high + b[5 * i + 4];
        // ray vs building box (slab test)
        let t0 = ((inv[0] >= 0 ? b[5 * i] : b[5 * i + 2]) - o.x) * inv[0];
        let t1 = ((inv[0] >= 0 ? b[5 * i + 2] : b[5 * i]) - o.x) * inv[0];
        const ty0 = ((inv[1] >= 0 ? y0 : y1) - o.y) * inv[1];
        const ty1 = ((inv[1] >= 0 ? y1 : y0) - o.y) * inv[1];
        if (t0 > ty1 || ty0 > t1) continue;
        if (ty0 > t0) t0 = ty0;
        if (ty1 < t1) t1 = ty1;
        const tz0 = ((inv[2] >= 0 ? b[5 * i + 1] : b[5 * i + 3]) - o.z) * inv[2];
        const tz1 = ((inv[2] >= 0 ? b[5 * i + 3] : b[5 * i + 1]) - o.z) * inv[2];
        if (t0 > tz1 || tz0 > t1) continue;
        if (tz0 > t0) t0 = tz0;
        if (tz1 < t1) t1 = tz1;
        if (t1 < 0 || (best && t0 > best.distance)) continue;
        const dist = this.intersectBuilding(ray, d, i, this.terrain ? tile.vertexBase : undefined);
        if (dist !== null && (!best || dist < best.distance)) best = { tile, index: i, distance: dist };
      }
    }
    return best;
  }

  private intersectBuilding(ray: THREE.Ray, d: BuildingTileData, i: number, vb: Float32Array | undefined) {
    const p = d.positions;
    const idx = d.index;
    const start = d.ranges[4 * i + 2];
    const end = start + d.ranges[4 * i + 3];
    let best: number | null = null;
    for (let k = start; k < end; k += 3) {
      _v0.fromArray(p, idx[k] * 3).y += vb ? vb[idx[k]] : 0;
      _v1.fromArray(p, idx[k + 1] * 3).y += vb ? vb[idx[k + 1]] : 0;
      _v2.fromArray(p, idx[k + 2] * 3).y += vb ? vb[idx[k + 2]] : 0;
      if (ray.intersectTriangle(_v0, _v1, _v2, false, _hit)) {
        const dist = _hit.distanceTo(ray.origin);
        if (best === null || dist < best) best = dist;
      }
    }
    return best;
  }

  private overlay(tile: Tile, index: number, material: THREE.Material) {
    const d = tile.data as BuildingTileData;
    const [v0, vc, i0, ic] = d.ranges.subarray(4 * index, 4 * index + 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(d.positions.slice(v0 * 3, (v0 + vc) * 3), 3));
    // its own copy of the ground offsets (the shader adds them while terrain is on)
    g.setAttribute("aBase", new THREE.BufferAttribute(tile.vertexBase ? tile.vertexBase.slice(v0, v0 + vc) : new Float32Array(vc), 1));
    const index16 = new Uint16Array(ic);
    for (let k = 0; k < ic; k++) index16[k] = d.index[i0 + k] - v0;
    g.setIndex(new THREE.BufferAttribute(index16, 1));
    g.computeBoundingBox();
    const [low, high] = this.baseOf(tile, index);
    g.boundingBox!.min.y += low;
    g.boundingBox!.max.y += high;
    g.boundingSphere = g.boundingBox!.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, material);
    mesh.renderOrder = 1;
    this.group.add(mesh);
    return mesh;
  }

  setHover(hit: { tile: Tile; index: number } | null) {
    if (this.hover && hit && this.hover.tile === hit.tile && this.hover.index === hit.index) return false;
    if (this.hover) {
      this.group.remove(this.hover.mesh);
      this.hover.mesh.geometry.dispose();
      this.hover = null;
    }
    if (hit && !(this.selected && this.selected.key === hit.tile.key && this.selected.index === hit.index)) {
      this.hover = { mesh: this.overlay(hit.tile, hit.index, this.hoverMaterial), tile: hit.tile, index: hit.index };
    }
    return true;
  }

  setSelected(ref: { key: string; index: number } | null) {
    if (this.selected && ref && this.selected.key === ref.key && this.selected.index === ref.index) return;
    if (this.selected) {
      this.group.remove(this.selected.mesh);
      this.selected.mesh.geometry.dispose();
      this.selected = null;
    }
    const tile = ref && this.tiles.building.get(ref.key);
    if (ref && tile?.state === "ready") {
      if (this.hover?.tile === tile && this.hover.index === ref.index) this.setHover(null);
      this.selected = { mesh: this.overlay(tile, ref.index, this.selectMaterial), key: ref.key, index: ref.index };
    }
  }

  /** id, tags and placement of a building in a loaded tile */
  describe(key: string, index: number) {
    const tile = this.tiles.building.get(key);
    if (!tile || tile.state !== "ready") return null;
    const d = tile.data as BuildingTileData;
    tile.tags ??= JSON.parse(d.tagsJson) as Record<string, string>[];
    const b = d.bounds;
    const [low, high] = this.baseOf(tile, index);
    return {
      key,
      index,
      id: d.ids[index],
      tags: tile.tags[index],
      center: new THREE.Vector3((b[5 * index] + b[5 * index + 2]) / 2, (low + high + b[5 * index + 4]) / 2, (b[5 * index + 1] + b[5 * index + 3]) / 2),
      height: b[5 * index + 4],
    };
  }

  /**
   * Buildings (feature ids: OSM way id, or negative for buildings added on map3d) that another layer draws
   * instead (edit mode, review preview): left out of their tile's drawing and picking until unmasked. Kept by
   * id, so it holds across tile reloads (new edits), renumbering and rebases. Each `owner` (layer) has its own
   * set; a building is masked while any owner masks it.
   */
  setMasked(ids: Iterable<number>, owner = "default") {
    this.maskOwners.set(owner, new Set(ids));
    const next = new Set<number>();
    for (const set of this.maskOwners.values()) for (const id of set) next.add(id);
    if (next.size === this.masked.size && [...next].every((id) => this.masked.has(id))) return;
    this.masked = next;
    for (const t of this.tiles.building.values()) if (t.state === "ready" && t.object) this.applyMask(t);
    if (this.hover && this.hover.tile.maskSaved?.has(this.hover.index)) this.setHover(null);
    if (this.selected && this.tiles.building.get(this.selected.key)?.maskSaved?.has(this.selected.index)) this.setSelected(null);
    this.onChange();
  }

  isMasked(id: number) {
    return this.masked.has(id);
  }

  /** a masked building's triangles all collapse onto its first vertex (nothing drawn, no ray hits) */
  private applyMask(t: Tile) {
    const d = t.data as BuildingTileData;
    const want = new Set<number>();
    if (this.masked.size) {
      if (!t.idIndex) {
        t.idIndex = new Map();
        for (let i = 0; i < d.ids.length; i++) t.idIndex.set(d.ids[i], i);
      }
      for (const id of this.masked) {
        const i = t.idIndex.get(id);
        if (i !== undefined) want.add(i);
      }
    }
    const saved = t.maskSaved;
    if (!want.size && !saved?.size) return;
    const attr = (t.object as THREE.Mesh).geometry.getIndex()!;
    const index = attr.array as Uint16Array | Uint32Array; // the same array as d.index
    attr.clearUpdateRanges();
    let changed = false;
    if (saved) {
      for (const [i, orig] of saved) {
        if (want.has(i)) continue;
        index.set(orig, d.ranges[4 * i + 2]);
        attr.addUpdateRange(d.ranges[4 * i + 2], orig.length);
        saved.delete(i);
        changed = true;
      }
    }
    for (const i of want) {
      if (saved?.has(i)) continue;
      const start = d.ranges[4 * i + 2];
      const count = d.ranges[4 * i + 3];
      (t.maskSaved ??= new Map()).set(i, index.slice(start, start + count));
      index.fill(d.ranges[4 * i], start, start + count);
      attr.addUpdateRange(start, count);
      changed = true;
    }
    if (changed) attr.needsUpdate = true;
  }

  /** Where a ray meets the ground (terrain relief when on, else y = 0); null above the horizon. */
  pickGround(ray: THREE.Ray): THREE.Vector3 | null {
    if (ray.direction.y > -1e-6) return null;
    const p = new THREE.Vector3();
    let h = 0;
    for (let i = 0; i < 8; i++) {
      const t = (h - ray.origin.y) / ray.direction.y;
      if (t < 0) return null;
      ray.at(t, p);
      const g = this.groundHeightAt(p.x, p.z);
      if (g === null || Math.abs(g - h) < 0.05) break;
      h = g;
    }
    p.y = h;
    return p;
  }

  /** lat / lng box around a loaded building (with a small margin) */
  buildingLngLatBox(key: string, index: number) {
    const tile = this.tiles.building.get(key);
    if (!tile || tile.state !== "ready") return null;
    const b = (tile.data as BuildingTileData).bounds;
    const sw = fromScene(this.origin, b[5 * index] - 2, b[5 * index + 3] + 2);
    const ne = fromScene(this.origin, b[5 * index + 2] + 2, b[5 * index + 1] - 2);
    return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
  }

  /** a loaded building by id (OSM way id, or negative for buildings added on map3d) */
  findBuilding(id: number): { key: string; index: number } | null {
    for (const t of this.tiles.building.values()) {
      if (t.state !== "ready") continue;
      const index = (t.data as BuildingTileData).ids.indexOf(id);
      if (index >= 0) return { key: t.key, index };
    }
    return null;
  }

  private retryDelay(id: string) {
    return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** ((this.failures.get(id) ?? 1) - 1));
  }

  private retryDue(id: string, failedAt: number | undefined, now: number) {
    return now - (failedAt ?? 0) >= this.retryDelay(id);
  }

  /**
   * Count a failure and make sure a frame runs when its retry is due: the view renders on demand, so without
   * this a tile that failed while nothing moved would stay missing until the next interaction.
   */
  private noteFailure(id: string) {
    this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
    this.wakeIn(this.retryDelay(id) + 50);
  }

  /** one timer, set to the earliest wake-up asked for */
  private wakeIn(ms: number) {
    const at = performance.now() + ms;
    if (this.retryTimer !== null) {
      if (this.retryAt <= at) return;
      clearTimeout(this.retryTimer);
    }
    this.retryAt = at;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.onChange();
    }, ms);
  }

  /** after each frame: wake up again when the next failed load in view is due for its retry */
  private scheduleRetries(now: number) {
    let next = Infinity;
    const due = (id: string, failedAt: number | undefined) => {
      if (failedAt !== undefined) next = Math.min(next, failedAt + this.retryDelay(id) - now);
    };
    for (const key of this.wanted.keys()) {
      for (const layer of ["building", "road"] as Layer[]) {
        const t = this.tiles[layer].get(key);
        if (t?.state === "error") due(`${layer}:${key}`, t.failedAt);
        else if (t?.terrainState === "error") due(`terrain:${layer}:${key}`, t.terrainFailedAt);
      }
    }
    for (const key of this.groundWanted) {
      const gKey = `${this.terrain ? "t" : "f"}:${key}`;
      const g = this.ground.get(gKey);
      if (g?.state === "error") due(`ground:${gKey}`, g.failedAt);
      const m = this.maps.get(key);
      if (m?.state === "error") due(`map:${key}`, m.failedAt);
    }
    if (next < Infinity) this.wakeIn(Math.max(50, next + 50));
  }

  retryFailed() {
    this.failures.clear();
    for (const map of Object.values(this.tiles)) for (const t of map.values()) if (t.terrainState === "error") t.terrainState = undefined;
    for (const map of Object.values(this.tiles)) for (const t of map.values()) if (t.state === "error") map.delete(t.key);
    for (const g of this.ground.values()) if (g.state === "error") this.ground.delete(g.key);
    this.onChange();
  }
}
