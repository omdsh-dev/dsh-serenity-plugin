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
#   V    —— 设置面板（B1）在 0.1.7 换了模型 ⇒ 装错就是**页面上什么都不出现**
#   V9   —— 🆕 第 ⑥ 项（2026-09-25）：**"缝走到" ≠ "功能可用"** —— V5/V7b 在没有模型凭据的
#           容器里照样绿，而每条真实轮次都以 `MISSING_CREDENTIAL` 结束（验收表上**看不出来**）
#           ⇒ V9 判"轮次真的正常收束 + 用的是指定路由/模型 + 零凭据错误"
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
# 🔴 判据重写（2026-09-24 实测纠正，**旧判据是错的**）：
#    ① 旧判据 grep 的 `Serenity cognitive container active`（`seams/context.ts` 的 ACC 横幅）
#       **从不打 stdout** —— 它是**注入进对话消息流**的 ⇒ 原判据**结构上不可能命中**（恒 0）。
#    ② `agent/created` 是**「agent 创建」事件**，**不是**「session 创建」（`session/create` 不触发它）
#       ⇒ 需要**一条真实用户轮**（`session/prompt`）才会走到播种（`bench-docker turn` 造它）。
#    ⇒ 新判据 = **在宿主自己的会话日志里找那条横幅**（`zstd -dc` 解压后 grep）——
#       这是"播种内容真的进了这条会话"的**唯一机械可读证据**。
sessdir=/root/.dsh/sessions
if command -v zstd >/dev/null 2>&1; then
  seed=0
  for f in $(find "$sessdir" -name 'session.v*.jsonl.zstd' 2>/dev/null); do
    n=$(zstd -dc "$f" 2>/dev/null | grep -c 'Serenity cognitive container active' || true)
    seed=$((seed + ${n:-0}))
  done
  check V5 "身份播种真的进了会话（ACC 横幅在会话日志里）" \
    "$([ "${seed:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "命中 ${seed:-0} 处；扫描 $(find "$sessdir" -name 'session.v*.jsonl.zstd' 2>/dev/null | wc -l | tr -d ' ') 份会话日志"
else
  check V5 "身份播种真的进了会话（ACC 横幅在会话日志里）" 1 \
    "🔴 **读数器缺失**（镜像里没有 zstd CLI）⇒ 无法读会话日志；**这不等于没播种**（见 Dockerfile 注释）"
fi
# 🔵 与 V5 配对：**宿主是否真的创建过 agent** —— `agent/created` 的宿主侧同源痕迹
prompted=$(grep -c 'bootstrap: anchor turns injected' "$web" 2>/dev/null || true)
check V5b "宿主真的创建过 agent（轮次缝被走到）" \
  "$([ "${prompted:-0}" -gt 0 ] && echo 0 || echo 1)" \
  "锚点注入痕迹 ${prompted:-0} 条（0 = 容器内**没有任何真实用户轮** ⇒ 先跑 bench-docker turn）"

# ── V7 🔴 运行期「我们真的被宿主调用了」证据（与 V5 配对，**本轮新增**）──
# 为什么需要它：V5 判的是"播种内容对不对"，而它依赖一整条真实轮次；V7 判的是
# **"宿主的运行期调用链真的走到我们的缝里了吗"** —— 这一条**不依赖模型**（缝在模型调用之前跑）。
# 判据 = 三个**只有真被调用才会打印**的 host 侧痕迹：
#   · `anchor turns injected`（`seams/bootstrap.ts`，首个真实轮次时注入锚点）
#   · 全局入口 skill section 注册 / 唤醒调度器启动（装配面）
seam_skill=$(grep -c '全局入口 skill section 已注册' "$web" 2>/dev/null || true)
seam_wake=$(grep -c 'trajectory 唤醒调度器启动' "$web" 2>/dev/null || true)
seam_ok=$([ "${seam_skill:-0}" -gt 0 ] && [ "${seam_wake:-0}" -gt 0 ] && echo 0 || echo 1)
check V7 "我们的缝在宿主运行期真被调用（装配面 ≥2 条自证行）" "$seam_ok" \
  "入口 skill ${seam_skill:-0} 行 / 唤醒调度器 ${seam_wake:-0} 行 / 锚点注入 ${prompted:-0} 行"
check V7b "首个真实轮次走到了 bootstrap 缝（锚点已注入会话）" \
  "$([ "${prompted:-0}" -gt 0 ] && echo 0 || echo 1)" "命中 ${prompted:-0} 条"

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

# ── V8 🆕 设置面板的**客户端面**证据（B1 的第三档：交付面）──
# 判据阶梯（R↓：为什么需要第三档）：
#   V6b = **契约层**（服务端有 configure/describe/update）
#   V6c = **功能层**（两条 settings 依赖的功能没被静默跳过）
#   V8  = **交付层**（宿主真发给浏览器的 client bundle 里，我们那张设置页在场且槽位注册语句在场）
#   （真实浏览器级"用户看到了页" = **未做**，登记为后续可选）
if [ -f /usr/local/bin/v8-client-check.mjs ]; then
  v8out=$(node /usr/local/bin/v8-client-check.mjs 2>&1)
  v8ok=$?
  v8detail=$(printf '%s' "$v8out" | grep -c '^PASS' | tr -d '\n')
  check V8 "设置面板客户端面（bundle 交付 + 槽位注册在场）" "$v8ok" "PASS ${v8detail:-0} 项；$(printf '%s' "$v8out" | grep -m1 '^FAIL' || echo '无 FAIL 行')"
  if [ "$v8ok" != "0" ]; then printf '%s\n' "$v8out" | sed 's/^/      /'; fi
else
  check V8 "设置面板客户端面（bundle 交付 + 槽位注册在场）" 1 "探针不在（`vpush` 未推 v8-client-check.mjs）"
fi

# ── V8b 🆕 设置面板的**渲染面**证据（真浏览器在容器里跑一遍）──
# 为什么还需要这一档（R↓）：V8 是**交付面**（文件与槽位语句在场），作者自述**非真浏览器证据**；
#   而 A19 的失效形态（十键未标 `.volatile()` ⇒ 设置页整块消失）**日志上一条报错都没有** ⇒
#   只有"真引擎渲染一次、DOM 里看我方标记"才抓得到。读数器 = 容器内 headless chromium。
if [ -f /usr/local/bin/v8b-browser-check.mjs ]; then
  if command -v chromium >/dev/null 2>&1; then
    v8bout=$(node /usr/local/bin/v8b-browser-check.mjs 2>&1)
    v8bok=$?
    v8bdetail=$(printf '%s' "$v8bout" | grep -c '^PASS' | tr -d '\n')
    check V8b "真浏览器面（页面真渲染 ＋ 我方客户端模块真被浏览器请求）" "$v8bok" "PASS ${v8bdetail:-0} 项；$(printf '%s' "$v8bout" | grep -m1 '^FAIL' || echo '无 FAIL 行')"
    if [ "$v8bok" != "0" ]; then printf '%s\n' "$v8bout" | sed 's/^/      /'; fi
  else
    # 🔴 读数器缺失 ⇒ **报 FAIL 而不是 PASS**（"判不了"与"过了"在验收表上不能长得一样）
    check V8b "真浏览器面（页面真渲染 ＋ 我方客户端模块真被浏览器请求）" 1 "读数器缺失：镜像里没有 chromium（重建镜像）"
  fi
else
  check V8b "真浏览器面（页面真渲染 ＋ 我方客户端模块真被浏览器请求）" 1 "探针不在（`vpush` 未推 v8b-browser-check.mjs）"
fi

# ── V9 🔴 「真实轮次成功」—— 第 ⑥ 项要的**功能可用**判据（本判据此前**不存在**）──
# 为什么必须新增（R↓）：V5/V7b 只判「缝被走到」，它们在**没有任何模型凭据**的容器里照样能绿
#   ⇒ 旧判据集**结构性无法回答** owner 的问题（"装完能不能真的用"）。2026-09-25 之前容器里
#   每条真实轮次都以 `MISSING_CREDENTIAL` 结束，而验收表上**看不出来**。
# 🔵 判据来源 = **实测样本**（不是猜的）：一条成功轮的会话日志尾部逐字含
#   `"provider":"minimax-bench","model":"MiniMax-M3"` ＋ `"turn/end" ... "kind":"completed"`；
#   而失败形态是日志里出现 `MISSING_CREDENTIAL`。三条各判一件事：
#   V9  轮次**正常收束**（有 turn/end + kind=completed）—— "答完了"
#   V9b 该轮**用的是我们指定的路由/模型** —— "用的是真模型，不是某个默认兜底"
#   V9c 会话日志里**零**凭据错误 —— 把旧失败形态变成显式负判据
EXPECT_PROVIDER=${EXPECT_PROVIDER:-minimax-bench}
EXPECT_MODEL=${EXPECT_MODEL:-MiniMax-M3}
if command -v zstd >/dev/null 2>&1; then
  turns_done=0; model_hits=0; cred_err=0
  for f in $(find "$sessdir" -name 'session.v*.jsonl.zstd' 2>/dev/null); do
    d=$(zstd -dc "$f" 2>/dev/null || true)
    turns_done=$((turns_done + $(printf '%s' "$d" | grep -c '"turn/end".*"kind":"completed"' || true)))
    model_hits=$((model_hits + $(printf '%s' "$d" | grep -c "\"provider\":\"$EXPECT_PROVIDER\"" || true)))
    cred_err=$((cred_err + $(printf '%s' "$d" | grep -c 'MISSING_CREDENTIAL' || true)))
  done
  check V9 "真实轮次正常收束（会话日志有 turn/end + kind=completed）" \
    "$([ "${turns_done:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "完成轮次 ${turns_done:-0} 个（0 = 还没有真实轮次 ⇒ 先 bench-docker turn）"
  check V9b "该轮用的是指定路由/模型（$EXPECT_PROVIDER / $EXPECT_MODEL）" \
    "$([ "${model_hits:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "日志命中 ${model_hits:-0} 处（0 = 路由 patch 没生效，或宿主用了别的默认）"
  check V9c "会话日志里零凭据错误（MISSING_CREDENTIAL）" \
    "$([ "${cred_err:-0}" -eq 0 ] && echo 0 || echo 1)" "命中 ${cred_err:-0} 处"
else
  check V9  "真实轮次正常收束（会话日志有 turn/end + kind=completed）" 1 "🔴 读数器缺失（无 zstd CLI）⇒ 读不到会话日志"
  check V9b "该轮用的是指定路由/模型（$EXPECT_PROVIDER / $EXPECT_MODEL）" 1 "🔴 读数器缺失（无 zstd CLI）"
  check V9c "会话日志里零凭据错误（MISSING_CREDENTIAL）" 1 "🔴 读数器缺失（无 zstd CLI）"
fi
# 与 V9 配对的**装配面**旁证：profile patch 真的落地了（entrypoint 写的 sha + 路由名命中）
if [ -f "$LOG/profile-patch.sha256" ]; then
  psha=$(cat "$LOG/profile-patch.sha256")
  phit=$(grep -c "$EXPECT_PROVIDER" /root/.dsh/profiles/web/cordis.patch.yml 2>/dev/null || true)
  check V9d "profile patch 已落地（sha 记录在 + 路由名命中）" \
    "$([ "${phit:-0}" -gt 0 ] && echo 0 || echo 1)" "sha ${psha:0:12}… / 路由名命中 ${phit:-0} 行"
else
  check V9d "profile patch 已落地（sha 记录在 + 路由名命中）" 1 "无 $LOG/profile-patch.sha256 ⇒ entrypoint 没收到 PROFILE_PATCH（默认模型仍是镜像内的）"
fi

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
