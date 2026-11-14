import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { createMapProxy, createEnvironmentMapProxy, validSceneQuery } from '../server/mapProxy.ts';
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

test('smaller selector queries are whitelisted but altered selectors are rejected',()=>{
  for(const group of layerGroups) for(let i=0;i<group.selectors.length;i++)assert.ok(validSceneQuery(geometryQuery(points,group.id,i)));
  assert.equal(validSceneQuery(query.replace('["building"]','["secret"]')),false);
});
test('last disconnected caller cancels upstream and does not poison the next boundary',async()=>{
  let oldSignal,finish,calls=0;const controller=new AbortController();
  const handle=createMapProxy({wait:async()=>{},fetch:async(_url,init)=>{calls++;if(calls===1){oldSignal=init.signal;return new Promise(resolve=>finish=resolve);}return success();}});
  const old=handle(new Request('https://app.example/api/interpreter',{method:'POST',body:query,signal:controller.signal}));
  const rejected=assert.rejects(old,{name:'AbortError'});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await rejected;assert.equal(oldSignal.aborted,true);
  finish(new Response('Late failure',{status:429,headers:{'Retry-After':'900'}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await handle(request(geometryQuery(points,'transport')))).status,200);assert.equal(calls,2);
});
test('cancelling one subscriber preserves an identical query for another caller',async()=>{
  let finish,upstream;const aController=new AbortController();
  const h=harness((_url,init)=>{upstream=init.signal;return new Promise(resolve=>finish=resolve);});
  const a=h.handle(new Request('https://app.example/api/interpreter',{method:'POST',body:query,signal:aController.signal}));
  const rejection=assert.rejects(a,{name:'AbortError'});
  const b=h.handle(request());
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));aController.abort();await rejection;
  assert.equal(upstream.aborted,false);finish(success());assert.equal((await b).status,200);assert.equal(h.calls.length,1);
});
test('query failures carry bounded diagnostics without a long inherited service cooldown',async()=>{
  const h=harness(()=>new Response('<p>runtime error: Query timed out</p>',{status:500}));
  const response=await h.handle(request());const body=await response.json();
  assert.equal(body.retryScope,'query');assert.equal(body.canSplit,true);assert.match(body.failures[0].detail,/Query timed out/);assert.ok(!body.failures[0].detail.includes('<'));
  h.advance(3000);await h.handle(request(geometryQuery(points,'transport')));assert.equal(h.calls.length,4);
});
test('older runtimes without incoming disconnect signals still load geometry',async()=>{
  const req=request();Object.defineProperty(req,'signal',{value:undefined});
  assert.equal((await harness(success).handle(req)).status,200);
});

test('521 plus a failed connection is a service outage, never a smaller-query retry',async()=>{
  const h=harness(url=>{if(url.includes('overpass-api.de'))return new Response('error code: 521',{status:521});throw new TypeError('fetch failed');});
  const res=await h.handle(request()),body=await res.json();
  assert.equal(body.retryScope,'service');assert.equal(body.canSplit,false);
  assert.deepEqual(body.failures.map(f=>f.status),[521,'connection failure']);
  assert.ok(Number(res.headers.get('Retry-After'))>=30);
  await h.handle(request(geometryQuery(points,'transport')));assert.equal(h.calls.length,2);
  h.advance(31000);await h.handle(request());assert.equal(h.calls.length,3);
  assert.match(h.calls[2].url,/private.coffee/);
});
test('generic 502 capacity errors back off without splitting or retrying each layer immediately',async()=>{
  const h=harness(()=>new Response('All query workers are busy and the request queue is full',{status:502}));
  const res=await h.handle(request()),body=await res.json();
  assert.equal(body.retryScope,'service');assert.equal(body.canSplit,false);
  assert.ok(Number(res.headers.get('Retry-After'))>=29);
  await h.handle(request(geometryQuery(points,'landscape')));assert.equal(h.calls.length,2);
});
test('unreadable gateway responses cannot trigger expensive selector fan-out',async()=>{
  const h=harness(()=>new Response('<html>Service unavailable</html>'));
  const res=await h.handle(request()),body=await res.json();
  assert.equal(body.retryScope,'service');assert.equal(body.canSplit,false);
});
test('a transport deadline and 521 do not masquerade as an Overpass query timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let started=false;
  const h=harness((url,init)=>{
    if(url.includes('private.coffee'))return new Response('error code: 521',{status:521});
    started=true;
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  });
  const pending=h.handle(request());
  while(!started)await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(35000);
  const response=await pending,body=await response.json();
  assert.deepEqual(body.failures.map(f=>f.status),['timeout',521]);
  assert.equal(body.canSplit,false);assert.equal(body.retryScope,'service');
  assert.ok(Number(response.headers.get('Retry-After'))>=29);
});

