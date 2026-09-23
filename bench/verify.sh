#!/usr/bin/env bash
# 运行态验收：回答"适配后的插件在这个新宿主上到底能不能用"
#
# 在容器**内**跑（docker exec）。只读：不装、不起、不改。
# 输出：人类可读的 PASS/FAIL 表 + 机器可读 /logs/verify.json（供 MSM 解析）
#
# 判据来源（为什么验这几条）：每一条都对应一次**真实踩过的坑**，不是凑数：
#   V2/V3 —— bundle 的版本不兼容是**静默**的（启动 skip + 一行 stderr）⇒ 必须**显式证明补丁层生效**
#   V4    —— ACC 自报版本（旧宿主上会自报旧版 ⇒ 能区分"装上了"与"生效了"）
#   V5    —— `agent/created`（0.1.7 起由 `agent/session-start` 改名）是**身份播种**的挂载点 ⇒ 失效即静默
#   V6    —— 设置面板（B1）在 0.1.7 换了模型 ⇒ 装错就是**页面上什么都不出现**
set -uo pipefail

LOG=${LOG:-/logs}
PORT=${PORT:-3080}
EXPECT_DSH=${DSH_VERSION:-}
EXPECT_ACC=${EXPECT_ACC_VERSION:-}
OUT="$LOG/verify.json"

pass=0; fail=0
declare -a ROWS

# 每条判据 = 一个 id、一句人话、一个布尔
check() { # id, 人话, 0/1
  local id="$1" label="$2" ok="$3" extra="${4:-}"
  if [ "$ok" = "0" ]; then
    ROWS+=("PASS|$id|$label|$extra"); pass=$((pass+1))
  else
    ROWS+=("FAIL|$id|$label|$extra"); fail=$((fail+1))
  fi
}

# ── V0 🔴 先自证"我这份脚本是本地最新推过来的那份" ──
# 为什么排第一条（2026-09-24 实测踩到的**假红**）：`verify.sh` 是**构建期 bake 进镜像**的；
# 本地改好判据后重跑 `up`（不重建镜像）⇒ 容器里跑的还是**旧脚本**，于是按**已废弃的判据**报 FAIL。
# ⇒ 判据纪律「读数器本身要先证明不瞎」在此处 = **先证明跑的是哪份脚本**。
SELF_SHA=$(sha256sum /usr/local/bin/verify.sh 2>/dev/null | cut -d' ' -f1)
PUSHED_SHA=$(cat /usr/local/bin/verify.sh.sha256 2>/dev/null || echo "")
if [ -n "$PUSHED_SHA" ] && [ "$SELF_SHA" = "$PUSHED_SHA" ]; then
  check V0 "判据脚本 = 本地推入版（vpush 已生效）" 0 "sha ${SELF_SHA:0:12}…"
elif [ -z "$PUSHED_SHA" ]; then
  check V0 "判据脚本 = 本地推入版（vpush 已生效）" 1 "未推过（跑的是**镜像 bake 版**）⇒ 判据可能已过期，先 vpush"
else
  check V0 "判据脚本 = 本地推入版（vpush 已生效）" 1 "容器内 sha 与推送记录不符（被人改过？）"
fi

# ── V1 宿主版本 ──
hv=$(cat "$LOG/host-version.txt" 2>/dev/null || echo "")
if [ -n "$EXPECT_DSH" ]; then
  case "$hv" in *"$EXPECT_DSH"*) check V1 "宿主版本 = $EXPECT_DSH" 0 "$(echo "$hv" | head -1)";;
                 *)               check V1 "宿主版本 = $EXPECT_DSH" 1 "实测: $(echo "$hv" | head -1)";; esac
else
  check V1 "宿主版本（未给期望值，仅记录）" 0 "$(echo "$hv" | head -1)"
fi

