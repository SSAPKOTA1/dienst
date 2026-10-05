import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { SECURITY_HEADERS } from './security-headers';

/** Writes `dist/_headers` (Netlify/Cloudflare format) from the same header list. */
const headersFile = (): Plugin => ({
  name: 'security-headers-file',
  generateBundle() {
    const lines = Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`);
    this.emitFile({
      type: 'asset',
      fileName: '_headers',
      source: `/*\n${lines.join('\n')}\n/sw.js\n  Cache-Control: no-cache\n/api/*\n  Cache-Control: no-store\n`,
    });
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), headersFile()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  // the preview server serves the production build, so it gets the production headers (not the dev server: hot reload needs inline scripts)
  preview: { port: 5173, proxy: { '/api': 'http://localhost:3000' }, headers: SECURITY_HEADERS },
});
