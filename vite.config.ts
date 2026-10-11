import { defineConfig, type ViteDevServer, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { build } from 'esbuild';
import { createMapProxy } from './server/mapProxy';

function configureMapServer(server: ViteDevServer | PreviewServer) {
  const handle = createMapProxy();
  server.middlewares.use('/api/interpreter', async (req, res) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end('Boundary outline is too large.'); return; } chunks.push(chunk); }
      const origin = `http://${req.headers.host}`;
      const request = new Request(`${origin}/api/interpreter`, { method: req.method, headers: { ...(req.headers.origin ? { Origin: req.headers.origin } : {}) }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {}) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'The local map-data service could not finish this request.' })); }
  });
}

// https://vitejs.dev/config/
export default defineConfig({
  // Prepare lazy worker dependencies at startup, avoiding a full-page reload
  // during the first analysis/export. Direct-mode tests use their own cache so
  // they cannot invalidate modules in an already-running gateway dev server.
  cacheDir: process.env.VITE_MAP_DATA_TRANSPORT === 'direct' ? 'node_modules/.vite-direct' : 'node_modules/.vite',
  optimizeDeps: { include: ['rhino3dm', 'clipper-lib'] },
  plugins: [
    {
      name: 'map-data-service',
      async generateBundle() {
        const result = await build({ entryPoints: ['server/mapProxy.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
        this.emitFile({ type: 'asset', fileName: '_worker.js', source: result.outputFiles[0].text });
        this.emitFile({ type: 'asset', fileName: '_routes.json', source: JSON.stringify({ version: 1, include: ['/api/interpreter'], exclude: [] }) });
      },
      configureServer: configureMapServer,
      configurePreviewServer: configureMapServer,
    },
    dts({
      insertTypesEntry: true,
    }),
    react({
      jsxImportSource: "@emotion/react",
      babel: {
        plugins: ["@emotion/babel-plugin"],
      },
    }),
  ],
  resolve: {
    alias: [{ find: "@", replacement: "/src" }],
  },
});
