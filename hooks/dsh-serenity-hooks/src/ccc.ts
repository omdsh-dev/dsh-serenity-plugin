/**
 * ccc.ts — CCC 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 职责：CCC 根检测（P1）、git 检测（P2）、serenity.json 配置读取（.opencode 规范位置，.dsh 回退）、
 * 路径守卫（P3 语义）、安全模式黑名单匹配。
 *
 * 由 tools/ 与 seams/ 复用；逻辑移植自 dsh-serenity-plugin v0.1-v0.2
 * runner（本项目自有代码，非 opencode-serenity-plugin 源码）。
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ── P1 有根 ──

export function findSerenityRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const marker = resolve(current, '.serenity');
    if (existsSync(marker) && statSync(marker).isFile()) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── P2 git 管 ──

export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── P3 路径二分 ──

export type PathClass = 'inside' | 'outside' | 'same';

/**
 * 前缀判定：abs 是否位于 rootAbs 之内。
 * caseInsensitive（Windows 盘符/路径大小写不敏感）由调用方按平台传入；
 * 边界必须是路径分隔符（`\` 或 `/` 任一）——不依赖平台 sep，跨平台语义一致：
 *   - 跨盘符绝对路径（root 在 D:\、target 在 C:\）前缀不匹配 → outside
 *   - 兄弟目录前缀陷阱（home vs home2）边界非分隔符 → outside
 * （旧实现用 path.relative().startsWith('..')——跨盘时 relative 返回绝对路径原文，
 *   不以 `..` 开头 → 漏判放行，见 Windows 兼容审计问题 1。）
 */
export function pathInside(rootAbs: string, abs: string, caseInsensitive = process.platform === 'win32'): boolean {
  const r = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  const a = caseInsensitive ? abs.toLowerCase() : abs;
  if (a === r) return true;
  if (!a.startsWith(r)) return false;
  const next = a[r.length];
  return next === '\\' || next === '/';
}

export function classifyPath(p: string, root: string): PathClass {
  const rootAbs = resolve(root);
  const abs = resolve(p);
  const ci = process.platform === 'win32';
  if (ci ? abs.toLowerCase() === rootAbs.toLowerCase() : abs === rootAbs) return 'same';
  return pathInside(rootAbs, abs, ci) ? 'inside' : 'outside';
}

