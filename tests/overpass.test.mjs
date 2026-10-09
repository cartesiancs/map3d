import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeometryClient, retryAfterMilliseconds } from '../src/data/overpass.ts';
function harness(fetchData) {
  let time=1700000000000;const waits=[];
  const client=createGeometryClient({fetch:fetchData,now:()=>time,random:()=>0,wait:async(ms,signal)=>{signal.throwIfAborted();waits.push(ms);time+=ms;}});
  return {client,waits,now:()=>time,advance:ms=>{time+=ms;}};
}
const success=(elements=[{type:'node',id:1,lat:0,lon:0,tags:{natural:'tree'}}])=>({ok:true,status:200,json:async()=>({elements})});
test('504 recovers through backup, then healthy server is preferred for subsequent batches',async()=>{
  const calls=[],progress=[];
  const h=harness(async url=>{calls.push(url);if(calls.length===1){h.advance(5000);return {ok:false,status:504};}return success();});
  await h.client('first',new AbortController().signal,s=>progress.push(s));
  await h.client('second',new AbortController().signal,()=>{});
  assert.equal(calls.length,3);assert.match(calls[1],/private\.coffee/);assert.equal(calls[2],calls[1]);assert.match(progress[1],/backup/);
  await h.client('first',new AbortController().signal,()=>{});assert.equal(calls.length,3);
});
test('both unavailable servers terminate bounded attempts without returning an empty scene',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return {ok:false,status:504};});
  await assert.rejects(h.client('busy',new AbortController().signal,()=>{}),/busy or timed out.*504.*Loaded layers are kept/);assert.equal(calls,2);
});
test('cancellation during a request never retries',async()=>{
  const controller=new AbortController();let calls=0;
  const h=harness(async()=>{calls++;controller.abort();throw new DOMException('Aborted','AbortError');});
  await assert.rejects(h.client('cancel',controller.signal,()=>{}),{name:'AbortError'});assert.equal(calls,1);
});
test('429 uses another independent service and remembers the blocked endpoint across batches',async()=>{
  const calls=[];
  const h=harness(async url=>{calls.push(url);return url.includes('overpass-api.de')?{ok:false,status:429,headers:new Headers({'Retry-After':'60'})}:success();});
  await h.client('rate-first',new AbortController().signal,()=>{});
  await h.client('rate-second',new AbortController().signal,()=>{});
  assert.equal(calls.filter(url=>url.includes('overpass-api.de')).length,1);assert.equal(calls.length,3);
});
test('when both services are rate limited, Retry-After is respected and recovery happens automatically',async()=>{
  const calls=[],updates=[];const start=1700000000000;
  const h=harness(async url=>{calls.push({url,at:h.now()});return calls.length<=2?{ok:false,status:429,headers:new Headers({'Retry-After':'45'})}:success();});
  const data=await h.client('rate-wait',new AbortController().signal,(message,p)=>updates.push({message,...p}));
  assert.equal(data[0].id,1);assert.equal(calls.length,3);assert.ok(calls[2].at-start>=45000);assert.ok(updates.some(p=>p.phase==='waiting'&&p.message.includes('automatically')));
});
test('repeated throttling uses exponential cooldown and eventually stops without an endless loop',async()=>{
  const calls=[];const h=harness(async url=>{calls.push({url,at:h.now()});return {ok:false,status:429};});
  await assert.rejects(h.client('rate-exhaust',new AbortController().signal,()=>{}),/after automatic retries/);
  assert.equal(calls.length,6);
  const first=calls.filter(c=>c.url.includes('overpass-api.de'));
  assert.ok(first[1].at-first[0].at>=30000);assert.ok(first[2].at-first[1].at>=60000);
});
test('cancellation during cooldown stops timers and makes no further request',async()=>{
  let calls=0,time=1700000000000;const controller=new AbortController();
  const client=createGeometryClient({fetch:async()=>{calls++;return {ok:false,status:429};},now:()=>time,random:()=>0,wait:async(ms,signal)=>{if(ms>750)controller.abort();else time+=ms;signal.throwIfAborted();}});
  await assert.rejects(client('cancel-wait',controller.signal,()=>{}),{name:'AbortError'});assert.equal(calls,2);
});
test('invalid queries do not get retried',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return {ok:false,status:400};});
  await assert.rejects(h.client('invalid',new AbortController().signal,()=>{}),/400/);assert.equal(calls,1);
});
test('partial timeout responses are retried and never cached as complete data',async()=>{
  let calls=0;const h=harness(async()=>++calls===1?{ok:true,status:200,json:async()=>({remark:'Query timed out',elements:[]})}:success());
  assert.equal((await h.client('remark',new AbortController().signal,()=>{}))[0].id,1);assert.equal(calls,2);
});
test('empty results are cached, and rapid batches are spaced at least 750 ms apart',async()=>{
  const calls=[];const h=harness(async()=>{calls.push(h.now());return success([]);});
  await h.client('empty',new AbortController().signal,()=>{});await h.client('empty',new AbortController().signal,()=>{});await h.client('another',new AbortController().signal,()=>{});
  assert.equal(calls.length,2);assert.ok(calls[1]-calls[0]>=750);
});
test('Retry-After supports seconds, HTTP dates and invalid/missing headers',()=>{
  const now=Date.parse('2026-10-09T14:00:00Z');
  assert.equal(retryAfterMilliseconds('60',now),60000);assert.equal(retryAfterMilliseconds('Fri, 09 Oct 2026 14:01:00 GMT',now),60000);
  assert.equal(retryAfterMilliseconds('bad',now),0);assert.equal(retryAfterMilliseconds(null,now),0);assert.equal(retryAfterMilliseconds('-1',now),0);
});
