import * as THREE from 'three';

export type ProjectionMode = 'perspective' | 'isometric';
export type ViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';
export type ModelPoint = [number, number, number];
export const viewDirections: Record<ViewDirection, ModelPoint> = {
  top: [0,1,0], bottom: [0,-1,0], front: [0,0,1], back: [0,0,-1], left: [-1,0,0], right: [1,0,0], iso: [1,1,1],
};
export function visibleHeight(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, target: THREE.Vector3) {
  if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom;
  const depth = target.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
  return 2 * Math.max(camera.near, depth) * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
}
/** A 1/2/5 metric scale that fits the requested CSS-pixel width. */
export function metricScale(metresPerPixel: number, maxPixels = 120) {
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return null;
  const max = metresPerPixel * maxPixels, power = 10 ** Math.floor(Math.log10(max));
  const metres = [5,2,1].find(step => step * power <= max)! * power;
  return { metres, pixels: metres / metresPerPixel };
}
export function formatDistance(metres: number) {
  if (metres >= 1000) return `${Number((metres / 1000).toFixed(2))} km`;
  return `${Number(metres.toFixed(metres < 10 ? 2 : 1))} m`;
}
export function measureDistance(a: ModelPoint, b: ModelPoint) {
  return { length: Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]), horizontal: Math.hypot(b[0]-a[0],b[2]-a[2]), height: b[1]-a[1] };
}
/** Only displayed model geometry is eligible; overlays never become endpoints. */
export function pickModelPoint(scene: THREE.Scene, raycaster: THREE.Raycaster): ModelPoint | null {
  scene.updateMatrixWorld(true);
  const objects: THREE.Object3D[] = [];
  scene.traverseVisible(object => {
    if ((object instanceof THREE.Mesh || object instanceof THREE.Line) && (object.userData.exportToGLB || object.userData.mapBatch)) objects.push(object);
  });
  const hit = raycaster.intersectObjects(objects, false)[0];
  if (hit) return hit.point.toArray();
  const ground = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0), new THREE.Vector3());
  return ground && ground.distanceTo(raycaster.ray.origin) <= raycaster.far ? ground.toArray() : null;
}
