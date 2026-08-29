# 认知容器敏感数据保护调研

- 日期：2026-08-29
- 会话：S142（dsh-serenity-plugin 长期维护）
- 状态：调研完成，待用户讨论拍板方案
- 触发：用户观察——认知容器中有敏感数据（凭据/机制），提示词与 skill 纪律约束其不出现在最终回答，但仍有意外可能。期望：**用户得到认知过程的结果，但不希望支撑宁静号的凭据与机制透露出去**

---

## 1. 威胁模型（本次 case 的精确表述）

| 维度 | 内容 |
|------|------|
| 资产 | ① 凭据：localstore.json credentials（API keys/tokens/SSH 密码）、`~/.dsh/serenity-hooks.json`（账号 passHash/publicAsk key）、环境变量中的 secret；② 机制：系统提示词全文（Metaphor/Principles/工具清单）、mech-registry、内部结构（插件路由/端口/配置路径） |
| 暴露面 | ① Skiff 问答（3099 调试页）；② ACP HTTP（3100 JSON-RPC）；③ 建议问答页（3100 /c/<name>，key 认证对外）；④ 未来企微/IM 桥（F4c-2）——**均为"用户问、agent 答"形态** |
| 攻击路径 | ① **提示词注入**（用户问句诱导 agent 复述系统提示词/读取凭据文件）；② **工具结果透传**（read localstore.json → 凭据进上下文 → 回答中复述）；③ **间接推断**（凭据格式/部分泄露 + 用户组合爆破）；④ 机制探测（工具清单/错误信息反推内部结构） |
| 现状约束 | 提示词纪律（"凭据只放 localstore，不泄露"）+ skill 纪律（EAP/SSH 规范）——**都是软约束（LLM 行为层），非机械保证**；用户的关切即"仍有意外可能" |

---

## 2. 业界做法（调研结果）

### 2.1 输出侧过滤（Output Redaction）——最直接对应"最终回答不含敏感数据"

