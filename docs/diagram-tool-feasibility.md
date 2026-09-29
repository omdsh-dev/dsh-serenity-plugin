# 「画给人看的图」做成 ACC 工具 —— 可行性调研

> 2026-09-29 ／ S142 ／ owner 需求：「做成一个 tool，**ACC 级别**的，配合一个开关（demo 功能，默认关，开了才可用）；
> Agent 调用这个 tool **直接给代码就行**，然后 dsh 可以**自动渲染成图片**（注意**不借助浏览器生成截图**）；
> 是**原地渲染**还是借助**右侧 sidebar** 渲染，交互上都可以 —— 调研可行性」。
>
> 本文只回答**可行性**。语法设计（owner 已定「标签格式」）与实现另开。
> 🔴 证据等级标注：**【实测】**＝本机跑过/读过真实字节；**【读源码】**＝从宿主源码读出的事实；**【推断】**＝未验证。

---

## 0. 结论速览

| 问 | 答 |
|---|---|
| 能不能不靠浏览器截图出图？ | ✅ **能**，而且有**两条互不依赖**的路 |
| 路 1：图**直接出现在对话里** | ✅ 可行，且是**类型级可证**的通路；🔴 **但必须先把 SVG 光栅化成 PNG/JPEG/WebP/GIF** |
| 路 2：图渲染在**右侧栏面板**里 | ✅ 可行，且**零光栅化、零新依赖**（浏览器原生渲染 SVG） |
| 一条被排除的想法 | ❌ **SVG 走 attachment 必被拒**（白名单硬约束，见 §1.3）——不是"待验证"，是"确定失败" |
| 主要成本 | 路 1 要引**一个光栅化器**（本插件当前 **runtime 依赖 = 0**）；路 2 要写**客户端 tab type** |

**一句话**：**"不借助浏览器"这条满足**；两条路都能走通，**分歧点只有一个 —— 要不要为了"图进对话记录"引入一个光栅化器**。

---

## 1. 图是怎么到人的眼睛的（只有两条路）

### 1.1 路 1 —— 对话内（durable ImageBlock）

**【读源码】**工具结果可以带图片：`ContentBlockMap` 含 `'image': ImageBlock`；工具可以返回 `ContentBlock[]`。

- 类型：`dsh-llm/lib/types/types.d.ts:61-71`（`ImageBlock{type:'image'; attachment:ImageAttachmentRef}`）／`:114-118`
- 造 ref：`ctx.attachments.saveImage({ data: Uint8Array, mediaType, name? }) → ImageAttachmentRef`
- 送达客户端：客户端对 ImageBlock 走 RPC `session.readAttachment(id)` → `URL.createObjectURL(new Blob(...))`
  （`dsh-client-ui-conversation/lib/client.js:2810-2817`）；宿主侧校验"本会话确实引用过该图"。
- 🔵 **本会话已实证**：我调 `read_image(<png>)`，owner 真的在 GUI 里看到了图 —— **全程没有浏览器参与渲染进程**。

⇒ **这条路的终点是"一张位图进对话流"**：可回看、可被后续轮次引用、**可经微信桥转发给别人**。

### 1.2 路 2 —— 右侧栏（客户端插槽）

**【读源码】**`sidebar.right.pane.tab` 是一个 **keyed 插槽**，其文档**明写它是给"从本仓库之外发布的 tab 类型"用的**：

> "`sidebar.right.pane.tab` is how a tab type contributes a body. It is keyed by the type definition's `id`,
> so adding a type is a registration, never an edit here. **The key domain stays the open string space
> because a tab type may ship from outside this repository.**"
> —— `dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts`

同族插槽（0.2.0-rc.1 实测清单）：`sidebar.right.pane.tab`（body ／ keyed ／ session）｜
`sidebar.right.pane.tab.title`（chip 标题 ／ keyed）｜`sidebar.right.tab.guide`（chain）｜
`sidebar.right.tab.guide.entry`（keyed）｜`sidebar.right.tab.menu.item`（list）｜`rightbar.session`（single ／ **官方右栏本体，已占用 ⇒ 注册即遮蔽**）。

