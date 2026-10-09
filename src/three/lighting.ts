export type SceneLighting = 'day' | 'night';
export const lightingPresets = {
  day: { background:'#eeedf8', ambient:1.6, key:2.3, keyColor:'#ffffff', sky:'#edf3ff', ground:'#b5bce4', hemisphere:0, fill:0, fillColor:'#c1a9ff', grid:'#cbd0ec', sections:'#aab6de' },
  night: { background:'#11152e', ambient:.4, key:1.35, keyColor:'#bad7ff', sky:'#8d95ec', ground:'#191b3b', hemisphere:.75, fill:.35, fillColor:'#c1a9ff', grid:'#30395b', sections:'#4d5d8a' },
} as const;
