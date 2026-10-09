import { test, expect } from "@playwright/test";

// All external assets and Overpass responses are deterministic in this smoke test.
test("select area, generate scene, and download a GLB without startup errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const hdr = Buffer.concat([Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"), Buffer.from([128, 128, 128, 128])]);
  await page.route("**/*", async route => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:5179")) return route.continue();
    if (url.includes("overpass-api.de")) {
      const query = route.request().postData() || "";
      const building = { id: 1, tags: { building: "yes", height: "15", name: "Test building" }, geometry: [
        { lat: 40.799, lon: -73.951 }, { lat: 40.799, lon: -73.949 },
        { lat: 40.801, lon: -73.949 }, { lat: 40.801, lon: -73.951 }, { lat: 40.799, lon: -73.951 },
      ] };
      return route.fulfill({ json: { elements: query.includes('"building"') ? [building] : [] } });
    }
    if (url.includes("tile.openstreetmap.org")) return route.fulfill({ contentType: "image/png", body: pixel });
    if (/\.hdr(?:\?|$)/.test(url)) return route.fulfill({ contentType: "application/octet-stream", body: hdr });
    return route.fulfill({ contentType: "text/css", body: "" });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find a location" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate 3D scene" })).toBeDisabled();
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  const box = await page.locator(".leaflet-container").boundingBox();
  if (!box) throw new Error("Map bounds unavailable");
  await page.mouse.click(box.x + box.width * .4, box.y + box.height * .4);
  await page.mouse.click(box.x + box.width * .6, box.y + box.height * .6);
  await page.getByRole("button", { name: "Generate 3D scene" }).click();
  await expect(page.locator(".layer-hint")).toContainText("Scene ready", {timeout:15000});
  await expect(page.getByRole("heading", { name: "Scene layers" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GLB" }).click();
  expect((await download).suggestedFilename()).toBe("scene.glb");
  expect(errors).toEqual([]);
});

test("failed requests preserve the boundary and offer retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/interpreter", route => { attempts++; return route.fulfill({ status: 504, body: "Unavailable" }); });
  await page.goto("/");
  await page.getByRole("button", { name: "Polygon", exact: true }).click();
  const box = await page.locator(".leaflet-container").boundingBox();
  if (!box) throw new Error("Map unavailable");
  for (const [x,y] of [[.4,.4],[.6,.4],[.5,.6]]) await page.mouse.click(box.x + box.width*x, box.y + box.height*y);
  await page.getByRole("button", { name: /Finish polygon/ }).click();
  await page.getByRole("button", { name: "Generate 3D scene" }).click();
  await expect(page.locator(".layer-entry.error")).toHaveCount(11, {timeout:15000});
  expect(attempts).toBe(8);
  await expect(page.getByRole("button", { name: "Retry Buildings", exact: true })).toBeVisible();
  await page.getByRole("button", {name: "Edit boundary"}).click();
  await expect(page.getByText("Boundary selected")).toBeVisible();
});

