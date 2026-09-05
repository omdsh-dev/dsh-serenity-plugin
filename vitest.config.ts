import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'hooks/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // coverage 见 hooks/dsh-serenity-hooks/vitest.config.ts（dsh-develop coverage 从 hooks 目录运行——
    // coverage-v8 装在 hooks node_modules；本根配置普通 test 不需要 coverage 依赖）
  },
});