**数据怎么进去**：本插件**已有**同源 HTTP 能力 —— `ctx.webServer.register({ kind:'exact', path, handler })`
（`src/voyage-page.ts:82` ／ `src/api.ts:209` ／ `:235`），客户端 `fetch('/serenity/…')`。
🔵 **现成先例**：`SafeModePanel.tsx:389-400` 已经在卡片右栏里用
`<iframe src="/serenity/voyage?card=1&v=<accVersion>">` 渲染**宿主路由发出来的产物**。

⇒ **把 SVG 放在 `/serenity/diagram/<id>.svg`，面板里 `<img src=…>` 即可 —— 浏览器原生渲染矢量，零光栅化。**

### 1.3 ❌ 被排除：SVG 走 attachment

**【读源码】白名单是硬的**：

```ts
// @deepseek-ai/dsh-attachment/lib/types/types.d.ts:5
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
```

- 非白名单**在准入即抛**：`throw new AttachmentError('Image type ... is not accepted', 'UNSUPPORTED_IMAGE_TYPE')`
- 全宿主快照 grep `image/svg|svg+xml`：**仅 1 处命中且无关**（一段 CSS 里的 svg 字形）⇒ 无任何 SVG 专门分支。

⇒ **"产出 SVG 就自动显示"不成立** —— 这条路不是"待验证"，是**确定失败**。

### 1.4 🟡 一条窄路（零依赖，但**未实测**，仅登记不当方案）

宿主另有一条**通用文件路由** `GET|HEAD /api/file?path=<绝对路径>`（`dsh-api-session-controller/lib/types/media-references.js:69-75`）：
它**没有 MIME 白名单**，按**扩展名**给 `Content-Type`（`.svg` ⇒ `image/svg+xml`），可读任意绝对路径。

- 客户端 markdown 的 `imageSource()` **接受绝对 http(s)**（`dsh-client-ui-primitives/lib/index.js:11092-11106`）
- ⚠️ 但**相对** `/api/file?...` 两侧都过不了；要写**绝对 URL** ⇒ agent 得知道 GUI origin
- ⚠️ 该路由的响应带 `Content-Security-Policy: sandbox; default-src 'none'`（`media-references.js:13-14`），
  **浏览器 `<img>` 是否仍渲染该 SVG 未实测**

⇒ **登记为"零依赖的窄路"**：值得用**一次肉眼实验**判定（§6 实验 0），但**不建议把它当设计地基**。

---

## 2. 光栅化（只有路 1 需要）

### 2.1 本机现状【实测】

| 项 | 结果 |
|---|---|
| CLI 光栅化器 | ❌ `rsvg-convert` ／ `inkscape` ／ `convert` ／ `magick` ／ `resvg` ／ `cairosvg` **全无** |
| 系统图形链 | ✅ `librsvg-2.so.2` ／ `libcairo.so.2` ／ `libpango-1.0` ／ `libgdk_pixbuf` ＋ GI typelib `Rsvg-2.0.typelib`；gdk-pixbuf 有 SVG loader |
| 🔴 **已在盘的 node 光栅器** | **`sharp` 0.35.5** 在 **DSH 自己的 node_modules 里**（`…/@deepseek-ai/dsh/node_modules/sharp` ＋ `@img/sharp-linux-x64` ＋ libvips `8.18.7`） |
| 本插件 | **零图片库**（runtime 依赖 = 0）；微信桥的媒体链路是**纯字节搬运**，不解码不转码 |

### 2.2 四条候选（成本升序）

| # | 方案 | 类型 | 需构建？ | 代价 / 风险 |
|---|---|---|---|---|
| 1 | **用已在盘的 `sharp`** | napi 预编译 | 否 | **零下载**；🔴 但**解析不到** —— 插件装在 `~/.dsh/profiles/web/node_modules/@shgroup/…`，而 sharp 在 `dsh/node_modules`，**不是它的祖先目录** ⇒ 只能 `createRequire` 绝对路径去够，**绑死 DSH 内部布局**（宿主升级即可能碎） |
| 2 | **`@resvg/resvg-js`** 2.6.2 | napi 预编译（Rust） | 否 | 专做 SVG→PNG（`render().asPng()`），比 sharp 更小更直白；需一次 registry 安装 |
| 3 | **`@resvg/resvg-wasm`** 2.6.2 | **纯 wasm** | 否 | **无原生二进制、无平台/架构约束**（公开包最安全）；代价 = 体积（unpacked ≈2.5 MB） |
| 4 | 系统 librsvg + `spawn` python3 | 零 npm 依赖 | 否 | 不装包，但**依赖外部解释器**、跨进程、错误面大（import 通路未实跑） |

