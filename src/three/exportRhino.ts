import * as THREE from 'three';
import type { RhinoModule, GeometryBase } from 'rhino3dm';
import { buildingDimensions, vectorLayers, type Feature, type LayerName } from '../data/layers.ts';
import { collectSublayers, featureSublayer, type SublayerVisibility } from '../data/sublayers.ts';
import { terrainHeight, type Terrain } from '../data/terrain.ts';
import { buildFeatureGeometries, featureColor } from './geometry.ts';
import { palette, sceneColors } from './palette.ts';
import { projection } from './batches.ts';
import { buildTerrainGeometry } from './terrainGeometry.ts';

export type RhinoExportInput = {
  features: Feature[]; points: {lat:number;lng:number}[]; location: string;
  layers: Record<LayerName,boolean>; sublayers: SublayerVisibility; terrain: Terrain | null;
  layerStatus: Record<string,string>; incomplete: boolean;
};
export type RhinoExportProgress = {completed:number;total:number;stage:'geometry'|'writing'};
const release = (value: unknown) => (value as {delete:()=>void}).delete();
const cleanName = (value:string) => Array.from(value).filter(char=>char.charCodeAt(0)>=32 && char.charCodeAt(0)!==127).join('').replace(/[<>:="/\\|?*]/g,' ').replace(/\s+/g,' ').trim().slice(0,160) || 'Unnamed';
const rgba = (value:string) => { const color = new THREE.Color(value); return {...color.getRGB({r:0,g:0,b:0},THREE.SRGBColorSpace),a:255}; };
const rgb = (value:string) => {const color=rgba(value);return {r:Math.round(color.r*255),g:Math.round(color.g*255),b:Math.round(color.b*255),a:255};};
const sublayerColor=(feature:Feature)=>{
  if(feature.layer==='Land use') return featureColor(feature);
  let hash=0;for(const char of featureSublayer(feature).id) hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;
  return `#${new THREE.Color(palette[feature.layer]).offsetHSL(((hash%7)-3)*.006,((hash%5)-2)*.015,((hash%5)-2)*.012).getHexString()}`;
};

/** Native meshes and editable polyline curves; local metres, X east / Y north / Z up. */
export function exportRhino(rhino:RhinoModule, input:RhinoExportInput, onProgress:(progress:RhinoExportProgress)=>void=()=>{}) {
  const {features,points,layers,sublayers,terrain}=input;
  if (!features.length && !terrain) throw new Error('No loaded geometry to export.');
  const origin={lat:points.reduce((sum,p)=>sum+p.lat,0)/points.length,lng:points.reduce((sum,p)=>sum+p.lng,0)/points.length};
  if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) throw new Error('A valid boundary is required for export.');
  const project=projection(origin), activeTerrain=layers.Terrain?terrain:null;
  const file=new rhino.File3dm();
  const materials=new Map<string,number>();
  let objectCount=0;
  const material=(color:string)=>{
    const key=new THREE.Color(color).getHexString();
    if(materials.has(key)) return materials.get(key)!;
    const value=new rhino.Material();
    try {
      value.name=`Map3d #${key}`;
      // The JS binding takes RGBA; the upstream declaration incorrectly says number[].
      value.diffuseColor=rgb(color) as unknown as number[];
      const index=file.materials().count;file.materials().add(value);materials.set(key,index);return index;
    } finally {release(value);}
  };
  const addLayer=(name:string,color:string,visible:boolean,parentId?:string)=>{
    const layer=new rhino.Layer();
    try {
      layer.name=cleanName(name);layer.color=rgb(color);layer.visible=visible;layer.expanded=!parentId;
      layer.renderMaterialIndex=material(color);
      if(parentId) layer.parentLayerId=parentId;
      const index=file.layers().add(layer);
      if(index<0) throw new Error(`Could not create Rhino layer ${name}.`);
      const stored=file.layers().get(index), id=stored.id;release(stored);
      return {index,id};
    } finally {release(layer);}
  };
  const addMesh=(geometry:THREE.BufferGeometry,attributes:InstanceType<RhinoModule['ObjectAttributes']>)=>{
    const position=geometry.getAttribute('position');
    // The factory always rotates Three's Y-up input into Rhino's Z-up. Our
    // export geometry is already Z-up, so encode its inverse rotation first.
    const positions:number[]=[];for(let i=0;i<position.count;i++) positions.push(position.getX(i),position.getZ(i),-position.getY(i));
    // Always supply indices: rhino3dm's non-indexed JSON path creates invalid faces.
    const data={attributes:{position:{itemSize:3,type:'Float32Array',array:positions}},index:{type:'Uint32Array',array:geometry.index?Array.from(geometry.index.array):Array.from({length:position.count},(_,i)=>i)}};
    const mesh=rhino.Mesh.createFromThreejsJSON({data});
    if(!mesh) throw new Error(`Could not convert ${attributes.name}.`);
    // Simplified roofs can contain zero-area eave triangles; Rhino requires them removed.
    try {mesh.faces().cullDegenerateFaces();mesh.compact();mesh.normals().computeNormals();addObject(mesh,attributes);} finally {release(mesh);}
  };
  const addObject=(geometry:GeometryBase,attributes:InstanceType<RhinoModule['ObjectAttributes']>)=>{
    if(!geometry.isValid) throw new Error(`Invalid geometry in ${attributes.name}.`);
    const id=file.objects().add(geometry,attributes);
    if(!id || /^0{8}-/.test(id)) throw new Error(`Could not save ${attributes.name}.`);
    objectCount++;
  };
  try {
    file.applicationName='Map3d';file.applicationUrl='https://github.com/elenichas/map3d';
    file.applicationDetails='Layered map geometry export. Based on cartesiancs/map3d.';
    const settings=file.settings();settings.modelUnitSystem=rhino.UnitSystem.Meters;settings.modelAbsoluteTolerance=.001;
    const anchor=settings.earthAnchorPoint;
    anchor.earthBasepointLatitude=origin.lat;anchor.earthBasepointLongitude=origin.lng;anchor.earthBasepointElevation=activeTerrain?.baseline || 0;
    anchor.modelBasePoint=[0,0,0];anchor.modelNorth=[0,1,0];anchor.modelEast=[1,0,0];anchor.name=input.location;settings.earthAnchorPoint=anchor;
    file.strings().set('map3d:source','© OpenStreetMap contributors · https://www.openstreetmap.org/copyright · ODbL https://opendatacommons.org/licenses/odbl/1-0/');
    file.strings().set('map3d:accuracy','Data may be missing, outdated, or incorrect. Geometry and measurements may be estimated or simplified. Use this app and its exports at your own risk.');
    file.strings().set('map3d:coordinates',JSON.stringify({units:'metres',axes:'X east, Y north, Z up',origin,terrainBaseline:activeTerrain?.baseline || 0,projection:'Local equirectangular approximation; not a survey coordinate system'}));
    file.strings().set('map3d:boundary',JSON.stringify(points));
    file.strings().set('map3d:layerStatus',JSON.stringify(input.layerStatus));
    file.strings().set('map3d:snapshot',JSON.stringify({location:input.location,exportedAt:new Date().toISOString(),incomplete:input.incomplete,features:features.length,includesHiddenLayers:true}));
    const root=addLayer('Map3d',palette.Buildings,true);
    const sublayerIndices=new Map<string,number>();
    const examples=new Map<string,Feature>();for(const feature of features) {const id=featureSublayer(feature).id;if(!examples.has(id)) examples.set(id,feature);}
    const groups=collectSublayers(features);
    for(const name of vectorLayers) {
      if(!groups[name].length) continue;
      const parent=addLayer(name,palette[name],layers[name],root.id);
      const usedNames=new Set<string>();
      for(const type of groups[name]) {
        // Unknown tags can share a readable label. Retain distinct, uniquely named Rhino layers.
        let label=cleanName(type.label);if(usedNames.has(label.toLowerCase())) label=cleanName(`${type.label} (${type.id.split('|')[1]})`);
        let suffix=2;const base=label;while(usedNames.has(label.toLowerCase())) label=`${base} ${suffix++}`;
        usedNames.add(label.toLowerCase());
        const example=examples.get(type.id)!;
        const child=addLayer(label,sublayerColor(example),sublayers[type.id]!==false,parent.id);
        sublayerIndices.set(type.id,child.index);
      }
    }
    const total=features.length+(terrain?1:0);
    const sourceId=(feature:Feature)=>`${feature.type || feature.key.split('/')[0]}/${feature.id ?? feature.key.split('/')[1]}`;
    const sourceKey=(feature:Feature)=>`${feature.layer}|${sourceId(feature)}`;
    const featureGroups=new Map<string,number>(), pieceCounts=new Map<string,number>(), pieceNumbers=new Map<string,number>();
    for(const feature of features) {const key=sourceKey(feature);pieceCounts.set(key,(pieceCounts.get(key)||0)+1);}
    onProgress({completed:0,total,stage:'geometry'});
    features.forEach((feature,index)=>{
      const subtype=featureSublayer(feature);
      const id=sourceId(feature), key=sourceKey(feature);
      const baseLabel=`${cleanName(feature.tags.name || subtype.label)} [${id}]`;
      const piece=(pieceNumbers.get(key)||0)+1;pieceNumbers.set(key,piece);
      const label=`${baseLabel}${pieceCounts.get(key)!>1?` · Piece ${piece}`:''}`;
      let groupIndex=featureGroups.get(key);
      if(groupIndex===undefined) {
        const group=new rhino.Group();group.name=cleanName(`${feature.layer} · ${baseLabel}`);
        groupIndex=file.groups().count;file.groups().add(group);release(group);featureGroups.set(key,groupIndex);
      }
      const attributes=(part:string,colorOverride?:string)=>{
        const attr=new rhino.ObjectAttributes();attr.name=`${label} · ${part}`;attr.layerIndex=sublayerIndices.get(subtype.id)!;attr.addToGroup(groupIndex);
        attr.colorSource=rhino.ObjectColorSource.ColorFromLayer;attr.materialSource=rhino.ObjectMaterialSource.MaterialFromLayer;
        if(colorOverride) {attr.colorSource=rhino.ObjectColorSource.ColorFromObject;attr.objectColor=rgb(colorOverride);attr.materialSource=rhino.ObjectMaterialSource.MaterialFromObject;attr.materialIndex=material(colorOverride);}
        attr.url=`https://www.openstreetmap.org/${id}`;
        attr.setUserString('OSM ID',id);attr.setUserString('Map3d feature',feature.key);attr.setUserString('Layer',feature.layer);attr.setUserString('Sublayer',subtype.label);attr.setUserString('Part',part);
        for(const [key,value] of Object.entries(feature.tags)) attr.setUserString(`OSM:${key}`,value);
        if(feature.layer==='Buildings') attr.setUserString('Height basis',buildingDimensions(feature.tags).estimated?feature.tags['building:levels']?'Estimated at 3 m per level':'Estimated 10 m':'Mapped height');
        return attr;
      };
      const center=feature.geometry.reduce((p,v)=>({lat:p.lat+v.lat/feature.geometry.length,lon:p.lon+v.lon/feature.geometry.length}),{lat:0,lon:0});
      const ground=terrainHeight(activeTerrain,center), xy=project(center);
      const saveMesh=(geometry:THREE.BufferGeometry,part:string,color?:string)=>{
        const attr=attributes(part,color);
        try {addMesh(geometry,attr);} finally {geometry.dispose();release(attr);}
      };
      if(feature.kind==='point') {
        const tree=feature.tags.natural==='tree';
        const stem=tree?new THREE.CylinderGeometry(.35,.5,4,6):new THREE.CylinderGeometry(.4,.4,4,6);
        stem.translate(xy.x,ground+2,-xy.y).rotateX(Math.PI/2);
        saveMesh(stem,tree?'Trunk':'Stem',tree?sceneColors.trunk:undefined);
        const marker=tree?new THREE.IcosahedronGeometry(3.5,0):new THREE.SphereGeometry(2.5,8,6);
        marker.translate(xy.x,ground+(tree?6:5),-xy.y).rotateX(Math.PI/2);
        saveMesh(marker,tree?'Crown':'Marker');
      } else {
        const geometries=buildFeatureGeometries(feature,project,activeTerrain);
        try {
          geometries.forEach((geometry,partIndex)=>{
            if(feature.kind==='line') {
              const positions=geometry.getAttribute('position'), vertices=Array.from({length:positions.count},(_,i)=>[positions.getX(i),-positions.getZ(i),positions.getY(i)]);
              const curve=new rhino.PolylineCurve(vertices), attr=attributes('Path');
              try {addObject(curve,attr);} finally {release(curve);release(attr);}
            } else {
              const building=feature.layer==='Buildings', dimensions=buildingDimensions(feature.tags);
              if(building) geometry.translate(0,0,ground+dimensions.base+.2+(partIndex?dimensions.bodyHeight:0));
              const attr=attributes(building?partIndex?'Roof':'Building':'Surface',partIndex?featureColor(feature,true):building && feature.tags['building:colour']?featureColor(feature):undefined);
              try {addMesh(geometry,attr);} finally {release(attr);}
            }
          });
        } finally {geometries.forEach(g=>g.dispose());}
      }
      if((index+1)%25===0 || index===features.length-1) onProgress({completed:index+1,total,stage:'geometry'});
    });
    if(terrain) {
      const parent=addLayer('Terrain',sceneColors.terrain,layers.Terrain,root.id);
      const child=addLayer('Elevation mesh',sceneColors.terrain,true,parent.id);
      const geometry=buildTerrainGeometry(terrain,project).rotateX(Math.PI/2), attr=new rhino.ObjectAttributes();
      attr.name='Terrain · sampled elevation';attr.layerIndex=child.index;attr.colorSource=rhino.ObjectColorSource.ColorFromLayer;attr.materialSource=rhino.ObjectMaterialSource.MaterialFromLayer;
      attr.setUserString('Source','Mapzen Terrarium / AWS elevation-tiles-prod');attr.setUserString('Elevation baseline (m)',String(terrain.baseline));
      attr.setUserString('Attribution','https://github.com/tilezen/joerd/blob/master/docs/attribution.md');
      try {addMesh(geometry,attr);} finally {geometry.dispose();release(attr);}
      file.strings().set('map3d:terrainAttribution','https://github.com/tilezen/joerd/blob/master/docs/attribution.md');
    }
    onProgress({completed:total,total,stage:'writing'});
    const options=new rhino.File3dmWriteOptions();options.version=7;options.saveUserData=true;
    try {
      const bytes=file.toByteArrayOptions(options);
      if(!bytes?.length) throw new Error('Rhino file could not be written.');
      return {bytes,objectCount,featureCount:features.length,layerCount:file.layers().count,incomplete:input.incomplete};
    } finally {release(options);}
  } finally {file.destroy();release(file);}
}
