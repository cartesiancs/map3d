import { analyzeSite } from './siteAnalysis';

self.onmessage = ({ data }: MessageEvent<[Parameters<typeof analyzeSite>[0], Parameters<typeof analyzeSite>[1]]>) => {
  try { self.postMessage({ report: analyzeSite(...data, phase => self.postMessage({ phase })) }); }
  catch (error) { self.postMessage({ error: 'Could not analyze this boundary. Loaded map data is kept. Retry the calculation or choose another boundary.', debug: import.meta.env.DEV && error instanceof Error ? error.stack : undefined }); }
};