# ── V2 插件进到 profile 了没 ──
prof=$(ls -d /root/.dsh/profiles/web/node_modules/@shgroup/* 2>/dev/null | head -1)
[ -n "$prof" ] && check V2 "插件已装进 profile" 0 "$prof" || check V2 "插件已装进 profile" 1 "profile 里没有 @shgroup/*"
[ -s "$LOG/plugin-install.log" ] && check V2b "插件安装无报错输出" "$(grep -qiE 'fail|error|ERR!|denied|ENOENT|not found' "$LOG/plugin-install.log" && echo 1 || echo 0)" "$(tail -1 "$LOG/plugin-install.log")"
# 🔵 判据修正（2026-09-23 首跑踩到）：最初只 grep `error|ERR!|denied`，
#    而真实失败原文是 `dsh: plugin command failed; …` ⇒ **"failed" 不在模式里 ⇒ 假绿**。
#    ⇒ 同族纪律：**验收 grep 必须先自检判据本身**（拿一个必然命中的样本跑同一 pattern）。

# ── V3 🔴 补丁层真的生效了没（防"静默 skip"）──
web="$LOG/dsh-web.log"
if [ -s "$web" ]; then
  skiphit=$(grep -icE 'skip|incompatible|refus|not compatible' "$web" || true)
  check V3 "宿主启动日志无「跳过/不兼容」痕迹" "$([ "${skiphit:-0}" -eq 0 ] && echo 0 || echo 1)" "命中 ${skiphit:-0} 行"
  # 正面证据：**我们的日志前缀**出现在启动日志里
  # 🔵 判据修正（2026-09-23 首跑踩到）：最初 grep `dsh-serenity-hooks`（**包名**），
  #    而宿主的日志前缀逐字是 `[serenity-hooks]` ⇒ **假红**。⇒ 改成 grep `serenity`。
  #    🔴 同族第二跳（2026-09-24）：判据改了、**容器里跑的却还是旧脚本**（bake 在镜像里）⇒ 依旧假红。
  #    ⇒ 已由 V0 兜住：V0 FAIL 时，V3b 的红**不算数**。
  ours=$(grep -c 'serenity' "$web" || true)
  check V3b "启动日志里出现我们的日志前缀（serenity）" "$([ "${ours:-0}" -gt 0 ] && echo 0 || echo 1)" "命中 ${ours:-0} 行"
else
  check V3  "宿主启动日志无「跳过/不兼容」痕迹" 1 "dsh-web.log 为空/不存在"
  check V3b "启动日志里出现我们的包名" 1 "dsh-web.log 为空/不存在"
fi

# ── V4 插件自报版本（= 真的生效了）──
st=$(curl -sS --max-time 5 "http://127.0.0.1:$PORT/serenity/status" 2>/dev/null || echo "")
if [ -n "$st" ]; then
  accv=$(echo "$st" | jq -r '.accVersion // .data.accVersion // empty' 2>/dev/null)
  if [ -n "$EXPECT_ACC" ] && [ -n "$accv" ]; then
    [ "$accv" = "$EXPECT_ACC" ] && check V4 "ACC 自报版本 = $EXPECT_ACC" 0 || check V4 "ACC 自报版本 = $EXPECT_ACC" 1 "实测 $accv"
  else
    check V4 "ACC 状态端点可达" 0 "accVersion=${accv:-<未含该字段>}"
  fi
else
  check V4 "ACC 状态端点可达 (/serenity/status)" 1 "无响应（端口 ${PORT}？宿主没起来？）"
fi

# ── V5 身份播种（agent/created 挂载点）──
seed=$(grep -c 'Serenity cognitive container active' "$web" 2>/dev/null || true)
check V5 "身份播种痕迹（ACC 横幅）" "$([ "${seed:-0}" -gt 0 ] && echo 0 || echo 1)" "命中 ${seed:-0} 行（0 可能只是还没建会话）"

# ── V6 设置面板（B1：0.1.7 换了模型 ⇒ 装错就整页不出现）──
# 🔵 判据升级（2026-09-24：原判据只有"grep 无报错" = **只能证明"没炸"**，证明不了"契约没破"）。
#    升级为**显式断言**：启动日志里的 `host contract` 行**不得含 `BROKEN`**。
#    先例（B1 只迁一半）：`host contract BROKEN (2 required): service "settings" is missing
#    function "installSection"` ⇒ 插件照常"能装、能起"，但两条功能**静默跳过**
#    （`opencode 路由自动配置跳过` / `DeepSeek 多模态补丁跳过`）—— 这正是最该被抓住的形态。
sset=$(grep -icE 'settings.*(fail|error)|installSection|SettingsProvider' "$web" 2>/dev/null || true)
check V6 "设置面板装配无报错" "$([ "${sset:-0}" -eq 0 ] && echo 0 || echo 1)" "命中 ${sset:-0} 行"

broken=$(grep -c 'host contract BROKEN' "$web" 2>/dev/null || true)
hcline=$(grep -m1 'host contract' "$web" 2>/dev/null || echo "(无 host contract 行)")
check V6b "host contract 不含 BROKEN（无 required 成员缺失）" \
  "$([ "${broken:-0}" -eq 0 ] && echo 0 || echo 1)" "BROKEN 命中 ${broken:-0} 行；实测: ${hcline:0:110}"

# 🔵 与 V6b 配对的**功能级**判据：契约破了必然伴随这两条"静默跳过"，故显式盯住它们
skiproute=$(grep -c 'opencode 路由自动配置跳过' "$web" 2>/dev/null || true)
skipvis=$(grep -c 'DeepSeek 多模态补丁跳过' "$web" 2>/dev/null || true)
check V6c "两条 settings 依赖的功能未被静默跳过" \
  "$([ "${skiproute:-0}" -eq 0 ] && [ "${skipvis:-0}" -eq 0 ] && echo 0 || echo 1)" \
  "路由跳过 ${skiproute:-0} 行 / 多模态跳过 ${skipvis:-0} 行"

# ── 汇总 ──
echo "═══ 运行态验收（宿主 ${EXPECT_DSH:-?} ／ 期望 ACC ${EXPECT_ACC:-?}）═══"
for r in "${ROWS[@]}"; do IFS='|' read -r st_ id label extra <<<"$r"; printf '%-4s %-4s %-42s %s\n' "$st_" "$id" "$label" "$extra"; done
echo "──────────────────────────────────────────────"
echo "PASS=$pass FAIL=$fail"

{ printf '{"host":"%s","expectAcc":"%s","pass":%d,"fail":%d,"checks":[' "$EXPECT_DSH" "$EXPECT_ACC" "$pass" "$fail"
  first=1
  for r in "${ROWS[@]}"; do IFS='|' read -r st_ id label extra <<<"$r"
    [ $first -eq 0 ] && printf ','; first=0
    printf '{"id":"%s","status":"%s","label":"%s","detail":"%s"}' "$id" "$st_" "$label" "${extra//\"/\'}"
  done
  printf ']}\n'; } > "$OUT"

[ "$fail" -eq 0 ]
