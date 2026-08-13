import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'hooks/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
