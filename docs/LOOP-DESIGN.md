# LOOP-DESIGN — ACC 级 acc_loop 工具（老 loop 等效能力）调研与设计

> 需求：serenity ACC 在 DSH 实现老 loop 的等效能力——本质是**用价格低廉模型（MiniMax M3）的牛马循环**：headless agent + 指定模型 + 反复执行直到完成 + 进度追踪/续跑。
> 状态：调研完成（v1，2026-08-07）。待确认后实现。

---

## 1. 老 loop 语义（源码还原，opencode-serenity-plugin）

### 1.1 参数
| 参数 | 必填 | 说明 |
|------|------|------|
| `label` | ✅ | 任务标签 → 会话标题 + 进度文件命名 |
| `session` | ✅ | 工作会话（S101），loop agent 继承上下文，进度写入该会话目录 |
| `model` | 从配置读 | **必需**（`loop.defaultModel`，未配置报错并提示写入 `.opencode/serenity.json`） |

### 1.2 机制
1. 生成 128 位随机 **stop token** + 随机端口
2. spawn 专用 headless opencode serve（外部进程）
3. 每轮 prompt headless agent；检测 stop token 结束；实时进度（stdout JSON → ctx.metadata）
4. 进度文件：`AGENT_SESSIONS/loop-<label>.md`（文本进度）+ `loop-<label>.json`（结构化状态：round/done/response）
5. 续跑：读进度文件从已完成的轮次继续（"永远从上次停止处继续，不重做"）
6. dispose 钩子清理所有残留 serve

### 1.3 轮次 prompt 结构
每轮告诉 agent：读 SESSION.md 回顾进度 → 自由工作（读/改/执行）→ 汇报（做了什么/下一步/是否完成）；**每轮前检查已完成部分，从上次停止处继续**。

## 2. DSH 等效机制（已源码验证 ✅）

| 老 loop 要素 | DSH 实现 | 验证 |
|---|---|---|
| 专用 headless agent | **`ctx.agentLoop.create(id, AgentOptions, meta?)`**——进程内创建，无需外部 serve | ✅ interception.spec 实证 |
| **指定模型** | `AgentOptions = { provider, model, maxTokens }`——**create 时直接指定**（M3 可行） | ✅ agent types |
| 发消息/取回执 | `agent.followup(UserMessage)`；`agent.session.events` 过滤 `assistant/message` | ✅ |
| 等待轮次完成 | `ctx.on('agent/status', (subject, status) => … idle)` | ✅ interception.spec |
| 上下文继承 | 可选：`agent.inject()` 播种；或从工作会话复制事件（fork） | ✅ |
| 进度/续跑 | 同老格式：`AGENT_SESSIONS/loop-<label>.md` + `.json` | 自实现 |
| 清理 | agent 生命周期随 `ctx.effect`/fiber 卸载 | ✅ |
| **模型配置** | 读 `.dsh/serenity.json` `loop.defaultModel`（插件已有此能力） | ✅ 已实现（context.ts 读取） |

## 3. M3 模型接入调研（关键前置）

### 3.1 DSH 模型选择机制
- `AgentOptions.provider/model`：provider 路由**必须已注册适配器**
- DSH 的 `ctx.llm` 缝支持**多适配器并存**：llm-deepseek（deepseek）+ **llm-pi-ai**（通用多 provider：`{ providers: { <route>: { apiKeyEnv, baseURL } } }`）
- **注册 minimax provider = 在 profile patch 加 llm-pi-ai 行**（无需改 DSH 源码）——与插件挂载同机制

### 3.2 待实测项（probe 计划）
| 项 | 现状 | 动作 |
|---|---|---|
| MiniMax M3 对话端点 | 凭证线索指向 `api.minimaxi.com/v1/coding_plan/...`（Token Plan 搜索端点，非对话） | **curl 探测** OpenAI 兼容路径（`/v1/chat/completions`），确认 M3 可用端点 |
| 密钥适用性 | `MINIMAX_TOKEN_PLAN_KEY`（Max 套餐） | 探测时验证对对话端点的鉴权 |
| pi-ai 目录中的模型名 | 未知 'MiniMax-M3' 是否在 pi-ai catalog | 探测后按实际模型名配置 |
| provider 路由名 | 计划 `minimax`（或对齐 opencode 的 `minimax-cn-coding-plan`） | 探测后定 |

### 3.3 风险
- coding-plan 密钥可能仅限搜索/特定端点——若对话端点不可用，需另备 MiniMax 标准 API key（`api.minimax.chat`）
- 探测会消费少量 token（用户知情）

## 4. acc_loop 工具设计

### 4.1 参数（对齐老 loop + DSH 习惯）
```
label: string        (required) 任务标签 → loop-<label>.md/.json 进度文件
session?: string     (optional) 工作会话 S###；缺省从 agent 会话上下文继承
model?: string       (optional) 指定 provider/model（如 minimax/MiniMax-M3）；缺省读 loop.defaultModel
maxRounds?: number   (default 20) 轮次上限（牛马兜底）
```

### 4.2 实现（`src/tools/loop.ts` + 纯逻辑 `src/loop-ops.ts`）
```
execute(args, exec):
  root = findSerenityRoot(agent cwd)          // 无 CCC → 报错
  model = args.model ?? serenity.loop.defaultModel   // 缺失 → 报错（对齐老 loop）
  provider = model.split('/')[0]; modelName = model.split('/')[1]
  loopAgent = ctx.agentLoop.create(newId, { provider, model: modelName }, { cwd: root })
  for round = resumeFrom(progress) .. maxRounds:
    prompt = buildRoundPrompt(root, session, progress, round)   // 对齐老 loop 结构
    loopAgent.followup(prompt)
    await waitIdle(loopAgent)                  // agent/status
    response = lastAssistantText(loopAgent.session)
    writeProgress(progressFile, round, response)               // loop-<label>.md/.json
    if containsStopToken(response) or done → break
  dispose loopAgent（effect 清理）
  return { done, rounds, model, progressFile }
```

### 4.3 进度与续跑
- 文件：`AGENT_SESSIONS/loop-<label>.md`（人类可读）+ `loop-<label>.json`（{round, done, response}）
- 续跑：`resumeFrom` 读 .json 的 round → 从下一轮开始；prompt 附带"已完成的轮次回顾"
- stop token：生成随机 token 注入 prompt（"若完成，输出 <token>"），同老 loop

### 4.4 与 workflow 的关系
- `acc_loop`（B）= **ACC 级忠实 loop**：专用 agent + 指定模型 + 进度文件 + 续跑——替代老 loop 的牛马语义
- `workflow` = 编排器（多代理扇出）——两者互补，不冲突

## 5. 里程碑

- **M1（本设计）**：调研 + 设计 ✅
- **M2**：M3 provider 注册（probe 端点 → profile patch llm-pi-ai minimax 路由）——需用户批准探测
- **M3**：acc_loop 实现（loop-ops 纯逻辑 + tools/loop.ts + 测试）
- **M4**：部署 + 实测（用 M3 跑一个真 loop：如 SQC 扫描）

## 6. 开放问题
- M3 对话端点/密钥确认（M2 探测）
- loop agent 是否需要隔离（独立 session vs 继承工作会话）——设计为独立 session + 可选继承，M3 实测定
- 并发 loop 的 agent 数量上限（agentLoop 配置）
