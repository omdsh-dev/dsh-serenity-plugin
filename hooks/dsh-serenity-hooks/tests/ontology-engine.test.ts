/**
 * ontology-engine.test.ts — Ontology 定义/校验工具单元测试
 *
 * 2026-10-11：随引擎（`src/ontology/engine.ts`）从 CCC 的 MSM 脚本搬进 ACC 仓
 * （原 `.opencode/skills/home-ontology/scripts/ontology-engineering.test.ts`）。
 * 与引擎同批的**机械改写**（断言文案与判据一字未改）：
 *   ① import：`./ontology-engineering.js` → `../src/ontology/engine.js`；
 *   ② 调用面：`main()` ＋ `process.argv`（旧形态会 process.exit 并直写 stdout）
 *      → `runOntologyCli(argv, opts)`：输出与退出码走**返回值** `{code, stdout, stderr}`
 *      ⇒ 「`expect(() => main()).toThrow(MsmError)`」等价改写为「`code` 非 0 ＋ stderr 里是
 *        MsmError 的原文块」；「stdout 被 spy 攒起来再解析」改写为「读 `res.stdout`」。
 *
 * ⚠️ **ACC/CCC 边界（D23：机制与措辞归 ACC、数据归 CCC）**：`compliance` 回归守卫的
 *    fixture = **真实注册表 ＋ skills 目录**，那是 **CCC 数据**，不在 ACC 仓内。
 *    原用例跑在 CCC 里，靠相对深度（`../references/…`、`../..`）命中；搬进 ACC 仓后
 *    相对深度不再成立 ⇒ 改为「自本文件上溯，找最近的含 `.opencode/skills` 的祖先目录 = CCC 根」，
 *    注册表 = `<CCC 根>/.opencode/skills/home-ontology/references/serenity-skills-ontology.ttl`。
 *    找不到（= 独立克隆 / CI，本仓为公开仓）则整块 **skip** —— 断言文本仍一字未改。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runOntologyCli, MsmError, validateOnto } from "../src/ontology/engine.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TMP = join(tmpdir(), "onto-test-" + Date.now());
let file: string;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  file = join(TMP, "test.ttl");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("validateOnto", () => {
  it("returns empty errors for valid ontology", () => {
    const onto: any = {
      name: "Test",
      types: {
        Skill: { superTypes: [] },
        HomeResearch: { superTypes: ["Skill"] },
      },
      relations: {},
      axioms: [],
    };
    const issues = validateOnto(onto, "normal");
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags unknown superType reference", () => {
    const onto: any = {
      name: "Test",
      types: {
        HomeResearch: { superTypes: ["MissingType"] },
      },
      relations: {},
      axioms: [],
    };
    const issues = validateOnto(onto, "normal");
    expect(issues.some((i) => i.check === "M1")).toBe(true);
  });

  it("flags rigid type without identity criteria", () => {
    const onto: any = {
      name: "Test",
      types: {
        Skill: { superTypes: [], rigidity: "rigid" },
      },
      relations: {},
      axioms: [],
    };
    const issues = validateOnto(onto, "normal");
    expect(issues.some((i) => i.check === "M4" && i.severity === "warning")).toBe(true);
  });
});

describe("MsmError", () => {
  it("maps user category to exit code 1", () => {
    const e = new MsmError("PARAMETER_MISSING", "user", "msg");
    expect(e.exitCode()).toBe(1);
  });

  it("maps system category to exit code 2", () => {
    const e = new MsmError("FILE_NOT_FOUND", "system", "msg");
    expect(e.exitCode()).toBe(2);
  });

  it("formats stderr block with code and category", () => {
    const e = new MsmError("PARAMETER_MISSING", "user", "missing arg", { valid: ["a"] });
    const out = e.toStderr();
    expect(out).toContain("[PARAMETER_MISSING]");
    expect(out).toContain("category: user");
    expect(out).toContain("missing arg");
    expect(out).toContain('"valid"');
  });
});

// 旧用例的 `main()` 会**抛出** MsmError；新形态的 runner 把 MsmError 收敛成
// `code` ＋ `stderr`（引擎原文块，逐字保留）——故此处断言换成这两样，
// 判据（PARAMETER_MISSING ／ Unknown subcommand ／ 协议旗标被拒）与期望文案不变。
describe("runOntologyCli (CLI router)", () => {
  it("empty argv ⇒ PARAMETER_MISSING（user 档，退出码 1）", () => {
    const r = runOntologyCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[PARAMETER_MISSING]");
    expect(r.stderr).toContain("category: user"); // = 抛的确实是 MsmError（user 档）
    expect(r.stdout).toBe(""); // 失败路径不污染 stdout（旧形态是直写 process.stdout）
  });

  it("unknown subcommand ⇒ 报告 Unknown subcommand", () => {
    const r = runOntologyCli(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown subcommand");
  });

  it("protocol flag --help ⇒ 被拒（MsmError）", () => {
    const r = runOntologyCli(["--help"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[PARAMETER_INVALID_VALUE]");
  });
});

/**
 * 2026-09-14 S188 —— compliance 生成器 5 项缺陷的回归守卫。
 *
 * 背景：2026-09-14 的合规审计发现该命令产出的 29 项检查里约 41% 空转/误靶，
 * 其中两条会让审计机制**自身不可信**（ID 跨报告不可比 / 全称量词被静默降级 →
 * 该检查项必然漏检）。此处把修复锁死，防止回归。
 *
 * 取证方式：直接对真实注册表跑 `compliance --format json`，读 stdout 解析。
 */

