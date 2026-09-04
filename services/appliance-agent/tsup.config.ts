import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['services/appliance-agent/src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'services/appliance-agent/dist',
  splitting: false,
  clean: true,
  bundle: true,
  noExternal: [],
});
