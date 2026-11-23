import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The bench's own tests run under node:test (`npm --prefix bench test`), not here.
    exclude: [...configDefaults.exclude, 'bench/**'],
  },
});
