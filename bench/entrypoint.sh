#!/usr/bin/env bash
# 容器启动脚本：装插件 → 起宿主 → 保持存活（供外部轮询）
#
# 🔴 一切噪声进 /logs（陷阱 §1）；本脚本**永不因单步失败而退出** ——
#    失败要**留在日志里**让外部 verify 读到，而不是让容器反复重启（那会掩盖真因）。
set -uo pipefail

LOG=/logs
mkdir -p "$LOG"

echo "=== entrypoint $(date -Is) ===" | tee "$LOG/entrypoint.log"
echo "DSH_VERSION   = ${DSH_VERSION:-<unset>}" | tee -a "$LOG/entrypoint.log"
echo "PLUGIN_SPEC   = ${PLUGIN_SPEC:-<unset>}" | tee -a "$LOG/entrypoint.log"
echo "PLUGIN_LINK   = ${PLUGIN_LINK:-<unset>}" | tee -a "$LOG/entrypoint.log"

# ── 0. 宿主版本自报（写文件，供 verify 读；stdout 噪声不进通道）──
{
  dsh --version 2>&1 || true
  npm ls -g --depth=0 2>&1 | grep -E '@deepseek-ai/dsh' || true
} > "$LOG/host-version.txt" 2>&1

# ── 0b. 把**镜像里 bake 的**判据脚本落进 /usr/local/bin ──
# 🔴 为什么要有这一步：`verify.sh` 是**构建期** COPY 进镜像的 ⇒ 不重建镜像时，
#    容器里跑的是**旧判据**（实测踩过：V3b 假红）。`bench-docker vpush` 可以把**本地最新**
#    的那份推进正在跑的容器（并落 `.sha256` 供 `verify.sh` 的 V0 自证"跑的是哪份"）。
#    ⇒ 这里只负责**首次落地**；"改判据后要推"是调用方的纪律（见 README §4）。
for f in verify.sh v8-client-check.mjs; do
  [ -f "/usr/local/bin/$f" ] && echo "judge script present: $f" | tee -a "$LOG/entrypoint.log"
done

# ── 1. 装插件 ──
# 三种模式（同一镜像三用，别混）：
#   PLUGIN_SPEC   = npm 已发布版（验"发布物在新宿主上能用吗"）
#   PLUGIN_SPEC   = 容器内 .tgz 绝对路径（🔴 **mode B 主用**：验"我这次的改动在新宿主上能用吗" ——
#                   由 bench-docker 的 `--plugin-tarball` 打进 /ccc/dist 并挂载，见其注释）
#   PLUGIN_LINK   = 本地构建目录（同一目的的另一种做法；需调用方自行 -v 挂载）
# ⚠️ PLUGIN_LINK 优先于 PLUGIN_SPEC（与 bench-docker 的互斥校验同向）
if [ -n "${PLUGIN_LINK:-}" ] && [ -d "${PLUGIN_LINK}" ]; then
  echo "--- plugin: link ${PLUGIN_LINK}" | tee -a "$LOG/entrypoint.log"
  dsh plugin --profile web add "link:${PLUGIN_LINK}" > "$LOG/plugin-install.log" 2>&1
elif [ -n "${PLUGIN_SPEC:-}" ]; then
  echo "--- plugin: npm ${PLUGIN_SPEC}" | tee -a "$LOG/entrypoint.log"
  dsh plugin --profile web add "${PLUGIN_SPEC}" --registry "${NPM_REGISTRY}" \
    > "$LOG/plugin-install.log" 2>&1
else
  echo "--- plugin: 未指定（只装宿主，不装插件）" | tee -a "$LOG/entrypoint.log"
  : > "$LOG/plugin-install.log"
fi
echo "plugin-install exit=$?" | tee -a "$LOG/entrypoint.log"

# ── 2. 起宿主（后台 + 完全重定向；陷阱 §7.1：不重定向则通道不关闭、调用方挂住）──
# 🔴 陷阱 §7.2：结果文件必须先清 —— 否则上一轮的产物会让本次"瞬间判完成"
: > "$LOG/dsh-web.log"
nohup dsh web > "$LOG/dsh-web.log" 2>&1 < /dev/null &
echo $! > "$LOG/dsh-web.pid"
echo "dsh web pid=$(cat "$LOG/dsh-web.pid")" | tee -a "$LOG/entrypoint.log"

# ── 3. 保持存活（不要 exit —— exit 会让容器停，外部就轮询不到了）──
sleep infinity
