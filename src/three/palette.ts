import type { VectorLayer } from '../data/layers.ts';

// Cool, softly shaded geometry leaves the cyan/violet interaction accents clear.
export const palette: Record<VectorLayer, string> = {
  Buildings: '#dde2fa', Roads: '#6e71bc', 'Walking & cycling': '#b397df',
  Transit: '#8170ed', 'Trees & woodland': '#8ab4df', Water: '#62d4ed',
  Waterways: '#2aaaca', 'Green spaces': '#c4cdf0', 'Land use': '#e6d9ef',
  'Points of interest': '#c879d7', 'Recreation & parking': '#cfbcef',
};
export const landColors: Record<string,string> = {
  residential: '#dedff4', commercial: '#c6b7f0', retail: '#e7c5eb',
  industrial: '#aab9dd', farmland: '#e4d6f5', forest: '#a8c8ea', cemetery: '#c4c8e1',
};
export const sceneColors = {
  roof: '#a1aee0', terrain: '#d9ddf2', trunk: '#858baa',
  selectedPoint: '#5b55ef', selectionFill: '#6571f0',
  haloOuter: '#7963ff', haloCyan: '#26d5ef', haloBlue: '#5664f1', haloCore: '#f2fcff',
  measurement: '#37d6ef', measurementShadow: '#24284c',
};
