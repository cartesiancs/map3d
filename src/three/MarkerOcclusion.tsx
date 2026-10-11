import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export type MapMarker = { element: HTMLButtonElement | null };

/** Check on every rendered frame, including when new layers arrive with a still camera. */
export function MarkerOcclusion() {
  const scratch = useMemo(() => ({ raycaster: new THREE.Raycaster(), position: new THREE.Vector3(), screen: new THREE.Vector3(), pointer: new THREE.Vector2() }), []);
  useFrame(({ scene, camera }) => {
    const markers: THREE.Object3D[] = [], solids: THREE.Object3D[] = [];
    scene.traverseVisible(object => {
      if (object.userData.mapMarker?.element) markers.push(object);
      if ((object as THREE.Mesh).isMesh && (object.userData.exportToGLB || object.userData.mapBatch)) solids.push(object);
    });
    if (!markers.length) return;
    scene.updateMatrixWorld(); camera.updateMatrixWorld();
    const { raycaster, position, screen, pointer } = scratch;
    for (const marker of markers) {
      marker.getWorldPosition(position);
      screen.copy(position).project(camera); pointer.set(screen.x, screen.y);
      raycaster.setFromCamera(pointer, camera);
      raycaster.near = camera.near;
      raycaster.far = position.distanceTo(raycaster.ray.origin) - .05;
      const hidden = screen.z < -1 || screen.z > 1 || raycaster.intersectObjects(solids, false).length > 0;
      // Hide the interactive DOM target as well as its icon. It must not cover a roof.
      (marker.userData.mapMarker as MapMarker).element!.style.display = hidden ? 'none' : '';
    }
  });
  return null;
}
