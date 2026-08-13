# DEPLOYMENT — dsh-serenity-hooks 部署与运维指南

> 状态：v1.15 合规化（官方 bundle 形态 + 自带 cordis.patch.yml）。实际部署 = 写入 DSH node_modules + profile patch + 重启，属**边界外操作**，执行前需用户批准。

## 安装路径（两种）

### 路径 A：官方 `dsh plugin`（v1.15+，推荐）

插件已是标准 bundle（`dsh.bundle.patch` 声明 + 自带 `cordis.patch.yml` + `prepare` 消费端构建）：

```bash
# 本地开发循环（link: 免重装热更，对齐官方 E2）
dsh plugin --profile web add link:/path/to/dsh-serenity-plugin/hooks/dsh-serenity-hooks

# 从 git 安装（fetch 源码，走 prepare 构建；pnpm ≥10 首次需 allowBuilds，dsh 会提示）
dsh plugin --profile web add github:dsh-external/dsh-serenity-plugin
```

`dsh plugin` 自动：初始化 profile（含 `@deepseek-ai/dsh-base`）→ pnpm 转发 → `dsh.profile.bundles` 对账（检测到 `dsh.bundle` 自动入层）。

### 路径 B：脚本部署（legacy 双锚，开发环境免 profile）

```bash
bash scripts/load-plugin.sh            # 构建 → 双锚复制 → shim → profile patch（读取插件自带 bundle 层）→ 预检
bash scripts/load-plugin.sh --dry-run  # 预览
```

## 前置

- 插件构建产物齐全：`hooks/dsh-serenity-hooks/lib/`（`pnpm build` 或 `tsc -p tsconfig.json`）
- 测试通过：hooks 51/51，根层 54/54
- 解析链（已源码验证）：
  - `boot()` 设 `ctx.baseUrl = apps/cli/config/`
  - workspace 链接在 `apps/cli/node_modules`（cordis + @deepseek-ai/*）
  - **根 node_modules 无 cordis/schemastery** → 插件必须复制进 `apps/cli/node_modules/@shgroup/`，schemastery 以 shim 进插件包自身 node_modules

## 部署步骤

```bash
bash scripts/load-plugin.sh            # 一键：构建 → 复制 → shim → 预检 → config.yaml insert
# 或预览：
bash scripts/load-plugin.sh --dry-run
```

脚本行为：
1. 构建插件（tsc → lib/）
2. **复制**（非 symlink）到 `<staging>/apps/cli/node_modules/@shgroup/dsh-serenity-hooks/`（保留 package.json + lib/）
3. schemastery shim：`<插件>/node_modules/schemastery → vendor/schemastery`
4. **预检**：从 `apps/cli/config` 动态导入插件（验证解析链；无副作用）
5. `~/.dsh/config.yaml` 追加 insert 行（自动备份 `.bak.<ts>`）
6. 提示重启

config.yaml 追加内容：

```yaml
- insert:
    - id: serenity-hooks
      name: '@shgroup/dsh-serenity-hooks'
      config:
        serenityConfigPaths: ['.dsh/serenity.json', '.opencode/serenity.json']
```

## 重启

```bash
# 重启 dsh web（会中断当前 Web GUI 会话，用户需重新打开页面）
# 由用户或获批准的 agent 执行
```

## 验证清单

| 项 | 验证方式 | 期望 |
|----|---------|------|
| 插件加载 | 新会话（home-serenity cwd）工具列表 | 出现 `cc_fs` / `session` / `acc_kit` / `cc_git` / `acc_msm` |
| 身份注入 | 新会话第一条消息后 | 收到 `[ACC] 宁静号认知容器已激活（dsh-serenity-hooks vX）` |
| 守卫生效 | 创建 `.serenity-safe-on` 后尝试写工具 | 被 deny（reason 含 safe mode） |
| session-keeper | 连续多次写操作 | 达阈值后收到 `[SESSION-KEEPER-recorded-…]` 提醒 |
| 配置读取 | `.dsh/serenity.json` 的 loop.defaultModel | acc_kit health 输出含该模型 |

## 回滚

```bash
# 1. 移除 config.yaml 中 insert 块（从备份恢复）
cp ~/.dsh/config.yaml.bak.<ts> ~/.dsh/config.yaml
# 2. 删除复制到 node_modules 的插件
rm -rf <staging>/apps/cli/node_modules/@shgroup/dsh-serenity-hooks
# 3. 重启 dsh web
```

## 升级插件

```bash
bash scripts/load-plugin.sh   # 重跑即覆盖（脚本含 rm -rf 再复制）
```

## 常见问题

- **预检失败（ERR_MODULE_NOT_FOUND）**：依赖解析链问题——确认插件复制在 `apps/cli/node_modules/@shgroup/` 且 schemastery shim 存在
- **工具未出现**：插件未加载——检查 config.yaml insert 块缩进（必须 2 空格层级的 YAML 列表）
- **守卫不生效**：确认 cwd 在 CCC 内（有 `.serenity`）且 `.serenity-safe-on` 标记存在
