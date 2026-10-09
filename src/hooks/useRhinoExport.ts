import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadFile } from '../data/download';
import type { RhinoExportInput } from '../three/exportRhino';

export function useRhinoExport(onStatus:(message:string)=>void,onError:(message:string)=>void) {
  const worker=useRef<Worker|null>(null);
  const [busy,setBusy]=useState(false);
  const cancel=useCallback(()=>{worker.current?.terminate();worker.current=null;setBusy(false);},[]);
  useEffect(()=>()=>{worker.current?.terminate();},[]);
  const start=(input:RhinoExportInput)=>{
    if(worker.current) return;
    onError('');onStatus('Preparing Rhino export…');setBusy(true);
    try {
      const task=new Worker(new URL('../three/rhino.worker.ts',import.meta.url),{type:'module'});worker.current=task;
      task.onerror=()=>{if(worker.current!==task) return;cancel();onStatus('');onError('Could not start the Rhino exporter. Please retry.');};
      task.onmessage=event=>{
        if(worker.current!==task) return;
        const result=event.data;
        if(result.type==='initializing') onStatus('Loading Rhino exporter…');
        if(result.type==='progress') onStatus(result.stage==='writing'?'Writing Rhino file…':`Preparing Rhino export · ${result.completed.toLocaleString()} / ${result.total.toLocaleString()} features`);
        if(result.type==='error') {cancel();onStatus('');onError(`Rhino export failed: ${result.message} Please retry.`);}
        if(result.type==='ready') {
          try {
            downloadFile('scene.3dm',result.bytes,'application/vnd.rhino');
            onStatus(`Rhino downloaded · ${result.objectCount.toLocaleString()} objects in ${result.layerCount} nested layers${result.incomplete?' · Partial data snapshot':''}.`);
          } catch {onStatus('');onError('Could not download the Rhino file. Please retry.');}
          finally {cancel();}
        }
      };
      task.postMessage(input);
    } catch {cancel();onStatus('');onError('Could not start the Rhino exporter. Please retry.');}
  };
  return {start,cancel,busy};
}
