/**
 * dsh-serenity-hooks — client half 入口（浏览器 bundle）
 *
 * 注册 UI 面：
 *  - conversation.session.header.actions — 头部状态徽章（绿点 + safe-mode 开关），
 *    点击徽章展开详情卡（CCC/handyman/守卫 + 大开关）。
 *  - conversation.input.dock — 图片自动落盘兜底（S142）：当前模型不支持图片时，
 *    发送失败（MODEL_DOES_NOT_SUPPORT_IMAGES）自动补救——图片上传 _tmp/images_from_user/、
 *    以「用户提供了图片在 {path}」文本重发，agent 经 CCC 自己的 vlm MSM 自主处理。
 *  - conversation.input.dock — 任意文件粘贴自动落盘（v1.24.1）：非图片文件粘贴 →
 *    _tmp/files_from_user/ + draft 追加路径提示（随发送进消息），agent 经 CCC MSM 处理。
 *  - settings.section — dsh 原生设置面板的 serenity-hooks 简单配置页（v1.21 分层：
 *    开关/阈值走 DSH settings；账号列表走宁静号高级面板）。
 * Export 纪律：只暴露 cordis apply 面。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
// v1.31.6 适配 0.1.5-rc.1：session 作用域类型面被抽成独立包。
//  - `SessionStandardProps.sessionId`（session-scope slot props 的标准套件）：ui-conversation → ui-session
//  - `Context.sessions`（client 面 ISessions）：ui-session 自己 import 了 api-session-controller/client
// 故本行**一个空类型 import 同时修好两条**（缺它则 props.sessionId / ctx.sessions 在 client 半编译不过）。
// 纯类型导入 → transform 期擦除，不触 client bundle purity 插件，PLATFORM_MODULES 无需改动。
import type {} from '@deepseek-ai/dsh-client-ui-session'
// v1.28.0 适配 0.1.2-rc.1（A1 补充）：官方 feature 插件经 ui-renderer/client 类型 import
// 获得 Context.slots 等 client 面声明合并（原 dsh-client-runtime 包提供；rc.1 已删）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
// 🆕 v1.51.2：`tool.call.toolview` 这个 SlotMap 条目**由宿主包 ui-tool 声明**（模块增强）
// ⇒ 必须**真的把它 import 进来**。🔴 只加 devDependency ＋ `paths` 条目**不够**：
//    `paths` 只是一张映射表，**没有任何 import 时那个 `.d.ts` 根本不进本程序**
//    ⇒ 增强不生效、`slots.register({name:'tool.call.toolview'})` 被判"不在 SlotMap"
//    （2026-09-29 实测：TS2344 ＋ TS2769，槽名被列进一串它不认识的名字里 —— 这条错误正是
//      "接了真契约"才暴露出来的；本地 `declare module` 那版会把这个事实**盖住**）。
// 走**公开包入口**（`/client`），不是宿主内部实现路径（§2.4-1 禁止后者）。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// 🆕 v1.51.3：`conversation.chat.turnTail` 这个槽条目**由宿主包 ui-chat 声明**（同一个道理 ——
// 没有 import 就没有模块增强）。写在**注册点**，是为了让这一行自足：
// 即便哪天 `diagram-tail.ts` 不再 import 该包，槽名在这里仍解析得到。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// v1.28.0 适配 0.1.2-rc.1（A1）：dsh-client-runtime 包已删 →
// ClientContext 用官方同款 `Context as ClientContext` from '@deepseek-ai/cordis'。
// 🔴 v1.47 适配 0.1.7-rc.1：`SettingsScope`/`SettingsScopeSpec` 与 `settingsScope` 服务**已从
//    `dsh-client-ui-settings` 移除**（实测：该包 client 面只导出 ConfigForms / ConfigForm /
//    SettingsSchemaService / SettingsDescribe*）⇒ 设置页数据改走 `ctx.configForms`
//    （按 profile 条目 Config 投影的表单），注册面改走 `configForms.whileServed`。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SafeModePanel } from './SafeModePanel.js'
import { ImageFallbackDock, ImageFallbackInjected } from './ImageFallbackDock.js'
import { uploadImage, getDraftFiles, resendText } from './image-fallback-api.js'
import { FileFallbackDock, FileFallbackInjected } from './FileFallbackDock.js'
import { uploadFile } from './file-fallback-api.js'
import { SettingsSection, SettingsSectionInjected, SerenitySimpleWire } from './SettingsSection.js'
import { DiagramToolView } from './DiagramToolView.js'
import { DiagramImageTail, diagramTailInjected } from './DiagramImageTail.js'

// v1.51.3 加 `uiConversation`：轮尾图行要用宿主的 Chat 快照（`binding().target('chat')`）
// 与宿主的会话授权图片 URL 缓存（`imageUrl` / `peekImageUrl`）—— 两者都在这个服务上。
export const inject = ['slots', 'conversation', 'sessions', 'configForms', 'uiConversation']

/** 设置页命名空间 = profile 条目 id（与 host 侧 `SERENITY_SETTINGS_NS` 同值；单一真相源在 host 侧常量，此处只作字面量引用） */
const SERENITY_SETTINGS_NS = 'serenity-hooks'

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation', 'sessions', 'configForms', 'uiConversation'], (scope: ClientContext) => {
    // v1.22.4 定稿：container_trajectory rebuild 复用旧会话原地清空（turn 结束 surface replace），
    // 无新会话创建 → 无需 client 自动切换（同会话 id、同工作区天然保持）。

    scope.effect(
      () =>
        scope.slots.register(
          { name: 'conversation.session.header.actions', id: 'serenity-safe', order: 10 },
          SafeModePanel,
        ),
      'serenity: header status badge',
    )

    // 图片自动落盘兜底（S142）：input.dock 条目，inject 提供图片操作回调（conversation/sessions 服务在 apply 闭包持有）
    scope.effect(
      () =>
        scope.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'serenity-image-fallback',
            order: 100,
            inject: (): ImageFallbackInjected => ({
              uploadImage: (file, sessionId) => uploadImage(file, sessionId),
              getDraftFiles: (sessionId, ids) => getDraftFiles(scope, sessionId, ids),
              resendText: (sessionId, text) => resendText(scope, sessionId, text),
            }),
          },
          ImageFallbackDock,
        ),
      'serenity: image fallback dock',
    )

    // 任意文件粘贴自动落盘（v1.24.1）：input.dock 条目——非图片文件粘贴 →
    // _tmp/files_from_user/ + draft 追加路径提示（随发送进消息，不自动发送）；无 UI
    scope.effect(
      () =>
        scope.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'serenity-file-fallback',
            order: 110,
            inject: (): FileFallbackInjected => ({
              uploadFile: (file, sessionId) => uploadFile(file, sessionId),
            }),
          },
          FileFallbackDock,
        ),
      'serenity: file fallback dock',
    )

    // v1.21 分层：简单配置 → dsh 原生设置面板（settings.section）。
    // v1.47（0.1.7-rc.1 A 案）：数据面 = `configForms.get(条目 id)`（条目 Config 投影的表单）；
    // 注册面 = `configForms.whileServed`——**宿主没在 serve 这个命名空间就不注册**，
    // 这正是旧版 `snapshot.status === 'unavailable'` 降级提示的官方替代（页面自动出现/消失）。
    const serenityForm = scope.configForms.get<SerenitySimpleWire>(SERENITY_SETTINGS_NS)
    scope.effect(
      () =>
        scope.configForms.whileServed([SERENITY_SETTINGS_NS], () =>
          scope.slots.inject('settings.section', () =>
            scope.slots.register(
              {
                name: 'settings.section',
                id: SERENITY_SETTINGS_NS,
                order: 90,
                label: () => 'Serenity',
                inject: (): SettingsSectionInjected => ({
                  hooks: { serenitySettings: serenityForm },
                  set: (field, value) => {
                    // 写失败不抛给 UI：表单快照会由宿主回读（镜像）自行收敛
                    void serenityForm.set(field, value).catch((_error: unknown) => { /* 见上 */ })
                  },
                }),
              },
              SettingsSection,
            ),
          ),
        ),
      'serenity: simple settings section',
    )

    // v1.51.2 diagram 图片行（Chat 视图）：`diagram` 的结果是 `[text 信封, image 图块]`，
    // 但宿主只有内建 `read_image` 声明了 durable 图片画廊（子槽 `tool.call.images`），
    // 未注册的 Tool 名落通用行 ⇒ 只 flatten 成文字、**图不出现**。
    // 🔴 **本条目刻意不声明任何子槽**：子槽「恰好一个条目声明」——再声明一个 `tool.call.images`
    //    **加载即抛**（宿主 `dsh-client-ui-tool` 槽契约原话）。故本行自己用 owner 交来的
    //    `loadImage` 取图渲染（见 `DiagramToolView.tsx` 文件头）。
    // `slots.inject` 而非直接 register：该槽归宿主 `ui-tool` 所有，可能后于本插件装上。
    scope.effect(
      () =>
        scope.slots.inject('tool.call.toolview', () =>
          scope.slots.register({ name: 'tool.call.toolview', key: 'diagram' }, DiagramToolView),
        ),
      'serenity: diagram tool view',
    )

    // v1.51.3 轮尾图行（Chat 视图）：工具卡**可折叠** ⇒ 折起来图就没了。owner 的诉求是
    // "图要出现在回答区域、且仍不落盘" —— 走宿主给的正路：`conversation.chat.turnTail`
    // 这个**list 槽**（官方 `ui-deliverables` 就是这么挂交付物的），在图归属我们的前提下
    // 自己渲染。数据与 URL 都取自宿主既有设施（Chat 快照 ＋ 会话授权图片 URL 缓存），
    // **不新建 HTTP 路由、不落工作区文件、不常驻内存**（见 `DiagramImageTail.tsx` 文件头）。
    // 🔴 该槽**要求** `inject` 面（实测 0.1.7-rc.1 契约：缺它 tsc 直接报 "Property 'inject' is missing"）
    // ⇒ 按官方同款（`ui-deliverables`）把客户端 ctx 包成注入面交给组件。
    scope.effect(
      () =>
        scope.slots.inject('conversation.chat.turnTail', () =>
          scope.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'serenity-diagram-tail',
              inject: () => diagramTailInjected(scope),
            },
            DiagramImageTail,
          ),
        ),
      'serenity: diagram image tail',
    )
  })
}
