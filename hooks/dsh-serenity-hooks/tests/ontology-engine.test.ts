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
 *    相对深度不再成立 ⇒ 改为「自本文件上溯，找最近的含 `.opencode/skills` 的祖先目录 = CCC 根」。
 *    🔴 **v1.52.1（2026-10-11）第二次修正：注册表按文件名搜，不再写死"谁持有它"。**
 *    原写法写死 `<CCC 根>/.opencode/skills/home-ontology/references/serenity-skills-ontology.ttl`，
 *    而注册表 2026-10-11 随 owner 三条令**搬到了 `home-serenity/references/`**（前者整个 skill 退役）
 *    ⇒ 原路径当场失效 ⇒ `HAS_FIXTURE` 变 false ⇒ **整块 6 条断言静默消失**
 *    （`test` 只报"文件数不变、用例数少 6"，**没有任何失败信号** —— 这正是最坏的失败形态）。
 *    ⇒ 两处一起改：① **按文件名搜**（注册表属于哪个 skill 目录是实现细节）；
 *    ② **在 CCC 内却定位不到 ⇒ 响亮失败**，不 skip（见下方「fixture 定位」守卫用例）。
 *    只有「上溯不到 CCC 根」（= 独立克隆 / CI，本仓为公开仓）才是**合法**的 skip。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runOntologyCli, MsmError, validateOnto } from "../src/ontology/engine.js";
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
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

/**
 * 🔴 注册表**按文件名搜** —— 不再写死"哪个 skill 目录持有它"。
 * 它已经搬过一次家（home-ontology → home-serenity，2026-10-11），把持有者写进来就会**再坏一次**。
 */
function findRegistry(skillsDir: string): string | undefined {
  for (const name of readdirSync(skillsDir)) {
    const p = join(skillsDir, name, "references", "serenity-skills-ontology.ttl");
    if (existsSync(p)) return p;
  }
  return undefined;
}

const CCC_ROOT = findCccRoot(__dirname);
const SKILLS = CCC_ROOT ? join(CCC_ROOT, ".opencode", "skills") : "";
const REG = SKILLS ? (findRegistry(SKILLS) ?? "") : "";
/** fixture（真实注册表 ＋ skills 目录）到位才跑本块 —— 它们是 CCC 数据，不在 ACC 仓内 */
const HAS_FIXTURE = REG !== "" && existsSync(REG) && existsSync(SKILLS);

/**
 * 🆕 v1.52.1：**防静默跳过的守卫**。本块此前只会 skip，于是"CCC 侧把注册表搬了家"
 * 表现成"全绿"（6 条断言凭空消失）。⇒ 把"在 CCC 内就必须定位到 fixture"写成
 * **无条件运行的用例**：CI/独立克隆（上溯不到 CCC 根）本就该 skip，故那时它是 no-op。
 */
describe("fixture 定位（防静默跳过）", () => {
  it("在 CCC 内运行时，本体注册表必须可定位（否则本文件的 compliance 守卫被静默拔掉）", () => {
    if (!CCC_ROOT) return; // 独立克隆 / CI：fixture 本就不该存在 —— 合法的 no-op
    expect(
      REG,
      `找不到 ${SKILLS}/*/references/serenity-skills-ontology.ttl（CCC 根 = ${CCC_ROOT}）`
        + ` ⇒ 多半是 CCC 侧把注册表搬家/改名了：请更新本件的定位逻辑，别写死 skill 目录名。`,
    ).not.toBe("");
  });
});

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

/**
 * 🔴 v1.52.2 回归钉：**V3 不得静默跳过**。
 *
 * 原缺陷（2026-10-11 实测）：`loadMechRegistry` 拼路径时**漏了 `references/` 段**
 *   （`…/skills/<topSkill>/mech-registry.json`），而本文件自己的文案写着 `references/`
 *   ⇒ 每次 `verify` 都走 else 分支打印「No mech-registry.json found — check skipped」，
 *   于是「**MSM 的 `skill` 字段必须指向一个真实存在的 skill 目录**」这条检查
 *   **从来没有跑过一条**（静默跳过 = 最坏的失败形态）。
 *
 * 本件把两侧都钉住：**孤儿必须被抓**（正控）＋ **正常的不得被误报**（负控）。
 * 用 `opts.cwd` 造一个最小 CCC（引擎的 ROOT 由调用方给 —— 就是为了这种可测性）。
 */
