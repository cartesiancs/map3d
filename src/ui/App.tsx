import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, ArrowLeft, Search, Pentagon, RectangleHorizontal, Hand, ArrowUpRight, Layers, X, Download, RotateCcw, MapPin, LoaderCircle, PanelLeftClose, PanelLeftOpen, ChevronUp, ChevronDown, ChevronRight, FileJson, Sun, Moon, Sunrise, MoonStar } from 'lucide-react';
import { MapComponent, type Point, type DrawMode } from '../components/map/SelectMap';
import { Space, type ExportRequest } from '../three/Space';
import { downloadFile } from '../data/download';
import { groupForLayer, layerGroups, vectorLayers, initialLayers, buildingDimensions, type Feature, type LayerName } from '../data/layers';
import { loadTerrain, type Terrain } from '../data/terrain';
import { useSceneLayers } from '../hooks/useSceneLayers';
import { useWorkspaceRoute } from '../hooks/useWorkspaceRoute';
import { readPreference, savePreference, type Theme } from './preferences';
import type { SceneLighting } from '../three/lighting';
import { collectSublayers, featureSublayer, isFeatureVisible, type SublayerVisibility } from '../data/sublayers';
import { DataGuide } from './DataGuide';
import { useRhinoExport } from '../hooks/useRhinoExport';

