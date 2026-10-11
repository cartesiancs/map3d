import { useState } from 'react';
import { ArrowLeft, Box, Download, LoaderCircle, MapPin, Info, Building2, Trees, Waves, Route, ArrowUpRight } from 'lucide-react';
import type { useSiteAnalysis } from '../hooks/useSiteAnalysis';
import type { useSceneLayers } from '../hooks/useSceneLayers';
import { layerGroups, type GroupId } from '../data/layers';
import { downloadFile } from '../data/download';
import type { AreaMetric, SiteReport } from '../data/siteAnalysis';
import './dashboard.css';

type Props = {
  points: { lat: number; lng: number }[];
  location: string;
  data: ReturnType<typeof useSceneLayers>;
  analysis: ReturnType<typeof useSiteAnalysis>;
  onMap: () => void;
  onViewer: () => void;
};
const number = (value: number | null | undefined, decimals = 0) => value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
const percentage = (area: number, total: number) => `${number(area / total * 100, 1)}%`;
const statusLabels = { idle: 'Not loaded', queued: 'Queued', loading: 'Loading', waiting: 'Retrying automatically', ready: 'Loaded', error: 'Unavailable', cancelled: 'Stopped' };
function Stat({ label, value, unit, detail, icon: Icon }: { label: string; value: string; unit?: string; detail: string; icon: typeof Box }) {
  return <div className="site-stat"><div className="site-stat-label"><span>{label}</span><Icon size={18}/></div><div className="site-stat-value">{value}<span>{unit}</span></div><p>{detail}</p></div>;
}
function AreaBars({ rows, total, formatArea }: { rows: AreaMetric[]; total: number; formatArea: (area: number) => string }) {
  return <div className="site-area-bars">{rows.map(row => <div className="site-area-row" key={row.id}>
    <div><span><i style={{ background: row.color }}/>{row.label}</span><strong>{percentage(row.area, total)}</strong></div>
    <div className="site-bar-track"><span style={{ width: `${Math.min(100, row.area / total * 100)}%`, background: row.color }}/></div>
    <small>{formatArea(row.area)}</small>
  </div>)}</div>;
}
function CoverChart({ report }: { report: SiteReport }) {
  let offset = 0;
  return <svg className="site-cover-chart" viewBox="0 0 180 180" role="img" aria-label="Site coverage chart. Exact values are listed alongside.">
    {report.covers.filter(row => row.area > 0).map(row => {
      const fraction = row.area / report.area, start = offset; offset += fraction;
      return <circle key={row.id} cx="90" cy="90" r="66" fill="none" stroke={row.color} strokeWidth="20" pathLength="100" strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`} strokeDashoffset={-start * 100} transform="rotate(-90 90 90)"/>;
    })}
    <text x="90" y="86" textAnchor="middle" className="site-chart-number">{percentage(report.area - report.covers[report.covers.length - 1].area, report.area)}</text>
    <text x="90" y="107" textAnchor="middle" className="site-chart-caption">mapped area</text>
  </svg>;
}
export default function SiteDashboard({ points, location, data, analysis, onMap, onViewer }: Props) {
  const { report, calculating, error, retry, phase } = analysis;
  const [unit, setUnit] = useState<'ha' | 'm²'>('ha');
  const [downloadError, setDownloadError] = useState('');
  const formatArea = (value: number) => `${number(unit === 'ha' ? value / 10000 : value, unit === 'ha' ? 2 : 0)} ${unit}`;
  const loaded = layerGroups.filter(group => data.states[group.id].status === 'ready').length;
  const partial = loaded !== layerGroups.length;
  const available = (group: GroupId) => data.states[group].status === 'ready' && !calculating;
  const b = report?.buildings;
  const buildingsAvailable = available('buildings') || !!b?.count;
  const landscapeAvailable = available('landscape');
  const transportAvailable = available('transport');
  const green = report?.covers.find(row => row.id === 'green')?.area || 0;
  const water = report?.covers.find(row => row.id === 'water')?.area || 0;
  const download = () => {
    if (!report) return;
    try {
      downloadFile('site-analysis.json', JSON.stringify({
        generator: 'map3d site dashboard', version: 1, exportedAt: new Date().toISOString(), location,
        boundary: { type: 'Polygon', coordinates: [[...points.map(p => [p.lng, p.lat]), [points[0].lng, points[0].lat]]] },
        attribution: '© OpenStreetMap contributors · ODbL', partial, sourceBatches: data.states,
        units: { areas: 'square metres', lengths: 'metres', heights: 'metres', density: 'mapped building / part features per hectare', floorAreaRatio: 'estimated floor area / site area' },
        methods: [
          'Local planar projection; polygon coordinates rounded to 1 mm for robust clipping. Areas clipped to the selected polygon, holes removed, overlaps merged.',
          'Coverage priority: buildings, water, green-designated areas, recreation & parking, other mapped areas. Land-use designations can overlap.',
          'Green designation is a proxy, not measured vegetation or tree canopy. Unclassified means no loaded area designation, not vacant land.',
          'Building count includes mapped parts. Heights use explicit height or 3 m per mapped level; missing heights excluded. No 10 m display fallback.',
          'Indicative floor area uses mapped levels or height / 3, excludes below-ground floors, respects minimum levels/heights, merges overlapping parts at each vertical band. Buildings without usable levels/heights excluded.',
          'All loaded features included regardless of viewer visibility. Missing, incorrect or incomplete OSM data can affect results. Use at your own risk.',
        ],
        metrics: report,
      }, null, 2), 'application/json');
      setDownloadError('');
    } catch { setDownloadError('Could not download the report. Please retry.'); }
  };
  return <div className="site-dashboard" role="region" aria-label="Site dashboard" aria-busy={calculating} tabIndex={-1}>
    <div className="site-page-heading">
      <div><div className="site-kicker"><MapPin size={14}/>{location}</div><h1>Site dashboard</h1><p>Understand the selected boundary through its mapped buildings, landscape and uses.</p></div>
      <div className="site-page-actions"><button onClick={onMap}><ArrowLeft size={15}/>Back to map</button><button onClick={onViewer}><Box size={15}/>View in 3D<ArrowUpRight size={14}/></button><button onClick={download} disabled={!report || calculating}><Download size={15}/>Download report</button></div>
    </div>
    <div className="site-data-status" role="status"><span className={`site-status-dot${partial ? ' partial' : ''}`}/><strong>{partial ? 'Partial mapped data' : 'All source batches loaded'}</strong><span>{loaded} of {layerGroups.length} batches loaded{calculating ? ' · Calculating statistics…' : data.loading ? ' · More data loading in the background' : ''}</span><div className="site-unit-control" role="group" aria-label="Area units">{(['ha', 'm²'] as const).map(value => <button key={value} aria-pressed={unit === value} onClick={() => setUnit(value)}>{value}</button>)}</div></div>
    {downloadError && <p role="alert" className="error-text">{downloadError}</p>}
    {!report && data.loading && <button onClick={data.cancel}>Stop loading layers</button>}
    {error && <div className="site-analysis-error" role="alert">{error}<button onClick={retry}>Retry calculation</button></div>}
    {!report && !error && <div className="site-calculating" role="status"><LoaderCircle className="spin" size={24}/><p>{phase}</p></div>}
    {report && <>
      <div className="site-stats">
        <Stat label="Site area" value={number(unit === 'ha' ? report.area / 10000 : report.area, unit === 'ha' ? 2 : 0)} unit={unit} detail={`${number(report.perimeter)} m boundary perimeter · actual polygon`} icon={MapPin}/>
        <Stat label="Building coverage" value={buildingsAvailable ? number(b!.footprint / report.area * 100, 1) : '—'} unit={buildingsAvailable ? '%' : ''} detail={buildingsAvailable ? `${formatArea(b!.footprint)} of merged footprints` : 'Waiting for building data'} icon={Building2}/>
        <Stat label="Mapped green space" value={landscapeAvailable ? number(green / report.area * 100, 1) : '—'} unit={landscapeAvailable ? '%' : ''} detail={landscapeAvailable ? `${formatArea(green)} · green-designation proxy` : 'Waiting for landscape data'} icon={Trees}/>
        <Stat label="Mean building height" value={buildingsAvailable ? number(b!.meanHeight, 1) : '—'} unit={buildingsAvailable && b!.meanHeight !== null ? 'm' : ''} detail={buildingsAvailable ? `${number(b!.knownHeights)} with usable heights · ${number(b!.unknownHeights)} unknown` : 'Waiting for building data'} icon={Building2}/>
      </div>
      <div className="site-grid">
        <section className="site-card site-coverage"><div className="site-card-heading"><div><h2>Site coverage</h2><p>Non-overlapping areas within the boundary</p></div><span className="site-tag">{partial ? 'Partial' : 'Mapped data'}</span></div>
          <div className="site-cover-content"><CoverChart report={report}/><AreaBars rows={report.covers} total={report.area} formatArea={formatArea}/></div>
          <p className="site-note">Buildings take priority over water, green space and other areas. Unclassified areas have no loaded area designation; they are not necessarily vacant or paved.</p>
        </section>
        <section className="site-card"><div className="site-card-heading"><div><h2>Building intensity</h2><p>Mapped buildings and building parts</p></div><Building2 size={18}/></div>
          {buildingsAvailable ? <><dl className="site-metric-list">
            <div><dt>Building / part features</dt><dd>{number(b!.count)}<small>{number(b!.parts)} are building parts</small></dd></div>
            <div><dt>Feature density</dt><dd>{number(b!.density, 1)}<small>building / part features per ha</small></dd></div>
            <div><dt>Indicative floor area</dt><dd>{b!.floorArea !== null ? formatArea(b!.floorArea) : '—'}</dd></div>
            <div><dt>Indicative floor area ratio</dt><dd>{number(b!.floorAreaRatio, 2)}<small>estimated floor area ÷ site area</small></dd></div>
          </dl><p className="site-note">Floor area uses mapped levels or height ÷ 3 m, with overlapping parts merged at each level. It covers {b!.footprint ? percentage(b!.floorSampleFootprint, b!.footprint) : '0%'} of mapped footprints. This is an estimate, not a planning or occupancy calculation.</p></> : <p className="site-empty">Building data has not loaded yet.</p>}
        </section>
        <section className="site-card"><div className="site-card-heading"><div><h2>Building heights</h2><p>Distribution of usable heights</p></div></div>
          {buildingsAvailable && b!.knownHeights > 0 ? <><div className="site-height-chart" role="img" aria-label={b!.bins.map(bin => `${bin.label}: ${bin.count} features`).join(', ')}>{b!.bins.map(bin => <div key={bin.label}><strong>{number(bin.count)}</strong><div className="site-height-track"><span style={{ height: `${bin.count / Math.max(1, ...b!.bins.map(row => row.count)) * 100}%` }}/></div><small>{bin.label}</small></div>)}</div>
            <div className="site-height-summary"><span>Median <strong>{number(b!.medianHeight, 1)} m</strong></span><span>Maximum <strong>{number(b!.maxHeight, 1)} m</strong></span></div>
            <p className="site-note">{number(b!.mappedHeights)} mapped heights · {number(b!.estimatedHeights)} estimated at 3 m per level · {number(b!.unknownHeights)} unknown, excluded. Viewer display defaults are excluded.</p>
            <details className="site-details"><summary>Tallest mapped buildings / parts</summary><ol>{b!.tallest.map(row => <li key={row.id}><span>{row.name}<small>{row.id} · {row.source}</small></span><strong>{number(row.value, 1)} m</strong></li>)}</ol></details>
          </> : <p className="site-empty">{buildingsAvailable ? b!.count ? 'No usable height or level tags were found. Unknown heights are excluded.' : 'No building footprints were found in the loaded data.' : 'Waiting for building data.'}</p>}
        </section>
        <section className="site-card"><div className="site-card-heading"><div><h2>Land-use allocation</h2><p>Area tagged with a land-use designation</p></div></div>
          {report.landUses.length ? <div className="site-scroll-list" role="region" aria-label="Land-use designations" tabIndex={0}><AreaBars rows={report.landUses} total={report.area} formatArea={formatArea}/></div> : <p className="site-empty">{landscapeAvailable ? 'No land-use polygons were found in the loaded data.' : 'Waiting for land-use data.'}</p>}
          <p className="site-note">Designations can overlap, so percentages may not add to 100%. These are mapped land-use tags, not zoning or inferred building uses.</p>
        </section>
        <section className="site-card"><div className="site-card-heading"><div><h2>Landscape & movement</h2><p>Mapped features inside the boundary</p></div><Route size={18}/></div>
          <dl className="site-metric-list">
            <div><dt><Trees size={14}/>Individual tree points</dt><dd>{landscapeAvailable ? number(report.treeCount) : '—'}</dd></div>
            <div><dt><Waves size={14}/>Water coverage</dt><dd>{landscapeAvailable ? percentage(water, report.area) : '—'}</dd></div>
            <div><dt>Road centrelines</dt><dd>{transportAvailable ? `${number(report.lengths.roads)} m` : '—'}</dd></div>
            <div><dt>Walking & cycling paths</dt><dd>{transportAvailable ? `${number(report.lengths.paths)} m` : '—'}</dd></div>
            <div><dt>Rail / tram centrelines</dt><dd>{transportAvailable ? `${number(report.lengths.rail)} m` : '—'}</dd></div>
            <div><dt>Transit points</dt><dd>{transportAvailable ? number(report.transitPoints) : '—'}</dd></div>
            <div><dt>Waterway centrelines</dt><dd>{landscapeAvailable ? `${number(report.lengths.waterways)} m` : '—'}</dd></div>
          </dl><p className="site-note">Lengths are clipped to the boundary. Tree points are not a canopy estimate. Green-designated space can include paths, lawns and other surfaces.</p>
        </section>
        <section className="site-card"><div className="site-card-heading"><div><h2>Places & amenities</h2><p>Mapped points of interest by type</p></div><MapPin size={18}/></div>
          {report.amenities.length ? <div className="site-scroll-list" role="region" aria-label="Amenity types" tabIndex={0}><dl className="site-metric-list">{report.amenities.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{number(row.count)}</dd></div>)}</dl></div> : <p className="site-empty">{available('places') ? 'No points of interest were found in the loaded data.' : 'Waiting for places data.'}</p>}
          <p className="site-note">Counts include POI markers derived from tagged buildings and grounds. A missing place in OpenStreetMap does not mean it does not exist.</p>
        </section>
      </div>
      <section className="site-card site-quality"><div className="site-card-heading"><div><h2>Data coverage & methodology</h2><p>{number(report.includedFeatures)} source features intersect the boundary{report.skipped ? ` · ${number(report.skipped)} invalid geometries excluded` : ''}</p></div><Info size={18}/></div>
        <div className="site-source-grid">{layerGroups.map(group => { const state = data.states[group.id]; return <div key={group.id} className={`site-source ${state.status}`}><strong>{group.label}</strong><span>{statusLabels[state.status]}</span>{state.message && state.status !== 'ready' && <small>{state.message}</small>}</div>; })}</div>
        <div className="site-loading-actions">{data.loading && <button onClick={data.cancel}>Stop loading layers</button>}{!data.loading && layerGroups.some(group => ['error', 'cancelled'].includes(data.states[group.id].status)) && <button onClick={data.retryFailed}>Retry unavailable layers</button>}</div>
        <p className="site-note">Calculations include all loaded layers, including those hidden in the 3D viewer. Areas use a local planar projection, with coordinates rounded to 1 mm for robust clipping, clipped to the actual boundary, with holes removed and overlaps merged. Values are indicative and become less accurate over very large regions or near the poles. This is not a survey, zoning assessment or population-density estimate.</p>
        <p className="site-risk"><Info size={16}/><span>Source: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>. Data may be missing, incomplete or incorrect. Verify findings independently and use at your own risk.</span></p>
      </section>
    </>}
  </div>;
}
