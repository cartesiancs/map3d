import rhino3dm from 'rhino3dm';
import wasmUrl from 'rhino3dm/rhino3dm.wasm?url';
import { exportRhino, type RhinoExportInput } from './exportRhino';

self.onmessage=async(event:MessageEvent<RhinoExportInput>)=>{
  try {
    self.postMessage({type:'initializing'});
    const rhino=await rhino3dm({locateFile:()=>wasmUrl});
    const result=exportRhino(rhino,event.data,progress=>self.postMessage({type:'progress',...progress}));
    // Copy out of WASM memory before transferring ownership to the UI.
    const bytes=new Uint8Array(result.bytes);
    self.postMessage({type:'ready',...result,bytes},{transfer:[bytes.buffer]});
  } catch(error) {self.postMessage({type:'error',message:error instanceof Error?error.message:'Could not create the Rhino file.'});}
};
