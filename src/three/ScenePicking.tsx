import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Feature } from '../data/layers';
import type { MeasurementInput } from './Measurements';
import { featureForHit, filterSceneHits } from './picking';
import { visibleHeight } from './viewerMath';

/** Pick the current geometry on release. Streaming can replace a batch between
 * pointer-down and click, invalidating R3F's object-identity click gate. */
export function ScenePicking({ onSelect, interaction }: {onSelect: (feature: Feature | null) => void; interaction: React.MutableRefObject<MeasurementInput>}) {
  const {gl, get} = useThree();
  const callback = useRef(onSelect); callback.current = onSelect;
  useEffect(() => {
    const canvas = gl.domElement, raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let down: {x: number; y: number; id: number} | null = null;
    const begin = (event: PointerEvent) => { down = !interaction.current.active && event.button === 0 && event.isPrimary ? {x: event.clientX, y: event.clientY, id: event.pointerId} : null; };
    const move = (event: PointerEvent) => { if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 5) down = null; };
    const cancel = () => { down = null; };
    const end = (event: PointerEvent) => {
      const start = down; down = null;
      if (!start || interaction.current.active || event.pointerId !== start.id || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) return;
      const {camera, scene, size, controls} = get(), bounds = canvas.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
      camera.updateMatrixWorld(); scene.updateMatrixWorld();
      raycaster.near = camera.near; raycaster.far = camera.far;
      // Three's default is one world metre: too tiny when zoomed out, too
      // generous up close. Match the rendered line's screen-space hit target.
      const target = (controls as unknown as {target?: THREE.Vector3})?.target || new THREE.Vector3();
      raycaster.params.Line.threshold = Math.max(.01, visibleHeight(camera, target) / size.height * 3);
      raycaster.setFromCamera(pointer, camera);
      const objects: THREE.Object3D[] = [];
      scene.traverseVisible(object => { if (object.userData.mapBatch || object.userData.mapFeature) objects.push(object); });
      const hits = filterSceneHits(raycaster.intersectObjects(objects, false), {camera, pointer, size});
      callback.current(hits.map(featureForHit).find(Boolean) || null);
    };
    canvas.addEventListener('pointerdown', begin, true); canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', end, true); canvas.addEventListener('pointercancel', cancel); canvas.addEventListener('pointerleave', cancel);
    return () => {
      canvas.removeEventListener('pointerdown', begin, true); canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', end, true); canvas.removeEventListener('pointercancel', cancel); canvas.removeEventListener('pointerleave', cancel);
    };
  }, [gl, get, interaction]);
  return null;
}
