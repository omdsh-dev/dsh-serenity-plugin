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
# 🔴 v1.62（D140）判据同步：锚定从「真跑两轮」改为「造历史」⇒ 自证行改名为
#    `anchor history fabricated`。⛔ 仍用旧串 `anchor turns injected` 会让两条判据**恒红**
#    （而那与"真的没跑轮次"在读数上不可分 —— 本轨既有判据：读数器先自证）。
#    兼容：两个串**都认**（旧版本的日志仍可判绿）。
prompted=$(( $(grep -c 'bootstrap: anchor history fabricated' "$web" 2>/dev/null || true) + $(grep -c 'bootstrap: anchor turns injected' "$web" 2>/dev/null || true) ))
check V5b "宿主真的创建过 agent（轮次缝被走到）" \
  "$([ "${prompted:-0}" -gt 0 ] && echo 0 || echo 1)" \
  "锚定痕迹 ${prompted:-0} 条（0 = 容器内**没有任何真实用户轮** ⇒ 先跑 bench-docker turn）"

# ── V7 🔴 运行期「我们真的被宿主调用了」证据（与 V5 配对，**本轮新增**）──
# 为什么需要它：V5 判的是"播种内容对不对"，而它依赖一整条真实轮次；V7 判的是
# **"宿主的运行期调用链真的走到我们的缝里了吗"** —— 这一条**不依赖模型**（缝在模型调用之前跑）。
# 判据 = 三个**只有真被调用才会打印**的 host 侧痕迹：
#   · `anchor history fabricated`（`seams/bootstrap.ts`，首个真实轮次时造锚定历史；v1.62 改名）
#   · 全局入口 skill section 注册 / 唤醒调度器启动（装配面）
seam_skill=$(grep -c '全局入口 skill section 已注册' "$web" 2>/dev/null || true)
seam_wake=$(grep -c 'trajectory 唤醒调度器启动' "$web" 2>/dev/null || true)
seam_ok=$([ "${seam_skill:-0}" -gt 0 ] && [ "${seam_wake:-0}" -gt 0 ] && echo 0 || echo 1)
check V7 "我们的缝在宿主运行期真被调用（装配面 ≥2 条自证行）" "$seam_ok" \
  "入口 skill ${seam_skill:-0} 行 / 唤醒调度器 ${seam_wake:-0} 行 / 锚点注入 ${prompted:-0} 行"
check V7b "首个真实轮次走到了 bootstrap 缝（锚定历史已造）" \
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

# ── V8c 🆕 设置面板的**元素级**证据（容器内 CDP：真点开设置页，querySelector 断言）──
# 判据阶梯最后一档：V8 交付层 → V8b 真浏览器层（模块真被请求）→ **V8c 元素级**（真的渲染出我们的 section）。
# 🔴 唯一能抓住 A19 那类"页消失了但日志零报错"的判据。
if [ -f /usr/local/bin/v8c-cdp-panel-check.mjs ]; then
  if command -v chromium >/dev/null 2>&1; then
    v8cout=$(node /usr/local/bin/v8c-cdp-panel-check.mjs 2>&1)
    v8cok=$?
    v8cdetail=$(printf '%s' "$v8cout" | grep -c '^PASS' | tr -d '\n')
    check V8c "设置面板元素级渲染（容器内 CDP 点开设置，querySelector 命中我方 UI）" "$v8cok" "PASS ${v8cdetail:-0} 项；$(printf '%s' "$v8cout" | grep -m1 '^FAIL' || echo '无 FAIL 行')"
    if [ "$v8cok" != "0" ]; then printf '%s\n' "$v8cout" | sed 's/^/      /'; fi
  else
    check V8c "设置面板元素级渲染（容器内 CDP 点开设置，querySelector 命中我方 UI）" 1 "读数器缺失：镜像里没有 chromium（重建镜像）"
  fi
else
  check V8c "设置面板元素级渲染（容器内 CDP 点开设置，querySelector 命中我方 UI）" 1 "探针不在（`vpush` 未推 v8c-cdp-panel-check.mjs）"
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

