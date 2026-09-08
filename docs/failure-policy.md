# dsp 失败策略（S142 review F-07）

> 状态：v1.30.8 落地。机械门禁：`hooks/dsh-serenity-hooks/tests/failure-policy.test.ts`。
> 适用范围：`hooks/dsh-serenity-hooks/src/**`（node 面 + client 面）。

## 1. 为什么需要策略

review 实证：dsp 有 **190+ 处 catch**，其中多数是"降级不崩"的有意设计——但**未命名**的静默
catch 无法与"忘了处理"区分，且 `v1.30.5` 那次真实 bug 的形态就是"静默失败"（宿主错误码漂移 →
补救永不触发且无任何日志）。因此策略不是"消灭 catch"，而是**让每个 catch 的语义可重建**。

## 2. 四类失败与各自义务

| 类 | 场景 | 义务 | 例子 |
|----|------|------|------|
| **P0 守卫/配置输入** | 安全模式黑名单、skiff 角色、handyman 白名单、localstore 凭据、宿主契约 | **响亮**：记录日志（含路径/原因/后果），降级语义写在日志里 | `ccc.loadSerenityConfig`、`localstore-ops.readAll`、`skiff-role.readSkiffRoles`、`settings-section`、`host/contract` |
| **P1 可选宿主服务** | `ctx.get('tokenMeter')` 等 lazy 服务缺失 | **响亮一次**（去重）+ 降级返回 `undefined`/空 | `host/access.ts`（返回 undefined，由调用方决定）、`settings-section`（warnOnce） |
| **P2 尽力而为的清理/诊断** | 退订、`socket.destroy()`、诊断落盘、日志、进程退出清理 | **静默但必须点名**（注释说明吞掉什么、为什么没有其它路径能到达） | `gateway` 的 socket noop、`seams/lifecycle` 的拆卸、`seams/guards.writeRestrictDiag` |
| **P3 边界翻译** | 工具入参/网络响应/子进程 | 转成**用户可见错误**（返回错误码/抛 `Error`），不吞 | `msm-ops` 路径逃逸、`git-ops`、`fs-ops` |

判断顺序：**能响亮就响亮**；只有"失败无副作用且无人在意"才允许 P2，并且必须留注释。

## 3. 硬规则（门禁强制）

1. **空 catch 必须含注释**，注释点名"吞掉了什么"。`tests/failure-policy.test.ts` 机械检查，
   违规 = 测试失败并列出 `文件:行`。
2. `apply()` 及其调用的装配路径**永不抛错**——宿主对插件 apply 抛错 = 整个 dsh 启动失败
   （`app-boot` 的 "plugin(s) failed to load"）。装配期失败一律"响亮降级"。
3. 生命周期/拆卸回调**一律吞错**（不影响宿主销毁流程），但每次吞错保留注释。
4. 去重告警用进程级 `Set`/`boolean`，并提供 `__reset...ForTest` 钩子——不刷屏，也不静默。

## 4. v1.30.8 落地的 P0/P1 修复

| 位置 | 之前 | 之后 |
|------|------|------|
| `ccc.loadSerenityConfig` | 坏 JSON → 静默 `{}`（黑名单/白名单/角色全部无声失效） | 按路径去重告警（路径 + 原因 + 后果），仍返回 `{}`（fail-open 但不静默） |
| `localstore-ops.readAll` | 坏 JSON → 静默 `{}`（凭据表现为"未设置"） | 按路径去重告警 |
| `skiff-role.readSkiffRoles` | 读失败 → 静默空角色集（所有 skiff 会话被拒且无线索） | 告警（权限面保持 fail-closed） |
| `settings-section.registerSettingsSection` | 无 settings provider → 静默降级 | warnOnce（面板开关不生效必须可见） |
| `host/effect.registerDisposer` | 无（新模块） | `ctx.effect` 缺失 → 告警 + 同标签去重 + 返回 false |
| `host/access.*` | 30+ 处分散断言 | 唯一读取入口，服务缺失返回 `undefined` 不抛错（契约由 `host/contract.ts` 探针 + `dashboard health` 报告） |

## 5. 残留（明确不做的部分）

- **不**把 P2 静默 catch 全部改成告警：拆 socket、退订、诊断落盘失败是正常的噪声源，
  告警只会淹没真正的信号（这正是 review 里"可观测性被动"的另一面）。
- **不**做全局错误上报/遥测：ACC 层不做网络副作用；错误可见性靠日志 + `dashboard health`。
- 依赖链上的 `@deepseek-ai/*` 宿主包在插件仓不可解析（由宿主提供）——测试用 `vi.mock` 保真，
  见 `tests/seams/lifecycle.test.ts` 的注释。
