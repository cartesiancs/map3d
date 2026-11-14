import {test,expect} from '@playwright/test';

test('orthographic projection, orientation controls and dynamic metric scale preserve the model',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/tests/performance/navigation.html');
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation?.type)).toBe('PerspectiveCamera');
  const names=await page.evaluate(()=>(window as any).__names());
  const scale=page.getByRole('img',{name:'Approximate scale at camera focus depth'});
  await expect(scale).toHaveAttribute('data-metres',/\d/);
  const before=Number(await scale.getAttribute('data-metres'))/Number(await scale.getAttribute('data-pixels'));
  await page.mouse.move(640,450);await page.mouse.wheel(0,-450);
  await expect.poll(async()=>Number(await scale.getAttribute('data-metres'))/Number(await scale.getAttribute('data-pixels'))).toBeLessThan(before);
  await page.getByRole('button',{name:'Isometric',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation?.type)).toBe('OrthographicCamera');
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation?.direction.map((v:number)=>Number(v.toFixed(3))))).toEqual([.577,.577,.577]);
  for(const [view,axis,sign] of [['top',1,1],['left',0,-1],['right',0,1],['front',2,1],['back',2,-1],['bottom',1,-1]] as const){
    await page.getByLabel('View direction',{exact:true}).selectOption(view);
    await expect.poll(()=>page.evaluate(({axis})=>(window as any).__navigation.direction[axis],{axis})).toBeCloseTo(sign,3);
  }
  await page.getByLabel('View direction',{exact:true}).selectOption('iso');
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation.direction[1])).toBeCloseTo(1/Math.sqrt(3),3);
  await page.getByRole('button',{name:'Top view',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation.direction[1])).toBeCloseTo(1,3);
  await page.getByRole('button',{name:'Perspective',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation.type)).toBe('PerspectiveCamera');
  expect(await page.evaluate(()=>(window as any).__names())).toEqual(names);
  await page.screenshot({path:'test-results/viewer-navigation.png'});
  expect(errors).toEqual([]);
});
for(const large of [false,true])test(`3D measurement hits model roofs, ignores drags and stays out of exports${large?' with batching':''}`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/tests/performance/navigation.html${large?'?large=1':''}`);
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation?.ready)).toBe(true);
  await page.getByRole('button',{name:'Isometric',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__navigation.type)).toBe('OrthographicCamera');
  const names=await page.evaluate(()=>(window as any).__names());
  const click=async(point:number[])=>{const p=await page.evaluate(point=>(window as any).__screenPoint(point),point);await page.mouse.click(p.x,p.y);};
  await page.getByRole('button',{name:'Measure distance',exact:true}).click();
  await click([-8,20.2,0]);
  await expect(page.getByRole('region',{name:'Measurements'})).toContainText('Choose the second point');
  await click([8,20.2,0]);
  await expect(page.getByRole('region',{name:'Measurements'})).toContainText('1. 16 m');
  await expect(page.getByRole('region',{name:'Measurements'})).toContainText('Horizontal 16 m · Height 0 m');
  await expect(page.locator('output')).toHaveText('No selection');
  expect(await page.evaluate(()=>(window as any).__names())).toEqual(names);
  await click([0,20.2,0]);await click([25,0,25]);
  await expect(page.getByRole('region',{name:'Measurements'})).toContainText('Horizontal 35.4 m · Height 20.2 m');
  await page.getByRole('button',{name:'Remove measurement 2',exact:true}).click();
  await page.screenshot({path:`test-results/viewer-measurement${large?'-batched':''}.png`});
  await click([0,20.2,0]);await page.keyboard.press('Escape');
  await expect(page.getByRole('region',{name:'Measurements'})).toContainText('Click a surface or ground to start');
  await page.mouse.move(700,500);await page.mouse.down();await page.mouse.move(760,520,{steps:8});await page.mouse.up();
  await expect(page.getByRole('region',{name:'Measurements'}).locator('li')).toHaveCount(1);
  await page.getByRole('button',{name:'Exit measure tool',exact:true}).click();
  await expect(page.getByRole('button',{name:'Measure distance',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Clear measurements',exact:true}).click();
  await expect(page.getByRole('region',{name:'Measurements'})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  for(const label of ['Model navigation and measurement','View orientation']) {
    const box=(await page.getByRole(label.startsWith('Model')?'toolbar':'group',{name:label}).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);expect(box.y+box.height).toBeLessThanOrEqual(844);
  }
  await page.screenshot({path:'test-results/viewer-navigation-mobile.png'});
  expect(errors).toEqual([]);
});