# ── V10~V14 🔴 v1.51.1：diagram 工具**在真实宿主里端到端能用**（owner 具名令「去 docker 验」）──
# 为什么这一组单测替代不了：单测验的是**函数**；这里验的是
# **开关落地 → 工具注册 → 模型自己选用 → 图进对话 → 不落文件 → 写错坐标响亮报错** 整条链在真宿主机里的形态。
# owner 报的那个缺陷（"别的 CCC 根本用不起来、难度太高"）**只在整链上才看得见**：
# 单测里坐标怎么算都对，而模型按常识写的"画布像素"在那个（已废弃的）默认域里全部飞出画布，
# 渲染器一声不吭 ⇒ 模型只能反复试错。
#
# 🔵 判据形态**全部取自实测样本**（2026-09-29 容器内两条真实轮，本文件的判据不是猜的）：
#   · 工具调用  = 事件 `"type":"tool/call"` 且同行含 `"name":"diagram"`
#   · 成功结果  = 同一行含 `图已生成` ＋ `体检干净`，且**不含** `源码错误`
#   · 图片块    = `{"type":"image","attachment":{"mediaType":"image/png","bytes":…,"width":…,"height":…}}`
#   · 越界报错  = `在绘图窗口外：box=…` ＋ `坐标窗口 x … ／ y …（y 向下；不写 domain 时＝画布）`
#   · 降级落盘  = `已降级落盘：`（模型路由不收图时的兜底分支，**正常路径不该出现**）
#
# 🔴 前置：本组要求容器里**真的跑过带图请求的真实轮**（`bench-docker turn`，见本文件顶部说明）。
#    没跑过 ⇒ 全组红，detail 会直说"先 turn" —— "没验"不能长得像"过了"。
DIAG_OUT_DIR=${DIAG_OUT_DIR:-/ccc/_tmp/diagram}

# V10 装配面：开关真的落到了部署层（少了它，容器里工具**根本不注册** ⇒ 后面全组无从谈起）
if grep -q 'diagramEnabled: true' /root/.dsh/profiles/web/cordis.patch.yml 2>/dev/null; then
  check V10 "diagram 开关落在部署层（profile patch）" 0 "profile patch 含 diagramEnabled: true"
else
  check V10 "diagram 开关落在部署层（profile patch）" 1 \
    "profile patch 里没有 diagramEnabled: true ⇒ 工具**关着**（关时不注册），后面几条必然全红"
fi

