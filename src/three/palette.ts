import type { VectorLayer } from '../data/layers.ts';

// Natural features use muted, cool greens and blues alongside the app's violet accents.
export const palette: Record<VectorLayer, string> = {
  Buildings: '#dde2fa', Roads: '#6e71bc', 'Walking & cycling': '#b397df',
  Transit: '#8170ed', 'Trees & woodland': '#739888', Water: '#79afc5',
  Waterways: '#6099b2', 'Green spaces': '#a8bfa3', 'Land use': '#e6d9ef',
  'Points of interest': '#c879d7', 'Recreation & parking': '#cfbcef',
};
export const landColors: Record<string,string> = {
  residential: '#dedff4', commercial: '#c6b7f0', retail: '#e7c5eb',
  industrial: '#aab9dd', farmland: '#c6c49f', forest: '#739888', cemetery: '#b0bba9',
};
export const sceneColors = {
  roof: '#a1aee0', terrain: '#d9ddf2', trunk: '#8c7c72',
  selectedPoint: '#5b55ef', selectionFill: '#6571f0',
  haloOuter: '#7963ff', haloCyan: '#26d5ef', haloBlue: '#5664f1', haloCore: '#f2fcff',
  measurement: '#37d6ef', measurementShadow: '#24284c',
};
