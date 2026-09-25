# DSH 宿主适配测试台 —— 常驻镜像
#
# 解决什么麻烦（白话）：DSH 每发一个新的 rc，我们都要把插件适配过去。
#   但在**本机**升级 DSH 会**当场打断正在跑的宁静号**（适配后的插件依赖新 API），
#   所以"适配后的插件在新宿主上到底能不能用"**在本机永远验不了**。
#   ⇒ 本镜像就是那个"别处"：一台干净的容器，装真实 DSH + 本插件，回答"能用吗"。
#
# 设计约束（不是风格偏好，是踩过的坑）：
#   · 构建/启动**一律后台化 + 远端轮询**，绝不阻塞调用方
#     （判据见 .opencode/skills/home-serenity/references/remote-execution-traps.md §7/§8/§9）
#   · 一切噪声进 /logs（陷阱 §1：输出体量不该影响成功/失败信号）
#   · 插件安装**在容器启动时做**（而不是构建时）⇒ 同一个镜像可反复用于不同版本/不同构建
#
# 用法（由 MSM `bench-docker` 驱动，勿手敲）：
#   docker build -t dsh-bench:0.1.7-rc.1 --build-arg DSH_VERSION=0.1.7-rc.1 bench/
#   docker run -d --name dsh-bench-<run> -e PLUGIN_SPEC=@shgroup/dsh-serenity-hooks@1.47.0 dsh-bench:0.1.7-rc.1

FROM node:22-bookworm-slim

# 宿主版本 = 构建参数（要适配哪个 rc 就传哪个；npm dist-tag `next` = 预发布线）
ARG DSH_VERSION=0.1.7-rc.1
ARG NPM_REGISTRY=https://registry.npmjs.org/

ENV DSH_VERSION=${DSH_VERSION} \
    NPM_REGISTRY=${NPM_REGISTRY} \
    DEBIAN_FRONTEND=noninteractive \
    DSH_HOME=/root/.dsh

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq procps tini zstd chromium \
 && rm -rf /var/lib/apt/lists/*
# ⚠️ `chromium` 是 **V8b 判据**的读数器（2026-09-25 加，非可选）：
#    V8 只做 `fetch` ＋ bundle/槽位文本检查 —— 作者自述边界就是"**非真浏览器证据**"；
#    而 A19 那类缺陷（十键未标 `.volatile()` ⇒ 设置页整块消失）**只有真浏览器看得见**。
#    V8b 用容器内的 headless chromium 真渲染一次页面 ⇒ 判据从"交付面"升级到"**渲染面**"。
#    （为什么不从本机 CDP 取证：测试台的宿主端口默认不发布，而临时发布到 LAN 后
#      从本机仍**连不上**——实测 192.168.1.4:80 可达、`:18080` 被拒 ⇒ 走容器内最稳。）
# ⚠️ `zstd` 是 V5 判据的**读数器**（2026-09-24 加，非可选）：
#    身份播种的 ACC 横幅**只进对话消息流**、**不打 stdout** ⇒ 唯一能机械读到它的地方是
#    宿主自己的会话日志（`/root/.dsh/sessions/**/session.v*.jsonl.zstd`）。
#    没有 zstd CLI ⇒ V5 只能报"没法读"，而"没法读"与"没播种"在验收表上长得一样（会误导后人）。
#    🔵 镜像里**没有** zstd 的 JS/原生模块（实测：`node:zstd` 不存在、无 `*.node`、无 node_modules/zstd）
#       ⇒ 必须走 CLI。libzstd.so.1 本来就有，CLI 只多几百 KB。

# 宿主 CLI：全局装（二进制名实测 = `dsh`）
# ⚠️ 还要装 **pnpm** —— 🔴 2026-09-23 首跑实测：DSH 的插件管理器**自己 spawn pnpm**
#    来装插件（`dsh: pnpm was not found; install pnpm and make it available on PATH.`），
#    只装 npm 会让 `dsh plugin add` **失败**而镜像看起来"装好了"。
#    版本取宿主仓自己 pin 的那个（`packageManager: pnpm@11.7.0`），避免版本漂移制造第二类故障。
RUN npm i -g --registry "${NPM_REGISTRY}" \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
      "pnpm@11.7.0" \
 && command -v dsh && command -v pnpm && pnpm --version

# 日志与工作区（CCC 根 = 带 .serenity 标记的普通目录）
RUN mkdir -p /logs /ccc && touch /ccc/.serenity

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY verify.sh     /usr/local/bin/verify.sh
# V8 探针（设置面板的**客户端面**证据；Node 脚本，verify.sh 调它）
COPY v8-client-check.mjs /usr/local/bin/v8-client-check.mjs
# V8b 探针（设置面板的**渲染面**证据：容器内 headless chromium 真渲染一次；Node 脚本，verify.sh 调它）
COPY v8b-browser-check.mjs /usr/local/bin/v8b-browser-check.mjs
# V8c 探针（**元素级**证据：容器内起 chromium＋CDP，点开设置面板后 querySelector 断言我方 UI）
COPY v8c-cdp-panel-check.mjs /usr/local/bin/v8c-cdp-panel-check.mjs
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/verify.sh

WORKDIR /ccc
EXPOSE 3080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
