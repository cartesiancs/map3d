import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { Ruler, Trash2, X } from 'lucide-react';
import { sceneColors } from './palette';
import { ViewerNavigation, type ViewRequest } from './ViewerNavigation';
import { Measurements, type Measurement, type MeasurementInput } from './Measurements';
import { formatDistance, measureDistance, type ModelPoint, type ProjectionMode, type ViewDirection } from './viewerMath';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { downloadFile } from '../data/download';
export type ExportRequest = { id: number; format: 'glb' | 'obj' };
import type { Point } from '../components/map/SelectMap';
import { FeatureGeometry } from './FeatureGeometry';
import { BatchedFeatures } from './BatchedFeatures';
import { collectExportScene } from './exportScene';
import { compareSurfaces, isSurface, surfaceOrder } from './surfaces';
import { SelectionHighlight } from './SelectionHighlight';
import type { Feature, LayerName } from '../data/layers';
import { terrainHeight, type Terrain } from '../data/terrain';
import { lightingPresets, type SceneLighting } from './lighting';
import { isFeatureVisible, type SublayerVisibility } from '../data/sublayers';
type Props = { features: Feature[]; points: Point[]; layers: Record<LayerName, boolean>; terrain: Terrain | null; selected: Feature | null; onSelect: (f: Feature | null) => void; reset: number; exportRequest: ExportRequest; onExport: (s: string) => void; onError: (s: string) => void; onPreparing?: (count: number) => void; children?: ReactNode; sceneLighting?: SceneLighting; sublayers?:SublayerVisibility };
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
  return <mesh geometry={geometry} userData={{ exportToGLB: true }}><meshStandardMaterial color={sceneColors.terrain} roughness={1} side={THREE.DoubleSide}/></mesh>;
}
function SceneExports({ exportRequest, onExport, onError, lastExport }: Pick<Props, 'exportRequest' | 'onExport' | 'onError'> & { lastExport: { current: number } }) {
  const { scene } = useThree();
  useEffect(() => {
    if (exportRequest.id === lastExport.current) return;
    lastExport.current = exportRequest.id;
    const { root, dispose } = collectExportScene(scene);
    try {
      if (exportRequest.format === 'obj') {
        downloadFile('scene.obj', new OBJExporter().parse(root), 'text/plain');
        dispose(); onExport('OBJ downloaded · visible geometry saved.');
      } else {
        new GLTFExporter().parse(root, result => {
          if (!(result instanceof ArrayBuffer)) { dispose(); onError('Export failed. Please retry.'); return; }
          downloadFile('scene.glb', result, 'model/gltf-binary');
          dispose(); onExport('GLB downloaded · visible layers saved.');
        }, () => { dispose(); onError('Could not export the scene. Please retry.'); }, { binary: true });
      }
    } catch {
      dispose(); onError('Could not export the scene. Please retry.');
    }
    // Only a new explicit export request triggers a download.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportRequest]);
  return null;
}
class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="viewer-error" role="alert">The 3D viewer could not start. Check that WebGL is enabled, or return to the 2D map.</div> : this.props.children; }
}
export function Space(props: Props) {
  const lastExport = useRef(props.exportRequest.id);
  const [projection,setProjection]=useState<ProjectionMode>('perspective');
  const [viewRequest,setViewRequest]=useState<ViewRequest>({id:0,direction:'iso'});
  const [measuring,setMeasuring]=useState(false);
  const [measurements,setMeasurements]=useState<Measurement[]>([]);
  const [measureStart,setMeasureStart]=useState<ModelPoint|null>(null);
  const [measurePreview,setMeasurePreview]=useState<ModelPoint|null>(null);
  const draft=useRef<ModelPoint|null>(null);
  const interaction=useRef<MeasurementInput>(null);
  const serial=useRef(0), scaleRef=useRef<HTMLDivElement>(null), cubeRef=useRef<HTMLDivElement>(null);
  const requestView=(direction:ViewDirection)=>setViewRequest(previous=>({id:previous.id+1,direction}));
  const cancelDraft=()=>{draft.current=null;setMeasureStart(null);setMeasurePreview(null);};
  const pickMeasurement=(point:ModelPoint)=>{
    if(!draft.current) {draft.current=point;setMeasureStart(point);setMeasurePreview(null);}
    else if(measureDistance(draft.current,point).length>.001) {
      const measurement={id:++serial.current,a:draft.current,b:point};
      setMeasurements(previous=>[...previous,measurement]);cancelDraft();
    }
  };
  // The DOM and Canvas have separate React roots. Keep input state synchronous
  // so rapid clicks do not wait for Canvas reconciliation.
  interaction.current={active:measuring,onPick:pickMeasurement,onPreview:point=>{if(draft.current) setMeasurePreview(point);}};
  useEffect(()=>{
    if(!measuring) return;
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape') return;
      if(draft.current) {draft.current=null;setMeasureStart(null);setMeasurePreview(null);} else setMeasuring(false);
    };
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[measuring,measureStart]);
  const clearMeasurements=()=>{setMeasurements([]);cancelDraft();};
  const { features, points, layers, selected, onSelect } = props;
  const terrain = layers.Terrain ? props.terrain : null;
  const lat = points.reduce((n,p) => n + p.lat, 0) / points.length;
  const lng = points.reduce((n,p) => n + p.lng, 0) / points.length;
  const project = useMemo(() => (p: Feature['geometry'][number]) => new THREE.Vector2((p.lon - lng) * 111320 * Math.cos(lat * Math.PI / 180), (p.lat - lat) * 111320), [lat, lng]);
  const distance = Math.max(150, terrain ? (Math.max(...terrain.elevations) - terrain.baseline) * 3 : 0, ...points.map(p => project({ lat: p.lat, lon: p.lng }).length() * 2));
  const visible = features.filter(f => isFeatureVisible(f,layers,props.sublayers)).sort((a,b) => isSurface(a) && isSurface(b) ? compareSurfaces(a,b) : Number(isSurface(b)) - Number(isSurface(a)));
  const origin = useMemo(() => ({ lat, lng }), [lat, lng]);
  const lighting = lightingPresets[props.sceneLighting || 'day'];
  return <ViewerBoundary><div className={`model-viewport${measuring ? ' measuring' : ''}`}><Canvas frameloop="demand" dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: 'high-performance' }} camera={{ fov: 45, near: .5, far: 100000 }} onPointerMissed={() => {if(!measuring) onSelect(null);}} fallback={<div className="viewer-error">Your browser does not support WebGL. Use the 2D map or another browser.</div>}><color attach="background" args={[lighting.background]}/><ambientLight intensity={lighting.ambient}/><hemisphereLight args={[lighting.sky,lighting.ground,lighting.hemisphere]}/><directionalLight name="scene-key-light" position={[300,600,200]} color={lighting.keyColor} intensity={lighting.key}/><directionalLight position={[-300,150,-200]} color={lighting.fillColor} intensity={lighting.fill}/>{props.sceneLighting==='night' && <fog attach="fog" args={[lighting.background,distance*2.8,distance*7]}/>}{features.length > 250 ? <BatchedFeatures sublayers={props.sublayers} features={features} origin={origin} terrain={terrain} layers={layers} selected={selected} onSelect={onSelect} onPreparing={props.onPreparing} onError={props.onError}/> : visible.map((f,index) => <FeatureGeometry surfaceStackOrder={surfaceOrder(f.layer) + index / (visible.length + 1)} key={f.key} feature={f} project={project} terrain={terrain} selected={selected?.key === f.key && f.kind === 'point'} onSelect={onSelect}/>)}{selected && selected.kind !== 'point' && isFeatureVisible(selected,layers,props.sublayers) && <SelectionHighlight feature={selected} project={project} terrain={terrain}/>} {props.children}{terrain && <TerrainMesh terrain={terrain} project={project}/>}<Grid infiniteGrid cellSize={25} sectionSize={100} fadeDistance={distance * 3} cellColor={lighting.grid} sectionColor={lighting.sections} position={[0,-.1,0]}/><SceneExports {...props} lastExport={lastExport}/>
    <ViewerNavigation projection={projection} request={viewRequest} reset={props.reset} distance={distance} scaleRef={scaleRef} cubeRef={cubeRef}/>
    <Measurements active={measuring} start={measureStart} preview={measurePreview} measurements={measurements} interaction={interaction}/>
    </Canvas>
    <div className="model-tools" role="toolbar" aria-label="Model navigation and measurement">
      <div className="segmented-control" role="group" aria-label="Camera projection">
        <button aria-pressed={projection==='perspective'} onClick={()=>setProjection('perspective')}>Perspective</button>
        <button aria-pressed={projection==='isometric'} onClick={()=>setProjection('isometric')}>Isometric</button>
      </div>
      <button className="measure-toggle" aria-label="Measure distance" aria-pressed={measuring} onClick={()=>{setMeasuring(value=>!value);cancelDraft();onSelect(null);}}><Ruler size={16}/>Measure</button>
    </div>
    {(measuring || measurements.length>0) && <div className="measurement-panel" role="region" aria-label="Measurements">
      <div className="measurement-heading"><strong>Measure distance</strong><button aria-label="Clear measurements" title="Clear measurements" disabled={!measurements.length && !measureStart} onClick={clearMeasurements}><Trash2 size={14}/></button>{measuring && <button aria-label="Exit measure tool" title="Exit measure tool" onClick={()=>{setMeasuring(false);cancelDraft();}}><X size={15}/></button>}</div>
      <p role="status">{measuring ? measureStart ? 'Choose the second point · Esc cancels' : 'Click a surface or ground to start' : 'Model distances · straight line'}</p>
      {measuring && <small>Drag to orbit · Right-drag to pan · Scroll to zoom</small>}
      {measurements.length>0 && <ol>{measurements.map(measurement=>{
        const metric=measureDistance(measurement.a,measurement.b);
        return <li key={measurement.id}><div><strong>{measurement.id}. {formatDistance(metric.length)}</strong><small>Horizontal {formatDistance(metric.horizontal)} · Height {formatDistance(Math.abs(metric.height))}</small></div><button aria-label={`Remove measurement ${measurement.id}`} onClick={()=>setMeasurements(previous=>previous.filter(item=>item.id!==measurement.id))}><X size={13}/></button></li>;
      })}</ol>}
    </div>}
    <div className="scale-legend" ref={scaleRef} role="img" aria-label={projection==='perspective'?'Approximate scale at camera focus depth':'Orthographic view scale'} title={projection==='perspective'?'Approximate at camera focus depth; perspective scale varies with depth':'Scale in the view plane; horizontal ground distances are foreshortened in tilted views'}>
      <div className="scale-labels"><span>0</span><span className="scale-distance">…</span></div><div className="scale-bar"/><small>{projection==='perspective'?'Approx. at focus depth':'View-plane scale'}</small>
    </div>
    <div className="orientation-gizmo" role="group" aria-label="View orientation">
      <div className="gizmo-stage"><div className="gizmo-cube" ref={cubeRef}>{(['front','back','top','bottom','left','right'] as const).map(face=><button key={face} className={`gizmo-face face-${face}`} aria-label={`${face[0].toUpperCase()+face.slice(1)} view`} title={`${face[0].toUpperCase()+face.slice(1)} view`} onClick={()=>requestView(face)}>{face}</button>)}</div></div>
      <select aria-label="View direction" value="" onChange={event=>{if(event.target.value) requestView(event.target.value as ViewDirection);}}><option value="" disabled>Choose view</option><option value="iso">Isometric angle</option><option value="top">Top · north up</option><option value="front">Front · from south</option><option value="back">Back · from north</option><option value="left">Left · from west</option><option value="right">Right · from east</option><option value="bottom">Bottom</option></select>
    </div>
    </div></ViewerBoundary>;
}
