import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { type ThreeEvent } from '@react-three/fiber';
import { vectorLayers, type Feature, type LayerName, type VectorLayer } from '../data/layers';
import type { Terrain } from '../data/terrain';
import { featureAt, projection, type Batch, type Origin } from './batches';
import { FeatureGeometry } from './FeatureGeometry';
type Prepared = { batches: Batch[]; features: Feature[] };
export type BatchMetadata = { batch: Batch; features: Feature[] };
function setBounds(object: THREE.BufferGeometry | THREE.InstancedMesh, bounds: number[]) {
  object.boundingBox = new THREE.Box3(new THREE.Vector3(...bounds.slice(0,3)), new THREE.Vector3(...bounds.slice(3,6)));
  object.boundingSphere = object.boundingBox.getBoundingSphere(new THREE.Sphere());
}
function Chunk({ batch, features, onSelect }: BatchMetadata & { onSelect: (feature: Feature) => void }) {
  const object = useMemo(() => {
    let object: THREE.Mesh | THREE.LineSegments | THREE.InstancedMesh;
    if (batch.kind === 'instances') {
      const shape = batch.form === 'trunk' ? new THREE.CylinderGeometry(.35,.5,4,6) : batch.form === 'crown' ? new THREE.IcosahedronGeometry(3.5,0) : batch.form === 'stem' ? new THREE.CylinderGeometry(.4,.4,4,6) : new THREE.SphereGeometry(2.5,8,6);
      const material = new THREE.MeshStandardMaterial({ color: batch.color, roughness: .85 });
      const mesh = new THREE.InstancedMesh(shape, material, batch.indices!.length);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(batch.matrices!, 16);
      setBounds(mesh, batch.bounds); object = mesh;
    } else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(batch.positions!, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(batch.colors!, 3, true));
      if (batch.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(batch.normals, 3));
      setBounds(geometry, batch.bounds);
      object = batch.kind === 'line' ? new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true })) : new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85, side: THREE.DoubleSide }));
    }
    object.name = batch.key; object.userData.mapBatch = { batch, features } satisfies BatchMetadata;
    return object;
  }, [batch, features]);
  useEffect(() => () => { object.geometry.dispose(); (object.material as THREE.Material).dispose(); if (object instanceof THREE.InstancedMesh) object.dispose(); }, [object]);
  const pick = (event: ThreeEvent<MouseEvent>) => {
    const index = batch.kind === 'instances' ? batch.indices?.[event.instanceId!] : featureAt(batch.ranges, batch.kind === 'line' ? event.index! : event.faceIndex! * 3);
    if (index !== undefined && features[index]) { event.stopPropagation(); onSelect(features[index]); }
  };
  return <primitive object={object} onClick={pick}/>;
}
export function BatchedFeatures({ features, origin, terrain, layers, selected, onSelect, onPreparing, onError }: { features: Feature[]; origin: Origin; terrain: Terrain | null; layers: Record<LayerName, boolean>; selected: Feature | null; onSelect: (feature: Feature) => void; onPreparing?: (count: number) => void; onError: (message: string) => void }) {
  const [prepared, setPrepared] = useState<Partial<Record<VectorLayer, Prepared>>>({});
  const [pending, setPending] = useState(() => new Set(features.filter(feature => layers[feature.layer]).map(feature => feature.layer)).size);
  const worker = useRef<Worker | null>(null), serial = useRef(0);
  const inputs = useRef(new Map<VectorLayer, Feature[]>());
  const jobs = useRef(new Map<VectorLayer, { id: number; features: Feature[] }>());
  const errorCallback = useRef(onError), progressCallback = useRef(onPreparing);
  errorCallback.current = onError; progressCallback.current = onPreparing;
  useEffect(() => {
    inputs.current.clear(); jobs.current.clear();
    const instance = new Worker(new URL('./scene.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<{ id: number; layer: VectorLayer; batches: Batch[]; error?: string }>) => {
      const job = jobs.current.get(data.layer);
      if (!job || job.id !== data.id) return;
      jobs.current.delete(data.layer); setPending(jobs.current.size);
      if (data.error) errorCallback.current(`Could not prepare ${data.layer}: ${data.error}`);
      else setPrepared(previous => ({ ...previous, [data.layer]: { batches: data.batches, features: job.features } }));
    };
    instance.onerror = () => { jobs.current.clear(); setPending(0); errorCallback.current('The geometry worker could not start. Reload the viewer to retry.'); };
    return () => { instance.terminate(); worker.current = null; };
  }, [origin, terrain]);
  useEffect(() => {
    if (!worker.current) return;
    const grouped = new Map<VectorLayer, Feature[]>();
    for (const feature of features) { let group = grouped.get(feature.layer); if (!group) { group = []; grouped.set(feature.layer, group); } group.push(feature); }
    for (const layer of vectorLayers) {
      if (!layers[layer]) continue;
      const next = grouped.get(layer) || [], previous = inputs.current.get(layer);
      if (previous && previous.length === next.length && previous.every((feature, index) => feature === next[index])) continue;
      inputs.current.set(layer, next);
      if (!next.length) { jobs.current.delete(layer); setPrepared(value => ({ ...value, [layer]: { batches: [], features: [] } })); continue; }
      const id = ++serial.current;
      jobs.current.set(layer, { id, features: next });
      worker.current.postMessage({ id, layer, features: next, origin, terrain });
    }
    setPending(jobs.current.size);
  }, [features, origin, terrain, layers]);
  useEffect(() => { progressCallback.current?.(pending); return () => { progressCallback.current?.(0); }; }, [pending]);
  const project = useMemo(() => projection(origin), [origin]);
  const selectedVisible = selected && layers[selected.layer] ? selected : null;
  return <group name="map-features" userData={{ preparing: pending, featureCount: Object.values(prepared).reduce((count, layer) => count + (layers[layer!.features[0]?.layer] ? layer!.features.length : 0), 0) }}>
    {vectorLayers.filter(layer => layers[layer]).flatMap(layer => (prepared[layer]?.batches || []).map(batch => <Chunk key={batch.key} batch={batch} features={prepared[layer]!.features} onSelect={onSelect}/>))}
    {selectedVisible && <FeatureGeometry feature={selectedVisible} project={project} terrain={terrain} selected onSelect={onSelect} exportable={false}/>}

  </group>;
}