| 方案 | 机制 | 参考 |
|------|------|------|
| **Docker agent `redact_secrets` builtin** | YAML hooks 声明 secrets 模式（正则/字面量），工具输出与日志经 hook 掩码替换 | [redact_secrets_hooks.yaml](https://github.com/docker/docker-agent/blob/main/examples/redact_secrets_hooks.yaml) |
| **dsh-guardian**（DSH 生态插件） | Runtime tool policy + dangerous-command guard + **output redaction**——直接对接 DeepSeek Harness 拦截缝 | [lonelymoon87/dsh-guardian](https://github.com/lonelymoon87/dsh-guardian) |
| **liteLLM + Presidio** | 网关层 PII masking callback：正则（邮箱/电话/卡号）+ NER 双通道识别 → 掩码 token 化 → 安全上下文才还原 | [Presidio PII Masking with liteLLM](https://docs.litellm.ai/docs/tutorials/presidio_pii_masking) |
| **Guardrails MCP / Blackwall LLM Shield / clawguard** | 输入校验 + prompt injection 检测 + PII redaction + 策略执行 + 审计日志（MCP/JS/Python 工具形态） | [guardrails-mcp-server](https://github.com/ExpertVagabond/guardrails-mcp-server) / [blackwall-llm-shield](https://github.com/vpdeva/blackwall-llm-shield-python) / [clawguard](https://socket.dev/npm/package/clawguard) |

**共同模式**：**不做"模型自觉"，做"机械层后处理"**——LLM 输出/tool 结果经过一次正则/规则/模型过滤器，命中 secret 模式即掩码。关键设计点：掩码 token 化（`<REDACTED:ssh_password>`）保留语义可读性；**安全上下文（管理员）才还原**。

### 2.2 凭据结构隔离（Structural Guarantee）——"agent 根本接触不到真实凭据"

| 方案 | 机制 | 参考 |
|------|------|------|
| **wardn** | "credential isolation for AI agents. **Agents never see real API keys — structural guarantee, not policy.**"——真实 key 由代理持有，agent 只见掩码/引用，需要时经受控通道代取 | [rohansx/wardn](https://github.com/rohansx/wardn) |
| **llm-safe-haven** | 完整威胁模型文档化：隔离边界/最小权限/审计面 | [llm-safe-haven threat-model](https://github.com/pleasedodisturb/llm-safe-haven/blob/b942e2fb3667f6c51157e9de2dcfd1cc90ce13d4/docs/threat-model.md) |

**核心洞见**：靠提示词说"不要泄露"是最弱的防线；**让 LLM 的输入面根本不含 secret 值**（或只有掩码）是结构性保证。wardn 明确区分 "policy"（策略，可被绕过）与 "structural guarantee"（结构，无法绕过）——与本会话用户"提示词纪律仍可能有意外"的关切完全一致。

### 2.3 系统提示词/知识保护（机制不泄露）

| 方案 | 机制 | 参考 |
|------|------|------|
| **redteams.ai system prompt protection** | 指令提取（prompt extraction）防御技术综述：分隔符混淆/注入检测/最小化披露 | [System Prompt Protection](https://redteams.ai/topics/walkthroughs/defense/system-prompt-protection) |
| **moZlAyer secure-custom-gpt-toolkit** | Zero-trust 框架：硬化系统提示词 + 模块化知识文件（知识与指令分离，按需装配）防 prompt injection/jailbreak | [secure-custom-gpt-toolkit](https://github.com/mozlayer/secure-custom-gpt-toolkit) |
| **Custom GPT 社区实践** | 结论一致：**指令提取无法 100% 防御**，只能减缓（最小化披露 + 检测 + 归责） | [OpenAI 社区讨论](https://community.openai.com/t/custom-gpts-gpt-store-and-instructions-protection/616927/3) |

**关键共识**：**没有万无一失的提示词防线**。防御重心应放在①最小化敏感信息进上下文 ②机械后处理兜底 ③审计。

### 2.4 网关/DLP 层（整体数据外泄防护）

| 方案 | 机制 |
|------|------|
| **Entro WebGuard / Barndoor AI LLM Gateway** | 浏览器/网关层拦截敏感数据进 AI 工具；DLP 策略 | [Entro](https://entro.security/blog/entro-webguard-stop-sensitive-data-from-leaking-into-ai-tools/) / [Barndoor](https://barndoor.ai/release-llm-gateway-data-loss-prevention-mcps/) |
| **tokligence prompt firewall** | 请求/响应双向防火墙 | [PROMPT_FIREWALL.md](https://github.com/tokligence/tokligence-gateway/blob/main/docs/PROMPT_FIREWALL.md) |
| **IEEE 多阶段 NLP 框架** | 企业公共 LLM 交互的分层数据保护（检测→掩码→审计） | [IEEE 论文](https://ieeexplore.ieee.org/abstract/document/11570292) |

---

## 3. 本地现状盘点（宁静号/dsp 已有防护）

### 3.1 已有（机械层）

| 面 | 机制 | 覆盖 |
|----|------|------|
| 工具调用守卫 | `guards.ts` tools/pre-execute + ctx.tools.guard：safe-mode bash 禁用 / 路径逃逸 / 黑名单 / **skiff 角色白名单**（工具面） | **输入侧**——管"能不能调用"，**不管结果内容** |
| 凭据读取面 | localstore 工具 `list/show` 只返回 key 名不返回值（get 才返回值） | 部分（软约束为主） |
| skiff 机制隔离 | skiff 会话旁路 keeper/bootstrap/compact/context；scoped 系统提示词（基础段 + CCC 定义段，**不注入 ACC 全量机制**） | skiff 会话的机制暴露已最小化 |
| 提示词纪律 | 系统提示词 "凭据只放 localstore，不泄露" + skill 纪律 | **软约束**——正是用户担忧的"意外可能" |

### 3.2 差距（缺口）

1. **无输出侧 redaction**：工具结果（read localstore.json 明文 → 上下文）与最终回答中的 secret 值**无机械过滤**。`tools/post-execute` waterfall 已存在（keeper 在用）——扩展点现成但未用于 redaction。
2. **skiff 白名单是"工具面"不是"数据面"**：qa 角色有 read/grep/glob——**可以直接 read 根目录 localstore.json 拿全部凭据明文**（或 grep 全仓 secret 模式）。白名单管了"哪些工具"，没管"哪些文件/哪些内容"。
3. **凭据值可经正常工具路径出**：localstore get 返回 value；msm exec 注入 SERENITY_ROOT/CCC/VERSION 环境；配置读工具可读 ~/.dsh/serenity-hooks.json（账号 hash/key）。
4. **非 skiff 会话全量机制可见**：普通 CCC 会话（本会话即如此）系统提示词含全部工具清单/机制描述——对"外部用户"不可见（仅本地 agent），但未来 IM 桥若复用普通会话则暴露。

---

## 4. 方案空间（供用户讨论）

> 设计原则对齐：**机械保证优先于模型自觉**（wardn 洞见）；**最小化敏感信息进上下文**（redteams 共识）；**复用现成拦截缝**（tools/post-execute）。

### A. 输出侧 redaction 层（机械，推荐优先）
- **落点**：`tools/post-execute` waterfall（result 改写）+ `agent/status`/回答面拦截
- **规则源**：secret 模式表——localstore credentials 实际值（运行时读取，值即规则）+ 已知敏感模式（`~/.dsh/serenity-hooks.json` 的 passHash/publicAsk key 格式）+ 通用模式（`sk-` 类 token/`-----BEGIN`/SSH 私钥块）
- **行为**：命中 → `<REDACTED:<类型>>` 掩码（token 化保留可读性）；仅管理员会话（非 skiff/非外部面）还原
- **参考**：Docker redact_secrets / dsh-guardian / liteLLM Presidio
- **工作量**：中小（规则表 + 一个 waterfall + 测试）

### B. 凭据结构隔离（wardn 风格，长期）
- **落点**：localstore get 对 agent 返回掩码/引用；真实值仅经 MSM 内部通道（env 注入已有先例 SERENITY_ROOT/CCC）代取
- **效果**：**agent 输入面不含 secret 值**——即使被 prompt injection 也无值可吐（结构性保证）
- **代价**：需改造依赖 localstore get 直读的 MSM/流程（迁移面）
- **参考**：wardn（"structural guarantee, not policy"）

### C. skiff 数据面白名单（补 skiff 缺口，机械）
- **落点**：guards.ts 对 skiff 会话加**路径级数据面规则**——read/grep/glob 命中敏感路径（localstore.json / ~/.dsh/serenity-hooks.json / .env / 凭据文件）→ deny
- **效果**：qa 角色"能读文件"但"读不到凭据文件"
- **工作量**：小（guards 加分支 + 测试）——**与 A 互补**（C 防"读取"，A 防"泄露"）

### D. 机制最小化披露（对 skiff/外部面）
- **现状**：skiff 已是 scoped prompt（不含 ACC 全量机制）✓；普通会话暂不必（仅本地）
- **可选增强**：对外部面（未来 IM 桥）进一步剥离工具清单/路由细节；错误信息泛化（已有先例：guards deny 提示不泄漏白名单外工具名）

### E. 审计与告警
- **落点**：post-execute/回答面扫描命中 secret 模式 → 审计日志（console.warn + 落盘）——泄露发生时可归责、可复盘
- **参考**：guardrails-mcp-server audit logging / IEEE 框架

### 推荐组合
**首期**：A（输出 redaction）+ C（skiff 数据面白名单）——两者都是机械层、复用现成缝、工作量可控，直接消除"意外可能"的两条主要路径（读不到 + 吐不出）。
**二期**：E（审计）——泄露可视化。
**长期**：B（结构隔离）——彻底（若迁移成本可接受）。

---

## 5. 待用户决策

1. **首期范围**：A+C 组合是否采纳？或只做其一？
2. **redaction 规则源**：localstore 实际值自动入规则表（运行时读取）是否接受？敏感模式清单的粒度（通用 token 格式 vs 仅本机已知值）？
3. **掩码形态**：`<REDACTED:<类型>>` token 化 vs 全星号 `****`？
4. **B 结构隔离**：是否列入长期规划（涉及 MSM 迁移面）？
5. **审计落点**：仅 console 日志 vs 落盘文件？

---

## 6. 参考链接

- [wardn — credential isolation for AI agents](https://github.com/rohansx/wardn)
- [dsh-guardian — DSH runtime tool policy + output redaction](https://github.com/lonelymoon87/dsh-guardian)
- [Docker agent redact_secrets hooks](https://github.com/docker/docker-agent/blob/main/examples/redact_secrets_hooks.yaml)
- [liteLLM Presidio PII masking](https://docs.litellm.ai/docs/tutorials/presidio_pii_masking)
- [guardrails-mcp-server](https://github.com/ExpertVagabond/guardrails-mcp-server)
- [Blackwall LLM Shield](https://github.com/vpdeva/blackwall-llm-shield-python)
- [redteams.ai System Prompt Protection](https://redteams.ai/topics/walkthroughs/defense/system-prompt-protection)
- [moZlAyer secure-custom-gpt-toolkit](https://github.com/mozlayer/secure-custom-gpt-toolkit)
- [llm-safe-haven threat model](https://github.com/pleasedodisturb/llm-safe-haven/blob/b942e2fb3667f6c51157e9de2dcfd1cc90ce13d4/docs/threat-model.md)
- [Entro WebGuard](https://entro.security/blog/entro-webguard-stop-sensitive-data-from-leaking-into-ai-tools/) / [Barndoor LLM Gateway](https://barndoor.ai/release-llm-gateway-data-loss-prevention-mcps/) / [tokligence prompt firewall](https://github.com/tokligence/tokligence-gateway/blob/main/docs/PROMPT_FIREWALL.md)
- [IEEE 多阶段 NLP 框架](https://ieeexplore.ieee.org/abstract/document/11570292)
- [OpenAI Custom GPT instructions protection 讨论](https://community.openai.com/t/custom-gpts-gpt-store-and-instructions-protection/616927/3)
