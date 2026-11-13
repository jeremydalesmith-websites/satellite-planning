import { execSync } from 'node:child_process';
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

/**
 * Identity of the planner CODE in this build (not of the data): the git commit, or PLANNER_BUILD_ID if given.
 * It is compiled into the app and also written to version.json beside it, so a page that was opened before an update can
 * notice, when the user searches, that the published planner has changed (see src/data/version.ts).
 */
function buildId(): string {
  if (process.env.PLANNER_BUILD_ID?.trim()) return process.env.PLANNER_BUILD_ID.trim();
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
const BUILD_ID = buildId();

export default defineConfig(({ command }) => ({
  base,
  define: { __BUILD_ID__: JSON.stringify(command === 'serve' ? 'dev' : BUILD_ID) },
  plugins: [
    react(),
    {
      name: 'planner-version-file',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
      },
    },
  ],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
}));