/** 自本文件上溯，找最近的「含 `.opencode/skills`」的祖先目录（= CCC 根）；ACC 仓独立克隆时返回 undefined */
function findCccRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".opencode", "skills"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const CCC_ROOT = findCccRoot(__dirname);
const SKILLS = CCC_ROOT ? join(CCC_ROOT, ".opencode", "skills") : "";
const REG = SKILLS ? join(SKILLS, "home-ontology", "references", "serenity-skills-ontology.ttl") : "";
/** fixture（真实注册表 ＋ skills 目录）到位才跑本块 —— 它们是 CCC 数据，不在 ACC 仓内 */
const HAS_FIXTURE = REG !== "" && existsSync(REG) && existsSync(SKILLS);

describe.skipIf(!HAS_FIXTURE)("compliance 生成器（S188 修复回归守卫）", () => {
  function runCompliance(): any {
    // 旧形态：`main()` 直写 process.stdout ＋ 成功时 process.exit(0)（测试靠 spy 攒 stdout、
    // 靠 mock 把**非零**退出变成抛错）。新形态：一次调用的输出**自带**，退出码是返回值
    // ⇒ 同一份判据（必须 0 退出、stdout 必须是可解析的 JSON）在此显式表达。
    const r = runOntologyCli(["compliance", REG, "--skills", SKILLS, "--format", "json"]);
    if (r.code !== 0) throw new Error(`compliance 退出码 ${r.code}：${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  it("检查 ID 与公理内容绑定，且两次运行稳定（缺陷①）", () => {
    const a = runCompliance();
    // 每次调用各有一份输出缓冲（旧形态共用 process.stdout，需按"尾部"比较）——
    // 故此处的 idsA / idsB 已是**整份**输出，比较语义比旧写法更严格、不变。
    const idsA = a.checks.map((c: any) => c.id);
    const b = runCompliance();
    const idsB = b.checks.map((c: any) => c.id);
    // 稳定：同一份注册表两次生成同一组 ID
    expect(idsA).toEqual(idsB);
    // 形态：C-<6位十六进制>，不是可随顺序平移的序号
    expect(idsA.every((id: string) => /^C-[0-9a-f]{6}$/.test(id))).toBe(true);
    // 唯一
    expect(new Set(idsA).size).toBe(idsA.length);
  });

  it("全称量词不被降级为单目标（缺陷②）：量词公理覆盖全部 skill", () => {
    const r = runCompliance();
    // 判据必须是**规则文本**（该公理的 pattern 是 constraint，不是 specific-dependency
    // ——第一版修按 pattern 判定导致修复从未执行，实测纠正）
    const universalDep = r.checks.filter(
      (c: any) =>
        /forall\s+\w+\s+in\s+Skill\b/.test(c.axiomRule) &&
        c.axiomRule.includes("skillDependsOn"),
    );
    expect(universalDep.length).toBeGreaterThan(0);
    for (const c of universalDep) {
      // 关键：不能退化成只检查根 skill 自己（那会让该检查项必然误判 Pass）
      expect(c.targets.length).toBeGreaterThan(1);
      expect(c.targets).not.toEqual(["home-serenity"]);
      // targets 必须是真实存在的 skill 目录名
      for (const t of c.targets) {
        expect(existsSync(join(SKILLS, t, "SKILL.md"))).toBe(true);
      }
    }
  });

  it("所有量词公理 targets 覆盖全部 skill", () => {
    const r = runCompliance();
    const universal = r.checks.filter(
      (c: any) => /forall\s+\w+\s+in\s+Skill\b/.test(c.axiomRule) && c.pattern !== "self-check",
    );
    expect(universal.length).toBeGreaterThan(0);
    for (const c of universal) {
      expect(c.targets.length).toBe(r.skill_count);
    }
  });

  it("targets 输出目录名而非 PascalCase 类名（缺陷③）", () => {
    const r = runCompliance();
    for (const c of r.checks) {
      for (const t of c.targets) {
        // 不含大写字母起步的类名形态（self-check 的主体描述除外）
        if (c.pattern === "self-check") continue;
        expect(t).not.toMatch(/^[A-Z]/);
      }
    }
  });

  it("依赖公理只取声明义务承担方（缺陷④），且 targets 无重复（缺陷⑤）", () => {
    const r = runCompliance();
    for (const c of r.checks) {
      expect(new Set(c.targets).size).toBe(c.targets.length);
    }
    // 具名依赖：targets 全部是注册表里真实存在的 skill（B 端不应出现）
    const named = r.checks.filter(
      (c: any) =>
        c.pattern === "specific-dependency" &&
        !/forall\s+\w+\s+in\s+Skill\b/.test(c.axiomRule),
    );
    for (const c of named) {
      for (const t of c.targets) {
        expect(existsSync(join(SKILLS, t, "SKILL.md"))).toBe(true);
      }
    }
  });

  it("注册表级公理不再被压成 skill 检查（主体修正）", () => {
    const r = runCompliance();
    const selfChecks = r.checks.filter((c: any) => c.pattern === "self-check");
    // 注册表里有「本注册表只登记结构」「MSM 清单真相源」两条主体非 skill 的公理
    expect(selfChecks.length).toBeGreaterThanOrEqual(1);
    for (const c of selfChecks) {
      expect(c.verification).not.toContain("{skill}");
    }
  });
});