const origin = {lat:40.8,lon:-73.95};
function footprint(lat: number, lon: number, width = .0002) {
  return [{lat,lon},{lat,lon:lon+width},{lat:lat+width,lon:lon+width},{lat:lat+width,lon},{lat,lon}];
}
const richElements = [
  {type:'way',id:101,tags:{building:'house',height:'16','roof:shape':'gabled','roof:height':'3','building:colour':'#c9bbac',name:'Gabled house'},geometry:footprint(40.7996,-73.9505)},
  {type:'way',id:102,tags:{'building:part':'yes',height:'23',min_height:'4','roof:shape':'pyramidal'},geometry:footprint(40.8004,-73.9505)},
  {type:'way',id:103,tags:{highway:'residential'},geometry:[{lat:40.799,lon:-73.951},{lat:40.801,lon:-73.951}]},
  {type:'way',id:104,tags:{highway:'cycleway'},geometry:[{lat:40.799,lon:-73.9508},{lat:40.801,lon:-73.9508}]},
  {type:'way',id:105,tags:{railway:'tram'},geometry:[{lat:40.799,lon:-73.9512},{lat:40.801,lon:-73.9512}]},
  {type:'node',id:106,tags:{natural:'tree'},lat:40.8,lon:-73.9495},
  {type:'way',id:107,tags:{natural:'water'},geometry:footprint(40.8004,-73.9495)},
  {type:'way',id:108,tags:{waterway:'stream'},geometry:[{lat:40.799,lon:-73.949},{lat:40.801,lon:-73.949}]},
  {type:'way',id:109,tags:{leisure:'park'},geometry:footprint(40.7994,-73.9495)},
  {type:'way',id:110,tags:{landuse:'commercial'},geometry:footprint(40.8,-73.9508)},
  {type:'node',id:111,tags:{amenity:'cafe',name:'Corner cafe'},...origin},
  {type:'way',id:112,tags:{leisure:'pitch'},geometry:footprint(40.7994,-73.9508)},
];
async function startRectangle(page: import('@playwright/test').Page) {
  await page.getByRole('button',{name:'Rectangle',exact:true}).click();
  const box = await page.locator('.leaflet-container').boundingBox();
  if (!box) throw new Error('Map unavailable');
  await page.mouse.click(box.x+box.width*.4,box.y+box.height*.4);
  await page.mouse.click(box.x+box.width*.6,box.y+box.height*.6);
  await page.getByRole('button',{name:'Generate 3D scene'}).click();
}
async function selectRectangle(page: import('@playwright/test').Page) {
  await startRectangle(page);
  await expect(page.locator(".layer-hint")).toContainText("Scene ready", {timeout:15000});
}
async function mockLayers(page: import('@playwright/test').Page) {
  await page.route('**/api/interpreter', route => route.fulfill({json:{elements:richElements}}));
  await page.route('**/*.tile.openstreetmap.org/**', route => route.fulfill({status:204,body:''}));
}
async function readGlb(download: import('@playwright/test').Download) {
  const {readFile} = await import('node:fs/promises');
  const file = await readFile((await download.path())!);
  const length = file.readUInt32LE(12);
  return JSON.parse(file.subarray(20,20+length).toString());
}
test('all vector layers have counts, toggle in export, and do not re-export on returning to 3D', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await mockLayers(page); await page.goto('/'); await selectRectangle(page);
  for (const name of ['Buildings','Roads','Walking & cycling','Transit','Trees & woodland','Water','Waterways','Green spaces','Land use','Points of interest','Recreation & parking']) {
    await expect(page.getByRole('checkbox',{name,exact:true}).locator('..')).toContainText(/\d+ features?/);
    await page.getByRole('checkbox',{name,exact:true}).uncheck();
  }
  await page.getByRole('checkbox',{name:'Points of interest',exact:true}).check();
  await page.getByRole('button',{name:'Inspect Corner cafe'}).click();
  await expect(page.getByRole('dialog',{name:'Feature details'})).toContainText('Corner cafe');
  await page.getByRole('button',{name:'Close feature details'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('checkbox',{name:'Points of interest',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'Buildings',exact:true}).check();
  let download = page.waitForEvent('download'); await page.getByRole('button',{name:'Download GLB'}).click();
  const buildings = await readGlb(await download);
  const names = buildings.nodes.map((n: {name: string}) => n.name);
  expect(names).toContain('way/101/roof'); expect(names).toContain('way/102/roof'); expect(names).not.toContain('way/104');
  await page.getByRole('checkbox',{name:'Walking & cycling',exact:true}).check();
  download = page.waitForEvent('download'); await page.getByRole('button',{name:'Download GLB'}).click();
  expect((await readGlb(await download)).nodes.map((n: {name:string}) => n.name)).toContain('way/104');
  let unexpectedDownloads = 0; page.on('download', () => unexpectedDownloads++);
  await page.getByRole('button',{name:'2D map',exact:true}).click();
  await page.getByRole('button',{name:'3D scene',exact:true}).click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.screenshot({path:'test-results/layers-desktop.png'});
  expect(unexpectedDownloads).toBe(0); expect(errors).toEqual([]);
});
test('terrain failure has retry, success is cached, and terrain is included in GLB', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await mockLayers(page); await page.goto('/'); await selectRectangle(page);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width=2; c.height=2;
    const ctx=c.getContext('2d')!; const image=ctx.createImageData(2,2);
    for(let i=0;i<4;i++) image.data.set([128,10+i*5,0,255],i*4);
    ctx.putImageData(image,0,0); return c.toDataURL().split(',')[1];
  });
  let fail = true, requests = 0;
  await page.route('https://s3.amazonaws.com/elevation-tiles-prod/**', route => {
    requests++;
    return fail ? route.fulfill({status:503,body:'Unavailable',headers:{'access-control-allow-origin':'*'}}) : route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64'),headers:{'access-control-allow-origin':'*'}});
  });
  await page.getByRole('checkbox',{name:'Terrain',exact:true}).check();
  await expect(page.getByText('Failed · flat ground shown')).toBeVisible();
  await expect(page.getByText('Elevation service returned 503.')).toBeVisible();
  fail=false; await page.getByRole('button',{name:'Retry elevation'}).click();
  await expect(page.getByText(/m elevation$/)).toBeVisible();
  const fetched=requests;
  await page.getByRole('checkbox',{name:'Terrain',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'Terrain',exact:true}).check();
  await expect(page.getByText(/m elevation$/)).toBeVisible(); expect(requests).toBe(fetched);
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'Download GLB'}).click();
  const glb=await readGlb(await download); expect(glb.meshes.length).toBeGreaterThan(10);
  await page.screenshot({path:'test-results/layers-terrain.png'}); expect(errors).toEqual([]);
});