if command -v zstd >/dev/null 2>&1; then
  d_calls=0; d_ok=0; d_img=0; d_err=0; d_degrade=0; d_imgdesc="(无)"
  for f in $(find "$sessdir" -name 'session.v*.jsonl.zstd' 2>/dev/null); do
    d=$(zstd -dc "$f" 2>/dev/null || true)
    d_calls=$((d_calls + $(printf '%s' "$d" | grep '"type":"tool/call"' | grep -c '"name":"diagram"' || true)))
    d_ok=$((d_ok + $(printf '%s' "$d" | grep '"type":"tool/result"' | grep '图已生成' | grep '体检干净' | grep -vc '源码错误' || true)))
    d_img=$((d_img + $(printf '%s' "$d" | grep '"type":"tool/result"' | grep -c '"mediaType":"image/png"' || true)))
    d_err=$((d_err + $(printf '%s' "$d" | grep -c '在绘图窗口外：box=' || true)))
    d_degrade=$((d_degrade + $(printf '%s' "$d" | grep -c '已降级落盘：' || true)))
    one=$(printf '%s' "$d" | grep -o '"mediaType":"image/png","bytes":[0-9]*,"width":[0-9]*,"height":[0-9]*' | tail -1)
    [ -n "$one" ] && d_imgdesc="$one"
  done

  check V11 "模型**自己**选用了 diagram（真实轮里有该工具调用）" \
    "$([ "${d_calls:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "工具调用 ${d_calls:-0} 次（0 = 没跑过图相关的真实轮 ⇒ 先 bench-docker turn；或工具没注册）"

  check V12 "零文档的自然语言请求 ⇒ **首次出正确图**（结果含「图已生成」＋「体检干净」，且无「源码错误」）" \
    "$([ "${d_ok:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "无错出图 ${d_ok:-0} 次 / 越界报错 ${d_err:-0} 次（判据 = 模型没看过任何文档、直接写画布像素坐标）"

  check V13 "图**真进了对话**（工具结果里有 image/png 附件块）" \
    "$([ "${d_img:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "图片块 ${d_img:-0} 个；末次 $d_imgdesc"

  # 🔴 V14 与 V13 **成对读**：图没进对话时"没落文件"不成立 —— 那时走的是**降级落盘**分支
  #   （v1.51.0 实测见过：模型路由未声明 image 输入 ⇒ 工具如实说明并把 PNG 落盘）。
  #   ⇒ 只有"图进了对话 ∧ 无降级 ∧ 盘上无 PNG"三条同时成立，才是"正常路径不落文件"。
  diag_files=$(find "$DIAG_OUT_DIR" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')
  d_nofile=1
  [ "${d_img:-0}" -gt 0 ] && [ "${d_degrade:-0}" -eq 0 ] && [ "${diag_files:-0}" -eq 0 ] && d_nofile=0
  check V14 "正常路径**不落文件**（图进对话 ∧ 无降级 ∧ \$CCC/_tmp/diagram 无 PNG）" "$d_nofile" \
    "图片块 ${d_img:-0} / 降级落盘 ${d_degrade:-0} / 落盘 PNG ${diag_files:-0} 个（三者要一起看）"

  check V15 "写错坐标 ⇒ **响亮报错**（越界图元报「在绘图窗口外」并跳过，不再静默出空白图）" \
    "$([ "${d_err:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "越界报错 ${d_err:-0} 次（0 = 没跑过那条「照抄越界坐标」的轮，或静默空白图又回来了）"
else
  for id in V11 V12 V13 V14 V15; do
    check "$id" "diagram 端到端（读数器缺失）" 1 "🔴 镜像里没有 zstd CLI ⇒ 读不到会话日志"
  done
fi

# ── V16 🔴 v1.51.2：**客户端半真的装上了**（`diagram` 的 Chat 渲染面）──
# 为什么必须有这条：v1.51.1 之前，`diagram` 的图在 **Chat** 里看不见、只在**轨迹**里看得见 ——
# 根因是宿主 Chat 的图片画廊走子槽 `tool.call.images`，而那个子槽**只允许一个声明者**
# （已被宿主内置 `read_image` 占住）⇒ 我们的图落进通用行，只剩扁平文本。
# 修法 = 本插件 **client 半**注册自己的 keyed tool view（`tool.call.toolview` key=`diagram`），
# 用 owner 载荷的 `loadImage` 自己渲染 ⇒ **这条链路只存在于客户端 bundle 里**，
# node 半与服务端日志**都看不见它** ⇒ 必须直接对**装进容器的那份 bundle**取证。
#
# ⚠️ **证据等级要说清**（判据纪律：别把"交付层"当"渲染层"）：
#   ✅ 它证明：客户端半装上了，且那段注册语句**在 bundle 里**
#   ❌ 它**不**证明：浏览器真把图画出来了 —— 那要真浏览器元素级（同 V8b/V8c 的分档）
DIAG_CLIENT=/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks/lib/client.js
if [ -s "$DIAG_CLIENT" ]; then
  dreg=$(grep -c 'tool\.call\.toolview' "$DIAG_CLIENT" 2>/dev/null || true)
  dkey=$(grep -c 'key: "diagram"' "$DIAG_CLIENT" 2>/dev/null || true)
  # 🔴 反向判据：**不许**声明子槽 `tool.call.images` —— 契约里「一个子槽只有一个声明者」，
  #    声明了会在**插件装载期直接抛错**（不是渲染丑，是起不来）。
  dchild=$(grep -c 'tool\.call\.images' "$DIAG_CLIENT" 2>/dev/null || true)
  check V16 "客户端半已装：diagram 的 Chat tool view 注册在 bundle 里（且未声明子槽）" \
    "$([ "${dreg:-0}" -gt 0 ] && [ "${dkey:-0}" -gt 0 ] && [ "${dchild:-0}" -eq 0 ] && echo 0 || echo 1)" \
    "tool.call.toolview ${dreg:-0} 处 / key: diagram ${dkey:-0} 处 / 违规声明子槽 ${dchild:-0} 处（须为 0）"
else
  check V16 "客户端半已装：diagram 的 Chat tool view 注册在 bundle 里（且未声明子槽）" 1 \
    "读不到 $DIAG_CLIENT（插件没装进 profile？）"
fi

# ── V17~V21 🔴 面 E（官方 ACP 面）在**真实宿主进程内**端到端可用（2026-10-16）──
# 为什么这一组必须存在（R↓）：面 E 是**缺省关**的对外面，而"默认关"的代码**没有任何日常路径会碰到它**
#   ⇒ 它坏掉的形态是**静默**的。本轮实测就抓到一次：`startAcpFace` 写好了却**没有任何调用点**
#   （W3 未接线）⇒ 拨开关**永远起不来**，而 typecheck 与全部单测**全绿**。
#   ⇒ 单测能验"函数对不对"，**验不了**"开关落地 → 监听器起来 → 真能握手 → 模型真答完"这条链。
#
# 🔵 判据形态**全部取自实测样本**（2026-10-16 本机 `ss -ltnp` ＋ `alive` 读数），不是猜的：
#   · 监听     = `ss -ltnp` 里出现 `:3200`（本面端口取自集中端口表 `FACE_PORTS.acp`）
#   · 启动痕迹 = 宿主日志里 `✓ 面 E（官方 ACP）`（`acp-face.ts` 的启动行，**只有真起来才打**）
#   · 握手     = 真实 WS 客户端能完成 101（**强证据**：只判"端口在听"是弱证据 ——
#                 端口开着而 `'upgrade'` 没接上也满足它）
#   · 协议     = ACP `initialize` 拿回 `agentInfo`（这才证明对面是**真 ACP**，不是任意 WS 端点）
#   · 模型     = `session/new` 拿到 sessionId ＋ `session/prompt` 收束（端到端真答完）
#
# ⚠️ **与 `acp-selftest` 的分工（别混）**：那件验的是 **stdio 那条路**（起 `dsh --profile acp` ＋ 桥，
#    跑在远端 docker，**不在本进程**）；本组验的是 **web 进程内**那条路（`dsh web` ＋ 本插件自持面）
#    —— 这正是 owner 2026-10-15 裁定的目标形态（D136/D137），也是**产品形态**。
#    两条路**互补不重叠**，故判据不重复。
ACP_PORT_EXPECT=${ACP_PORT_EXPECT:-3200}
acp_face_on=$(grep -c 'acpFaceEnabled: true' /root/.dsh/profiles/web/cordis.patch.yml 2>/dev/null || true)

# V17 装配面：开关真的落到了部署层（少它则面根本不注册 ⇒ 后面全组无从谈起）
check V17 "面 E 开关落在部署层（profile patch 含 acpFaceEnabled: true）" \
  "$([ "${acp_face_on:-0}" -gt 0 ] && echo 0 || echo 1)" \
  "命中 ${acp_face_on:-0} 处（⚠️ 键名须是 acpFaceEnabled；写成旧名 acpEnabled 会**静默无效**）"

# V18 🔴 面**真的在监听**（端口级证据；也是 owner「0.0.0.0 监听」那条裁决的机械落点）
# ⚠️ **实测纠正（2026-10-16 首跑）**：首版用 `ss -ltn` —— 而 `node:22-bookworm-slim` 镜像里
#    **没有 `ss`**（`bash: ss: command not found`）⇒ 该判据会**恒报 FAIL**，
#    而症状看起来像"面没起来"（**读数器坏了被误读成被测对象坏了** —— 本轨高频坑，这次又踩）。
#    ⇒ 改用 **node 自带 `net` 做一次真连接**（node 必然在场，且"能连上"比"表里有行"更接近语义）。
if command -v node >/dev/null 2>&1; then
  acp_conn=$(node -e "
    const s=require('net').connect(${ACP_PORT_EXPECT},'127.0.0.1');
    s.on('connect',()=>{console.log('OPEN');s.destroy();process.exit(0)});
    s.on('error',e=>{console.log(e.code||'ERR');process.exit(0)});
    setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},4000);
  " 2>&1 | tail -1)
else
  acp_conn="NO_NODE"
fi
check V18 "面 E 真的在监听 :${ACP_PORT_EXPECT}（真连接探测，非查表）" \
  "$([ "${acp_conn:-}" = "OPEN" ] && echo 0 || echo 1)" \
  "连接读数 = ${acp_conn:-<空>}（OPEN=在听；ECONNREFUSED=没起）"

# V19 启动痕迹（**只有真起来才打**的自证行 —— 它能把"没监听"分成"没起"与"起了但绑不上"两档）
acp_boot=$(grep -c '面 E（官方 ACP）' "$web" 2>/dev/null || true)
acp_err=$(grep -c '面 E（官方 ACP）启动失败' "$web" 2>/dev/null || true)
check V19 "宿主日志有面 E 启动自证行（且无启动失败）" \
  "$([ "${acp_boot:-0}" -gt 0 ] && [ "${acp_err:-0}" -eq 0 ] && echo 0 || echo 1)" \
  "启动行 ${acp_boot:-0} 条 / 失败 ${acp_err:-0} 条"

# V20 🔴 **端到端一条真链**（本组最强的一条）：WS 101 → ACP initialize → session/new →
#     session/prompt → **模型正文逐字复述**。
# 为什么要一整条而不是拆成四小条：**中途每一格都可能"没报错但内容没到"**（D138 那族假阳：
#   `followup()` 静默接受、`stopReason=end_turn` 正常返回，而内容根本没到）⇒
#   拆开判会让"走到第 3 步"看起来像"快成了"，而实际上**第 4 步才是判据**。
# ⇒ 由 `acp-face-check.mjs` 一次跑完并断言**内容**；本条只读它的结论。
ACP_PROBE=/usr/local/bin/acp-face-check.mjs
if [ -f "$ACP_PROBE" ]; then
  acp_out=$(ACP_PORT="$ACP_PORT_EXPECT" node "$ACP_PROBE" 2>&1)
  acp_rc=$?
  acp_json=$(printf '%s' "$acp_out" | grep -m1 '^ACP_RESULT=' | cut -d= -f2-)
  acp_ok=$(printf '%s' "$acp_json" | grep -c '"okCount"' || true)
  acp_content=$(printf '%s' "$acp_out" | grep -c 'model_content => OK' || true)
  acp_phases=$(printf '%s' "$acp_out" | grep -c '^\[phase\]' || true)
  shift_detail=$(printf '%s' "$acp_out" | grep '^\[phase\]' | tr '\n' ';' | cut -c1-300)
  check V20 "面 E 端到端：WS101 → ACP initialize → session/new → prompt → **模型正文逐字复述**" \
    "$([ "$acp_rc" = "0" ] && [ "${acp_content:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "exit=${acp_rc} 相位=${acp_phases} 内容级断言命中=${acp_content} ｜ ${shift_detail}"
else
  check V20 "面 E 端到端（探针缺失）" 1 \
    "无 $ACP_PROBE ⇒ `bench-docker vpush` 没推它（或镜像未重建）"
fi

# V21 面的**安全前提**必须随状态下发（不许"看到 3200 在听就以为它是安全的"）
# `acpFaceStatus().authNote` 是源码里那条前提的运行时出口；容器里没有跨进程读它的路，
# ⇒ 判据退化为**静态取证**：状态出口的文案确实带"无认证 ＋ 靠 Access 兜底"。
# ⚠️ **实测纠正（2026-10-16 首跑）**：首版只 grep `lib/index.js` ⇒ **FAILL（0 处）**，
#    而真相是**打包把这段拆进了带哈希的 chunk**（`lib/settings-section-<hash>.js`）——
#    `index.js` 里根本没有那个串。**读数器扫错了域**（本轨高频坑：否定性结论的可信度上限 = 扫描域）。
#    ⇒ 改为扫**整个 lib/ 目录**（发布物的真实边界），而不是某一个文件。
ACPDIR=/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks/lib
acp_src=$(grep -rc '不做认证' "$ACPDIR" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
acp_auth=$(grep -rc 'Access' "$ACPDIR" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
check V21 "面 E 的**安全前提**在产物里（authNote 逐字含「不做认证」＋「Access」）" \
  "$([ "${acp_src:-0}" -gt 0 ] && [ "${acp_auth:-0}" -gt 0 ] && echo 0 || echo 1)" \
  "「不做认证」${acp_src:-0} 处 / 「Access」${acp_auth:-0} 处（扫整个 lib/ —— 打包会把它拆进带哈希的 chunk）"

# ── V22 🆕 **系统提示词的位置判据**（2026-10-17 v1.61.0 事故的直接产物）──
# 为什么必须单列一条（R↓，这不是"多一条检查"）：
#   v1.61.0 的事故里**全部既有判据都是绿的** —— V5（横幅在不在）绿、V9（轮次收束）绿、
#   2915 条单测全绿。而真实故障是 **surface 上出现了两个 system 节点**：
#   第一个是空占位，真提示词被 `append` 到了**对话末尾** ⇒ 模型看到
#   `[空占位, anchor1, ack1, anchor2, ack2, 真 system]`。**不产生任何报错**。
#   ⇒ V5 判「内容进了会话」，V22 判「**它排在对的位置**」—— 两者互补，缺一即盲。
#
# 判据（由 v22-system-head-check.mjs 一次跑完，本处只读结论）：
#   V22  首节点是 system（且非空）
#   V22b system 节点**恰为 1 个**（>1 = 双 system，正是事故形态）
#   V22c 无占位残留文本（`anchor-placeholder` 等）
V22_PROBE=/usr/local/bin/v22-system-head-check.mjs
if [ -f "$V22_PROBE" ]; then
  if command -v zstd >/dev/null 2>&1; then
    v22out=$(node "$V22_PROBE" 2>&1)
    v22rc=$?
    # 🔴 逐条登记（**不用 `| while`**：管道会进子 shell，`check` 的计数带不回来 ——
    #    这是 shell 常识，但踩了就是"三条判据在表上凭空消失"）
    for id_ in V22 V22b V22c; do
      line=$(printf '%s\n' "$v22out" | grep -E "^PASS $id_ |^FAIL $id_ " | head -1)
      if [ -z "$line" ]; then
        check "$id_" "系统提示词位置（$id_ 未产出结论）" 1 "探针没给这条判据的结论"
      else
        st_=$(printf '%s' "$line" | cut -d' ' -f1)
        lab_=$(printf '%s' "$line" | cut -d' ' -f3-)
        [ "$st_" = "PASS" ] && check "$id_" "$lab_" 0 || check "$id_" "$lab_" 1
      fi
    done
    if [ "$v22rc" != "0" ]; then
      printf '%s\n' "$v22out" | grep -E '反例样本|roles=' | sed 's/^/      /'
    fi
  else
    for id_ in V22 V22b V22c; do
      check "$id_" "系统提示词位置（读数器缺失）" 1 "🔴 镜像里没有 zstd CLI ⇒ 读不到会话日志"
    done
  fi
else
  for id_ in V22 V22b V22c; do
    check "$id_" "系统提示词位置（探针不在）" 1 "无 $V22_PROBE ⇒ 先 bench-docker vpush"
  done
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
