import { vectorLayers, type Feature, type LayerName, type VectorLayer } from './layers.ts';

export type Sublayer = { id:string; label:string; count:number };
export type SublayerVisibility = Record<string,boolean>;
const labels:Record<string,string> = {
  'highway:residential':'Residential streets','highway:service':'Service roads','highway:primary':'Primary roads',
  'highway:secondary':'Secondary roads','highway:tertiary':'Tertiary roads','highway:trunk':'Trunk roads',
  'highway:motorway':'Motorways','highway:unclassified':'Unclassified roads','highway:living_street':'Living streets',
  'highway:footway':'Footpaths','highway:cycleway':'Cycleways','highway:path':'Paths','highway:pedestrian':'Pedestrian areas',
  'highway:steps':'Steps','highway:bridleway':'Bridleways','highway:bus_stop':'Bus stops',
  'railway:rail':'Rail tracks','railway:tram':'Tram tracks','railway:light_rail':'Light rail',
  'railway:subway':'Subway tracks','railway:station':'Railway stations','railway:halt':'Railway halts',
  'railway:tram_stop':'Tram stops','railway:subway_entrance':'Subway entrances',
  'public_transport:platform':'Platforms','public_transport:stop_position':'Stop positions',
  'natural:tree':'Individual trees','natural:wood':'Woodland','natural:tree_row':'Tree rows','landuse:forest':'Managed forest',
  'natural:water':'Unspecified water','water:lake':'Lakes','water:pond':'Ponds','water:reservoir':'Reservoirs','landuse:reservoir':'Reservoirs',
  'waterway:river':'Rivers','waterway:stream':'Streams','waterway:canal':'Canals','waterway:drain':'Drains','waterway:ditch':'Ditches',
  'leisure:park':'Parks','leisure:garden':'Gardens','landuse:grass':'Grass','landuse:meadow':'Meadows','landuse:village_green':'Village greens',
  'leisure:pitch':'Sports pitches','leisure:playground':'Playgrounds','leisure:sports_centre':'Sports centres',
  'amenity:parking':'Parking','amenity:bicycle_parking':'Bicycle parking',
  'amenity:cafe':'Cafés','amenity:restaurant':'Restaurants','amenity:fast_food':'Fast food','amenity:bar':'Bars','amenity:pub':'Pubs',
  'amenity:school':'Schools','amenity:university':'Universities','amenity:college':'Colleges','amenity:kindergarten':'Kindergartens',
  'amenity:hospital':'Hospitals','amenity:clinic':'Clinics','amenity:pharmacy':'Pharmacies','amenity:doctors':'Doctors',
  'amenity:place_of_worship':'Places of worship','amenity:library':'Libraries','amenity:bank':'Banks','amenity:atm':'ATMs',
  'amenity:toilets':'Toilets','amenity:drinking_water':'Drinking water','amenity:bench':'Benches','amenity:cinema':'Cinemas',
  'building:yes':'Unspecified buildings','building:house':'Houses','building:apartments':'Apartment buildings',
  'building:residential':'Residential buildings','building:commercial':'Commercial buildings','building:industrial':'Industrial buildings',
  'building:retail':'Retail buildings','building:garage':'Garages','building:garages':'Garage blocks','building:part:yes':'Building parts',
};
const cache = new WeakMap<Feature,{id:string;label:string}>();
const humanize = (value:string) => value.replace(/[_;]/g,' ').replace(/^\w/,letter=>letter.toUpperCase());

/** Keep exact tagged types separate; unknown OSM values remain available as their own type. */
export function featureSublayer(feature:Feature) {
  const existing=cache.get(feature);if(existing) return existing;
  const tags=feature.tags;
  let tag:string|undefined;
  switch(feature.layer) {
    case 'Buildings':tag=tags.building && tags.building!=='yes'?'building':tags['building:part'] && tags['building:part']!=='no'?'building:part':'building';break;
    case 'Roads':case 'Walking & cycling':tag='highway';break;
    case 'Transit':tag=['railway','public_transport','highway','route'].find(key=>tags[key]);break;
    case 'Trees & woodland':tag=tags.natural?'natural':'landuse';break;
    case 'Water':tag=tags.water?'water':tags.landuse==='reservoir'?'landuse':'natural';break;
    case 'Waterways':tag='waterway';break;
    case 'Green spaces':case 'Recreation & parking':tag=['leisure','amenity','landuse'].find(key=>tags[key]);break;
    case 'Land use':tag='landuse';break;
    case 'Points of interest':tag=['amenity','shop','tourism','historic'].find(key=>tags[key] && !(key==='amenity' && ['parking','bicycle_parking'].includes(tags[key])));break;
  }
  const value=tag?tags[tag]:undefined;
  const type=feature.layer==='Water' && !tags.water && tags.landuse==='reservoir'?'water:reservoir':value?`${tag}:${value}`:'other';
  const prefix=tag==='shop'?'Shops · ':tag==='tourism'?'Tourism · ':tag==='historic'?'Historic · ':'';
  const result={id:`${feature.layer}|${type}`,label:labels[type] || (value?prefix+humanize(value):'Other / unspecified')};
  cache.set(feature,result);return result;
}
export function collectSublayers(features:Feature[]) {
  const groups=Object.fromEntries(vectorLayers.map(layer=>[layer,new Map<string,Sublayer>()])) as Record<VectorLayer,Map<string,Sublayer>>;
  for(const feature of features) {
    const type=featureSublayer(feature), group=groups[feature.layer], previous=group.get(type.id);
    if(previous) previous.count++;else group.set(type.id,{...type,count:1});
  }
  return Object.fromEntries(vectorLayers.map(layer=>[layer,[...groups[layer].values()].sort((a,b)=>a.label.localeCompare(b.label)||a.id.localeCompare(b.id))])) as Record<VectorLayer,Sublayer[]>;
}
export function isFeatureVisible(feature:Feature,layers:Record<LayerName,boolean>,sublayers:SublayerVisibility={}) {
  return layers[feature.layer] && sublayers[featureSublayer(feature).id]!==false;
}
