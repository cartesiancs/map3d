import {test,expect} from '@playwright/test';

for(const large of [false,true]) {
  test(`buildings remain selectable over indoor POIs with all layers enabled${large?' with batching':''}`,async({page})=>{
    await page.goto(`/tests/performance/picking.html${large?'?large=1':''}`);
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking?.ready)).toBe(true);
    await page.getByLabel('View direction',{exact:true}).selectOption('top');
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking.direction[1])).toBeCloseTo(1,3);
    // A selected point also has a DOM label in the batched rendering path.
    await page.getByRole('button',{name:'Select indoor cafe',exact:true}).click();
    await expect(page.getByRole('button',{name:'Inspect Indoor cafe',exact:true})).toBeHidden();
    const click=async(point:number[])=>{const p=await page.evaluate(point=>(window as any).__screenPoint(point),point);await page.mouse.click(p.x,p.y);};
    await click([0,20.2,0]);
    await expect(page.locator('output')).toHaveText('building');
    await click([-25,5,0]);
    await expect(page.locator('output')).toHaveText('outdoor-cafe');
    await click([25,6,0]);
    await expect(page.locator('output')).toHaveText('tree');
    await page.getByRole('button',{name:'Toggle buildings',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking.buildings)).toBe(0);
    await click([0,5,0]);
    await expect(page.locator('output')).toHaveText('indoor-cafe');
    await expect(page.getByRole('button',{name:'Inspect Indoor cafe',exact:true})).toBeVisible();
    // Layer changes must update occlusion without needing an orbit or zoom.
    await page.getByRole('button',{name:'Toggle buildings',exact:true}).click();
    await expect(page.getByRole('button',{name:'Inspect Indoor cafe',exact:true})).toBeHidden();
    await click([0,20.2,0]);
    await expect(page.locator('output')).toHaveText('building');
    await page.screenshot({path:`test-results/picking-all-layers${large?'-batched':''}.png`});
  });
  test(`nearby road hit tolerance does not steal building facade clicks${large?' with batching':''}`,async({page})=>{
    await page.goto(`/tests/performance/picking.html${large?'?large=1':''}`);
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking?.ready)).toBe(true);
    await page.getByLabel('View direction',{exact:true}).selectOption('front');
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking.direction[2])).toBeCloseTo(1,3);
    // Zoom in so a world-space line hit can be visibly far from the cursor.
    await page.mouse.move(640,450);
    for(let i=0;i<30;i++)await page.mouse.wheel(0,-100);
    await expect.poll(()=>page.evaluate(()=>(window as any).__picking.distance)).toBeLessThan(60);
    const click=async(point:number[])=>{const p=await page.evaluate(point=>(window as any).__screenPoint(point),point);await page.mouse.click(p.x,p.y);};
    await click([0,1.5,10]);
    await expect(page.locator('output')).toHaveText('building');
    await click([0,.8,10.5]);
    await expect(page.locator('output')).toHaveText('road');
  });
}
