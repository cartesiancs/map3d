import type { Feature } from '../../src/data/layers';
/** Deterministic mixed urban workload: 1000 buildings, 500 trees, 60 POIs and 24 roads per km². */
export function cityFixture(areaKm2: number, density = 1) {
  const side = Math.sqrt(areaKm2) * 1000, center = { lat: 40.8, lon: -73.95 };
  const point = (x:number,y:number) => ({ lat: center.lat + y / 111320, lon: center.lon + x / (111320 * Math.cos(center.lat * Math.PI / 180)) });
  const features: Feature[] = [];
  const buildings = Math.round(areaKm2 * 1000 * density), width = Math.ceil(Math.sqrt(buildings));
  for (let i = 0; i < buildings; i++) {
    const x = ((i%width+.3)/width-.5)*side, y = ((Math.floor(i/width)+.3)/width-.5)*side, size = Math.min(18,side/width*.6);
    const geometry = [point(x,y),point(x+size,y),point(x+size,y+size*.7),point(x+size*.6,y+size*.7),point(x+size*.6,y+size),point(x,y+size),point(x,y)];
    features.push({ id:i+1, key:`way/${i+1}`, type:'way', layer:'Buildings', kind:'area', geometry, holes: i%25 === 0 ? [[point(x+2,y+2),point(x+5,y+2),point(x+5,y+5),point(x+2,y+5),point(x+2,y+2)]] : undefined, tags:{ building:'yes', 'building:levels':String(2+i%8), ...(i%4===0?{'roof:shape':'gabled','roof:height':'3'}:{}), ...(i%7===0?{'building:colour':'#c9bbac'}:{}) } });
  }
  for (let i=0;i<areaKm2*500*density;i++) features.push({id:100000+i,key:`node/${100000+i}`,type:'node',layer:'Trees & woodland',kind:'point',geometry:[point(((i*317%1000)/1000-.5)*side,((i*613%1000)/1000-.5)*side)],tags:{natural:'tree'}});
  for (let i=0;i<areaKm2*60*density;i++) features.push({id:200000+i,key:`node/${200000+i}`,type:'node',layer:'Points of interest',kind:'point',geometry:[point(((i*311%1000)/1000-.5)*side,((i*607%1000)/1000-.5)*side)],tags:{amenity:'cafe',name:`Place ${i}`}});
  for (let i=0;i<areaKm2*24*density;i++) {
    const y=((i+.5)/(areaKm2*24*density)-.5)*side;
    features.push({id:300000+i,key:`way/${300000+i}`,type:'way',layer:'Roads',kind:'line',geometry:Array.from({length:8},(_,j)=>point((j/7-.5)*side,y)),tags:{highway:'residential'}});
  }
  for (let i=0;i<areaKm2*8*density;i++) {
    const x=((i*177%1000)/1000-.5)*side,y=((i*449%1000)/1000-.5)*side;
    features.push({id:400000+i,key:`way/${400000+i}`,type:'way',layer:i%2?'Water':'Green spaces',kind:'area',geometry:[point(x,y),point(x+45,y),point(x+45,y+45),point(x,y+45),point(x,y)],tags:i%2?{natural:'water'}:{leisure:'park'}});
  }
  const corners=[point(-side/2,-side/2),point(side/2,-side/2),point(side/2,side/2),point(-side/2,side/2)];
  return {features,points:corners.map(p=>({lat:p.lat,lng:p.lon}))};
}
