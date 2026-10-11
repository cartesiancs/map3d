import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { createMapProxy, validSceneQuery } from '../server/mapProxy.ts';
import { geometryQuery, layerGroups } from '../src/data/layers.ts';

const points = [{lat:40.7148,lng:-74.009},{lat:40.7148,lng:-74.007},{lat:40.716,lng:-74.007}];
const query = geometryQuery(points, 'buildings');
const request = (body = query, headers = {}) => new Request('https://app.example/api/interpreter', {method:'POST', body, headers});
const success = () => Response.json({elements:[{type:'way',id:42,tags:{building:'yes'}}]});
function harness(fetchData, cache) {
  let time = 1700000000000;
  const calls=[];
  const handle = createMapProxy({fetch:async (...args)=>{calls.push({url:args[0],init:args[1],at:time});return fetchData(...args);}, cache, now:()=>time, wait:async ms=>{time+=ms;}});
  return {handle,calls,advance:ms=>{time+=ms;}};
}
function memoryCache() {
  const entries = new Map();
  return {match:async req=>entries.get(req.url)?.clone(),put:async(req,res)=>{entries.set(req.url,res.clone());},entries};
}

test('gateway accepts only generated read-only scene queries for every batch',()=>{
  for(const group of [...layerGroups.map(g=>g.id),undefined]) assert.ok(validSceneQuery(geometryQuery(points,group)));
  assert.ok(validSceneQuery(geometryQuery([{lat:0,lng:1e-7},{lat:1e-7,lng:0},{lat:0,lng:0}], 'buildings')));
  assert.equal(validSceneQuery('[out:json];node(1);out;'),false);
  assert.equal(validSceneQuery(query.replace('[timeout:25]','[timeout:999]')),false);
  assert.equal(validSceneQuery(geometryQuery(points.map(p=>({...p,lat:100})),'buildings')),false);
});
test('invalid methods, origins and oversized or arbitrary queries never reach Overpass',async()=>{
  const h=harness(success);
  assert.equal((await h.handle(new Request('https://app.example/api/interpreter'))).status,405);
  assert.equal((await h.handle(request(query,{Origin:'https://other.example'}))).status,403);
  assert.equal((await h.handle(request(query,{'Content-Length':'65537'}))).status,413);
  assert.equal((await h.handle(request('node(1);out;'))).status,400);
  assert.equal((await h.handle(request('x'.repeat(65537)))).status,400);
  assert.equal(h.calls.length,0);
});
test('gateway identifies the app and form-encodes data without forwarding browser headers',async()=>{
  const h=harness(success);
  const res=await h.handle(request(query,{Origin:'https://app.example',Referer:'https://app.example/viewer'}));
  assert.equal(res.status,200);assert.equal((await res.json()).elements[0].id,42);
  const headers=new Headers(h.calls[0].init.headers);
  assert.match(headers.get('User-Agent'),/Map3dStudio.*github.com\/elenichas\/map3d/);
  assert.equal(headers.get('Accept'),'application/json');assert.equal(headers.get('Origin'),null);assert.equal(headers.get('Referer'),null);
  assert.match(headers.get('Content-Type'),/application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(h.calls[0].init.body).get('data'),query);
});
test('default fetch retains the runtime global receiver and does not follow redirects',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async function (_url,init) {assert.equal(this,globalThis);assert.equal(init.redirect,'manual');return success();};
  try {assert.equal((await createMapProxy()(request())).status,200);} finally {globalThis.fetch=original;}
});
test('406 switches to backup, remembers it and spaces requests',async()=>{
  const h=harness(url=>url.includes('overpass-api.de')?new Response('Blocked',{status:406}):success());
  assert.equal((await h.handle(request())).status,200);
  assert.equal((await h.handle(request(geometryQuery(points,'transport')))).status,200);
  assert.equal(h.calls.length,3);assert.match(h.calls[1].url,/private.coffee/);assert.equal(h.calls[2].url,h.calls[1].url);
  assert.ok(h.calls[1].at-h.calls[0].at>=750);assert.ok(h.calls[2].at-h.calls[1].at>=750);
});
test('both failures retain actionable status codes and respect cooldown without hammering servers',async()=>{
  const h=harness(()=>new Response('Busy',{status:429,headers:{'Retry-After':'60'}}));
  const res=await h.handle(request());assert.equal(res.status,503);assert.ok(Number(res.headers.get('Retry-After'))>=59);
  const body=await res.json();assert.match(body.error,/HTTP 429/);assert.equal(body.failures.length,2);
  const again=await h.handle(request());assert.equal(again.status,503);assert.equal(h.calls.length,2);
  h.advance(61000);await h.handle(request());assert.equal(h.calls.length,4);
});
test('complete and empty results are cached; incomplete responses are never cached',async()=>{
  const cache=memoryCache();let n=0;
  const h=harness(()=>++n===1?Response.json({elements:[],remark:'Query timed out'}):Response.json({elements:[]}),cache);
  const first=await h.handle(request());assert.equal(first.status,200);assert.equal(first.headers.get('X-Map-Cache'),'MISS');assert.equal(h.calls.length,2);
  const second=await h.handle(request());assert.equal(second.headers.get('X-Map-Cache'),'HIT');assert.deepEqual(await second.json(),{elements:[]});assert.equal(h.calls.length,2);assert.equal(cache.entries.size,1);
});
test('cache failure preserves valid data and duplicate concurrent queries share a single upstream request',async()=>{
  let finish;
  const h=harness(()=>new Promise(resolve=>{finish=resolve;}),{match:async()=>{throw Error('cache down');},put:async()=>{throw Error('cache down');}});
  const a=h.handle(request()),b=h.handle(request());
  while(!finish) await new Promise(resolve=>setImmediate(resolve));
  finish(success());const results=await Promise.all([a,b]);
  assert.equal(h.calls.length,1);for(const res of results) assert.equal((await res.json()).elements[0].id,42);
});
test('advanced-mode worker preserves static assets and SPA routing',async()=>{
  const res=await worker.fetch(new Request('https://app.example/viewer'),{ASSETS:{fetch:async req=>new Response(new URL(req.url).pathname)}});
  assert.equal(await res.text(),'/viewer');
});
