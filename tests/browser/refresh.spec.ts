import {test, expect, type Page} from '@playwright/test';

const boundary=(lat:number,lng:number)=>[{lat,lng},{lat,lng:lng+.002},{lat:lat+.002,lng:lng+.002},{lat:lat+.002,lng}];
const siteElements=(lat:number,lon:number,height:string,id:number)=>[
  {type:'way',id,tags:{building:'yes',height,name:`Building ${id}`},geometry:[{lat,lon},{lat,lon:lon+.0005},{lat:lat+.0005,lon:lon+.0005},{lat:lat+.0005,lon},{lat,lon}]},
  {type:'way',id:id+1,tags:{leisure:'park'},geometry:[{lat,lon},{lat,lon:lon+.001},{lat:lat+.001,lon:lon+.001},{lat:lat+.001,lon},{lat,lon}]},
];
async function observeAnalysis(page:Page){
  await page.addInitScript(()=>{
    const BaseWorker=window.Worker;
    (window as any).__analysis={started:0,completed:0,completedId:0,lastLat:0,lastHeight:0};
    window.Worker=class extends BaseWorker{
      analysisInput:any;
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(String(url).includes('siteAnalysis.worker')){
          const id=++(window as any).__analysis.started;
          this.addEventListener('message',event=>{
            if(event.data.report) Object.assign((window as any).__analysis,{completed:(window as any).__analysis.completed+1,completedId:id,lastLat:this.analysisInput[0][0].lat,lastHeight:event.data.report.buildings.meanHeight});
          });
        }
      }
      postMessage(message:any,options?:any){this.analysisInput=message;super.postMessage(message,options);}
    };
  });
  await page.route('**/*.tile.openstreetmap.org/**',route=>route.fulfill({status:204,body:''}));
}
test('viewer precomputes dashboard statistics and updates them before the dashboard opens',async({page})=>{
  await observeAnalysis(page);
  await page.addInitScript(points=>sessionStorage.setItem('map3d.workspace',JSON.stringify({points,location:'Athens'})),boundary(37.98,23.72));
  await page.route('**/reverse?**',route=>route.fulfill({json:{address:{city:'Athens',country:'Greece'}}}));
  let release=()=>{};
  const landscape=new Promise<void>(resolve=>release=resolve);
  let requests=0;
  await page.route('**/api/interpreter',async route=>{
    requests++;const query=route.request().postData() || '';
    if(query.includes('landuse'))await landscape;
    await route.fulfill({json:{elements:query.includes('"building"')?siteElements(37.9803,23.7203,'12',1).slice(0,1):query.includes('landuse')?siteElements(37.9803,23.7203,'12',1).slice(1):[]}});
  });
  await page.goto('/viewer');
  await expect.poll(()=>page.evaluate(()=>(window as any).__analysis.lastHeight)).toBe(12);
  const before=await page.evaluate(()=>(window as any).__analysis.completed);
  release();
  await expect(page.locator('.layer-hint')).toContainText('Scene ready');
  await expect.poll(()=>page.evaluate(()=>(window as any).__analysis.completed)).toBeGreaterThan(before);
  await expect.poll(()=>page.evaluate(()=>(window as any).__analysis.completedId===(window as any).__analysis.started)).toBe(true);
  const started=await page.evaluate(()=>(window as any).__analysis.started);
  await page.getByRole('button',{name:'Site dashboard',exact:true}).click();
  await expect(page.getByRole('region',{name:'Site dashboard'})).toHaveAttribute('aria-busy','false');
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('12m');
  await expect(page.locator('.site-stat').filter({hasText:'Mapped green space'})).not.toContainText('—');
  expect(await page.evaluate(()=>(window as any).__analysis.started)).toBe(started);
  await page.getByRole('button',{name:'View in 3D',exact:true}).click();
  await page.getByRole('button',{name:'Site dashboard',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__analysis.started)).toBe(started);
  expect(requests).toBe(4);
});

