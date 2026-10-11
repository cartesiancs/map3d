import { geometryQuery, layerGroups, type GroupId, type OsmElement } from './layers.ts';
import { abortableWait, GeometryRequestError, requestGeometry } from './overpass.ts';
export type QueryState = { status: 'idle' | 'queued' | 'loading' | 'waiting' | 'ready' | 'error' | 'cancelled'; message?: string };
type Points = {lat:number;lng:number}[];
type Job = {group:GroupId; selector?:number; attempts:number; readyAt:number};
type Options = {
  attempt?: typeof requestGeometry.attempt; now?: () => number; wait?: typeof abortableWait;
  onGroup: (group:GroupId, state:QueryState, elements?:OsmElement[]) => void;
};
export function mergeElements(elements: OsmElement[]) {
  return [...new Map(elements.map(element => [`${element.type}/${element.id}`,element])).values()];
}
/** One in-flight query, fair turns between batches, and bounded automatic recovery. */
export async function loadSceneQueries(points:Points, groups:GroupId[], signal:AbortSignal, options:Options) {
  const attempt=options.attempt || requestGeometry.attempt, now=options.now || Date.now, wait=options.wait || abortableWait;
  const deadline=now()+6*60*1000, queue:Job[]=groups.map(group=>({group,attempts:0,readyAt:0}));
  const records=new Map(groups.map(group=>[group,{remaining:1,failed:false,elements:[] as OsmElement[],error:''}]));
  let requests=0;
  const emit=(group:GroupId,state:QueryState,elements?:OsmElement[])=>{signal.throwIfAborted();options.onGroup(group,state,elements);};
  for(const group of groups) emit(group,{status:'queued',message:'Queued for download'});
  while(queue.length && now()<deadline && requests<48) {
    signal.throwIfAborted();
    const index=queue.findIndex(job=>job.readyAt<=now());
    if(index<0) {
      const retryAt=Math.min(...queue.map(job=>job.readyAt));
      for(const group of new Set(queue.map(job=>job.group))) {
        const at=Math.min(...queue.filter(job=>job.group===group).map(job=>job.readyAt));
        emit(group,{status:'waiting',message:`Waiting to retry automatically in ${Math.max(1,Math.ceil((at-now())/1000))} s…`});
      }
      await wait(Math.min(1000,retryAt-now(),deadline-now()),signal);
      continue;
    }
    const [job]=queue.splice(index,1), record=records.get(job.group)!;
    emit(job.group,{status:'loading',message:job.selector===undefined?'Downloading map data…':'Downloading smaller requests…'});
    try {
      const elements=await attempt(geometryQuery(points,job.group,job.selector),signal);
      signal.throwIfAborted();requests++;record.remaining--;
      record.elements=mergeElements([...record.elements,...elements]);
      emit(job.group,{status:record.remaining?'queued':record.failed?'error':'ready',message:record.remaining?'Some data loaded · remaining requests queued':record.failed?record.error:undefined},record.elements);
    } catch(error) {
      signal.throwIfAborted();
      if(!(error instanceof GeometryRequestError)) throw error;
      if(error.attempted) {job.attempts++;requests++;}
      record.error=error.message;
      if(error.retryable && error.canSplit && job.selector===undefined && job.attempts>=2) {
        const selectors=layerGroups.find(group=>group.id===job.group)!.selectors;
        record.remaining+=selectors.length-1;
        queue.push(...selectors.map((_,selector)=>({group:job.group,selector,attempts:0,readyAt:Math.max(now()+2000,error.retryAt)})));
        emit(job.group,{status:'waiting',message:'Retrying automatically with smaller requests…'});
      } else if(error.retryable && job.attempts<3 && error.retryAt<deadline) {
        job.readyAt=Math.max(error.retryAt,now()+(error.attempted?5000*3**Math.max(0,job.attempts-1):0));
        queue.push(job);
        emit(job.group,{status:'waiting',message:'Download delayed · automatic retry scheduled'});
      } else {
        record.failed=true;record.remaining--;
        emit(job.group,{status:record.remaining?'queued':'error',message:record.remaining?'Some requests failed · continuing remaining data':error.message});
      }
    }
  }
  signal.throwIfAborted();
  for(const [group,record] of records) if(record.remaining) emit(group,{status:'error',message:`Automatic recovery reached its limit. ${record.error || 'Map-data services are still busy. Loaded layers are kept.'}`});
}