test('overpass.ch sends its secret only as an authentication header and preserves all layer queries',async()=>{
  let time=0;const calls=[];
  const handle=createMapProxy({provider:'overpass-ch',apiKey:'test-private-key',now:()=>time,wait:async ms=>{time+=ms;},fetch:async(url,init)=>{calls.push({url,init,at:time});return success();}});
  for(const group of layerGroups) {
    const q=geometryQuery(points,group.id),res=await handle(request(q));
    assert.equal(res.status,200);assert.equal(res.headers.get('X-Map-Source'),'api.overpass.ch');
    assert.ok(!(await res.text()).includes('test-private-key'));
    const call=calls.at(-1);assert.equal(call.url,'https://api.overpass.ch/v1/interpreter');
    assert.equal(new Headers(call.init.headers).get('X-API-Key'),'test-private-key');
    assert.equal(new URLSearchParams(call.init.body).get('data'),q);
    assert.equal(call.init.redirect,'manual');
  }
  assert.equal(calls.length,4);assert.ok(calls[1].at-calls[0].at>=2100);
});
test('missing or invalid provider settings fail closed without querying public endpoints',async()=>{
  for(const config of [{provider:'overpass-ch'},{provider:'overpass-ch',apiKey:'bad\nkey'},{provider:'typo'}]) {
    let calls=0;
    const res=await createMapProxy({...config,fetch:async()=>{calls++;return success();}})(request());
    assert.equal(res.status,503);assert.equal((await res.json()).retryable,false);assert.equal(calls,0);
  }
});
test('managed authentication and quota failures are terminal, redacted, and remembered across layers',async()=>{
  for(const [status,code] of [[401,'unauthorized'],[403,'forbidden_referer'],[403,'key_scope'],[429,'quota_exceeded']]) {
    let calls=0;
    const handle=createMapProxy({apiKey:'secret-test-value',fetch:async()=>{calls++;return Response.json({error:code,message:'secret-test-value'},{status});}});
    const res=await handle(request()),text=await res.text(),body=JSON.parse(text);
    assert.equal(body.retryable,false);assert.equal(body.canSplit,false);assert.ok(!text.includes('secret-test-value'));
    if(code==='key_scope')assert.match(body.error,/All APIs/);
    await handle(request(geometryQuery(points,'transport')));assert.equal(calls,1);
  }
});
test('managed transient failure honors cooldown without falling back to public servers',async()=>{
  let time=0,calls=0;
  const handle=createMapProxy({apiKey:'test-key',now:()=>time,wait:async ms=>{time+=ms;},fetch:async url=>{
    assert.equal(url,'https://api.overpass.ch/v1/interpreter');calls++;
    return calls===1?Response.json({error:'server_busy'},{status:503,headers:{'Retry-After':'45'}}):success();
  }});
  const res=await handle(request());assert.equal(res.status,503);assert.ok(Number(res.headers.get('Retry-After'))>=45);
  const cooling=await handle(request());assert.equal((await cooling.json()).attempted,false);assert.equal(calls,1);
  time+=46000;assert.equal((await handle(request())).status,200);assert.equal(calls,2);
});
test('managed concurrent queries share identical work and defer distinct work without consuming a retry',async()=>{
  let finish,calls=0;
  const handle=createMapProxy({apiKey:'test-key',fetch:async()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const a=handle(request());
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  const b=handle(request());
  const busy=await handle(request(geometryQuery(points,'landscape')));
  assert.equal(busy.status,503);assert.equal((await busy.json()).attempted,false);assert.equal(calls,1);
  finish(success());assert.equal((await a).status,200);assert.equal((await b).status,200);
});
test('provider caches are isolated and changing a runtime secret resets rejected authentication',async()=>{
  const cache=memoryCache();let calls=0;
  const configured=createEnvironmentMapProxy({cache,wait:async()=>{},fetch:async(_url,init)=>{
    calls++;return new Headers(init.headers).get('X-API-Key')==='old-key'?Response.json({error:'unauthorized'},{status:401}):success();
  }});
  assert.equal((await configured(request(),{})).status,200);
  const denied=await configured(request(),{OVERPASS_CH_API_KEY:'old-key'});assert.equal((await denied.json()).retryable,false);
  const fresh=await configured(request(),{OVERPASS_CH_API_KEY:'new-key'});assert.equal(fresh.status,200);assert.equal(calls,3);
  assert.equal(cache.entries.size,2);
  for(const cacheKey of cache.entries.keys())assert.ok(!cacheKey.includes('new-key'));
});
test('managed transport errors never return echoed credentials to the browser',async()=>{
  const handle=createMapProxy({apiKey:'test-sensitive-key',fetch:async()=>{throw Error('failed request X-API-Key: test-sensitive-key');}});
  const res=await handle(request());assert.ok(!(await res.text()).includes('test-sensitive-key'));
});
