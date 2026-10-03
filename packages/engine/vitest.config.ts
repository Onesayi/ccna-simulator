import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html'],
      // Keep the engine well covered: CI fails if a change drops below these.
      thresholds: { lines: 95, statements: 90, functions: 90, branches: 80 },
    },
  },
});
