---
name: acc-safe-mode
description: 安全模式协议（safe-mode 语义，DSH 版——v1.30 机制不变：WebUI 开关控制 .serenity-safe-on 标记，bash 禁用 + 写入黑名单机械执行）。on/off/status/check 控制标记；黑名单规则在 serenity.json 的 safeMode.blacklist 配置。守卫由拦截缝机械执行（非独立工具）。
---

# Skill: acc-safe-mode — 安全模式协议

> **v1.30.0 说明**：安全模式非独立工具——开关仅 WebUI（x-serenity-ui 头），agent 不可见不可自开关；守卫由拦截缝（guards seam）机械执行。本技能为知识说明。

## 用途

安全模式是 ACC 的**降权守卫**：开启后 Agent 的行为被收紧——bash 仅允许只读操作，write/edit 前必须对目标路径做黑名单检查。

## 触发

- 系统提示 / 用户要求进入安全模式
- CCC 根目录存在 `.serenity-safe-on` 标记文件（自动生效，无需调用）
- 涉及敏感路径（密钥、数据、生产配置）时建议开启

## 操作协议

```bash
bun "<skill 基目录>/scripts/safe-mode.ts" <subcommand> [args...]
```

| 子命令 | 说明 |
|--------|------|
| `on` | 开启：创建 `.serenity-safe-on` 标记文件 |
| `off` | 关闭：删除标记文件 |
| `status` | 状态：标记存在与否 + 黑名单规则列表（JSON） |
| `check <path>` | 检查路径是否命中黑名单（开启时每次 write/edit 前必查） |

## 黑名单规则（`.dsh/serenity.json` 或 `.opencode/serenity.json`）

```json
{
  "safeMode": {
    "blacklist": [".secrets/", "regex:\\.env$", "home-credentials.json"]
  }
}
```

| 规则形态 | 匹配 |
|---------|------|
| 普通字符串 | 路径前缀匹配（相对 CCC 根） |
| `regex:<expr>` | 正则匹配完整相对路径 |

## 安全模式下的行为纪律（强制）

1. **bash 禁用写操作**：仅允许只读命令（ls/cat/git status 等）；任何写操作（mkdir/rm/写入/移动）需先 `off`（需用户确认）
2. **write/edit 前检查**：对目标相对路径执行 `check <path>`；命中黑名单 → 拒绝并解释原因
3. **标记即状态**：`.serenity-safe-on` 存在即生效，不依赖对话记忆

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（on/off/status；check 未命中） |
| 1 | user 错误（未知子命令 / 缺参数） |
| 2 | system 错误（无 CCC；check 命中黑名单） |

## 何时使用

- 处理敏感文件前后
- 用户要求"小心点"时
- 长时间无人值守的循环任务前

## 参考

- 配置 schema：`.dsh/serenity.json`（`src/config-schema.ts`）
- 身份与工具映射总览：`acc-serenity` 技能
