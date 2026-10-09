<p align='center'>
<h1 align='center'>🗺️ map3d</h1>
<p align='center'>Generate a real world 3D map</p>
</p>

<p align='center'>
<a href="https://map.fleet.im/">Visit Website</a> · <a href="https://github.com/cartesiancs/map3d/issues">Report Bugs</a>
</p>

![img](./.github/screenshot.png)

## About The Project

This is a 3D building mapping service implemented with [React-Three-Fiber](https://github.com/pmndrs/react-three-fiber). It allows exporting as a GLB file, and all features are free to use. Based on this project, various functionalities such as **digital twin**, **drone surveying**, and **GPS markers** can be implemented.

The map files are based on OpenStreetMap data.

> [!IMPORTANT]
> 📢 <strong>This project cannot guarantee the accuracy of the data.</strong> Since it uses OpenStreetMap data, some height values may be missing or incorrectly recorded. To address this issue, an option will be added in the future to allow users to manually correct the data.

## Roadmap

- [x] Create 3D Buildings
- [x] Create Roads
- [x] Export GLB
- [ ] Building Texture
- [ ] Height Customization
- [ ] Material
- [ ] Heightmap

## Demo

https://github.com/user-attachments/assets/1b61c2f8-dcf9-40bb-9804-59f6a74594dc

## Contributors

Hyeong Jun Huh [(GitHub)](https://github.com/DipokalLab)

## License

MIT License

## Run and verify this fork

Use Node.js 24 (minimum 22.18), then `npm ci --ignore-scripts` and `npm run dev`.

### Studio workflow

- Open **Data & guide** in the map or viewer footer for data sources, geometry and height estimates, the original repository, and accuracy limitations. The guide includes OpenStreetMap/ODbL and terrain credits and a clear use-at-your-own-risk notice for the app and its exports.
- Search for a city, address, or postcode and choose a result.
- Choose **Rectangle** and click two opposite corners, or choose **Polygon**, click vertices, then click **Finish polygon**, the first vertex, or press Enter. Both tools show a live cursor preview and fixed-vertex markers; Escape cancels the draft.
- Select a boundary, then click **Generate 3D scene**. There is no area cap, allowing larger-area testing.
- The viewer opens immediately. Buildings, transport, landscape, and places/recreation load in four sequential batches and appear as they arrive. Batches containing enabled layers go first, with buildings first among equally visible batches. Layer rows distinguish queued, loading, waiting for an automatic retry, loaded, empty, failed, and stopped data. A failed batch does not discard other geometry or block later batches. Layers sharing a batch share its request status.
- Failed or stopped batches can be retried from a layer row, or together with **Retry unavailable layers**, once current background loading finishes. **Stop loading layers** keeps completed batches. Updating the boundary aborts old requests and clears the old scene. A progress notice remains visible when the tools drawer is minimized.
- Overpass requests automatically use an available server and remember the server that last succeeded. A rate limit triggers a per-server cooldown respecting `Retry-After`, with increasing waits of at least 30, 60, then 120 seconds plus jitter. If both servers are busy, a countdown communicates the automatic background retry; loaded layers remain usable. Retries are bounded by six attempts and a three-minute budget per batch. Other transient failures receive up to two attempts; invalid requests fail without retrying. Stopping loading or changing the boundary cancels pending retries. Successful responses, including empty results, are cached in memory for five minutes (up to twelve batches).
- In 3D, the map-only search and drawing sidebar is hidden. Minimize or expand **Scene layers** without changing toggles or loading. Camera reset and download controls live in the top toolbar. Drag to orbit, right-drag to pan, and scroll to zoom. **Reset camera** frames the boundary. The viewer renders on demand when scene data or the camera changes, avoiding continuous rendering while idle.
- A metric scale bar follows zoom in both map and viewer. The perspective legend is approximate at the camera's focus depth because scale varies with depth. The orthographic legend measures the view plane; a tilted ground plane is foreshortened. Use **Top** for a north-up plan scale. The bar describes the on-screen view, not a fixed physical printing ratio.
- **Perspective / Isometric** switches camera projection without rebuilding the model. Isometric uses an orthographic camera at an equal-axis angle and retains the focus and apparent scale. Orbiting remains available afterward. Click the rotating view cube or choose its menu for top, bottom, front (south), back (north), left (west), right (east), or the isometric angle. View changes keep the current pan target and zoom and animate briefly; **Reset camera** reframes the boundary.
- **Measure** enables point-to-point measurements on visible model geometry, including roofs, batched features, and elevation, with the reference ground as a fallback in empty space. Click two points; a live preview follows the second endpoint. Each result shows straight-line 3D length, horizontal length, and absolute height difference in metres or kilometres. Dragging still orbits and does not place an endpoint; right-drag pans and scrolling zooms. Escape cancels the pending point, then exits the tool. Completed dimensions remain until individually removed or cleared, and disappear when leaving the viewer. Measurements and navigation helpers are excluded from model downloads. Values describe the displayed model, including estimated building heights; they are not surveyed dimensions.
- **Appearance** switches the interface between light and dark themes, including map controls and panels. **Scene lighting** independently switches the 3D background, lights, and reference grid between day and night. The palette uses pale lavender panels, cyan-to-violet accents, cool periwinkle buildings, and cyan water. Night uses cool moonlight with a subtle violet fill. Both choices are saved locally; the initial interface theme follows the system preference. Changing either setting preserves loaded data, camera position, and selection.
- Click a building, tree, place marker, path, or other feature to inspect its map tags. Selected buildings and area features receive a cyan-and-violet halo, a bright contour, and a subtle fill tint; roof edges and courtyard boundaries are included. The selection overlay renders only for the active feature, respects occlusion, and is excluded from downloads. Close the inspector or click empty space to dismiss it.
- Toggle buildings, roads, walking/cycling, transit, trees/woodland, water, waterways, green spaces, land use, points of interest, and recreation/parking. Counts show mapped features; zero counts explicitly say **No mapped data here**. Land use and POIs start hidden to keep the scene readable.
- Expand the arrow beside a vector layer to see its loaded sublayers and counts: road classes, POI types, building types, land uses, and other tagged categories. Each type has an independent visibility checkbox. Parent checkboxes show a partial state when some children are hidden; checking a parent enables all its types, and unchecking it hides the group. Hidden types are excluded from inspection and GLB/OBJ downloads; hiding the selected type dismisses its inspector and halo. Filtering makes no extra map requests. The batched viewer retains prepared data and toggles subtype chunks without rebuilding unrelated geometry. New mapped types appear as background batches arrive; unknown tag values remain available as separate types.
- Ground surfaces use a stable visual order: land use, green spaces, woodland, recreation/parking, then water. Smaller areas draw after broader areas within each small scene or spatial chunk. Surface overlays retain depth testing against terrain and buildings, but do not write competing depth values; polygon offset separates them from the ground. The reference grid stays behind them. This display priority does not resolve conflicting OSM classifications or alter the raw data.
- Turn on **Terrain** to load elevation independently. Loading and failure states are separate from the vector layers, with **Retry elevation** on failure. Turning it off restores flat ground; downloaded elevation is reused until you change the boundary.
- **GLB** and **OBJ** in the top toolbar download the currently loaded, visible geometry, including enabled terrain and mapped roofs. GLB retains materials; OBJ exports geometry in metres with Y up, without material files. Downloads remain available when the layers panel is minimized.
- **Raw data** downloads `map-data.json`: deduplicated, unmodified OSM source elements from all completed batches, including hidden layers and sublayers, plus the boundary as a GeoJSON polygon, batch statuses/counts, parent and sublayer visibility settings, and sampled elevation if loaded. Partial downloads identify unfinished or unavailable batches. Terrain is a sampled grid, not the original tile images.
- **Back to map** in the viewer returns to `/map` at the same map position and reopens the map tools. **Generate 3D scene** opens `/viewer`; there is no mode switch on the map. Browser Back/Forward restore the boundary associated with each history entry and reuse the current scene when its boundary is unchanged. Draw a replacement boundary and generate another scene. The existing scene stays available until a new boundary is committed. Refreshing `/viewer` restores its boundary and reloads data; the last boundary and location are saved for this tab only. Opening `/viewer` without a saved boundary redirects to `/map`.

The two routes use browser history without a page reload. Production hosting must serve `index.html` for `/map` and `/viewer` (Vite dev/preview already supports this fallback).

Search uses Nominatim on explicit submission. Each geometry batch uses an Overpass query scoped to the drawn polygon and bounding box, fetching OSM nodes, ways, and multipolygon relations. All four batches are requested sequentially, with at least 750 ms between uncached request starts, to avoid bursts on public map servers. Transport node queries only fetch relevant stops and stations; road and rail ways are retained. Unsupported route and site relations are excluded; queries request 25 seconds and 128 MiB of server resources. Each server attempt has a 40-second client deadline, including response decoding. Fragmented polygon rings and courtyard holes are reconstructed. Mapped building parts replace enclosing outer volumes; mapped name/address/use/colour tags are inherited from the outer building. Heights use tagged height (metres or feet), then 3 m per tagged level, then a disclosed 10 m fallback. Minimum heights and building minimum levels are respected. Flat, gabled, and pyramidal roofs are supported; gabled/pyramidal roofs use tagged roof height or levels, then a disclosed 2 m estimate. Other roof shapes remain flat and are identified in the inspector. Pyramidal roofs use a bounding-box approximation on irregular footprints. Complex building relation hierarchies are not fully reconstructed.

Terrain uses public [Mapzen Terrarium tiles](https://github.com/tilezen/joerd/blob/master/docs/formats.md) from the AWS elevation-tiles-prod bucket, with [source attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) linked in the viewer. A 49 × 49 local elevation surface is sampled from at most nine adaptive-zoom tiles. Line networks and area surfaces are draped; buildings and markers are anchored at sampled ground elevation. Buildings use a single foundation elevation, so sloped foundations, bridge/tunnel clearance, and hydrologically level water are not modelled. The ground surface spans the boundary's bounding rectangle. Elevation resolution and mapping detail vary by location. Map tiles, search, vector geometry, and elevation require an internet connection.

- `npm run build`: TypeScript checks and production bundle
- `npm run lint`: JavaScript correctness and React hook checks
- `npm test`: offline layer normalization, building height, elevation interpolation, road loading, automatic retries, cooldowns, caching, and cancellation tests
- `npx playwright install chromium && npm run test:e2e`: browser tests covering selection, layer counts/toggles, feature inspection, visible-layer export, incremental loading with partial failures, targeted retries, automatic rate-limit recovery, cooldown cancellation, live drawing previews, map/viewer navigation, panel minimization, OBJ/raw-data downloads, mobile viewer layout, and elevation failure/retry/caching

Browser tests use synthetic geometry; they do not verify live service availability or map accuracy.
