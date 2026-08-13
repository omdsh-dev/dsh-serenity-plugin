#!/usr/bin/env bash
# load-plugin.sh — 把 dsh-serenity-hooks 加载进 DSH（免改 DSH 源码）
#
# 解析链（已源码验证，含 DSH 升级适配）：
#   plugin-loader 经 loader.internal（web = client-modules Node half）导入条目名；
#   createRequire(ctx.baseUrl) 解析 —— 锚点随版本变化（apps/cli/config 或 profile 目录/根）。
#   → **双锚定部署**：staging 根 node_modules + apps/cli/node_modules 各放一份，
#     插件自身 node_modules 补齐全部直接 peer shim → 解析自包含，布局免疫。
#
# 步骤：
#   1. 构建插件（tsc → lib/ + tsdown client bundle）
#   2. 复制（非 symlink，避免 realpath 陷阱）到双锚 node_modules/@shgroup/
#   3. 依赖 shim（cordis/schemastery/@deepseek-ai 7 项 → 插件自身 node_modules）
#   4. ~/.dsh/config.yaml insert 行（幂等：已存在则跳过）
#   5. 预检：从 staging 根动态导入插件（验证解析链，无副作用）
#   6. 提示重启 dsh web（boot graph 启动时扫描；client bundle 需重启入图）
#
# 注意：步骤 2-5 修改运行中 DSH 的 node_modules 与 config —— 边界外操作，
#       执行前请确认用户已批准。
#
# 用法：
#   bash load-plugin.sh            # 完整加载（含写入）
#   bash load-plugin.sh --dry-run  # 只打印将执行的命令（不写任何文件）

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")/../hooks/dsh-serenity-hooks" && pwd)"
CONFIG_YAML="${DSH_HOME:-$HOME/.dsh}/config.yaml"
STAGING_ROOT="$(readlink -f "$HOME/.dsh/source/current" 2>/dev/null || echo "$HOME/.dsh/source/current")"
APP_NM="$STAGING_ROOT/apps/cli/node_modules"
ROOT_NM="$STAGING_ROOT/node_modules"
# 双锚定：新 DSH 的解析锚可能指向 staging 根（client-modules createRequire(baseUrl)），
# 旧布局锚在 apps/cli。两个位置都部署，解析免疫布局变化。
PLUGIN_TARGETS=("$ROOT_NM" "$APP_NM")
DRY="${1:-}"

echo "==> 1/4 构建插件"
(cd "$HOOKS_DIR" && ../../node_modules/.bin/tsc -p tsconfig.json)
(cd "$HOOKS_DIR" && "$STAGING_ROOT/node_modules/.bin/tsdown" -c tsdown.config.ts 2>&1 | grep -E "client.js|✔" | tail -3 || true)

echo "==> 2/4 复制插件（双锚定，非 symlink）"
if [[ "$DRY" == "--dry-run" ]]; then
  echo "    (dry-run) 将复制到 ${#PLUGIN_TARGETS[@]} 个位置: ${PLUGIN_TARGETS[*]}"
else
  for NM in "${PLUGIN_TARGETS[@]}"; do
    DST="$NM/@shgroup/dsh-serenity-hooks"
    rm -rf "$DST"
    mkdir -p "$NM/@shgroup"
    cp -r "$HOOKS_DIR" "$DST"
    rm -rf "$DST/tests" "$DST/src" "$DST/tsconfig.json" "$DST/client" "$DST/dsh.plugin.json" "$DST/node_modules" "$DST/.pnpm-store"
    echo "    copied -> $DST（保留 package.json + lib/，含 client bundle）"
  done
fi

echo "==> 3/4 依赖 shim（解析自包含：插件自身 node_modules 补齐全部直接 peer）"
# 背景：DSH 升级会重构 workspace 布局（apps/cli/node_modules 的 @deepseek-ai/* 集合会变），
# 插件把直接依赖全部 shim 进自身 node_modules → 不依赖宿主布局，升级免疫。
declare -A SHIMS=(
  ["cordis"]="$STAGING_ROOT/vendor/cordis"
  ["schemastery"]="$STAGING_ROOT/vendor/schemastery"
  ["@deepseek-ai/dsh-tools"]="$STAGING_ROOT/packages/core/tools"
  ["@deepseek-ai/dsh-agent"]="$STAGING_ROOT/packages/core/agent"
  ["@deepseek-ai/dsh-session"]="$STAGING_ROOT/packages/core/session"
  ["@deepseek-ai/dsh-llm"]="$STAGING_ROOT/packages/llm/llm"
  ["@deepseek-ai/dsh-host-webserver"]="$STAGING_ROOT/packages/host/webserver"
)
if [[ "$DRY" != "--dry-run" ]]; then
  for NM in "${PLUGIN_TARGETS[@]}"; do
    PLUGIN_DST="$NM/@shgroup/dsh-serenity-hooks"
    mkdir -p "$PLUGIN_DST/node_modules/@deepseek-ai"
    for spec in "${!SHIMS[@]}"; do
      target="${SHIMS[$spec]}"
      if [[ -d "$target" ]]; then
        ln -sfn "$target" "$PLUGIN_DST/node_modules/$spec"
      else
        echo "    !! shim 目标缺失: $spec -> $target"
      fi
    done
    echo "    shimmed ${#SHIMS[@]} deps -> $PLUGIN_DST/node_modules/"
  done
