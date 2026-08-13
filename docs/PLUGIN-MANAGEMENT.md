# PLUGIN-MANAGEMENT — 插件开启/关闭/管理指南

> 适用于 dsh-serenity-plugin 的 Native Cordis 插件 `@shgroup/dsh-serenity-hooks`。
> 部署方式：官方 personal-config 层（`~/.dsh/config.yaml` insert 行）+ 复制进 DSH node_modules，免改 DSH 源码。

## 1. 开启 / 卸载（整体）

插件存在 = `~/.dsh/config.yaml` 中有此 insert 块：

```yaml
- insert:
    - id: serenity-hooks
      name: '@shgroup/dsh-serenity-hooks'
      config:
        serenityConfigPaths: ['.dsh/serenity.json', '.opencode/serenity.json']
```

| 操作 | 方法 | 生效方式 |
|------|------|---------|
| **开启** | `bash scripts/load-plugin.sh`（自动写入 config.yaml + 复制插件） | config 变更 → **HMR 实时生效**（无需重启，已验证）；首次部署稳妥起见可重启 |
| **卸载** | 删除 config.yaml 中的 insert 块 | HMR / 重启后失效 |
| **彻底卸载** | 卸载后再删 `apps/cli/node_modules/@shgroup/dsh-serenity-hooks/` | 重启后 |
| **升级** | 改代码 → 重跑 `bash scripts/load-plugin.sh`（自动覆盖副本） | 需重启（模块内存态不热更） |

> 验证生效：进入 CCC 目录的 DSH 会话应收到 `[ACC] 宁静号认知容器已激活` 注入，且工具列表出现 `cc_fs/session/acc_kit/cc_git/acc_msm`。

## 2. 功能级开关（config 布尔项，无需卸载）

```yaml
- insert:
    - id: serenity-hooks
      name: '@shgroup/dsh-serenity-hooks'
      config:
        tools: false      # 关闭 5 个 ACC 工具（cc_fs/session/acc_kit/cc_git/acc_msm）
        guards: false     # 关闭机械守卫（安全模式 bash 禁用/黑名单/路径逃逸）
        keeper: false     # 关闭 session-keeper DCP 计分提醒
        context: false    # 关闭 ACC 身份注入（session-start/prompt-submit）
        turnFlush: false  # 关闭回合自动落盘（agent/turn-stopping）
        keeperThreshold: 150   # keeper 缺省阈值（CCC 的 serenity.json 优先）
```

缺省全开（`true`）。改 config.yaml 后 HMR 生效（或重启）。

## 3. 安全模式（与插件解耦的标记文件）

安全模式 = 机械约束：**bash 禁用** + 写入黑名单（前缀匹配 / `regex:` 前缀）。

| 操作 | 命令 | 效果 |
|------|------|------|
| 开启 | `touch <CCC>/.serenity-safe-on` | 立即机械生效（agent 的 bash 被 deny） |
| 关闭 | `rm <CCC>/.serenity-safe-on` | 立即恢复 |

> ⚠️ 注意：开启后 agent 无法自行关闭（bash 已被禁，形成死锁）——**只能由你在终端执行 rm**。这是安全模式的预期语义（agent 不能自证清白）。

## 4. 行为配置（各 CCC 的 `.dsh/serenity.json`）

```jsonc
{
  "loop": { "defaultModel": "minimax-cn-coding-plan/MiniMax-M3" },  // ACC 身份注入 / acc_kit health 读取
  "sessionKeeper": { "threshold": 150 },                            // keeper 提醒阈值（越低越频繁）
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] }       // 写入黑名单规则
}
```

（也可用 `.opencode/serenity.json`，读取顺序：`.dsh/` 优先。）

## 5. 状态查询

| 方式 | 内容 |
|------|------|
| `acc_kit` 工具 `health` | CCC 三原则（P1 .serenity / P2 git / 配置）+ 当前配置快照 |
| `dsh-serenity-plugin status`（CLI） | 激活状态（cwdRoot / inGitRepo） |
| 检查 `~/.dsh/config.yaml` | 插件 insert 块是否存在 |
| 检查 `apps/cli/node_modules/@shgroup/dsh-serenity-hooks/` | 插件副本是否在（未在 = 已卸载） |

## 6. 排障速查

| 现象 | 排查 |
|------|------|
| 工具未出现 | config.yaml insert 块缩进错误（YAML 2 空格层级）；插件副本缺失；需重启 |
| 守卫不生效 | cwd 不在 CCC 内（无 `.serenity`）；`guards: false` |
| bash 被禁 | `.serenity-safe-on` 存在 → 终端 rm 关闭 |
| 写入被拒 | 路径命中黑名单 / 越出 CCC 根 → 调整 serenity.json 黑名单或路径 |
| 身份注入未出现 | `context: false`；或会话在 CCC 外 |
| 预检失败（部署时） | 依赖解析：确认插件复制在 apps/cli/node_modules/@shgroup/ 且 schemastery shim 存在（见 DEPLOYMENT.md） |

## 7. 与其他插件体系的关系

- **官方通道**（本插件采用）：`~/.dsh/config.yaml` personal-config 层 insert——免改源码，官方支持
- **repository plugins**：`~/.dsh/config.yaml` 的 repository-plugins 行，仅静态技能/MCP，不能改 loop——不适用
- **dsh-external 生态**（plugin-registry / marisa）：第三方插件管理器，需给 DSH 打补丁安装——成本高，未采用

## 参考

- 部署步骤 / 回滚：`docs/DEPLOYMENT.md`
- 插件设计（6 拦截缝）：`docs/dsh-serenity-hooks-design.md`
- 加载脚本：`scripts/load-plugin.sh`
