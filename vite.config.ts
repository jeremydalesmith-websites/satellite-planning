import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Deployment base path.
 * Default './' makes every asset/data URL relative, so the built folder works
 * from any sub-directory (e.g. https://example.com/satellites/) without
 * touching other content on the domain. Override with VITE_BASE_PATH=/sub/dir/
 * if you prefer absolute paths.
 */
const base = process.env.VITE_BASE_PATH?.trim() || './';

export default defineConfig({
  base,
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