### 2.3 🔴 装包这一步，本通道跑不了

`sys` 白名单 = `ps/ss/curl/lsof/pgrep/pkill/kill/sleep/date/ls/xdg-open/zstd/git` —— **没有 `npm` / `pnpm`**。
⇒ 选 2/3 都要**一次装包动作**，而它**必须由本通道之外完成**（owner 手跑一次 `pnpm add`，或把 `pnpm` 加进 dev 白名单
—— 后者是 `scripts/` 里的开发面改动，**不发版**，但**加宽了 agent 可执行的命令面，属安全面决策**）。

---

## 3. 工具与开关（**模式已经成形，无需发明**）

### 3.1 工具注册

`src/index.ts:370-389` 一个 `if (config.tools)` 块里逐行 `ctx.tools.register(createXTool(ctx))`，每行上方有注释。
⇒ **加一个工具 = 一行 ＋ 一个 `src/tools/<name>.ts`**。

### 3.2 开关：三种既有先例，选一种

| 先例 | 形态 | 语义 |
|---|---|---|
| `skiffEnabled` ／ `acpEnabled` ／ **`unattendedEnabled`** | settings 面板**扁平键**（`PanelBoolean`）＋ 部署层嵌套 `x.enabled` ＋ DEFAULTS 里 `false` | **默认关的实验性功能** —— **与 owner 要的"demo 开关"逐字对应** |
| `exclusiveTools` ＋ `tools.restrict` | CCC 配置里点名 | **默认对所有 CCC 隐藏**，点名才可见（`acc-diag` 就是这个） |
| IM 通道缺失 ⇒ guards 摘掉 `im-bridge` | 条件可见 | "看不见" 优于 "会被拒" |

**实现落点**（若取第一行）：`src/settings-section.ts` 的 **DEFAULTS 对象（:139-147）＋ unwrap 行（:296-306）** ＋
Serenity 设置页一个 Group（客户端的 `SettingsSection.tsx`）。

**"默认关"的机械形态**：**关闭时不注册**（工具根本不进模型工具清单 ⇒ 不占 token、不会被误调）——
与 `skiff`／`acp` "未开启零资源占用"同一口径。

### 3.3 工具面计数

+1 ⇒ **11 → 12**。连带面：`src/invariant.ts`（工具数不变量）／系统提示词的工具清单行／README ／ CHANGELOG。

---

## 4. 两条交互路线对比

| 维度 | **路 1 原地（对话内）** | **路 2 右侧栏** |
|---|---|---|
| 光栅化 | 🔴 **必需** | ✅ **不需要**（矢量） |
| 新依赖 | 🔴 **1 个光栅化器**（当前为 0） | ✅ **0** |
| 新增代码面 | 工具 + 光栅化调用 + `saveImage` | 服务端路由 + **客户端 tab type** |
| 图的质量 | 位图（受尺寸限制） | **矢量**：任意缩放清晰、文字可选中 |
| **进对话记录** | ✅ **进**（durable attachment：可回看／可被后续轮次引用／**可转微信**） | ❌ 不进（面板是临时视图） |
| 用户要不要动手 | 不用 | **要**（得把右栏打开） |
| 已有实证 | ✅ `read_image` 本会话活证 | ✅ `/serenity/voyage` 已在卡片右栏 iframe |
| 已知未证 | 光栅化器在**本机**的实际效果（未跑） | 0.2.0 的右栏**打开动作**（`ctx.layout.openRightbar` 面未在 0.2.0 快照内取到） |

### 我的倾向：**先路 1，路 2 作为二期**

