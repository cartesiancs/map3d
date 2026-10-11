import {chromium} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
const cases=process.argv.slice(2).length ? process.argv.slice(2) : ['legacy:4:1','batched:4:1','batched:10:1','batched:25:1','batched:50:1','batched:25:.1'];
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--enable-precise-memory-info',...(process.env.GPU_BACKEND?['--use-angle='+process.env.GPU_BACKEND]:process.env.SOFTWARE_GPU?['--use-angle=swiftshader']:[])]});
const results=[];
try{
 for(const entry of cases){
  const [renderer,area,density,terrain]=entry.split(':');const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const url=`http://127.0.0.1:5173/tests/performance/index.html?renderer=${renderer}&area=${area}&density=${density}${terrain?'&terrain=1':''}`;
  try{
   await page.goto(url,{timeout:60000});
   await page.waitForFunction(()=>window.__bench?.done||window.__bench?.error,{},{timeout:180000});
   const data=await page.evaluate(()=>window.__bench);
   const frames=data.frames.sort((a,b)=>a-b);const mean=frames.reduce((a,b)=>a+b,0)/frames.length;
   const result={case:entry,...data,frames:undefined,fps:1000/mean,p50FrameMs:frames[Math.floor(frames.length*.5)],p95FrameMs:frames[Math.min(frames.length-1,Math.floor(frames.length*.95))],samples:frames.length,errors};
   results.push(result);console.log(JSON.stringify(result));
   await mkdir('test-results/performance',{recursive:true});await page.screenshot({path:`test-results/performance/${entry.replaceAll(':','-')}.png`});
  }catch(error){const result={case:entry,error:error.message,errors};results.push(result);console.log(JSON.stringify(result));}
  finally{await context.close();}
 }
}finally{await browser.close();}
await mkdir('test-results/performance',{recursive:true});await writeFile('test-results/performance/results.json',JSON.stringify(results,null,2));