describe("V3 MSM 注册一致性（防静默跳过）", () => {
  const MINI_TTL = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sr: <http://home-serenity/ontology#> .
@prefix : <http://example.org/onto#> .

:onto a owl:Ontology ;
    sr:name "mini" ;
    owl:versionInfo "0.1.0" .

:Skill a owl:Class ; rdfs:label "Skill" ; sr:rigidity "rigid" .
:HomeSerenity a owl:Class ; rdfs:label "home-serenity" ; rdfs:subClassOf :Skill ; sr:rigidity "rigid" .
:RealSkill a owl:Class ; rdfs:label "real-skill" ; rdfs:subClassOf :Skill ; sr:rigidity "rigid" .
`;

  it("注册表在 <CCC>/.opencode/skills/<topSkill>/references/ ⇒ V3 真检查：孤儿报错、正常的静默", () => {
    const root = mkdtempSync(join(tmpdir(), "onto-v3-"));
    try {
      const skills = join(root, ".opencode", "skills");
      for (const n of ["home-serenity", "real-skill"]) {
        mkdirSync(join(skills, n), { recursive: true });
        writeFileSync(join(skills, n, "SKILL.md"), `# ${n}\n`);
      }
      mkdirSync(join(skills, "home-serenity", "references"), { recursive: true });
      writeFileSync(
        join(skills, "home-serenity", "references", "mech-registry.json"),
        JSON.stringify({
          msms: [
            { name: "ok-msm", skill: "real-skill" },
            { name: "orphan-msm", skill: "no-such-skill" },
          ],
        }),
      );
      const ttl = join(root, "mini.ttl");
      writeFileSync(ttl, MINI_TTL);

      const r = runOntologyCli(["verify", ttl, "--level", "operational"], {
        cwd: root,
        topSkill: "home-serenity",
      });

      // ① 不再静默跳过（原缺陷的指纹：这一句以前每次都会出现）
      expect(r.stdout + r.stderr).not.toContain("No mech-registry.json found");
      // ② 正控：孤儿被真抓出来
      expect(r.stdout).toContain('"orphan-msm"');
      expect(r.stdout).toContain("no-such-skill");
      // ③ 负控：指向**真实**目录的那条不得被误报（否则等于"见注册表就报"）
      expect(r.stdout).not.toContain('"ok-msm"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 🆕 v1.52.2 的另一半：**把 V3 钉在"真实注册表"上**（合成 fixture 之外的实物对照）。
 *
 * 上一件证明「V3 会抓孤儿」；本件证明「**对着真实 CCC 的注册表它确实在跑**」。
 * 为什么值得单独一件：V3 因路径 bug **从未运行过** ⇒ 真实注册表里的归属一致性
 * **从来没有被检查过一次**（而它正是"MSM 的 skill 必须指向真实目录"的守卫）。
 * 钉上之后，以后每次 `test` 都会过一遍 —— 真出现孤儿就当场红，不再静默。
 */
describe.skipIf(!HAS_FIXTURE)("V3 对真实注册表（CCC fixture）", () => {
  it("真跑（不 skip）且 0 个孤儿", () => {
    // 🔴 前置自证（可达性）：本件的断言依赖这三个事实，差一个就是在测空气
    expect(CCC_ROOT, `CCC_ROOT=${CCC_ROOT}`).toBeTruthy();
    expect(REG, `REG=${REG}`).toContain("serenity-skills-ontology.ttl");
    const regReal = join(CCC_ROOT!, ".opencode", "skills", "home-serenity", "references", "mech-registry.json");
    expect(existsSync(regReal), `CCC_ROOT=${CCC_ROOT} ／ 期望注册表=${regReal}`).toBe(true);

    const r = runOntologyCli(["verify", REG, "--level", "operational"], { cwd: CCC_ROOT!, topSkill: "home-serenity" });
    const out = r.stdout + r.stderr;
    // ① V3 真的跑了（修前这句**每次**都会出现 ⇒ 本断言就是那个 bug 的指纹）
    expect(out).not.toContain("No mech-registry.json found");
    // ② 无孤儿（真出现 = 有 MSM 注册在一个不存在的 skill 下 ⇒ 该去修，不该静默）
    expect(out).not.toContain("directory not found");
    // ③ 总错误数为 0（把 V1/V2/V3 一起钉住；格式是本仓自己的报表）
    expect(out).not.toMatch(/Errors:\s*[1-9]/);
  });
});

/**
 * 🆕 A45（v1.56.1）—— **规则里的 `:LocalName` 必须按文件自己的默认前缀解析**。
 *
 * 缘起（2026-10-12，CCC 侧 `dsh-serenity-plugin-development/skill.ttl` 的 P2 工作）：要把一条公理
 * 改写成「所链 `Evidence` 的 kind …」时，按容器纪律**先探针后落笔**（D119：不许照源码的"意图"
 * 抄引擎行为）。探针本体 `_tmp/ael-probe-043/probe.ttl` 用的是**自定义默认前缀**
 * （`@prefix : <…/probe043#>`）⇒ 同一组规则**报 5 条 `ERR [M9] quantifier references unknown type`**；
 * 把默认前缀改成 `http://example.org/onto#` 就全绿。**根因 = `resolveIri()` 对空前缀直接
 * `return baseIri + local`**（`baseIri` 硬编码 `http://example.org/onto#`），**从不看 `@prefix :`**。
 *
 * 本组把"文件自己的默认前缀说了算"钉住，**并带负控**（未声明类型仍必须报）——
 * 否则"没报"与"检查没跑"分不开（这正是 D119 的教训）。
 */
describe("A45 · 规则里的 `:LocalName` 按**文件自己的默认前缀**解析", () => {
  /** 造一份本体：默认前缀**故意不是**引擎那个硬编码值 */
  function writeCustomPrefix(axiomRule: string): void {
    writeFileSync(
      file,
      [
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix sr: <http://home-serenity/ontology#> .",
        "@prefix : <http://home-serenity/domains/a45probe#> .",
        "",
        ':onto a owl:Ontology ; rdfs:label "A45 probe" .',
        ':Thing a owl:Class ; rdfs:label "a thing" ; sr:rigidity "rigid" ; sr:identity :thingId .',
        "",
        `:onto sr:axiom [ sr:axiomId "A45" ; sr:rule "${axiomRule}" ] .`,
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  it("🔴 修前必红的形态：自定义默认前缀 ＋ 规则引用**本文件声明的**类 ⇒ 现在 exit 0", () => {
    writeCustomPrefix("forall t in Thing: t.ok == true");
    const r = runOntologyCli(["check", file, "--level", "strict"], { cwd: TMP });
    // 修前这句每次都会出现（= 那个 bug 的指纹）；修后 `Thing` 按 `@prefix :` 解析 ⇒ 表里有它
    expect(r.stdout).not.toContain("quantifier references unknown type");
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });

  it("🔴 负控：同一形态里放**未声明**类型 ⇒ 仍必须报（证明检查真在跑，不是被关掉）", () => {
    writeCustomPrefix("forall t in NoSuchThing: t.ok == true");
    const r = runOntologyCli(["check", file, "--level", "strict"], { cwd: TMP });
    expect(r.stdout).toContain('unknown type "NoSuchThing"');
  });

  it("🔴 正控：**引擎那个默认前缀**（`http://example.org/onto#`）的文件行为不变", () => {
    writeFileSync(
      file,
      [
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix sr: <http://home-serenity/ontology#> .",
        "@prefix : <http://example.org/onto#> .",
        "",
        ':onto a owl:Ontology ; rdfs:label "default-ns probe" .',
        ':Thing a owl:Class ; rdfs:label "a thing" ; sr:rigidity "rigid" ; sr:identity :thingId .',
        "",
        ':onto sr:axiom [ sr:axiomId "A45b" ; sr:rule "forall t in Thing: t.ok == true" ] .',
        "",
      ].join("\n"),
      "utf-8",
    );
    const r = runOntologyCli(["check", file, "--level", "strict"], { cwd: TMP });
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });
});

describe("label/comment 分离（2026-10-13 S142：原实现把两者合并 ⇒ 一句话静默吃掉）", () => {
  /** 同一实体上**同时**写 label 与 comment —— 这正是修前会丢内容的形态 */
  function writeBoth(): void {
    writeFileSync(
      file,
      [
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix sr: <http://home-serenity/ontology#> .",
        "@prefix : <http://example.org/probe#> .",
        "",
        ':onto a owl:Ontology ; sr:name "lc-probe" ; owl:versionInfo "0.0.1" .',
        ':Thing a owl:Class ;',
        '    rdfs:label "SHORT-LABEL" ;',
        '    rdfs:comment "LONG-COMMENT" ;',
        '    sr:rigidity "rigid" ;',
        '    sr:identity :thingName .',
        ':thingName a owl:DatatypeProperty .',
        ':rel a owl:ObjectProperty ;',
        '    rdfs:label "REL-LABEL" ;',
        '    rdfs:comment "REL-COMMENT" ;',
        '    rdfs:domain :Thing ;',
        '    rdfs:range :Thing .',
        ':onto sr:axiom [',
        '    sr:axiomId "AX-PROBE" ;',
        '    rdfs:label "AX-LABEL" ;',
        '    rdfs:comment "AX-COMMENT" ;',
        '    sr:rule "Thing.thingName != \'\'" ;',
        '    sr:axiomType "state"',
        '  ] .',
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  /** 取 `review --format=json` 的 JSON 块（stdout 里紧随一行工具抬头） */
  function reviewJson(): any {
    const r = runOntologyCli(["review", file, "--format", "json"], { cwd: TMP });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const start = r.stdout.indexOf("{");
    expect(start, r.stdout).toBeGreaterThanOrEqual(0);
    return JSON.parse(r.stdout.slice(start));
  }

  it("🔴 类型：label 与 comment **各自原样到达**（修前 label 被 comment 覆盖、两者都不出口）", () => {
    writeBoth();
    const t = reviewJson().ontology.types.find((x: any) => x.name === "Thing");
    expect(t.label).toBe("SHORT-LABEL");
    expect(t.comment).toBe("LONG-COMMENT");
  });

  it("🔴 兼容：`description` 仍是**主描述**（label 优先）⇒ 既有消费点一字不用改", () => {
    writeBoth();
    const t = reviewJson().ontology.types.find((x: any) => x.name === "Thing");
    expect(t.description).toBe("SHORT-LABEL");
  });

  it("🔴 关系：label/comment 原先**完全不收** ⇒ 现在两个都在", () => {
    writeBoth();
    const rel = reviewJson().ontology.relations.find((x: any) => x.name === "rel");
    expect(rel.label).toBe("REL-LABEL");
    expect(rel.comment).toBe("REL-COMMENT");
  });

  it("🔴 公理：`sr:description` 优先，label/comment 另存 ⇒ 三者不再互相覆盖", () => {
    writeBoth();
    const ax = reviewJson().ontology.axioms[0];
    expect(ax.label).toBe("AX-LABEL");
    expect(ax.comment).toBe("AX-COMMENT");
    // 本 fixture 没有 sr:description ⇒ description 回落 label（保持旧行为）
    expect(ax.description).toBe("AX-LABEL");
  });

  it("🔴 负控：只写 comment、不写 label ⇒ comment 仍要能当 description 用（不因分离而丢）", () => {
    writeFileSync(
      file,
      [
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
        "@prefix sr: <http://home-serenity/ontology#> .",
        "@prefix : <http://example.org/probe#> .",
        "",
        ':onto a owl:Ontology ; sr:name "lc-probe2" .',
        ':OnlyComment a owl:Class ; rdfs:comment "ONLY-COMMENT" .',
        "",
      ].join("\n"),
      "utf-8",
    );
    const t = reviewJson().ontology.types.find((x: any) => x.name === "OnlyComment");
    expect(t.comment).toBe("ONLY-COMMENT");
    expect(t.label).toBeUndefined();
    expect(t.description).toBe("ONLY-COMMENT");
  });
});
