# assets/ — ACC 层静态资产

## serenity-voyage.html

**宁静号航行动画**——单文件自包含的三维动画（three.js r180 内联，离线可跑）。

### 用途

由 `src/voyage-page.ts` 经 `GET /serenity/voyage` 分发；当前唯一消费者 =
会话头部状态胶囊**展开卡片**（`SafeModePanel` 的 `sp-pop`）的**背景层**，
即所有者定的定位：「宁静号的心智模型」。

同一份文件两种用法，靠 query 切换：

| URL | 形态 |
|---|---|
| `/serenity/voyage` | **全屏构图版**——标题 / 品牌语「不赶路，只航行」/ 状态胶囊 / 航速 / 容器事实面板齐备，可独立打开 |
| `/serenity/voyage?card=1` | **卡片模式**——隐藏作品自带的整层 UI 与加载页、镜头拉远、星野调暗、铭牌层关闭，只留认知星野 + 飞船，供卡片当背景 |

### 🔴 源不在这里（R↓：包内只有产物）

本仓库**只携带构建产物**。**源与构建脚本住在 CCC 侧**：

```
<CCC 根>/AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/serenity-voyage-animation/
├── build/            app.js（场景与词表）· ship.js（飞船程序化建模）· index.template.html
│                     three.core.min.js + three.module.min.js（构建输入）· build.ts（构建脚本）
├── serenity-voyage.html     ← 与本目录同物（改源后重建，再拷过来）
├── preview.png · preview-card.png   两种形态的真实渲染帧
└── provenance/S132-ORIGIN-SESSION.md  赠予方（tiangong-serenity）的原始会话记录
```

**重建**：在该目录下 `bun build/build.ts`（脚本自定位，目录挪动不会断），产物写出后
拷入本目录，再跑一次 `dsh-develop pack-check` 确认资产进了 tarball。

### 来历与内容口径

- **来历**：作品由 **tiangong-serenity**（另一个 Serenity CCC）赠予，属跨容器赠品。
  它的三维建模、运镜与渲染质量是原作者的功劳；本仓库承载的是**内容重播 + 卡片模式**。
- **内容重播（S142 §12.42/§12.43）**：星空词元已从赠予方的名字换成**宁静号自己的**
  技能 / 公理 / MSM / 本体文件名（102 条，全部有出处、无自造）；事实面板六个数
  （仓库 19 / 技能 35 / 工具 84 / 本体 12 / 公理 56 / 会话 190）为实测快照，口径写在
  `app.js` 的注释里。
- **外来内容已归零**：`tg-*` 技能名、`AX-*` 公理名、`TIANGONG` 铭牌等**全部替换**。
  该判据已被 `tests/voyage-page.test.ts` 自动化（**大小写不敏感**——上一轮正因人工
  grep 用了小写而漏掉全大写的 `TIANGONG`），改动资产若带回外来内容，测试即红。

### 版本口径

资产内容随包版本变，而 URL 稳定 ⇒ 客户端用 `?v=<ACC 版本>` 打点（见
`SafeModePanel.tsx`），同版本长缓存、升级即失效。改资产**必须**跟一次版本号，
否则浏览器会继续吃缓存里的旧文件。

## serenity-voyage-preview.png

卡片模式（340×460）的真实渲染帧，供评审用。**不参与运行时**，只是随包的可视证据。
