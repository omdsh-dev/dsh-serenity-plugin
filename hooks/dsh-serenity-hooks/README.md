# @shgroup/dsh-serenity-hooks

宁静号 ACC（Abstract Cognitive Container）harness — **DeepSeek Harness 原生 Cordis 插件**。

为 DSH 会话提供认知容器基础设施：真实 DSH 工具（9 个）+ 拦截缝机械约束（safe-mode / 路径守卫 / 会话落盘）+ 系统提示词注入（ACC/CCE/Constraints/SKILL/Session 五块，对齐 opencode-serenity-plugin）+ WebUI 状态徽章。

## 安装

```bash
dsh plugin --profile web add @shgroup/dsh-serenity-hooks
```

安装后重启 dsh web。在带 `.serenity` 标记的 CCC 目录中的会话自动获得全部能力。

## 工具

`cc_fs` / `session` / `acc_kit` / `cc_git` / `acc_msm` / `eap` / `neat` / `cce` / `handyman`

## 系统提示词

五块注入（`systemPrompt.section`，order -50）：`=== Serenity ACC ===` / `=== Serenity CCE ===` / `=== Serenity Constraints ===` / 顶层入口 skill 全文（按 `.serenity` 记号发现）/ `=== Serenity Session ===` —— 平台无关文本与 [opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) 逐字节对齐；同一 CCC 可任意换用 osp / dsh 运行时。

## 配置

`.dsh/serenity.json`（回退 `.opencode/serenity.json`）：

```jsonc
{
  "handyman": { "models": ["provider/model"], "defaultModel": "provider/model" },
  "sessionKeeper": { "threshold": 100 },
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] }
}
```

## 文档

完整文档见仓库 [README](https://github.com/tellmewhattodo/dsh-serenity-plugin)。

## 许可

MIT
