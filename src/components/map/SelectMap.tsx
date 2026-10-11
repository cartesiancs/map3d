import { useEffect, useRef, useState } from 'react';
import { MapContainer, ScaleControl, TileLayer, Polygon, Polyline, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
export type Point = { lat: number; lng: number };
export type DrawMode = 'pan' | 'rectangle' | 'polygon';
function rectangle(a: Point, b: Point) {
  const bounds = L.latLngBounds(a, b);
  return [bounds.getNorthEast(), bounds.getNorthWest(), bounds.getSouthWest(), bounds.getSouthEast()];
}
type Props = { mode: DrawMode; points: Point[]; onChange: (p: Point[]) => void; onDrawingChange: (drawing: boolean) => void; target: [number, number] | null };
function Controls({ mode, points, onChange, onDrawingChange, target }: Props) {
  const [draft, setDraft] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const map = useMap();
  useEffect(() => { onDrawingChange(draft.length > 0); }, [draft.length, onDrawingChange]);
  const cancel = () => { setDraft([]); setCursor(null); };
  const finishPolygon = () => { onChange(draft); cancel(); };
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  useEffect(() => { if (target) map.flyTo(target, 16); }, [target, map]);
  useEffect(() => {
    setDraft([]); setCursor(null);
    if (points.length >= 3) {
      const bounds = L.latLngBounds(points.map(p => L.latLng(p.lat, p.lng)));
      if (!map.getBounds().contains(bounds)) map.fitBounds(bounds, {animate: false});
    }
  }, [points, map]);
  useEffect(() => {
    setDraft([]); setCursor(null);
    map.getContainer().classList.toggle('is-drawing', mode !== 'pan');
    if (mode !== 'pan') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    return () => { map.doubleClickZoom.enable(); map.getContainer().classList.remove('is-drawing'); };
  }, [mode, map]);
  useMapEvents({
    mousemove(e) { if (mode !== 'pan' && draft.length) setCursor(e.latlng); },
    mouseout() { setCursor(null); },
    click(e) {
      if (mode === 'pan') return;
      if (mode === 'rectangle') {
        if (!draft.length) { setDraft([e.latlng]); setCursor(e.latlng); return; }
        if (draft[0].lat === e.latlng.lat || draft[0].lng === e.latlng.lng) return;
        onChange(rectangle(draft[0], e.latlng)); cancel();
      } else {
        if (draft.length >= 3 && map.latLngToContainerPoint(draft[0]).distanceTo(e.containerPoint) < 10) { finishPolygon(); return; }
        setDraft(p => [...p, e.latlng]); setCursor(null);
      }
    },
  });
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, button')) return;
      if (e.key === 'Escape') { setDraft([]); setCursor(null); }
      if (e.key === 'Enter' && mode === 'polygon' && draft.length >= 3) {
        e.preventDefault(); onChange(draft); setDraft([]); setCursor(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [draft, mode, onChange]);
  const preview = mode === 'rectangle'
    ? draft.length && cursor ? rectangle(draft[0], cursor) : []
    : cursor ? [...draft, cursor] : draft;
  const previewStyle = { color: '#6256e8', fillOpacity: .1, dashArray: '6 6', className: 'boundary-preview' };
  return <>
    {points.length > 2 && <Polygon positions={points} className="boundary-selection" interactive={false} pathOptions={{ color: '#6256e8', fillOpacity: draft.length ? .04 : .16, className: 'boundary-selection' }}/>}
    {preview.length >= 3
      ? <Polygon positions={preview} className="boundary-preview" interactive={false} pathOptions={previewStyle}/>
      : preview.length > 1 && <Polyline positions={preview} className="boundary-preview" interactive={false} pathOptions={previewStyle}/>}
    {draft.map((point, index) => <CircleMarker key={index} center={point} radius={4} className="draft-vertex" interactive={false} pathOptions={{ color: '#6256e8', fillColor: '#fff', fillOpacity: 1, weight: 2, className: 'draft-vertex' }}/>) }
    {mode === 'polygon' && draft.length >= 3 && <div className="finish-drawing"><button onClick={e => { e.stopPropagation(); finishPolygon(); }}>Finish polygon · {draft.length} points ↵</button></div>}
  </>;
}
export function MapComponent(props: Props) {
  const initialBounds = useRef(props.points.length >= 3 ? L.latLngBounds(props.points.map(p => L.latLng(p.lat, p.lng))) : undefined);
  const [tileError, setTileError] = useState(false);
  const [tilesLoading, setTilesLoading] = useState(true);
  return <>
    <MapContainer bounds={initialBounds.current} center={[40.8, -73.95]} zoom={15} style={{ height: '100%', width: '100%' }}>
      <TileLayer attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" eventHandlers={{ loading: () => { setTilesLoading(true); setTileError(false); }, load: () => setTilesLoading(false), tileerror: () => setTileError(true) }}/>
      <ScaleControl position="bottomleft" imperial={false}/>
      <Controls {...props}/>
    </MapContainer>
    {tilesLoading && <div className="tile-warning" role="status">Loading map tiles…</div>}
    {!tilesLoading && tileError && <div className="tile-warning" role="status">Some map tiles could not load. Check your connection and zoom to retry.</div>}
  </>;
}
