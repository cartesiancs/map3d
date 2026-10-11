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
  await expect(page.locator(".leaflet-control-scale-line")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate 3D scene" })).toBeDisabled();
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  const box = await page.locator(".leaflet-container").boundingBox();
  if (!box) throw new Error("Map bounds unavailable");
  await page.mouse.click(box.x + box.width * .4, box.y + box.height * .4);
  await page.mouse.click(box.x + box.width * .6, box.y + box.height * .6);
  await page.getByRole("button", { name: "Generate 3D scene" }).click();
  await expect(page.locator(".layer-hint")).toContainText("Scene ready", {timeout:15000});
  await expect(page.getByRole("heading", { name: "Scene layers" })).toBeVisible();
  await expect(page.getByRole("toolbar",{name:"Model navigation and measurement"})).toBeVisible();
  await expect(page.getByRole("img",{name:"Approximate scale at camera focus depth"})).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GLB" }).click();
  expect((await download).suggestedFilename()).toBe("scene.glb");
  expect(errors).toEqual([]);
});

test("failed requests preserve the boundary and offer retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/interpreter", route => { attempts++; return route.fulfill({ status: 400, body: "Rejected" }); });
  await page.goto("/");
  await page.getByRole("button", { name: "Polygon", exact: true }).click();
  const box = await page.locator(".leaflet-container").boundingBox();
  if (!box) throw new Error("Map unavailable");
  for (const [x,y] of [[.4,.4],[.6,.4],[.5,.6]]) await page.mouse.click(box.x + box.width*x, box.y + box.height*y);
  await page.getByRole("button", { name: /Finish polygon/ }).click();
  await page.getByRole("button", { name: "Generate 3D scene" }).click();
  await expect(page.locator(".layer-entry.error")).toHaveCount(11, {timeout:15000});
  expect(attempts).toBe(4);
  await expect(page.getByRole("button", { name: "Retry Buildings", exact: true })).toBeVisible();
  await page.getByRole("button", {name: "Back to map"}).click();
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
test('themes and scene lighting are independent, persist, and share the top toolbar with exports',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let requests=0;
  await mockLayers(page);
  await page.route('**/api/interpreter',route=>{requests++;return route.fulfill({json:{elements:richElements}});});
  await page.emulateMedia({colorScheme:'light'});
  await page.goto('/');
  await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('header')).toHaveCSS('background-color','rgb(27, 32, 58)');
  await page.screenshot({path:'test-results/theme-dark-map.png'});
  await selectRectangle(page);
  const count=requests;
  await page.evaluate(()=>{(window as any).__originalCanvas=document.querySelector('canvas');});
  const background=async()=>{
    const box=(await page.locator('canvas').boundingBox())!;
    const image=await page.screenshot({clip:{x:box.x+2,y:box.y+2,width:1,height:1}});
    return page.evaluate(async base64=>{
      const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
      return [...context.getImageData(0,0,1,1).data].slice(0,3);
    },image.toString('base64'));
  };
  await expect.poll(background).toEqual([238,237,248]);
  await page.getByRole('button',{name:'Night lighting',exact:true}).click();
  await expect.poll(background).toEqual([17,21,46]);
  await expect(page.getByRole('button',{name:'Night lighting',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:'test-results/theme-dark-night.png'});
  await page.getByRole('button',{name:'Light theme',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(page.getByRole('button',{name:'Night lighting',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Day lighting',exact:true}).click();
  await expect.poll(background).toEqual([238,237,248]);
  await page.screenshot({path:'test-results/theme-light-day.png'});
  expect(await page.evaluate(()=>document.querySelector('canvas')===(window as any).__originalCanvas)).toBe(true);
  expect(requests).toBe(count);
  for(const name of ['Download GLB','Download OBJ','Download raw data (JSON)','Day lighting','Night lighting','Dark theme']) await expect(page.locator('header').getByRole('button',{name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  await page.getByRole('button',{name:'Night lighting',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Minimize scene layers'}).click();
  const header=(await page.locator('header').boundingBox())!;
  for(const name of ['Download GLB','Download OBJ','Download raw data (JSON)','Night lighting','Dark theme']) {
    const button=(await page.getByRole('button',{name,exact:true}).boundingBox())!;
    expect(button.x).toBeGreaterThanOrEqual(0);expect(button.x+button.width).toBeLessThanOrEqual(390);
    expect(button.y+button.height).toBeLessThanOrEqual(header.y+header.height);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({path:'test-results/theme-mobile-night.png'});
  await page.reload();
  await expect(page.getByRole('button',{name:'Dark theme',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page).toHaveURL('/viewer');
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  await expect(page.getByRole('button',{name:'Night lighting',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(errors).toEqual([]);
});
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
  await page.getByRole('button',{name:'Back to map',exact:true}).click();
  await page.goBack();
  await expect(page).toHaveURL('/viewer');
  await expect(page.locator('canvas')).toBeVisible();
  await page.screenshot({path:'test-results/layers-desktop.png'});
  expect(unexpectedDownloads).toBe(0); expect(errors).toEqual([]);
});
test('nested road and POI types filter independently, clear selection, and preserve raw source data',async({page})=>{
  let requests=0;
  const extras=[
    {type:'way',id:300,tags:{highway:'service'},geometry:[{lat:40.799,lon:-73.9503},{lat:40.801,lon:-73.9503}]},
    {type:'way',id:301,tags:{highway:'primary'},geometry:[{lat:40.799,lon:-73.9501},{lat:40.801,lon:-73.9501}]},
    {type:'node',id:302,tags:{amenity:'restaurant',name:'Test restaurant'},lat:40.8003,lon:-73.9498},
    {type:'node',id:303,tags:{shop:'bakery',name:'Test bakery'},lat:40.8005,lon:-73.9498},
  ];
  await mockLayers(page);
  await page.route('**/api/interpreter',route=>{requests++;return route.fulfill({json:{elements:[...richElements,...extras]}});});
  await page.goto('/');await selectRectangle(page);const count=requests;
  await page.getByRole('button',{name:'Show Roads sublayers',exact:true}).click();
  const service=page.getByRole('checkbox',{name:'Roads: Service roads',exact:true});
  await expect(service).toBeChecked();
  await service.uncheck();
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true})).toHaveAttribute('aria-checked','mixed');
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('2 visible');
  let download=page.waitForEvent('download');await page.getByRole('button',{name:'Download GLB',exact:true}).click();
  const names=(await readGlb(await download)).nodes.map((node:{name:string})=>node.name);
  expect(names).toContain('way/103');expect(names).toContain('way/301');expect(names).not.toContain('way/300');
  await page.getByRole('checkbox',{name:'Points of interest',exact:true}).check();
  await page.getByRole('button',{name:'Show Points of interest sublayers',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'Points of interest: Shops · Bakery',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Inspect Corner cafe',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Feature details'})).toBeVisible();
  await page.getByRole('checkbox',{name:'Points of interest: Cafés',exact:true}).uncheck();
  await expect(page.getByRole('dialog',{name:'Feature details'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Inspect Corner cafe',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Inspect Test restaurant',exact:true})).toBeVisible();
  download=page.waitForEvent('download');await page.getByRole('button',{name:'Download raw data (JSON)',exact:true}).click();
  const {readFile}=await import('node:fs/promises');
  const raw=JSON.parse(await readFile((await (await download).path())!,'utf8'));
  expect(raw.elements.some((element:{id:number})=>element.id===111)).toBe(true);
  expect(raw.scene.sublayers.find((type:{label:string;parent:string})=>type.label==='Cafés' && type.parent==='Points of interest').visible).toBe(false);
  await page.getByRole('checkbox',{name:'Roads',exact:true}).click();
  await expect(service).toBeChecked();
  await page.getByRole('checkbox',{name:'Roads',exact:true}).uncheck();
  await expect(service).toBeDisabled();
  await page.getByRole('checkbox',{name:'Roads',exact:true}).check();
  await expect(service).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true})).toHaveAttribute('aria-checked','true');
  expect(requests).toBe(count);
  await page.getByRole('button',{name:'Hide Roads sublayers',exact:true}).click();
  await expect(service).toBeHidden();
  await page.screenshot({path:'test-results/sublayers-desktop.png'});
});
test('layer drawer scrolls overflowing sublayers while keeping its heading visible',async({page})=>{
  await mockLayers(page);await page.goto('/');await selectRectangle(page);
  for(const size of [{width:1280,height:720},{width:390,height:844}]) {
    await page.setViewportSize(size);
    const list=page.getByRole('region',{name:'Scene layer list',exact:true});
    const heading=page.locator('.layer-panel-heading');
    await list.evaluate(element=>{element.scrollTop=0;});
    const before=(await heading.boundingBox())!;
    await expect.poll(()=>list.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
    await list.hover();await page.mouse.wheel(0,1200);
    await expect.poll(()=>list.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('checkbox',{name:'Terrain',exact:true})).toBeInViewport();
    const after=(await heading.boundingBox())!;
    expect(after.y).toBe(before.y);
    await expect(page.getByRole('button',{name:'Minimize scene layers',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(size.width);
  }
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
  await page.getByRole('button',{name:'Back to map',exact:true}).click();
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
    if(q.includes('["highway"]')) {calls.transport++;return transportFails ? route.fulfill({status:400,body:'Rejected'}) : route.fulfill({json:{elements:richElements.slice(2,5)}});}
    if(q.includes('["landuse"]')) {calls.landscape++;return route.fulfill({json:{elements:[]}});}
    calls.places++;await placesGate;return route.fulfill({json:{elements:richElements.slice(10)}});
  });
  try {
    await page.goto('/');await startRectangle(page);
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Scene layers'})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('Downloading map data…');
    await expect(page.getByRole('checkbox',{name:'Water',exact:true}).locator('..')).toContainText('Queued');
    await expect(page.getByRole('button',{name:'Download GLB'})).toBeDisabled();
    releaseBuildings();
    await expect(page.getByRole('checkbox',{name:'Buildings',exact:true}).locator('..')).toContainText('1 feature');
    await expect(page.locator('.layer-entry.error')).toHaveCount(3, {timeout:15000});
    await expect(page.getByRole('checkbox',{name:'Water',exact:true}).locator('..')).toContainText('No mapped data here', {timeout:15000});
    await expect(page.getByRole('checkbox',{name:'Points of interest',exact:true}).locator('..')).toContainText('Downloading map data…');
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
    await expect(page.locator('.scene-notice')).toContainText('downloading');
    releasePlaces();
    await expect(page.locator('.layer-hint')).toContainText('3 layers unavailable');
    transportFails = false;
    await page.getByRole('button',{name:'Expand scene layers'}).click();
    await page.getByRole('button',{name:'Retry Roads',exact:true}).click();
    await expect(page.locator('.layer-hint')).toContainText('Scene ready', {timeout:15000});
    await expect(page.locator('.layer-entry.error')).toHaveCount(0);
    expect(calls).toEqual({buildings:1,transport:2,landscape:1,places:1});
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
    await page.getByRole('button',{name:'Back to map',exact:true}).click();
    await page.getByRole('button',{name:'Clear boundary'}).click();release();
    await expect(page).toHaveURL('/map');
    await expect(page.getByRole('button',{name:'3D scene',exact:true})).toHaveCount(0);
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
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText(/automatically|automatic retry/, {timeout:15000});
  await expect(page.locator('.layer-entry.error')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Retry Roads',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/automatic-retry-countdown.png'});
  busy=false;await page.clock.fastForward(33000);
  await expect(page.locator('.layer-hint')).toContainText('Scene ready', {timeout:15000});
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText('1 feature');
  expect(calls.filter(q=>q.includes('["building:part"]'))).toHaveLength(1);
  expect(calls.filter(q=>q.includes('["highway"]')).length).toBeGreaterThanOrEqual(2);
});

test('stopping during automatic cooldown cancels future retries',async({page})=>{
  await page.clock.install();let calls=0;
  await page.route('**/api/interpreter',route=>{
    calls++;const q=route.request().postData()||'';
    return q.includes('["building:part"]')?route.fulfill({json:{elements:[richElements[0]]}}):route.fulfill({status:429,headers:{'Retry-After':'30'},body:'Busy'});
  });
  await page.goto('/');await startRectangle(page);
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true}).locator('..')).toContainText(/automatically|automatic retry/, {timeout:15000});
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
  await page.getByRole('button',{name:'Back to map'}).click();
  await expect(page.getByRole('complementary',{name:'Map tools'})).toBeVisible();
  await expect(page.locator('.boundary-selection')).toHaveAttribute('d',original!);
  await page.getByRole('button',{name:'Polygon',exact:true}).click();
  for(const [x,y] of [[.45,.35],[.65,.35],[.55,.55]]) {const p=point(x,y);await page.mouse.click(p.x,p.y);}
  await page.getByRole('button',{name:/Finish polygon/}).click();
  await expect(page.locator('.boundary-selection')).not.toHaveAttribute('d',original!);
  await expect(page).toHaveURL('/map');
    await expect(page.getByRole('button',{name:'3D scene',exact:true})).toHaveCount(0);
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
  await expect(page.getByRole('button',{name:'Back to map'})).toBeVisible();
  const main=await page.locator('main').boundingBox();expect(main!.width).toBe(390);
  await page.screenshot({path:'test-results/viewer-mobile.png'});
});


test('map and viewer routes restore history boundaries, reload, and handle an empty viewer link',async({page})=>{
  let requests=0;
  await mockLayers(page);
  await page.route('**/api/interpreter',route=>{requests++;return route.fulfill({json:{elements:richElements}});});
  await page.goto('/viewer');
  await expect(page).toHaveURL('/map');
  await expect(page.getByRole('button',{name:'Back to map',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'2D map',exact:true})).toHaveCount(0);
  await selectRectangle(page);
  await expect(page).toHaveURL('/viewer');
  await expect(page.getByRole('button',{name:'3D scene',exact:true})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'Roads',exact:true}).uncheck();
  const loaded=requests;
  await page.goBack();await expect(page).toHaveURL('/map');
  const original=await page.locator('.boundary-selection').getAttribute('d');
  await page.goForward();await expect(page).toHaveURL('/viewer');
  await expect(page.getByRole('checkbox',{name:'Roads',exact:true})).not.toBeChecked();
  expect(requests).toBe(loaded);
  await page.getByRole('button',{name:'Back to map',exact:true}).click();
  await expect(page).toHaveURL('/map');
  await expect(page.locator('.boundary-selection')).toHaveAttribute('d',original!);
  await page.getByRole('button',{name:'Clear boundary'}).click();
  await page.getByRole('button',{name:'Polygon',exact:true}).click();
  const box=(await page.locator('.leaflet-container').boundingBox())!;
  for(const [x,y] of [[.3,.3],[.5,.3],[.4,.5]]) await page.mouse.click(box.x+box.width*x,box.y+box.height*y);
  await page.getByRole('button',{name:/Finish polygon/}).click();
  const replacement=await page.locator('.boundary-selection').getAttribute('d');
  expect(replacement).not.toBe(original);
  await page.getByRole('button',{name:'Generate 3D scene',exact:true}).click();
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  await page.goBack();await expect(page).toHaveURL('/map');
  await expect(page.locator('.boundary-selection')).toHaveAttribute('d',replacement!);
  await page.goBack();await expect(page).toHaveURL('/viewer');
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download raw data (JSON)',exact:true}).click();
  const {readFile}=await import('node:fs/promises');
  const raw=JSON.parse(await readFile((await (await download).path())!,'utf8'));
  expect(raw.scene.boundary.geometry.coordinates[0]).toHaveLength(5); // Earlier rectangle, not the newer triangle.
  await page.reload();await expect(page).toHaveURL('/viewer');
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button',{name:'Back to map',exact:true}).click();
  await expect(page.getByText('Boundary selected')).toBeVisible();
  await page.goto('/viewer');await expect(page).toHaveURL('/viewer');
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
});

for (const mobile of [false, true]) test(`data guide is accessible on map and viewer${mobile ? ' on mobile' : ''}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({width:390,height:844});
  await mockLayers(page);
  await page.goto('/map');
  const trigger = page.getByRole('button', {name:'Data & guide',exact:true});
  const guide = page.getByRole('dialog', {name:'From map data to 3D'});
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(guide).toBeVisible();
  await expect(page.getByRole('button',{name:'Close data guide'})).toBeFocused();
  await expect(guide.getByLabel('Data accuracy notice')).toContainText('Use this app and its exports at your own risk');
  await expect(guide.getByRole('link',{name:'cartesiancs/map3d',exact:true})).toHaveAttribute('href','https://github.com/cartesiancs/map3d');
  await page.screenshot({path:`test-results/data-guide-map${mobile ? '-mobile' : ''}.png`});
  // Native modal dialogs make the underlying workspace inert.
  await trigger.evaluate(button=>button.focus());
  await expect(page.getByRole('button',{name:'Close data guide'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(guide.getByRole('link',{name:'OpenStreetMap',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button',{name:'Close data guide'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(guide).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await selectRectangle(page);
  const canvas = await page.locator('canvas').elementHandle();
  await trigger.click();
  await expect(guide).toBeVisible();
  const bounds = (await guide.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y+bounds.height).toBeLessThanOrEqual(mobile?844:900);
  await guide.getByRole('link',{name:'Open Database License (ODbL)'}).scrollIntoViewIfNeeded();
  await expect(guide.getByRole('heading',{name:'Project & credits'})).toBeVisible();
  await page.getByRole('button',{name:'Close data guide'}).click();
  await expect(guide).not.toBeVisible();
  await expect(page).toHaveURL(/\/viewer$/);
  expect(await canvas?.evaluate(element=>element===document.querySelector('canvas'))).toBe(true);
  await trigger.click();
  await page.mouse.click(2,2);
  await expect(guide).not.toBeVisible();
});
