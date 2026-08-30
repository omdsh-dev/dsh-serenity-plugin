# @shgroup/dsh-serenity-hooks

宁静号 ACC（Abstract Cognitive Container）harness — **DeepSeek Harness 原生 Cordis 插件**（npm 发布单元，v1.26.11）。

为 DSH 会话提供认知容器基础设施：真实 DSH 工具（12 个）+ 拦截缝机械约束（safe-mode / 路径守卫 / 凭据守卫 / 输出守卫）+ 系统提示词注入（8 块，对齐 opencode-serenity-plugin）+ WebUI 状态胶囊 + 外部访问（双端口网关 / Skiff 问答 / ACP+建议问答页）。

## 安装

```bash
dsh plugin --profile web add @shgroup/dsh-serenity-hooks
```

安装后重启 dsh web。在带 `.serenity` 标记的 CCC 目录中的会话自动获得全部能力。

## 工具（12）

`cc_fs` / `session` / `acc_kit` / `cc_git` / `acc_msm` / `eap` / `neat` / `cce` / `handyman` / `session_rebuild` / `localstore` / `skiff_admin`

## 系统提示词（8 块）

`systemPrompt.section`（order -50）：`=== Serenity ACC ===`（身份+工具清单）/ `=== Serenity Metaphor ===`（世界模型三层隐喻）/ `=== Serenity Principles ===`（认知容器本体论 + MSM 原则）/ `=== Serenity CCE ===`（5 行为约束）/ `=== Serenity EAP ===`（E↑R↓S↑ 自检）/ 状态块（Safe Mode / Localstore）/ 顶层入口 skill 全文（按 `.serenity` 记号发现）/ `=== Serenity Session ===`（活跃会话 + Trajectory Steward 预声明）—— 平台无关文本与 [opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) 逐字节对齐；同一 CCC 可任意换用 osp / dsh 运行时。

## 配置

`.opencode/serenity.json`（CCC 级）：

```jsonc
{
  "handyman": { "models": ["provider/model"], "defaultModel": "provider/model" },
  "sessionKeeper": { "threshold": 100 },
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] },
  "skiff": { "roles": { "qa": { "msms": [], "tools": [], "systemPrompt": "" } } }
}
```

plugin 级配置（账号/开关/阈值）在 DSH 设置面板 + `~/.dsh/serenity-hooks.json`（0600）。

## 文档

- 完整文档：仓库 [README](https://github.com/tellmewhattodo/dsh-serenity-plugin)（能力为主）
- 理论叙述：`docs/cognitive-container-theory.md`
- 设计决策与架构：`CHANGELOG.md` + 维护 skill（`dsh-serenity-plugin-development`）

## 许可

MIT
