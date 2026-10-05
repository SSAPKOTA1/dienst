// Bundles the API (server, migration runner, rekey job, worker) into apps/api/dist as plain ESM files so the
// production image needs no TypeScript runtime. The workspace packages (@dienst/*) are TypeScript sources and are
// bundled in; every other dependency stays external and is installed in the image.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('apps/api/dist', { recursive: true, force: true });
const external = {
  name: 'external-deps',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@dienst/') || args.path.startsWith('node:')) return null;
      return { path: args.path, external: true };
    });
  },
};
await build({
  entryPoints: {
    server: 'apps/api/src/server.ts',
    migrate: 'apps/api/src/db/migrate-cli.ts',
    rekey: 'apps/api/src/db/rekey.ts',
    drill: 'apps/api/src/db/drill.ts',
  },
  outdir: 'apps/api/dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  plugins: [external],
  logLevel: 'info',
});