test('504 uses a backup server and repeated generation reuses the saved response', async ({page}) => {
  const calls: string[] = [];
  await page.route('**/api/interpreter', route => {
    const url = route.request().url(); calls.push(url);
    if (url.includes('overpass-api.de')) return route.fulfill({status:504,body:'Busy'});
    return route.fulfill({json:{elements:richElements}});
  });
  await page.goto('/'); await selectRectangle(page);
  expect(calls).toHaveLength(5); expect(calls[1]).toContain('overpass.private.coffee');
  await page.getByRole('button',{name:'Edit boundary',exact:true}).click();
  await page.getByRole('button',{name:'Generate 3D scene',exact:true}).click();
  await expect(page.locator(".layer-hint")).toContainText("Scene ready", {timeout:15000});
  expect(calls).toHaveLength(5);
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('viewer opens immediately, preserves successful layers, and retries only the failed batch', async ({page}) => {
  let releaseBuildings!: () => void, releasePlaces!: () => void;
  const buildingsGate = new Promise<void>(resolve => releaseBuildings = resolve);
  const placesGate = new Promise<void>(resolve => releasePlaces = resolve);
  let transportFails = true;
  const calls = {buildings:0,transport:0,landscape:0,places:0};
  await page.route('**/api/interpreter', async route => {
    const q = route.request().postData() || '';
    if(q.includes('["building:part"]')) {calls.buildings++;await buildingsGate;return route.fulfill({json:{elements:[richElements[0]]}});}
    if(q.includes('["highway"]')) {calls.transport++;return transportFails ? route.fulfill({status:504,body:'Busy'}) : route.fulfill({json:{elements:richElements.slice(2,5)}});}
    if(q.includes('["landuse"]')) {calls.landscape++;return route.fulfill({json:{elements:[]}});}
    calls.places++;await placesGate;return route.fulfill({json:{elements:richElements.slice(10)}});
  });
  try {
    await page.goto('/');await startRectangle(page);
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Scene layers'})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('Loading…');
    await expect(page.getByRole('checkbox',{name:'Water',exact:true}).locator('..')).toContainText('Queued');
    await expect(page.getByRole('button',{name:'Download GLB'})).toBeDisabled();
    releaseBuildings();
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
    await expect(page.locator('.layer-entry.error')).toHaveCount(3, {timeout:15000});
    await expect(page.getByRole('checkbox',{name:'Water',exact:true}).locator('..')).toContainText('No mapped data here', {timeout:15000});
    await expect(page.getByRole('checkbox',{name:'Points of interest',exact:true}).locator('..')).toContainText('Loading…');
    const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Download GLB'}).click();
    expect((await readGlb(await download)).nodes.map((n:{name:string})=>n.name)).toContain('way/101');
    const rawDownload = page.waitForEvent('download');
    await page.getByRole('button',{name:'Download raw data (JSON)',exact:true}).click();
    const {readFile} = await import('node:fs/promises');
    const raw = JSON.parse(await readFile((await (await rawDownload).path())!,'utf8'));
    expect(raw.scene.batches.buildings.status).toBe('ready');
    expect(raw.scene.batches.transport.status).toBe('error');
    expect(raw.scene.batches.places.status).toBe('loading');
    expect(raw.elements.map((element:{id:number})=>element.id)).toEqual([101]);
    await page.getByRole('button',{name:'Minimize scene layers'}).click();
    await expect(page.locator('.scene-notice')).toContainText('loading in the background');
    releasePlaces();
    await expect(page.locator('.layer-hint')).toContainText('3 layers unavailable');
    transportFails = false;
    await page.getByRole('button',{name:'Expand scene layers'}).click();
    await page.getByRole('button',{name:'Retry Roads',exact:true}).click();
    await expect(page.locator('.layer-hint')).toContainText('Scene ready', {timeout:15000});
    await expect(page.locator('.layer-entry.error')).toHaveCount(0);
    expect(calls).toEqual({buildings:1,transport:3,landscape:1,places:1});
    await page.screenshot({path:'test-results/progressive-layers.png'});
  } finally {releaseBuildings();releasePlaces();}
});

test('stopping background loads keeps completed features, and changing the boundary ignores old responses',async({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/interpreter',async route=>{
    const q=route.request().postData()||'';
    if(q.includes('["building:part"]')) return route.fulfill({json:{elements:[richElements[0]]}});
    await gate;await route.fulfill({json:{elements:richElements.slice(2,5)}}).catch(()=>{});
  });
  try{
    await page.goto('/');await startRectangle(page);
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
    await page.getByRole('button',{name:'Stop loading layers'}).click();
    await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('Stopped');
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
    await expect(page.getByRole('button',{name:'Download GLB'})).toBeEnabled();
    await page.getByRole('button',{name:'2D map',exact:true}).click();
    await page.getByRole('button',{name:'Clear boundary'}).click();release();
    await expect(page.getByRole('button',{name:'3D scene',exact:true})).toBeDisabled();
    await expect(page.locator('.feedback')).toContainText('Boundary cleared');
    await expect(page.getByRole('button',{name:'Generate 3D scene',exact:true})).toBeDisabled();
  }finally{release();}
});


test('rate-limited layers recover automatically in the background after a cooldown',async({page})=>{
  await page.clock.install();
  const calls: string[]=[];
  let busy=true;
  await page.route('**/api/interpreter',route=>{
    const q=route.request().postData()||'';calls.push(q);
    if(q.includes('["highway"]')&&busy) return route.fulfill({status:429,headers:{'Retry-After':'30'},body:'Busy'});
    return route.fulfill({json:{elements:q.includes('["building:part"]')?[richElements[0]]:q.includes('["highway"]')?richElements.slice(2,5):[]}});
  });
  await page.goto('/');await startRectangle(page);
  await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('Retrying automatically', {timeout:15000});
  await expect(page.locator('.layer-entry.error')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Retry Roads',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/automatic-retry-countdown.png'});
  busy=false;await page.clock.fastForward(33000);
  await expect(page.locator('.layer-hint')).toContainText('Scene ready', {timeout:15000});
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('1 feature');
  expect(calls.filter(q=>q.includes('["building:part"]'))).toHaveLength(1);
  expect(calls.filter(q=>q.includes('["highway"]'))).toHaveLength(3);
});

