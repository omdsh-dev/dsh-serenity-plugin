import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 🔴 2026-09-28：`tests/**`（仓库根）已随**安装器族**整体退役（S142 ③ 周边整合）——
    // 那 9 个用例钉的是安装器 CLI 与技能模板，随 `src/`／`bin/` 一起删。
    // 本仓现在的测试面 = hooks 包 + 开发脚本。
    include: ['hooks/**/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    // v1.30.16：`.pnpm-store` 在 hooks 目录内（.npmrc 的 store-dir，gitignore 但**在文件树里**），
    // 其中的 side-effects/projects 缓存会带一份项目文件副本 → `hooks/**/tests/**` 会把它当测试收集，
    // 同一测试跑两遍（实证：固定端口 3182 EADDRINUSE 假失败）。显式排除（含 vitest 默认项，避免覆盖丢失）。
    exclude: ['**/node_modules/**', '**/.pnpm-store/**', '**/dist/**', '**/coverage/**', '**/.git/**'],
    environment: 'node',
    // coverage 见 hooks/dsh-serenity-hooks/vitest.config.ts（dsh-develop coverage 从 hooks 目录运行——
    // coverage-v8 装在 hooks node_modules；本根配置普通 test 不需要 coverage 依赖）
  },
});
