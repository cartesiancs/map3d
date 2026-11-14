import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSceneQueries} from '../src/data/queryScheduler.ts';
import {createGeometryClient,GeometryRequestError} from '../src/data/overpass.ts';
import {createMapProxy} from '../server/mapProxy.ts';
const points=[{lat:40,lng:23},{lat:40,lng:23.01},{lat:40.01,lng:23}];
const groups=['buildings','transport','landscape','places'];
const element={type:'way',id:1,tags:{building:'yes'}};
function harness(attempt){
  let time=0;const events=[],calls=[];
  return {events,calls,run:(signal=new AbortController().signal)=>loadSceneQueries(points,groups,signal,{now:()=>time,wait:async(ms,signal)=>{signal.throwIfAborted();time+=ms;},attempt:async(q,s)=>{calls.push(q);return attempt(q,s,time);},onGroup:(group,state,elements)=>events.push({group,...state,elements})}),time:()=>time};
}
test('buildings retry yields to every healthy batch and then recovers automatically',async()=>{
  let buildings=0;
  const h=harness(async q=>{if(q.includes('"building"')&&++buildings===1)throw new GeometryRequestError('Busy',true,5000,true,true);return [element];});
  await h.run();
  assert.ok(h.calls[1].includes('highway'));assert.ok(h.calls[2].includes('landuse'));assert.ok(h.calls[3].includes('amenity'));assert.ok(h.calls[4].includes('building'));
  assert.equal(h.events.filter(e=>e.status==='ready').length,4);
});
test('repeated heavy batch failures split by selector, keep partial data, deduplicate and finish',async()=>{
  const h=harness(async q=>{if(q.includes('"building"')&&q.includes('"building:part"'))throw new GeometryRequestError('Too heavy',true,0,true,true);return [element];});
  await h.run();
  const results=h.events.filter(e=>e.group==='buildings'&&e.elements);
  assert.equal(results.length,2);assert.equal(results[0].status,'queued');assert.equal(results[1].status,'ready');assert.deepEqual(results[1].elements,[element]);
});
test('permanent errors never split or retry and other groups finish',async()=>{
  const h=harness(async q=>{if(q.includes('building'))throw new GeometryRequestError('Invalid',false);return [];});
  await h.run();assert.equal(h.calls.length,4);assert.equal(h.events.filter(e=>e.status==='error').length,1);
});
test('persistent transient errors stop with bounded requests and leave failed groups explicit',async()=>{
  const h=harness(async()=>{throw new GeometryRequestError('HTTP 500',true,0,true,true);});
  await h.run();assert.ok(h.calls.length<=48);assert.ok(h.time()<=360000);assert.equal(new Set(h.events.filter(e=>e.status==='error').map(e=>e.group)).size,4);
});
test('one failed split never discards a successful sibling or reports the batch complete',async()=>{
  const h=harness(async q=>{if(q.includes('building:part'))throw new GeometryRequestError('Incomplete',true,0,true,true);return [element];});
  await h.run();const events=h.events.filter(e=>e.group==='buildings');
  assert.ok(events.some(e=>e.elements?.length===1));assert.equal(events.at(-1).status,'error');assert.ok(!events.some(e=>e.status==='ready'));
});
test('cancellation during a download ignores a late success and never starts another batch',async()=>{
  const controller=new AbortController();const h=harness(async()=>{controller.abort();return [element];});
  await assert.rejects(h.run(controller.signal),{name:'AbortError'});assert.equal(h.calls.length,1);assert.ok(!h.events.some(e=>e.elements));
});
test('service cooldown is shared, respected, and does not consume attempts while waiting',async()=>{
  let time=0,calls=0;const start=[];
  const client=createGeometryClient({endpoints:['/api/interpreter'],now:()=>time,random:()=>0,wait:async ms=>{time+=ms;},fetch:async()=>{start.push(time);return ++calls===1?Response.json({retryScope:'service',error:'Busy'},{status:503,headers:{'Retry-After':'30'}}):Response.json({elements:[]});}});
  await loadSceneQueries(points,groups,new AbortController().signal,{now:()=>time,wait:async ms=>{time+=ms;},attempt:client.attempt,onGroup:()=>{}});
  assert.equal(calls,5);assert.ok(start[1]>=30000);
});
test('aborted old response cannot impose a cooldown or poison new boundary data',async()=>{
  let finish,calls=0,time=0;const controller=new AbortController();
  const client=createGeometryClient({endpoints:['/api/interpreter'],now:()=>time,wait:async ms=>{time+=ms;},fetch:async()=>++calls===1?new Promise(resolve=>finish=resolve):Response.json({elements:[element]})});
  const old=client.attempt('old',controller.signal);controller.abort();finish(new Response('Busy',{status:429,headers:{'Retry-After':'999'}}));
  await assert.rejects(old,{name:'AbortError'});
  assert.deepEqual(await client.attempt('new',new AbortController().signal),[element]);assert.equal(calls,2);
});
test('end-to-end 521 outages respect cooldown across all groups without selector fan-out',async()=>{
  let time=0;const calls=[],events=[];
  const gateway=createMapProxy({now:()=>time,wait:async ms=>{time+=ms;},fetch:async(_url,init)=>{
    calls.push({at:time,query:new URLSearchParams(init.body).get('data')});
    return new Response('error code: 521',{status:521});
  }});
  const client=createGeometryClient({endpoints:['/api/interpreter'],now:()=>time,random:()=>0,wait:async ms=>{time+=ms;},fetch:async(_url,init)=>gateway(new Request('https://app.example/api/interpreter',init))});
  await loadSceneQueries(points,groups,new AbortController().signal,{now:()=>time,wait:async ms=>{time+=ms;},attempt:client.attempt,onGroup:(_group,state)=>events.push(state)});
  assert.ok(calls.length<=6);assert.ok(calls[2].at-calls[0].at>=120000);
  assert.ok(!events.some(state=>state.message?.includes('smaller')));
  assert.ok(events.some(state=>state.status==='waiting'));
  assert.equal(events.filter(state=>state.status==='error').length,4);
});