test('stopping during automatic cooldown cancels future retries',async({page})=>{
  await page.clock.install();let calls=0;
  await page.route('**/api/interpreter',route=>{
    calls++;const q=route.request().postData()||'';
    return q.includes('["building:part"]')?route.fulfill({json:{elements:[richElements[0]]}}):route.fulfill({status:429,headers:{'Retry-After':'30'},body:'Busy'});
  });
  await page.goto('/');await startRectangle(page);
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('Retrying automatically', {timeout:15000});
  await page.getByRole('button',{name:'Stop loading layers'}).click();const stopped=calls;
  await page.clock.fastForward(120000);
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('Stopped');
  await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
  expect(calls).toBe(stopped);
});

test('live boundary previews, collapsible layers, and returning from 3D to draw another polygon', async ({page}) => {
  await mockLayers(page); await page.goto('/');
  await expect(page.getByText(/your world|Find somewhere interesting|Select a little piece/i)).toHaveCount(0);
  const map = page.locator('.leaflet-container');
  await page.mouse.move(850,450);await page.mouse.down();await page.mouse.move(900,500,{steps:5});await page.mouse.up();
  await page.getByRole('button',{name:'Rectangle',exact:true}).click();
  const box = (await map.boundingBox())!;
  const point = (x:number,y:number) => ({x:box.x+box.width*x,y:box.y+box.height*y});
  const a=point(.35,.35),b=point(.6,.6),c=point(.65,.5);
  await page.mouse.click(a.x,a.y);await page.mouse.move(b.x,b.y);
  const preview=page.locator('.boundary-preview');
  await expect(preview).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Finish boundary first'})).toBeDisabled();
  const before=await preview.getAttribute('d');
  await page.mouse.move(c.x,c.y);
  await expect(preview).not.toHaveAttribute('d',before!);
  await page.screenshot({path:'test-results/rectangle-preview.png'});
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);await expect(page.locator('.draft-vertex')).toHaveCount(0);
  await page.getByRole('button',{name:'Polygon',exact:true}).click();
  await page.mouse.click(a.x,a.y);await page.mouse.click(c.x,c.y);await page.mouse.move(b.x,b.y);
  await expect(preview).toHaveAttribute('d',/z$/i);
  await page.screenshot({path:'test-results/polygon-preview.png'});
  await page.mouse.click(b.x,b.y);await page.getByRole('button',{name:/Finish polygon/}).click();
  await expect(preview).toHaveCount(0);
  const original=await page.locator('.boundary-selection').getAttribute('d');
  await page.getByRole('button',{name:'Generate 3D scene'}).click();
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  await expect(page.getByRole('complementary',{name:'Map tools'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Rectangle',exact:true})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'Roads',exact:true}).uncheck();
  await page.getByRole('button',{name:'Minimize scene layers'}).click();
  await expect(page.getByRole('checkbox',{name:'Buildings',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Download OBJ'})).toBeVisible();
  await page.screenshot({path:'test-results/viewer-minimized.png'});
  await page.getByRole('button',{name:'Expand scene layers'}).click();
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true})).not.toBeChecked();
  await page.getByRole('button',{name:'Edit boundary'}).click();
  await expect(page.getByRole('complementary',{name:'Map tools'})).toBeVisible();
  await expect(page.locator('.boundary-selection')).toHaveAttribute('d',original!);
  await page.getByRole('button',{name:'Polygon',exact:true}).click();
  for(const [x,y] of [[.45,.35],[.65,.35],[.55,.55]]) {const p=point(x,y);await page.mouse.click(p.x,p.y);}
  await page.getByRole('button',{name:/Finish polygon/}).click();
  await expect(page.locator('.boundary-selection')).not.toHaveAttribute('d',original!);
  await expect(page.getByRole('button',{name:'3D scene',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Generate 3D scene'}).click();
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
});

test('OBJ exports visible geometry and raw JSON keeps hidden source data and boundary metadata', async ({page}) => {
  await mockLayers(page);await page.goto('/');await selectRectangle(page);
  const {readFile}=await import('node:fs/promises');
  const downloadText=async(name:string)=>{
    const pending=page.waitForEvent('download');await page.getByRole('button',{name,exact:true}).click();
    const file=await pending;
    return {name:file.suggestedFilename(),text:await readFile((await file.path())!,'utf8')};
  };
  await page.getByRole('checkbox',{name:'Buildings',exact:true}).uncheck();
  let obj=await downloadText('Download OBJ');
  expect(obj.name).toBe('scene.obj');expect(obj.text).toMatch(/^v [-\d.]+ /m);expect(obj.text).toMatch(/^l /m);
  expect(obj.text).not.toContain('o way/101');expect(obj.text).not.toContain('o way/102');
  await page.getByRole('checkbox',{name:'Buildings',exact:true}).check();
  obj=await downloadText('Download OBJ');
  expect(obj.text).toContain('o way/101/roof');expect(obj.text).toMatch(/^f \d+\//m);
  expect(obj.text).not.toMatch(/(?:NaN|Infinity)/);
  const raw=await downloadText('Download raw data (JSON)');
  expect(raw.name).toBe('map-data.json');
  const data=JSON.parse(raw.text);
  expect(data.elements).toHaveLength(richElements.length);
  expect(data.elements.find((e:{id:number})=>e.id===111).tags.name).toBe('Corner cafe');
  expect(data.scene.visibleLayers).not.toContain('Points of interest');
  const ring=data.scene.boundary.geometry.coordinates[0];
  expect(ring).toHaveLength(5);expect(ring[0]).toEqual(ring[4]);
  expect(ring[0][0]).toBeLessThan(-70);expect(ring[0][1]).toBeGreaterThan(40);
  expect(Object.values(data.scene.batches).every((b:any)=>b.status==='ready')).toBe(true);
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'Download OBJ'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit boundary'})).toBeVisible();
  const main=await page.locator('main').boundingBox();expect(main!.width).toBe(390);
  await page.screenshot({path:'test-results/viewer-mobile.png'});
});
