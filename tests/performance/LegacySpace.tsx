import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { downloadFile } from '../../src/data/download';
export type ExportRequest = { id: number; format: 'glb' | 'obj' };
import type { Point } from '../../src/components/map/SelectMap';
import { FeatureGeometry } from './LegacyFeatureGeometry';
import type { Feature, LayerName } from '../../src/data/layers';
import { terrainHeight, type Terrain } from '../../src/data/terrain';
type Props = { features: Feature[]; points: Point[]; layers: Record<LayerName, boolean>; terrain: Terrain | null; selected: Feature | null; onSelect: (f: Feature | null) => void; reset: number; exportRequest: ExportRequest; onExport: (s: string) => void; onError: (s: string) => void; children?: ReactNode };
function TerrainMesh({ terrain, project }: { terrain: Terrain; project: (p: { lat: number; lon: number }) => THREE.Vector2 }) {
  const geometry = useMemo(() => {
    const { size, north, south, east, west } = terrain;
    const positions: number[] = [], indices: number[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = { lat: north + (south - north) * y / (size - 1), lon: west + (east - west) * x / (size - 1) }, v = project(p);
      positions.push(v.x, terrainHeight(terrain,p), -v.y);
      if (x < size - 1 && y < size - 1) { const i = y * size + x; indices.push(i, i+size, i+1, i+1, i+size, i+size+1); }
    }
    const result = new THREE.BufferGeometry(); result.setAttribute('position', new THREE.Float32BufferAttribute(positions,3)); result.setIndex(indices); result.computeVertexNormals(); return result;
  }, [terrain, project]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} userData={{ exportToGLB: true }}><meshStandardMaterial color="#bdcbb2" roughness={1} side={THREE.DoubleSide}/></mesh>;
}
function Scene({ reset, exportRequest, onExport, onError, distance, lastExport }: Pick<Props, 'reset' | 'exportRequest' | 'onExport' | 'onError'> & { distance: number; lastExport: { current: number } }) {
  const { camera, scene } = useThree();
  const controls = useRef<any>(null);
  useEffect(() => { camera.position.set(distance * .7, distance * .8, distance * .8); camera.lookAt(0, 0, 0); if (controls.current) { controls.current.target.set(0, 0, 0); controls.current.update(); } }, [camera, reset, distance]);
  useEffect(() => {
    if (exportRequest.id === lastExport.current) return;
    lastExport.current = exportRequest.id;
    const root = new THREE.Group();
    scene.updateMatrixWorld(true);
    scene.traverse(child => { if (child.userData.exportToGLB) { const copy = child.clone(); copy.applyMatrix4(child.parent?.matrixWorld || new THREE.Matrix4()); root.add(copy); } });
    root.updateMatrixWorld(true);
    try {
      if (exportRequest.format === 'obj') {
        downloadFile('scene.obj', new OBJExporter().parse(root), 'text/plain');
        onExport('OBJ downloaded · visible geometry saved.');
      } else {
        new GLTFExporter().parse(root, result => {
          if (!(result instanceof ArrayBuffer)) { onError('Export failed. Please retry.'); return; }
          downloadFile('scene.glb', result, 'model/gltf-binary');
          onExport('GLB downloaded · visible layers saved.');
        }, () => onError('Could not export the scene. Please retry.'), { binary: true });
      }
    } catch {
      onError('Could not export the scene. Please retry.');
    }
    // Only a new explicit export request triggers a download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportRequest]);
  return <OrbitControls ref={controls} makeDefault minDistance={10} maxDistance={distance * 5} maxPolarAngle={Math.PI / 2.05}/>;
}
class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="viewer-error" role="alert">The 3D viewer could not start. Check that WebGL is enabled, or return to the 2D map.</div> : this.props.children; }
}
export function Space(props: Props) {
  const lastExport = useRef(props.exportRequest.id);
  const { features, points, layers, selected, onSelect } = props;
  const terrain = layers.Terrain ? props.terrain : null;
  const lat = points.reduce((n,p) => n + p.lat, 0) / points.length;
  const lng = points.reduce((n,p) => n + p.lng, 0) / points.length;
  const project = useMemo(() => (p: Feature['geometry'][number]) => new THREE.Vector2((p.lon - lng) * 111320 * Math.cos(lat * Math.PI / 180), (p.lat - lat) * 111320), [lat, lng]);
  const distance = Math.max(150, terrain ? (Math.max(...terrain.elevations) - terrain.baseline) * 3 : 0, ...points.map(p => project({ lat: p.lat, lon: p.lng }).length() * 2));
  const visible = features.filter(f => layers[f.layer]);
  return <ViewerBoundary><Canvas frameloop="demand" camera={{ fov: 45, near: .5, far: 100000 }} onPointerMissed={() => onSelect(null)} fallback={<div className="viewer-error">Your browser does not support WebGL. Use the 2D map or another browser.</div>}><color attach="background" args={['#e9eee9']}/><ambientLight intensity={1.6}/><directionalLight position={[300, 600, 200]} intensity={2.3}/>{visible.map(f => <FeatureGeometry key={f.key} feature={f} project={project} terrain={terrain} selected={selected?.key === f.key} onSelect={onSelect}/>)}{terrain && <TerrainMesh terrain={terrain} project={project}/>}<Grid infiniteGrid cellSize={25} sectionSize={100} fadeDistance={distance * 3} cellColor="#c5d1c8" sectionColor="#aabcae" position={[0,-.1,0]}/>{props.children}<Scene {...props} distance={distance} lastExport={lastExport}/></Canvas></ViewerBoundary>;
}