type Place = { place_id: number; display_name: string; lat: string; lon: string };
const layerNames: LayerName[] = [...vectorLayers, 'Terrain'];
function App() {
  const [theme,setTheme]=useState<Theme>(()=>readPreference('map3d.theme',['light','dark'],window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
  const [sceneLighting,setSceneLighting]=useState<SceneLighting>(()=>readPreference('map3d.sceneLighting',['day','night'],'day'));
  useEffect(()=>{ document.documentElement.dataset.theme=theme; savePreference('map3d.theme',theme); },[theme]);
  useEffect(()=>{ savePreference('map3d.sceneLighting',sceneLighting); },[sceneLighting]);
  const [drawerMinimized, setDrawerMinimized] = useState(false);
  const [layersMinimized, setLayersMinimized] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const [mode, setMode] = useState<DrawMode>('pan');
  const [isDrawing, setIsDrawing] = useState(false);
  const { points, location, view, navigate, update: updateRoute } = useWorkspaceRoute();
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [target, setTarget] = useState<[number, number] | null>(null);
  const sceneLayers = useSceneLayers(points);
  const { features, loading, started: sceneStarted, start: startLayers, clear: clearLayers } = sceneLayers;
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const rhinoExport=useRhinoExport(setStatus,setError);
  const {cancel:cancelRhinoExport}=rhinoExport;
  useEffect(()=>{cancelRhinoExport();},[points,view,cancelRhinoExport]);
  const [selected, setSelected] = useState<Feature | null>(null);
  const [layers, setLayers] = useState<Record<LayerName, boolean>>(initialLayers);
  const [sublayers,setSublayers]=useState<SublayerVisibility>({});
  const [expandedLayers,setExpandedLayers]=useState<Partial<Record<LayerName,boolean>>>({});
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [terrainState, setTerrainState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [terrainError, setTerrainError] = useState('');
  const [terrainRetry, setTerrainRetry] = useState(0);
  const terrainRequest = useRef<AbortController | null>(null);
  const [reset, setReset] = useState(0);
  const [exportRequest, setExportRequest] = useState<ExportRequest>({ id: 0, format: 'glb' });
  const searchRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { searchRequest.current?.abort(); }, []);
  const updateBoundary = (p: Point[]) => { updateRoute({ points: p }); setIsDrawing(false); setStatus(p.length ? '' : 'Boundary cleared.'); setError(''); setMode('pan'); };
  const previousBoundary = useRef(points);
  useEffect(() => {
    const changed = previousBoundary.current !== points;
    previousBoundary.current = points;
    if (changed) {
      clearLayers(); terrainRequest.current?.abort(); setTerrain(null); setTerrainState('idle'); setTerrainError(''); setSelected(null);
    }
    if (view === '3d' && (changed || !sceneStarted)) {
      const priority = [...layerGroups].sort((a,b) => Number(b.layers.some(name => layers[name])) - Number(a.layers.some(name => layers[name])));
      startLayers(priority.map(group => group.id));
    }
  }, [points, view, sceneStarted, startLayers, clearLayers, layers]);
  useEffect(() => { setMode('pan'); setSelected(null); setDrawerMinimized(false); setStatus(''); setError(''); }, [view]);
  const search = async (e: React.FormEvent) => {
    e.preventDefault(); if (!query.trim()) return;
    searchRequest.current?.abort(); const controller = new AbortController(); searchRequest.current = controller;
    setSearching(true); setSearchError(''); setPlaces([]);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!r.ok) throw new Error('Location search is unavailable. Try again shortly.');
      const data = await r.json(); setPlaces(data); if (!data.length) setSearchError('No locations found. Try a city, address, or postcode.');
    } catch (e) { if (!controller.signal.aborted) setSearchError(e instanceof Error ? e.message : 'Search failed. Please retry.'); }
    finally { if (!controller.signal.aborted) setSearching(false); }
  };
  const generate = () => {
    navigate('3d');
  };
  useEffect(() => {
    if (!layers.Terrain || !sceneStarted || !points.length || terrain) return;
    const controller = new AbortController(); terrainRequest.current = controller;
    setTerrainState('loading'); setTerrainError('');
    const timeout = setTimeout(() => controller.abort('timeout'), 25000);
    loadTerrain(points, controller.signal).then(data => {
      if (!controller.signal.aborted) { setTerrain(data); setTerrainState('ready'); }
    }).catch(e => {
      if (!controller.signal.aborted || controller.signal.reason === 'timeout') {
        controller.abort(); setTerrainState('error');
        setTerrainError(controller.signal.reason === 'timeout' ? 'Elevation request timed out.' : e instanceof Error ? e.message : 'Elevation could not load.');
      }
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [layers.Terrain, sceneStarted, points, terrain, terrainRetry]);
  const layerCounts = useMemo(() => { const counts = Object.fromEntries(vectorLayers.map(name => [name, 0])); for (const feature of features) counts[feature.layer]++; return counts; }, [features]);
  const sublayerGroups=useMemo(()=>collectSublayers(features),[features]);
  const visibleCounts=useMemo(()=>Object.fromEntries(vectorLayers.map(name=>[name,layers[name]?sublayerGroups[name].reduce((sum,type)=>sum+(sublayers[type.id]!==false?type.count:0),0):0])),[sublayerGroups,layers,sublayers]);
  const toggleLayer=(name:LayerName,enabled:boolean)=>{
    setLayers(previous=>({...previous,[name]:enabled}));
    if(enabled && name!=='Terrain') setSublayers(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!id.startsWith(`${name}|`))));
    if(!enabled && selected?.layer===name) setSelected(null);
  };
  const toggleSublayer=(id:string,enabled:boolean)=>{
    setSublayers(previous=>({...previous,[id]:enabled}));
    if(!enabled && selected && featureSublayer(selected).id===id) setSelected(null);
  };
  const layerStatus = (name: typeof vectorLayers[number]) => {
    const state = sceneLayers.states[groupForLayer(name).id], count = layerCounts[name];
    const countLabel = `${count.toLocaleString()} ${count === 1 ? 'feature' : 'features'}${layers[name] && visibleCounts[name]<count?` · ${visibleCounts[name].toLocaleString()} visible`:''}`;
    if (state.status === 'queued') return count ? `${countLabel} · More data queued` : 'Queued';
    if (state.status === 'waiting') return count ? `${countLabel} · ${state.message}` : state.message || 'Retrying automatically…';
    if (state.status === 'loading') return count ? `${countLabel} · Loading more…` : state.message || 'Loading…';
    if (state.status === 'error') return count ? `${countLabel} · Incomplete` : 'Failed to load';
    if (state.status === 'cancelled') return count ? `${countLabel} · Loading stopped` : 'Not loaded · Stopped';
    return count ? countLabel : state.status === 'ready' ? 'No mapped data here' : 'Not loaded';
  };
  const failedCount = vectorLayers.filter(name => sceneLayers.states[groupForLayer(name).id].status === 'error').length;
  const stoppedCount = vectorLayers.filter(name => sceneLayers.states[groupForLayer(name).id].status === 'cancelled').length;
  const pendingCount = vectorLayers.filter(name => ['loading', 'queued', 'waiting'].includes(sceneLayers.states[groupForLayer(name).id].status)).length;
  const dataMessage = !sceneStarted ? 'Preparing scene…' : loading ? `${features.length ? `${features.length} ${features.length === 1 ? 'feature' : 'features'} loaded · ` : ''}${pendingCount} layers loading in the background${failedCount ? ` · ${failedCount} unavailable` : ''}` : failedCount ? `${features.length} ${features.length === 1 ? 'feature' : 'features'} loaded · ${failedCount} layers unavailable` : stoppedCount ? `${features.length} ${features.length === 1 ? 'feature' : 'features'} loaded · ${stoppedCount} layers stopped` : `Scene ready · ${features.length} features`;
  const sceneMessage = preparing ? `${loading ? dataMessage : `${features.length.toLocaleString()} features loaded`} · Preparing 3D geometry (${preparing} layers)` : dataMessage;
  const area = points.length ? Math.abs((Math.max(...points.map(p => p.lat)) - Math.min(...points.map(p => p.lat))) * (Math.max(...points.map(p => p.lng)) - Math.min(...points.map(p => p.lng))) * 12364 * Math.cos(points[0].lat * Math.PI / 180)) : 0;
  const returnToMap = () => navigate('map');
  const exportScene = (format: ExportRequest['format']) => {
    setStatus(''); setError('');
    setExportRequest(previous => ({ id: previous.id + 1, format }));
  };
  const downloadRawData = () => {
    try {
      const ring = points.map(p => [p.lng, p.lat]);
      if (ring.length) ring.push([...ring[0]]);
      const elements = [...new Map(layerGroups.flatMap(group => sceneLayers.sources[group.id] || []).map(element => [`${element.type || 'way'}/${element.id}`, element])).values()];
      const data = {
        version: 0.6,
        generator: 'map3d',
        attribution: '© OpenStreetMap contributors',
        elements,
        scene: {
          exportedAt: new Date().toISOString(), location,
          boundary: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
          batches: Object.fromEntries(layerGroups.map(group => [group.id, { ...sceneLayers.states[group.id], elementCount: sceneLayers.sources[group.id]?.length || 0 }])),
          visibleLayers: layerNames.filter(name => layers[name]),
          sublayers: vectorLayers.flatMap(name=>sublayerGroups[name].map(type=>({...type,parent:name,visible:layers[name] && sublayers[type.id]!==false}))),
          terrain: terrain ? { ...terrain, source: 'Mapzen Terrarium / AWS elevation-tiles-prod', attribution: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md' } : null,
        },
      };
      downloadFile('map-data.json', JSON.stringify(data, null, 2), 'application/json');
      setError(''); setStatus(`Raw data downloaded · ${elements.length.toLocaleString()} source elements.`);
    } catch { setError('Could not download the raw data. Please retry.'); }
  };
  const canExportScene = !preparing && (features.some(feature => isFeatureVisible(feature,layers,sublayers)) || !!(layers.Terrain && terrain));
  const downloadRhino=()=>rhinoExport.start({features,points,location,layers,sublayers,terrain,
    layerStatus:Object.fromEntries(layerNames.map(name=>[name,name==='Terrain'?terrainState:sceneLayers.states[groupForLayer(name).id].status])),
    incomplete:loading || failedCount>0 || stoppedCount>0 || terrainState==='loading' || terrainState==='error',
  });
  const loadControls = <>
    {loading && <button onClick={sceneLayers.cancel}>Stop loading layers</button>}
    {!loading && (failedCount > 0 || stoppedCount > 0) && <button onClick={sceneLayers.retryFailed}>Retry unavailable layers</button>}
  </>;
  return <div className={`workspace${view === '3d' ? ' viewer-mode' : drawerMinimized ? ' sidebar-collapsed' : ''}`}>
    <header className="app-header">
      <a className="brand" href="/map" onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); returnToMap(); } }} aria-label="Map3d home"><span><Box size={23}/></span>map3d</a>
      <div className="top-toolbar" role="toolbar" aria-label="Display and export tools">
        <div className="toolbar-control theme-control" role="group" aria-label="Interface theme">
          <span className="toolbar-label">Appearance</span>
          <div className="segmented-control">
            <button aria-label="Light theme" aria-pressed={theme==='light'} title="Light interface" onClick={()=>setTheme('light')}><Sun size={15}/><span>Light</span></button>
            <button aria-label="Dark theme" aria-pressed={theme==='dark'} title="Dark interface" onClick={()=>setTheme('dark')}><Moon size={15}/><span>Dark</span></button>
          </div>
        </div>
        {view==='3d' && <>
          <div className="toolbar-control lighting-control" role="group" aria-label="Scene lighting">
            <span className="toolbar-label">Scene lighting</span>
            <div className="segmented-control">
              <button aria-label="Day lighting" aria-pressed={sceneLighting==='day'} title="Daytime scene lighting" onClick={()=>setSceneLighting('day')}><Sunrise size={15}/><span>Day</span></button>
              <button aria-label="Night lighting" aria-pressed={sceneLighting==='night'} title="Nighttime scene lighting" onClick={()=>setSceneLighting('night')}><MoonStar size={15}/><span>Night</span></button>
            </div>
          </div>
          <div className="toolbar-control export-control" role="group" aria-label="Scene exports">
            <span className="toolbar-label">Scene tools</span>
            <div className="viewer-toolbar">
              <button aria-label="Reset camera" title="Reset camera" onClick={()=>setReset(value=>value+1)}><RotateCcw size={16}/></button>
              <span className="toolbar-divider"/>
              <button aria-label="Download Rhino 3DM" title="Download all loaded geometry as Rhino 7+ 3DM, including hidden layers, nested sublayers and colors (metres, Z-up)" disabled={rhinoExport.busy || (!features.length && !terrain)} onClick={downloadRhino}>{rhinoExport.busy?<LoaderCircle className="spin" size={15}/>:<Download size={15}/>}3DM</button>
              <button aria-label="Download GLB" title="Download visible layers as GLB, including materials" disabled={rhinoExport.busy || !canExportScene} onClick={()=>exportScene('glb')}><Download size={15}/>GLB</button>
              <button aria-label="Download OBJ" title="Download visible geometry as OBJ (metres, Y-up; no materials)" disabled={rhinoExport.busy || !canExportScene} onClick={()=>exportScene('obj')}><Download size={15}/>OBJ</button>
              <button aria-label="Download raw data (JSON)" title="Download all loaded source data, boundary, and load statuses as JSON" disabled={!Object.keys(sceneLayers.sources).length} onClick={downloadRawData}><FileJson size={15}/><span className="raw-data-label">Raw data</span></button>
            </div>
          </div>
        </>}
      </div>
    </header>
    {view === 'map' && <aside className="sidebar" aria-label="Map tools">
      <div className="drawer-top">
        {!drawerMinimized && <span>Map tools</span>}
        <button className="drawer-toggle" aria-label={drawerMinimized ? 'Expand map tools' : 'Minimize map tools'} title={drawerMinimized ? 'Expand map tools' : 'Minimize map tools'} aria-expanded={!drawerMinimized} aria-controls="map-tools-content" onClick={() => setDrawerMinimized(value => !value)}>{drawerMinimized ? <PanelLeftOpen size={19}/> : <PanelLeftClose size={19}/>}</button>
      </div>
      <div id="map-tools-content" className="drawer-content" hidden={drawerMinimized}>
        <section>
          <div className="section-heading"><h2>Find a location</h2></div>
          <form className="search" onSubmit={search}>
            <Search size={17}/><input aria-label="Search location" placeholder="City, address, or postcode" value={query} onChange={e => setQuery(e.target.value)}/>
            <button aria-label="Search" disabled={searching || !query.trim()}>{searching ? <LoaderCircle className="spin" size={17}/> : <ArrowUpRight size={18}/>}</button>
          </form>
          {searchError && <p role="status" className="error-text">{searchError}</p>}
          {places.length > 0 && <ul className="results">{places.map(place => <li key={place.place_id}><button onClick={() => { setTarget([Number(place.lat), Number(place.lon)]); updateRoute({ location: place.display_name.split(',').slice(0, 2).join(',') }); setPlaces([]); }}><MapPin size={16}/>{place.display_name}</button></li>)}</ul>}
        </section>
        <section>
          <div className="section-heading"><h2>Boundary</h2></div>
          <div className="draw-tools">{([{ id: 'pan', label: 'Explore', icon: Hand }, { id: 'rectangle', label: 'Rectangle', icon: RectangleHorizontal }, { id: 'polygon', label: 'Polygon', icon: Pentagon }] as const).map(tool => <button key={tool.id} aria-pressed={mode === tool.id} onClick={() => setMode(tool.id)}><tool.icon size={21}/>{tool.label}</button>)}</div>
          <p className="hint">{mode === 'rectangle' ? 'Click two opposite corners. Esc cancels.' : mode === 'polygon' ? 'Click vertices, then finish or click the first point. Esc cancels.' : 'Choose a tool to draw or replace the boundary.'}</p>
          {points.length > 0 && <div className="boundary-summary"><span><i/>Boundary selected <small>{area.toFixed(2)} km² bounding area</small></span><button aria-label="Clear boundary" onClick={() => updateBoundary([])}><X size={16}/></button></div>}
        </section>
        <button className="primary" disabled={points.length < 3 || loading || isDrawing} onClick={generate}>
          {loading ? <LoaderCircle size={18} className="spin"/> : <Box size={18}/>} {isDrawing ? 'Finish boundary first' : loading ? 'Loading scene layers…' : 'Generate 3D scene'}{!loading && <ArrowUpRight size={18}/>}
        </button>
        <div className="feedback" aria-live="polite">
          {sceneStarted && <><p>{sceneMessage}</p>{loading && <div className="progress"/>}{loadControls}</>}
          {status && <p>{status}</p>}{error && <div role="alert" className="error-text">{error}</div>}
        </div>
      </div>
    </aside>}
    <main>
      <div className="viewport-top">
        <div className="location-pill"><MapPin size={15}/>{location}</div>
        {view === '3d' && <button className="back-to-map" onClick={returnToMap}><ArrowLeft size={15}/>Back to map</button>}
      </div>
      <div className="viewport">
        <div className="map-viewport" hidden={view !== 'map'}><MapComponent mode={mode} points={points} onChange={updateBoundary} onDrawingChange={setIsDrawing} target={target}/></div>
        {view === '3d' && <Space sublayers={sublayers} features={features} points={points} layers={layers} terrain={terrain} selected={selected} onSelect={setSelected} reset={reset} exportRequest={exportRequest} onExport={message => setStatus(message)} onError={message => setError(message)} onPreparing={setPreparing} sceneLighting={sceneLighting}/>}
      </div>
      {view === '3d' && <>
        <div className={`layer-panel${layersMinimized ? ' minimized' : ''}`}>
          <div className="layer-panel-heading">
            <Layers size={16}/><h2>Scene layers</h2>
            <button aria-label={layersMinimized ? 'Expand scene layers' : 'Minimize scene layers'} title={layersMinimized ? 'Expand scene layers' : 'Minimize scene layers'} aria-expanded={!layersMinimized} aria-controls="scene-layers-content" onClick={() => setLayersMinimized(value => !value)}>{layersMinimized ? <ChevronDown size={17}/> : <ChevronUp size={17}/>}</button>
          </div>
          <div id="scene-layers-content" className="layer-panel-content" hidden={layersMinimized}>
            <p className="layer-hint" aria-live="polite">{sceneMessage}</p>
            <div className="layer-list" role="region" aria-label="Scene layer list" tabIndex={0}>{layerNames.map(name => {
              const state = name === 'Terrain' ? null : sceneLayers.states[groupForLayer(name).id];
              const types=name==='Terrain'?[]:sublayerGroups[name];
              const mixed=name!=='Terrain' && layers[name] && visibleCounts[name]>0 && visibleCounts[name]<layerCounts[name];
              const checked=layers[name] && (name==='Terrain' || !layerCounts[name] || visibleCounts[name]===layerCounts[name]);
              const groupId=`sublayers-${layerNames.indexOf(name)}`;
              return <div key={name} className={`layer-entry ${state?.status || ''}`}>
                <div className="layer-main-row">
                  {types.length>0 ? <button className="sublayer-expander" aria-label={`${expandedLayers[name]?'Hide':'Show'} ${name} sublayers`} title={`${types.length} ${types.length===1?'sublayer':'sublayers'}`} aria-expanded={!!expandedLayers[name]} aria-controls={groupId} onClick={()=>setExpandedLayers(previous=>({...previous,[name]:!previous[name]}))}>{expandedLayers[name]?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="sublayer-spacer"/>}
                  <label className="layer-row"><span>{name}<small>{name === 'Terrain' ? !layers.Terrain ? 'Load elevation on demand' : terrainState === 'loading' ? 'Loading elevation…' : terrainState === 'error' ? 'Failed · flat ground shown' : terrain ? `${Math.round(terrain.baseline)}–${Math.round(Math.max(...terrain.elevations))} m elevation` : 'Waiting for scene' : layerStatus(name)}{types.length>1 && <span className="type-count"> · {types.length} types</span>}</small></span><input aria-label={name} type="checkbox" checked={checked} ref={input=>{if(input) input.indeterminate=mixed;}} aria-checked={mixed?'mixed':checked} onChange={e=>toggleLayer(name,e.target.checked)}/></label>
                </div>
                {types.length>0 && <div className="sublayer-list" id={groupId} role="group" aria-label={`${name} sublayers`} hidden={!expandedLayers[name]}>{types.map(type=><label className="sublayer-row" key={type.id}><span>{type.label}<small>{type.count.toLocaleString()} {type.count===1?'feature':'features'}</small></span><input type="checkbox" aria-label={`${name}: ${type.label}`} checked={layers[name] && sublayers[type.id]!==false} disabled={!layers[name]} onChange={e=>toggleSublayer(type.id,e.target.checked)}/></label>)}</div>}
                {state && ['error', 'cancelled'].includes(state.status) && <div className="layer-failure"><details><summary>Why this layer is unavailable</summary><p>{state.message}</p></details><button disabled={loading} title={loading ? 'Other layers are still loading' : `Retry ${name}`} onClick={() => sceneLayers.retry(groupForLayer(name as typeof vectorLayers[number]).id)}>Retry {name}</button></div>}
              </div>;
            })}</div>
            {layers.Terrain && terrainState === 'error' && <div className="terrain-error" role="status">{terrainError}<button onClick={() => setTerrainRetry(value => value + 1)}>Retry elevation</button></div>}
          </div>
        </div>
        <div className="viewer-actions">
          {status && <p className="viewer-feedback" role="status">{status}</p>}
          {rhinoExport.busy && <button className="rhino-cancel" onClick={()=>{rhinoExport.cancel();setStatus('Rhino export cancelled.');}}>Cancel Rhino export</button>}
          {error && <p className="viewer-feedback error-text" role="alert">{error}</p>}
        </div>
        {selected && <div className="inspector" role="dialog" aria-label="Feature details"><button className="close" aria-label="Close feature details" onClick={() => setSelected(null)}><X size={18}/></button><div className="eyebrow">{selected.layer === 'Buildings' ? 'BUILDING INSPECTOR' : selected.layer.toUpperCase()}</div><h2>{selected.tags.name || (selected.layer === 'Buildings' ? 'Unnamed building' : selected.tags.amenity || selected.tags.leisure || selected.tags.natural || selected.tags.landuse || selected.tags.highway || selected.layer)}</h2><p className="hint">OpenStreetMap · {selected.type}/{selected.id}</p><dl>{Object.entries(selected.tags).map(([k,v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>)}</dl>{selected.layer === 'Buildings' && <><p className="hint">{!buildingDimensions(selected.tags).estimated ? 'Height from map data.' : selected.tags['building:levels'] ? 'Height estimated at 3 m per level.' : 'Height unavailable. Displayed at an estimated 10 m.'}</p>{selected.tags['building:part'] && <p className="hint">Mapped building part · elevation offset respected.</p>}{selected.tags['roof:shape'] && <p className="hint">{['gabled', 'pyramidal'].includes(selected.tags['roof:shape']) ? `Roof: ${selected.tags['roof:shape']}${buildingDimensions(selected.tags).roofEstimated ? ' · estimated 2 m roof height' : ''}.` : selected.tags['roof:shape'] === 'flat' ? 'Flat roof from map data.' : `Roof shape “${selected.tags['roof:shape']}” is not reconstructed yet; shown flat.`}</p>}</>}</div>}
      </>}
      {view === '3d' && sceneStarted && (loading || preparing > 0 || failedCount > 0 || stoppedCount > 0 || !features.length) && <div className="scene-notice" role="status">
        {(loading || preparing > 0) && <LoaderCircle size={15} className="spin"/>}
        <span>{!loading && !features.length ? failedCount ? 'No layers loaded.' : stoppedCount ? 'Loading stopped.' : 'No mapped features found. Try another boundary.' : sceneMessage}</span>
        {loadControls}
      </div>}
      <div className="viewport-bottom"><span className="viewport-hint">{view === 'map' ? 'Draw a boundary to generate a scene' : 'Drag to orbit · Right-drag to pan · Scroll to zoom · Click to inspect'}</span><div className="viewport-credits"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a><DataGuide/></div></div>
    </main>
  </div>;
}
export default App;
