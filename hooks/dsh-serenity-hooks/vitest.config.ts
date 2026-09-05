import { defineConfig } from 'vitest/config';

// hooks 子项目本地 vitest 配置——coverage 度量用（dsh-develop coverage 从本目录运行）。
// 普通 test 仍从仓库根运行（根 vitest.config.ts include 覆盖根 tests/ + hooks tests + scripts tests）。
// 本配置独立存在是因为 coverage-v8 装在 hooks 自身 node_modules（根 node_modules 无）——
// 根 vitest 解析不到 provider；coverage 目标 = hooks src（node 侧主产物），从 hooks 目录跑最直接。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/invariant.ts',
        'src/constants.ts',
        'src/json.ts',
        'src/client/**',
        'src/**/*.d.ts',
      ],
      // 阈值（2026-09-05 首份基线：全仓 80.88/78.04/80.81/80.88——设 60 留补测空间同时防倒退；
      // 低洼模块 api 21/gateway 27/opencode-skills 31/tools 壳 50-60 逐批补测后收紧到 70+/80+）
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 55,
        lines: 60,
      },
    },
  },
});
