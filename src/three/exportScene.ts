import * as THREE from 'three';
import type { BatchMetadata } from './BatchedFeatures';
/** Reconstruct separate named objects only for downloads; the live scene stays batched. */
export function collectExportScene(scene: THREE.Scene) {
  const root = new THREE.Group(), temporary = new Set<THREE.BufferGeometry>();
  scene.updateMatrixWorld(true);
  scene.traverse(child => {
    const metadata = child.userData.mapBatch as BatchMetadata | undefined;
    if (metadata) {
      const { batch, features } = metadata;
      if (child instanceof THREE.InstancedMesh) {
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < child.count; i++) {
          child.getMatrixAt(i, matrix);
          const mesh = new THREE.Mesh(child.geometry, child.material);
          mesh.name = `${features[batch.indices![i]].key}/${batch.form}`;
          mesh.applyMatrix4(matrix.premultiply(child.matrixWorld)); root.add(mesh);
        }
      } else if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        for (const range of batch.ranges) {
          const geometry = new THREE.BufferGeometry();
          for (const name of ['position', 'normal', 'color']) {
            const attribute = child.geometry.getAttribute(name) as THREE.BufferAttribute;
            if (attribute) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.array.slice(range.start * attribute.itemSize, range.end * attribute.itemSize), attribute.itemSize, attribute.normalized));
          }
          const object = batch.kind === 'line' ? new THREE.LineSegments(geometry, child.material) : new THREE.Mesh(geometry, child.material);
          object.name = range.name; object.applyMatrix4(child.matrixWorld); root.add(object); temporary.add(geometry);
        }
      }
    } else if (child.userData.exportToGLB) {
      const copy = child.clone(); copy.applyMatrix4(child.parent?.matrixWorld || new THREE.Matrix4()); root.add(copy);
    }
  });
  root.updateMatrixWorld(true);
  return { root, dispose: () => temporary.forEach(geometry => geometry.dispose()) };
}
