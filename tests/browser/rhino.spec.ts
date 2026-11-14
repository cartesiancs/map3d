import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import rhino3dm from 'rhino3dm';
const rhino=await rhino3dm();
const ring=(lat=40.7996,lon=-73.9505)=>[{lat,lon},{lat,lon:lon+.0002},{lat:lat+.0002,lon:lon+.0002},{lat:lat+.0002,lon},{lat,lon}];
const elements=[
  {type:'way',id:101,tags:{building:'house',height:'20','roof:shape':'gabled','roof:height':'3',name:'Test house'},geometry:ring()},
  {type:'way',id:102,tags:{highway:'residential',name:'Test street'},geometry:[{lat:40.799,lon:-73.951},{lat:40.801,lon:-73.951}]},
  {type:'way',id:103,tags:{highway:'service'},geometry:[{lat:40.799,lon:-73.9508},{lat:40.801,lon:-73.9508}]},
  {type:'way',id:104,tags:{landuse:'commercial'},geometry:ring(40.8,-73.9504)},
  {type:'node',id:105,tags:{amenity:'cafe',name:'Corner café'},lat:40.8,lon:-73.95},
  {type:'node',id:106,tags:{natural:'tree'},lat:40.8,lon:-73.9503},
];
const rows=(file:any)=>Array.from({length:file.objects().count},(_,i)=>file.objects().get(i));
const layerRows=(file:any)=>Array.from({length:file.layers().count},(_,i)=>file.layers().get(i));
const strings=(file:any)=>Object.fromEntries(Array.from({length:file.strings().count},(_,i)=>file.strings().get(i)));
async function generate(page:import('@playwright/test').Page) {
  await page.goto('/map');await page.getByRole('button',{name:'Rectangle',exact:true}).click();
  const box=(await page.locator('.leaflet-container').boundingBox())!;
  await page.mouse.click(box.x+box.width*.4,box.y+box.height*.4);await page.mouse.click(box.x+box.width*.6,box.y+box.height*.6);
  await page.getByRole('button',{name:'Generate 3D scene'}).click();
}
async function download(page:import('@playwright/test').Page) {
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download Rhino 3DM'}).click();
  const file=await pending;expect(file.suggestedFilename()).toBe('scene.3dm');
  return rhino.File3dm.fromByteArray(new Uint8Array(await readFile((await file.path())!)));
}
for(const batched of [false,true]) test(`Rhino download retains hidden geometry, nested visibility, groups and materials${batched?' in a batched scene':''}`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  let wasmRequests=0;page.on('request',request=>{if(request.url().includes('.wasm')) wasmRequests++;});
  const data=batched?[...elements,...Array.from({length:260},(_,i)=>({...elements[0],id:200+i,geometry:ring(40.802+i*.00001,-73.951)}))]:elements;
  await page.route('**/api/interpreter',route=>route.fulfill({json:{elements:data}}));
  await page.route('**/*.tile.openstreetmap.org/**',route=>route.fulfill({status:204,body:''}));
  await generate(page);await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  expect(wasmRequests).toBe(0);
  if(!batched) await page.screenshot({path:'test-results/rhino-export-viewer.png'});
  await page.getByRole('button',{name:'Show Roads sublayers',exact:true}).click();
  await page.getByRole('checkbox',{name:'Roads: Service roads',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'Buildings',exact:true}).uncheck();
  const file=await download(page);
  try {
    expect(file).toBeTruthy();expect(file.settings().modelUnitSystem.value).toBe(rhino.UnitSystem.Meters.value);
    const all=rows(file),layers=layerRows(file),root=layers.find(l=>l.name==='Map3d'),roads=layers.find(l=>l.name==='Roads');
    expect(roads.parentLayerId).toBe(root.id);expect(layers.find(l=>l.name==='Service roads').parentLayerId).toBe(roads.id);
    expect(layers.find(l=>l.name==='Service roads').visible).toBe(false);expect(layers.find(l=>l.name==='Buildings').visible).toBe(false);
    expect(all.filter(o=>o.attributes().getUserString('OSM ID')==='way/101')).toHaveLength(2);
    expect(all.filter(o=>o.attributes().getUserString('OSM ID')==='node/105')).toHaveLength(2);
    expect(all.every(o=>o.geometry().isValid && o.attributes().groupCount===1)).toBe(true);
    expect(all.every(o=>o.attributes().name && o.attributes().getUserString('OSM ID'))).toBe(true);
    expect(file.groups().count).toBe(data.length);
    expect(file.materials().count).toBeGreaterThan(4);
    expect(strings(file)['map3d:source']).toContain('OpenStreetMap');
    expect(JSON.parse(strings(file)['map3d:snapshot']).incomplete).toBe(false);
  } finally {file.destroy();file.delete();}
  expect(wasmRequests).toBeGreaterThan(0);expect(errors).toEqual([]);
  await expect(page.getByRole('status').filter({hasText:'Rhino downloaded'})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  const header=(await page.locator('header').boundingBox())!,button=(await page.getByRole('button',{name:'Download Rhino 3DM'}).boundingBox())!;
  expect(button.x).toBeGreaterThanOrEqual(0);expect(button.x+button.width).toBeLessThanOrEqual(390);
  expect(await page.locator('header').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  const footer=(await page.locator('.viewport-bottom').boundingBox())!;
  expect(footer.height).toBeLessThan(45);expect(footer.x+footer.width).toBeLessThanOrEqual(390);
  expect(await page.getByRole('button',{name:'Data & guide'}).isVisible()).toBe(true);
  await page.screenshot({path:`test-results/rhino-toolbar${batched?'-batched':''}-mobile.png`});
  expect(header.height).toBeLessThan(125);
});

test('Rhino exports a labeled partial snapshot while layers keep loading and can cancel initialization',async({page})=>{
  let releaseLayers:()=>void=()=>{};const gate=new Promise<void>(resolve=>{releaseLayers=resolve;});
  await page.route('**/api/interpreter',async route=>{
    if((route.request().postData()||'').includes('"building"')) return route.fulfill({json:{elements:[elements[0]]}});
    await gate;await route.fulfill({json:{elements:[]}});
  });
  await page.route('**/*.tile.openstreetmap.org/**',route=>route.fulfill({status:204,body:''}));
  await generate(page);await expect(page.getByRole('button',{name:'Download Rhino 3DM'})).toBeEnabled();
  // Hold the local WASM request so cancellation is deterministic, with no late download.
  let releaseWasm:()=>void=()=>{};const wasmGate=new Promise<void>(resolve=>{releaseWasm=resolve;});
  await page.route('**/*.wasm*',async route=>{await wasmGate;await route.continue();});
  let downloads=0;page.on('download',()=>{downloads++;});
  await page.getByRole('button',{name:'Download Rhino 3DM'}).click();
  await expect(page.getByRole('button',{name:'Cancel Rhino export'})).toBeVisible();
  await page.getByRole('button',{name:'Cancel Rhino export'}).click();
  await expect(page.getByRole('status').filter({hasText:'Rhino export cancelled'})).toBeVisible();
  expect(downloads).toBe(0);releaseWasm();await page.unroute('**/*.wasm*');
  const file=await download(page);
  try {
    expect(file.objects().count).toBe(2);
    expect(JSON.parse(strings(file)['map3d:snapshot']).incomplete).toBe(true);
    expect(Object.values(JSON.parse(strings(file)['map3d:layerStatus']))).toContain('loading');
  } finally {file.destroy();file.delete();}
  await expect(page.getByRole('status').filter({hasText:'Partial data snapshot'})).toBeVisible();
  releaseLayers();await expect(page.locator('.layer-hint')).toContainText('Scene ready');
});