else
  echo "    (dry-run) 将 shim ${#SHIMS[@]} 个直接依赖（cordis/schemastery/@deepseek-ai 7 项）到双锚"
fi

echo "==> 4/4 profile 挂载（新 DSH 标准：profiles/web/cordis.patch.yml）+ 预检"
# DSH 升级：个人配置层从 ~/.dsh/config.yaml 改为 profile 机制
# （$DSH_HOME/profiles/<name>/cordis.patch.yml 用户补丁层 + profiles/node_modules 扁平回退双锚）。
# v1.15 合规化：profile patch 内容取自插件自带 cordis.patch.yml（bundle 层，B2/B3），
# 不再硬编码 INSERT_BLOCK —— 与 `dsh plugin --profile web add <spec>` 的官方路径一致。
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
# 插件自带 bundle 层（package.json dsh.bundle.patch 指向它）
BUNDLE_PATCH="$HOOKS_DIR/cordis.patch.yml"

if [[ "$DRY" == "--dry-run" ]]; then
  echo "    (dry-run) 将写入 $PATCH_FILE（内容来自插件自带 $BUNDLE_PATCH）+ 符号链接 profiles/node_modules/@shgroup/dsh-serenity-hooks"
else
  if [[ ! -f "$BUNDLE_PATCH" ]]; then
    echo "!! 插件自带 cordis.patch.yml 缺失: $BUNDLE_PATCH（先执行 build）"
    exit 1
  fi
  # 1) 符号链接进扁平回退目录（双锚之一）
  mkdir -p "${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/@shgroup"
  ln -sfn "$ROOT_NM/@shgroup/dsh-serenity-hooks" "${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/@shgroup/dsh-serenity-hooks"
  # 2) cordis.patch.yml：幂等写入（保留注释头；已含则跳过）
  if [[ -f "$PATCH_FILE" ]] && grep -q "id: serenity-hooks" "$PATCH_FILE"; then
    echo "    $PATCH_FILE 已包含 serenity-hooks 行，跳过（幂等）"
  elif [[ -f "$PATCH_FILE" ]]; then
    cp "$PATCH_FILE" "$PATCH_FILE.bak.$(date +%s)"
    printf '\n' >> "$PATCH_FILE"
    cat "$BUNDLE_PATCH" >> "$PATCH_FILE"
    echo "    $PATCH_FILE 已追加 bundle 层（原文件已备份）"
  else
    mkdir -p "$PROFILE_DIR"
    cp "$BUNDLE_PATCH" "$PATCH_FILE"
    echo "    $PATCH_FILE 已创建（复制插件自带 bundle 层）"
  fi

  # 预检：从 staging 根解析并导入插件（验证双锚 + shim，无副作用）
  PREFLIGHT_OK=0
  for NM in "${PLUGIN_TARGETS[@]}"; do
    if (cd "$STAGING_ROOT" && node --input-type=module -e "
      const m = await import('@shgroup/dsh-serenity-hooks')
      console.log('[preflight] 插件加载成功:', m.name, '| inject:', JSON.stringify(m.inject))
    " 2>&1); then
      PREFLIGHT_OK=1
      break
    fi
  done
  if [[ "$PREFLIGHT_OK" != "1" ]]; then
    echo '!! 预检失败（双锚均无法解析/加载插件），请检查上方错误'
    exit 1
  fi
fi

echo
echo "==> 完成。重启 dsh web 使插件生效（会中断当前 Web GUI 会话）。"
echo "    验证：新会话应出现 cc_fs / session / acc_kit / cc_git / acc_msm 工具，"
echo "          ACC 身份注入、守卫约束，以及输入停靠栏 SafeModePanel。"