export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: "${p}" resolves outside "${root}"`);
  }
  return abs;
}

// ── 配置（.opencode/serenity.json 规范位置 / .dsh/serenity.json 回退）──

export interface SerenityConfig {
  /** handyman（杂工）配置：模型白名单（v1.24.0 取代 loop） */
  handyman?: {
    /** 可用模型白名单（provider/model 列表）——handyman 只能使用其中模型（用户拍板：CCC 配置控制） */
    models?: string[];
    /** 缺省模型（必须 ∈ models） */
    defaultModel?: string;
    /** 对话轮次上限（保险阀，缺省 100） */
    maxRounds?: number;
    /** jobs 编排并行上限（缺省 10——便宜模型便宜） */
    maxParallel?: number;
  };
  sessionKeeper?: { threshold?: number };
  safeMode?: { blacklist?: string[] };
  /** localstore git 提交策略（S134 重设计）：allow 可提交 / deny 禁提交（缺省 deny） */
  localstore?: { gitTrack?: 'allow' | 'deny' };
  // 注意：bootstrap 配置段已于 v1.19.5 移除（S142 用户原则——first-anchor 属
  // ACC 协议层，任何 CCC 抽象层都是宁静号/ACC，机制与内容零配置面，代码固化）。
  hooks?: {
    enabled?: boolean;
    injectAccContext?: boolean;
    enforceSafeMode?: boolean;
    sessionKeeper?: boolean;
    /** 重启自动恢复最近激活的宁静号会话（session-start 时，根会话且无自身标记 → 回退最近 use 的标记） */
    autoRestoreSession?: boolean;
  };
  /** Skiff（F4，v1.25.0 实验性）认知子集角色配置——角色归 CCC 定义（S142 用户拍板） */
  skiff?: {
    /** 角色定义（名 → 角色配置）；缺省/空 = Skiff 未启用（零影响） */
    roles?: Record<string, SkiffRoleConfig>;
  };
  /**
   * 自主轨迹（v1.26.12 实验提案，specs self-sustaining-trajectory-hypothesis）：
   * CCC 定义的一条自主 trajectory——时钟唤起 + 先验偏见（自生+随机）+ 前台运行。
   * 未配置或 enabled=false → 机制完全不启动（零资源占用，零影响现有功能）。
   */
  autotrajectory?: AutoTrajectorySettings;
  /**
   * 微信桥（F4c-3，v1.27.0 实验性）：**CCC 级**配置——dsh 一个进程含多个 CCC，
   * 每个 CCC 独立对接微信桥（S142 用户拍板：ACC 不绑定 role，配置归 CCC，手工）。
   * 结构/路由/开关在此文件（git 管可重建）；**bot_token 凭据在 CCC localstore**
   * （weixin.accounts.<accountId>.token/.baseUrl/.userId——扫码后自动写入，安全纪律）。
   * 未配置或 enabled=false → 该 CCC 桥完全不启动（零资源占用）。
   */
  weixin?: WeixinSettings;
}

/**
 * 自主轨迹配置（CCC 定义；S142 用户拍板 v0.5）：
 * - 偏见内容提供者 = CCC 根目录下脚本（biasProvider，缺省 autotrajectory-bias.ts）——
 *   tool 直接运行取 stdout 作为偏见内容；脚本缺失 → 报错要求实现（不再经 mech-registry 注册 MSM）
 * - 会话标志 = 目录名后缀 `--auto`（验证用方便）：AGENT_SESSIONS/<date>--<desc>--auto/
 * - **session 必填**（用户拍板：自动唤起不默认任何会话——CCC 日常有多条 trajectory 在跑，
 *   未配置明确目标绝不唤起）；唤起窗口避开北京时间 8~18 点（用量峰谷省钱——用户拍板）
 */
export interface AutoTrajectorySettings {
  /** 总开关（缺省 false——默认关，未开零资源占用） */
  enabled?: boolean;
  /** 无人类活动 N 小时后自动唤起（缺省 12） */
  intervalHours?: number;
  /** 偏见内容提供者脚本（相对 CCC 根；缺省 autotrajectory-bias.ts——缺失报错要求实现） */
  biasProvider?: string;
  /**
   * 轨迹焦点（topPrompt，v1.26.17，用户"确保自动轨迹质量"）：**CCC 定义 autotrajectory 时
   * 自己填写**的顶层提示词——本轨迹的核心目标/纪律/质量要求。**每次唤起最先注入**（位于
   * 身份锚定之前，影响力最大），作为稳定焦点锚定 trajectory，防止多轮自主唤起中焦点丢失
   * （腐化）。区别于偏见内容（每轮随机探索方向）：焦点=稳定锚，偏见=随机探索，两者互补。
   * 实验经验：trajectory 在多轮中腐化严重（焦点丢失）——topPrompt 即为此而设。
   */
  topPrompt?: string;
  /** **必填**：目标会话（S### / 目录名）——未配置绝不唤起（CCC 日常多轨迹并行，不默认） */
  session?: string;
  /** 避开唤起的高峰时段（北京时间，[start, end) 内不唤起；缺省 {8, 18}——用量峰谷省钱） */
  avoidWakeHours?: { start?: number; end?: number };
}

/**
 * 微信桥配置（CCC 级；S142 用户拍板）：
 * - 结构/路由/开关在 .opencode/serenity.json（git 管可重建）
 * - **bot_token 凭据在 CCC localstore**（weixin.accounts.<accountId>.token/.baseUrl/.userId）——
 *   扫码登录后插件自动写入（面板只显示"已绑定"），永不进 git 明文面
 * - 路由 user → role：exact 匹配优先，通配 `*` 兜底；role 必须是该 CCC skiff.roles 之一
 * - 多账号：accounts[] 每项 { accountId, name?, enabled }（本地唯一键，如 wechat-1）
 */
export interface WeixinSettings {
  /** 总开关（缺省 false——默认关，未开零资源占用） */
  enabled?: boolean;
  /** bot_type（iLink 取码参数；实证 3 可用，留配置项应对未来语义变化） */
  botType?: string;
  /** 账号表（本地键 accountId；凭据在 localstore） */
  accounts?: WeixinAccountConfig[];
  /** 消息路由：微信用户 → 该 CCC 的 skiff role（不绑定具体 role——用户自选） */
  routes?: WeixinRouteConfig[];
}

/** 微信桥账号配置（serenity.json 内；凭据部分在 localstore） */
export interface WeixinAccountConfig {
  /** 本地唯一键（如 wechat-1；localstore 凭据键 weixin.accounts.<accountId>.*） */
  accountId: string;
  /** 展示名（可选；如"家庭招财"） */
  name?: string;
  /** 该账号轮询开关（缺省 true） */
  enabled?: boolean;
}

/** 微信桥路由配置：微信用户 → CCC 的 skiff role */
export interface WeixinRouteConfig {
  /** 微信用户标识（from_user_id，形如 userA@im.wechat）；`*` = 通配兜底 */
  user: string;
  /** 目标 skiff role 名（必须 ∈ 该 CCC skiff.roles；ACC 不绑定——用户自选） */
  role: string;
}

/**
 * Skiff 角色配置（CCC 定义：全知全能轨迹的一个子集）：
 * 能力面 = tools（非 MSM 工具白名单）+ msms（MSM 白名单）双白名单，白名单外全隐藏；
 * 轨迹纪律面 = trajectory 子集（session/keeper/rebuild 参与项，默认全关）。
 * 实验性质：未配置任何角色时 Skiff 完全零影响（无监听、无 agent 创建）。
 */
export interface SkiffRoleConfig {
  /** 角色模型（provider/model；CCC 直接指定，无白名单校验——用户拍板） */
  model?: string;
  /** MSM 白名单（独立）：该角色可 exec 的 MSM 名列表；缺省空 = 无 MSM 通道 */
  msms?: string[];
  /** 非 MSM 工具白名单（独立）：平台/ACC 工具名列表；缺省空 = 仅 MSM 通道 */
  tools?: string[];
  /** 轨迹纪律子集（缺省全 false = 完全独立，不参与 keeper/session/rebuild） */
  trajectory?: {
    session?: boolean;
    keeper?: boolean;
    rebuild?: boolean;
  };
  /** 角色系统提示词（CCC 完整定义：人格/认知边界/回答风格） */
  systemPrompt?: string;
  /** 角色系统提示词文件（推荐：相对 CCC 根引用 md 文件——超长提示词在 JSON 内嵌不可读；
   *  优先于 systemPrompt；文件缺失/逃逸 → resolveRoleSystemPrompt 抛错） */
  systemPromptFile?: string;
}

/**
 * 解析 handyman 配置（v1.24.0：取代 loop.defaultModel；不兼容旧 loop 配置——用户拍板）。
 * @returns 白名单 + 缺省模型 + 上限；models 未配置返回 null（工具应报错要求配置）
 */
export function readHandymanConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): {
  models: string[]
  defaultModel: string
  maxRounds: number
  maxParallel: number
} | null {
  const cfg = loadSerenityConfig(root, paths)
  const models = cfg.handyman?.models
  if (!Array.isArray(models) || models.length === 0) return null
  const clean = models.map((m) => m.trim()).filter(Boolean)
  if (clean.length === 0) return null
  const defaultModel = cfg.handyman?.defaultModel?.trim()
  return {
    models: clean,
    defaultModel: defaultModel !== undefined && clean.includes(defaultModel) ? defaultModel : clean[0]!,
    maxRounds: cfg.handyman?.maxRounds ?? 100,
    maxParallel: cfg.handyman?.maxParallel ?? 10,
  }
}

/**
 * ACC 依赖的 CCC 配置路径（S134 修正：兼容历史——历史在 .opencode，规范位置 = .opencode；
 * .dsh 仅作 dsh 运行时回退，不优先）。
 */
export const DEFAULT_SERENITY_CONFIG_PATHS = ['.opencode/serenity.json', '.dsh/serenity.json'];

/**
 * 读取 UTF-8 文件并剥离 BOM（Windows 审计问题 16）：PowerShell/Windows 编辑器
 * 写出的 BOM（\uFEFF）会让 JSON.parse 抛错（配置静默变空）或 frontmatter 检测失败（技能被丢弃）。
 */
export function readUtf8(path: string): string {
  return readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
}

export function loadSerenityConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): SerenityConfig {
  for (const candidate of paths) {
    const p = resolve(root, candidate);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readUtf8(p)) as SerenityConfig;
    } catch {
      return {};
    }
  }
  return {};
}

// ── 安全模式 ──

export const SAFE_MODE_MARKER = '.serenity-safe-on';

export function isSafeModeOn(root: string): boolean {
  return existsSync(resolve(root, SAFE_MODE_MARKER));
}

/** 黑名单条目（对齐 osp BlacklistEntry）：pattern + 可选自定义拦截提示 message */
export interface BlacklistRule {
  pattern: string;
  message?: string;
}

/**
 * 读取黑名单（对齐 osp readBlacklist）：支持两种条目格式——
 *   string：".secrets/" 或 "regex:^..."（前缀 / 正则）
 *   object：{ "pattern": ".secrets/", "message": "自定义提示" }
 * dsp v1.17.4 前只支持 string（对象会被 String() 成 "[object Object]" → 规则失效，不拦截）。
 */
export function readBlacklist(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): BlacklistRule[] {
  const cfg = loadSerenityConfig(root, paths);
  const rules = cfg.safeMode?.blacklist;
  if (!Array.isArray(rules)) return [];
  const out: BlacklistRule[] = [];
  for (const item of rules) {
    if (typeof item === 'string') {
      if (item) out.push({ pattern: item });
    } else if (item && typeof item === 'object' && typeof (item as { pattern?: unknown }).pattern === 'string') {
      const obj = item as { pattern: string; message?: unknown };
      const p = obj.pattern;
      if (p) out.push({ pattern: p, message: typeof obj.message === 'string' ? obj.message : undefined });
    }
    /* 非法条目跳过 */
  }
  return out;
}

/** 匹配黑名单规则；命中返回条目，未命中返回 null。前缀匹配 / regex: 前缀（对齐 osp）。Windows：规则反斜杠归一化为正斜杠与 rel 对齐 */
export function matchBlacklist(relPath: string, rules: BlacklistRule[]): BlacklistRule | null {
  for (const rule of rules) {
    if (rule.pattern.startsWith('regex:')) {
      try {
        if (new RegExp(rule.pattern.slice(6)).test(relPath)) return rule;
      } catch {
        /* 非法正则跳过 */
      }
    } else {
      const pat = rule.pattern.split('\\').join('/')
      if (relPath.startsWith(pat)) return rule;
    }
  }
  return null;
}

/** 写类工具名（safe-mode 下禁止） */
export const WRITE_TOOLS = new Set(['bash', 'write', 'edit', 'str_replace_editor', 'cc_fs']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}
