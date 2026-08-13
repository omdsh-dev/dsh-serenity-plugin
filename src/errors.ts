/**
 * errors.ts — dsh-serenity-plugin 错误类
 *
 * 每个错误有明确触发条件、serenityCode、影响级别。
 * 独立实现（仿照 opencode-serenity-plugin 的 13 错误类语义，不复用源码）。
 */

export type ErrorImpact = 'blocking' | 'warning' | 'info';

export class SerenityError extends Error {
  readonly serenityCode: string;
  readonly impact: ErrorImpact;

  constructor(code: string, message: string, impact: ErrorImpact = 'blocking') {
    super(message);
    this.name = new.target.name;
    this.serenityCode = code;
    this.impact = impact;
  }
}

/** RR6 违反 — cwd 不在 git 仓库内 */
export class NotInGitRepoError extends SerenityError {
  constructor(cwd: string) {
    super('E-GIT-001', `Not in a git repo: "${cwd}". ACC 要求 CCC 处于 git 管理下 (P2).`, 'blocking');
  }
}

/** RR1 违反 — 未找到 .serenity 标记 */
export class SerenityFileNotFoundError extends SerenityError {
  constructor(cwd: string) {
    super('E-CCC-001', `No CCC found: no .serenity file found when walking up from "${cwd}".`, 'blocking');
  }
}

/** RR2 违反 — 入口技能缺失 */
export class SkillNotFoundError extends SerenityError {
  constructor(cwdRoot: string, skillName: string) {
    super('E-SKILL-001', `Entry skill "${skillName}" not found under "${cwdRoot}".`, 'blocking');
  }
}

/** MSM 注册表错误 */
export class MsmNotRegisteredError extends SerenityError {
  constructor(name: string) {
    super('E-MSM-001', `MSM "${name}" is not registered. 先运行 msm_admin register 或检查 mech-registry.json.`, 'blocking');
  }
}

export class MsmAlreadyRegisteredError extends SerenityError {
  constructor(name: string) {
    super('E-MSM-002', `MSM "${name}" is already registered.`, 'blocking');
  }
}

export class MsmNotInRegistryError extends SerenityError {
  constructor(name: string, registryPath: string) {
    super('E-MSM-003', `MSM "${name}" not found in registry: ${registryPath}.`, 'blocking');
  }
}

/** C3 契约 — 错误路径保留 stdout/stderr */
export class MsmExecutionError extends SerenityError {
  readonly stdout: string;
  readonly stderr: string;

  constructor(name: string, code: number, stdout: string, stderr: string) {
    super('E-MSM-004', `MSM "${name}" exited with code ${code}.`, 'blocking');
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** 路径安全错误 */
export class MsmPathEscapeError extends SerenityError {
  constructor(flag: string, value: string) {
    super('E-PATH-001', `Path escape blocked: flag "${flag}" value "${value}" resolves outside CCC root.`, 'blocking');
  }
}

export class MsmSymlinkError extends SerenityError {
  constructor(path: string) {
    super('E-PATH-002', `Symlink detected at "${path}". ACC 拒绝跟随 symlink 逃逸.`, 'blocking');
  }
}

export class MsmScriptNotFoundError extends SerenityError {
  constructor(scriptPath: string) {
    super('E-PATH-003', `MSM script not found: "${scriptPath}".`, 'blocking');
  }
}

/** CCC 完整性错误 */
export class InvalidCccNameError extends SerenityError {
  constructor(name: string) {
    super('E-CCC-002', `Invalid CCC name "${name}": 只允许小写字母+数字+连字符 (kebab-case).`, 'blocking');
  }
}

export class FileNotInsideSerenityError extends SerenityError {
  constructor(path: string, root: string) {
    super('E-PATH-004', `File "${path}" is outside serenity root "${root}".`, 'blocking');
  }
}

export class CccStatusError extends SerenityError {
  constructor(message: string) {
    super('E-CCC-003', message, 'warning');
  }
}