test('changing Athens to New York clears old labels and metrics, ignores late data and restores history',async({page})=>{
  await observeAnalysis(page);
  const athens=boundary(37.98,23.72),newYork=boundary(40.78,-73.97);
  await page.addInitScript(points=>sessionStorage.setItem('map3d.workspace',JSON.stringify({points,location:'Athens'})),athens);
  let releaseOld=()=>{},releaseNew=()=>{};
  const oldData=new Promise<void>(resolve=>releaseOld=resolve),newData=new Promise<void>(resolve=>releaseNew=resolve);
  let oldLandscapeStarted=false;
  await page.route('**/reverse?**',async route=>{
    const old=route.request().url().includes('lat=37.');
    if(old)await oldData;
    await route.fulfill({json:{address:{city:old?'Athens':'New York',country:old?'Greece':'United States'}}}).catch(()=>{});
  });
  await page.route('**/api/interpreter',async route=>{
    const query=route.request().postData() || '',old=query.includes('37.98');
    if(old&&query.includes('landuse')){oldLandscapeStarted=true;await oldData;}
    if(!old)await newData;
    const data=old?siteElements(37.9803,23.7203,'12',1):siteElements(40.7803,-73.9697,'120',100);
    await route.fulfill({json:{elements:query.includes('"building"')?data.slice(0,1):query.includes('landuse')?data.slice(1):[]}}).catch(()=>{});
  });
  await page.goto('/dashboard');
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('12m');
  await expect.poll(()=>oldLandscapeStarted).toBe(true);
  // Restore a different site's history snapshot carrying a legacy, stale label.
  await page.evaluate(points=>{
    history.pushState({map3d:{points,location:'Athens'}},'', '/dashboard');
    dispatchEvent(new PopStateEvent('popstate'));
  },newYork);
  await expect(page.locator('.site-kicker')).not.toContainText('Athens');
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Download report',exact:true})).toBeDisabled();
  releaseNew();
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('120m');
  await expect(page.locator('.site-kicker')).toContainText('New York');
  releaseOld();
  await expect(page.getByText('All source batches loaded',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Site dashboard'})).toHaveAttribute('aria-busy','false');
  await expect(page.locator('.site-kicker')).toContainText('New York');
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('120m');
  await page.goBack();
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('12m');
  await expect(page.locator('.site-kicker')).toContainText('Athens');
  await page.goForward();
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('120m');
  await expect(page.locator('.site-kicker')).toContainText('New York');
});

test('searching elsewhere never renames the existing site or its report',async({page})=>{
  await observeAnalysis(page);
  await page.addInitScript(points=>sessionStorage.setItem('map3d.workspace',JSON.stringify({points,location:'Athens'})),boundary(37.98,23.72));
  await page.route('**/reverse?**',route=>route.fulfill({json:{address:{city:'Athens',country:'Greece'}}}));
  await page.route('**/search?**',route=>route.fulfill({json:[{place_id:10,display_name:'New York, United States',lat:'40.78',lon:'-73.97'}]}));
  await page.route('**/api/interpreter',route=>route.fulfill({json:{elements:siteElements(37.9803,23.7203,'12',1)}}));
  await page.goto('/map');
  await page.getByRole('textbox',{name:'Search location'}).fill('New York');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('button',{name:'New York, United States',exact:true}).click();
  await expect(page.locator('.location-pill')).toContainText('New York');
  await page.getByRole('button',{name:'Site dashboard',exact:true}).click();
  await expect(page.locator('.site-kicker')).toContainText('Athens');
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('12m');
});

test('returning after the freshness window revalidates sources and refreshes calculations',async({page})=>{
  await page.clock.install();
  await page.addInitScript(points=>sessionStorage.setItem('map3d.workspace',JSON.stringify({points,location:'Athens'})),boundary(37.98,23.72));
  await page.route('**/*.tile.openstreetmap.org/**',route=>route.fulfill({status:204,body:''}));
  await page.route('**/reverse?**',route=>route.fulfill({json:{address:{city:'Athens',country:'Greece'}}}));
  let height='12',requests=0;
  await page.route('**/api/interpreter',route=>{requests++;return route.fulfill({json:{elements:siteElements(37.9803,23.7203,height,1)}});});
  await page.goto('/dashboard');
  await expect(page.getByText('All source batches loaded',{exact:true})).toBeVisible();
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('12m');
  await page.getByRole('button',{name:'Back to map',exact:true}).click();
  await page.clock.fastForward(301000);height='24';
  await page.getByRole('button',{name:'Site dashboard',exact:true}).click();
  await expect(page.locator('.site-stat').filter({hasText:'Mean building height'})).toContainText('24m');
  await expect(page.getByText('All source batches loaded',{exact:true})).toBeVisible();
  expect(requests).toBe(8);
});