**理由（按分量排）**：
1. 🔴 **只有路 1 能把图放进对话记录** —— 而"图是给人看的"这个目的，落在**记录里**才算数：可回看、可被后续轮次引用、
   **可经微信桥发给家人**。路 2 的图是"你正好开着右栏才看得到"。
2. 路 1 的链路**类型级可证**（`saveImage` → ImageBlock → RPC → blob），路 2 的"打开右栏"在 0.2.0 上**还有一格未证**。
3. 路 2 **不是被否，是排后**：它零依赖、矢量、可实时刷新，作为"**看图/调图的工作面**"体验更好 —— 二期做。

**被否**：把"零依赖"当第一优先级而只做路 2（图不进记录 ⇒ 微信侧看不到，等于对这个家庭最有用的那半没做）。

---

## 5. 需要 owner 裁的点

| # | 事项 | 我的倾向 |
|---|---|---|
| **G1** | **光栅化器选哪个**：① 借 DSH 的 `sharp`（零下载、绑死宿主布局）② `@resvg/resvg-js`（预编译、小） ③ `@resvg/resvg-wasm`（纯 wasm、跨平台、2.5 MB） | **③**（公开发布的包最怕平台/构建问题；多 2.5 MB 换"任何机器都跑得起来"）——②是性能优先时的备选 |
| **G2** | **开关挂哪一层**：ACC 机器级（settings 扁平键，同 `unattendedEnabled`）还是 CCC 级（`serenity.json`，同 `exclusiveTools`） | **ACC 机器级**（"demo 功能"的语义是全局试用；落点也已有 Settings 页） |
| **G3** | **装包这一步谁来做**：owner 手跑一次 `pnpm add`，还是**把 `pnpm` 加进 dev 白名单**（`scripts/` 开发面、**不发版**，但**加宽 agent 命令面**） | **owner 手跑一次**（加宽命令面是安全面的事，不为省一次操作去动它） |
| **G4** | **要不要先做 §6 实验 0**（1 分钟、零成本，判定 §1.4 那条零依赖窄路） | **做** —— 若成立，demo 阶段可以**完全不引依赖**先跑起来（但仍建议最终走路 1 的稳妥版） |

---

## 6. 下一步（建议的 spike）

| 实验 | 做什么 | 判据 | 谁做 |
|---|---|---|---|
| **0** | 用绝对 URL `http://127.0.0.1:3080/api/file?path=<CCC 内某个 .svg 的绝对路径>` 写进一条 markdown 图片 | **owner 肉眼**：图出现 = 成立 | 我发，owner 看一眼 |
| **1** | 装 `@resvg/resvg-wasm`（或 `-js`），把**现有的 `europe-1939.mini.svg`** 光栅化成 PNG | **实测**：出图 ＋ 肉眼比对（svg vs png）＋ 字节数 ／ 耗时 | 需 G3 先定 |
| **2** | 把 PNG 经 `ctx.attachments.saveImage` 做成 ImageBlock 从工具返回 | **实测**：对话里自动出现该图（对照 `read_image` 的活证） | 我 |
| **3** | 右侧栏 tab type 最小版（服务端路由发 SVG ＋ 客户端 keyed 注册） | **实测**：右栏出现面板并显示该图 | 我 |

⚠️ **依赖关系**：实验 1 卡在 G3（装包通道）；实验 3 卡在"0.2.0 右栏打开 API"是否可用（需补取
`dsh-client-ui-layout` / `dsh-client-ui-dockkit` 的 0.2.0 真实包 —— 可经 `host-fetch` 或 `curl file://` 从本机安装里取）。

🔴 **发版**：本件属 ACC ⇒ 落地**须 owner 具名发版令（D14）**。开发可在 CCC 侧插件仓内进行。

---

## 附：本文的证据来源

三路并行只读调研（2026-09-29，S142），全部给到 `file:line`：
① **宿主默认包集**（`dsh-serenity-plugin/_tmp/host-0.2.0-rc.1/`）—— 图/uI 通路与插槽面
② **本机 live 安装**（`/home/yh/.npm-global/lib/node_modules/@deepseek-ai/dsh/`，经 `sys curl file://` 读）—— 补上 0.2.0 缺的两个包
③ **本机系统面**（`sys ls` / `sys curl` registry）—— 光栅化能力清点
