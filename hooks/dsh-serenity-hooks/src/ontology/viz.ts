/**
 * viz.ts — 把 `.ttl` 本体**渲染成一张可读的结构图**（2026-10-13 S142 从 CCC 搬进 ACC）
 *
 * 🔴 **本次搬家的两条纪律**（否则"搬"会变成"抄一份新的"）：
 *  ① **渲染器（layout / svg / html）逐字保留** —— 它们的视觉是 owner 亲自认可的，
 *     搬的过程里**一个像素都不该动**。本文件里 `toSvg`／`toHtml`／`layout`／`edgePath`
 *     等仍是原件，未做任何"顺手改好一点"。
 *  ② 🔴 **自带解析器整块删除**，改用**引擎的 `turtleToOnto`** —— 这是本次搬家的
 *     **全部意义**：原 viz 的解析器实测有三类错（只认具名式公理 ⇒ **8/16 文件公理数归零**；
 *     `sr:identity` 只认括号形 ⇒ **18 处假阳**；`sr:description` 从不读 ⇒ 公理正文丢失）。
 *     复用引擎后这三类**自动消失**，因为引擎两种写法都认。
 *
 * ⚠️ 调用面由 `src/tools/ontology-eng.ts` 提供（`ontology viz`），本文件**不自己读 argv/退出**。
 *
 * 原始出处 = CCC 的 `.opencode/skills/home-serenity/scripts/ontology-viz.ts`（1505 行）。
 * 搬家判据与验收基准 = `AGENT_SESSIONS/…S142…/2026-10-13T0751-a3f1-viz-parser-baseline.md`
 * （16 份 `.ttl` 的逐文件读数，改后须与之**逐条对读**）。
 *
 * ---
 * 原文件头（保留其下的设计说明，仍成立的部分）：
 *
 * 把 `.ttl` 本体**渲染成一张可读的结构图**（Mech，零环境依赖）
 *
 * ## 它解决什么
 * 本体的真相是文本（`.ttl`），但"这个领域里有哪些东西、它们怎么连、约束在哪"——
 * 在 200 行 Turtle 里是**看不出来**的。`ontology explain` 给的是**清单**（段落文字），
 * 本工具给的是**图**（空间关系：谁在中心、谁孤立、链路怎么走）。
 *
 * ## 与既有工具的分工（不重复造）
 * | 工具 | 给什么 | 形态 |
 * |---|---|---|
 * | `ontology check/verify` | **判定**（对不对） | 报表 / 退出码 |
 * | `ontology explain` | **清单**（有什么） | 段落文字 |
 * | **本工具** | **结构**（怎么连的） | 图 |
 *
 * ## 子命令
 *   stats <ttl>              只出读数（类/关系/公理/实例/外部链），不画图
 *   diagram <ttl> [--show-axioms]    输出**内置 `diagram` 工具的标签源码**（可直接贴进对话看）
 *   svg <ttl> [--out=路径]    输出独立 SVG（矢量、可入文档）
 *   html <ttl> [--out=路径]   输出**交互版** HTML（拖拽平移/滚轮缩放/点节点看详情/搜索）
 *   list [扫描根]             列出所有可用 .ttl（缺省 = <CCC>/.opencode/skills）
 *   all  [扫描根] [--out-dir] 批量出 html（体检用）
 *
 * 业务 flag（协议 flag --format/--log/--help 由 msm 拦截，本脚本不接受）：
 *   --out=<path>        输出路径（缺省 _tmp/ontology-viz/<名>.{svg,html}）
 *   --show-axioms       公理也画成节点并连到它提到的类（缺省只在侧栏列）
 *   --show-instances    实例画成小方块挂在所属类下（缺省只在侧栏列）
 *   --no-imports        不画外部链节点
 *   --max-nodes=N       超过 N 个类就拒绝画图并提示（缺省 40；防一张糊图）
 *
 * 退出码：0 成功 ／ 1 参数错 ／ 2 文件不可读 ／ 4 内部异常 ／ 5 跑完但有发现（如超节点上限）
 *
 * ## 解析到什么程度（诚实边界 E↑）
 * **不是**通用 Turtle 解析器：不递归处理嵌套空白节点、不做 IRI 归一、不校验语义。
 * 它认的是**本容器实际在写的那种形态**（逐条实测自 16 份 `.ttl`）：
 *   `@prefix` / `@base` / `<>` ／ `:X a owl:Class ; rdfs:label "…"@en ; sr:rigidity sr:rigid ;
 *   sr:identity (…) ; sr:property [ sr:name "…" ; sr:type "…" ; sr:cardinality "…" ] .`
 *   `:p a owl:ObjectProperty ; rdfs:domain :A ; rdfs:range :B .`
 *   `:ax a sr:Axiom ; sr:axiomRule "…" ; sr:axiomType "…" .` ／ 实例 `:i a :SomeClass ; …`
 * 遇到不认识的构造**跳过并在 stats 里报数**（fail-loud，不静默吞）。
 */
import { basename } from "node:path";
import { loadOntoFile } from './engine.js';

interface OntoModel {
  file: string;
  prefixes: Map<string, string>;
  base: string | null;
  /** 本体自身元信息 */
  meta: { label?: string; comment?: string; version?: string; imports: string[] };
  classes: ClassDef[];
  relations: RelationDef[];
  axioms: AxiomDef[];
  instances: InstanceDef[];
  /** 没认出来的主语 a 类型（fail-loud 计数） */
  unknownTypes: string[];
}

interface ClassDef {
  id: string;
  label: string;
  comment: string;
  rigidity: "rigid" | "anti-rigid" | "semi-rigid" | null;
  identity: string[];
  properties: { name: string; type: string; cardinality: string }[];
  parents: string[];
}

interface RelationDef {
  id: string;
  label: string;
  comment: string;
  domain: string | null;
  range: string | null;
  cardinality: string;
  isObject: boolean;
}

interface AxiomDef {
  id: string;
  rule: string;
  type: string;
  comment: string;
  /** 规则文本里提到、且**本文件确实声明了**的类型名（用于连边） */
  mentions: string[];
}

interface InstanceDef {
  id: string;
  ofClass: string | null;
  label: string;
}


/**
 * `OntoModel` 的**唯一来源 = 引擎的解析器**（2026-10-13 S142）。
 *
 * 🔴 这里**不解析任何 Turtle** —— 只把引擎的 `OntologyDefinition` **翻译**成本文件的
 *    渲染模型。原 viz 自带的手写解析器已整块删除：它实测错三类
 *    （只认具名式公理 ⇒ 8/16 文件公理数归零；`sr:identity` 只认括号形 ⇒ 18 处假阳；
 *     从不读 `sr:description` ⇒ 公理正文丢失）。引擎两种写法都认 ⇒ 三类**自动消失**。
 *
 * 需引擎侧先满足两件事（已随 82e740f 落地）：导出 `loadOntoFile`／类型；模型收 `instances`。
 */
function fromEngine(file: string, absPath: string): OntoModel {
  const onto = loadOntoFile(absPath).onto;
  const model: OntoModel = {
    file,
    prefixes: new Map<string, string>(),
    base: null,
    meta: { imports: onto.imports ?? [] },
    classes: [],
    relations: [],
    axioms: [],
    instances: [],
    // ⚠️ `unknownTypes` **恒为空**（不是漏填）：它是原解析器的"主语 `a` 了没认出来的类型"计数，
    //    而引擎侧的判据是**只收"`a` 指向本文件已声明的类"** ⇒ 按构造就没有"没认出来的类型"。
    //    "类型名写错/未声明"这类问题由**引擎的 `check`（M9）**负责报，不再由图上重复一遍。
    unknownTypes: [],
  };

  // 🔴 **刚性值的三种形态都要归一**（2026-10-13 S142 实测；**这是 v1.56.3 发出去的那个崩溃**）：
  //    · `sr:rigidity "rigid"`              ← **字面量**（`ccc-ontology.ttl` 等基础链全用这种）
  //    · `sr:rigidity sr:rigid`             ← **带前缀的项**（`home-mail`／`home-browser` 等领域本体用这种）
  //    · 引擎对它存的是**展开后的完整 IRI** `http://home-serenity/ontology#rigid`
  //      （`engine.ts` 对该谓词是 `String(s.object)`，不 i2q 回短名 —— 实测确认）
  //    原渲染器查表键是 `rigid`／`anti-rigid`／`semi-rigid` ⇒ 后两种**查不到**
  //    ⇒ 颜色表取到 `undefined` ⇒ **渲染当场抛 TypeError**（症状：`Cannot read properties of
  //    undefined (reading 'class')`）。⇒ 在**唯一入口**归一，渲染器不感知多种写法。
  const normRigidity = (v: string | undefined): "rigid" | "anti-rigid" | "semi-rigid" | null => {
    if (v === undefined || v === "") return null;
    // 取最后一段：`http://home-serenity/ontology#rigid` → `rigid`；`sr:rigid` → `rigid`；`rigid` → `rigid`
    const last = v.slice(v.lastIndexOf("#") + 1);
    const bare = last.includes(":") ? last.slice(last.lastIndexOf(":") + 1) : last;
    return bare === "rigid" || bare === "anti-rigid" || bare === "semi-rigid" ? bare : null;
  };

  // ── 类 ──
  // 🔴 `label` 与 `comment` 是**两个字段**（引擎 v1.56.2 起）：图上节点名取 `label`，
  //    侧栏详情取 `comment` —— 原实现把两者合并进一个 `description`，后者覆盖前者
  //    ⇒ 图上节点名会被注释吃掉（这正是 v1.56.2 修的那个病）。
  //    兼容：老模型只有 `description` ⇒ 回落它。
  for (const [id, td] of Object.entries(onto.types ?? {})) {
    model.classes.push({
      id,
      label: td.label ?? td.description ?? id,
      comment: td.comment ?? td.description ?? "",
      rigidity: normRigidity(td.rigidity),
      identity: td.identity ?? [],
      properties: Object.entries(td.properties ?? {}).map(([name, pd]) => ({
        name,
        type: pd.type,
        cardinality: pd.cardinality ?? "",
      })),
      parents: td.superTypes ?? [],
    });
  }

  // ── 关系 ──
  for (const [id, rd] of Object.entries(onto.relations ?? {})) {
    model.relations.push({
      id,
      label: rd.label ?? id,
      comment: rd.comment ?? "",
      domain: rd.domain ?? null,
      range: rd.range ?? null,
      cardinality: rd.cardinality ?? "",
      isObject: true,
    });
  }

  // ── 公理 ──
  // 正文优先级：`rule` 优先（引擎里 `rule` 是必填），空则回落 `description`。
  // 🔴 匿名式公理（`:onto sr:axiom [ … ]`）**只有 `sr:description`、没有 `sr:axiomRule`**
  //    ⇒ 不回落的话正文是空串（原 viz 连这类公理都数不出来，见基线件）。
  // 🔴 **公理 id 必须逐条唯一** —— 渲染器三处拿它当节点键（`ax:${a.id}`／`a_${a.id}`）。
  //    留空会让**所有公理塌成同一个节点**（图上看只剩一个方块、连线全并到一起）。
  //    `dsp-dev/skill.ttl` 有 11 条 → 用序号编；`home-rhetoric` 那种具名式
  //    （`:ax-rule-has-a-source a sr:Axiom`）引擎侧不保名 ⇒ 同样退化成序号。
  onto.axioms?.forEach((ax, i) => {
    const rule = ax.rule !== "" ? ax.rule : (ax.description ?? "");
    model.axioms.push({
      id: `#${i + 1}`,
      rule,
      type: ax.type ?? "",
      comment: ax.comment ?? ax.description ?? "",
      mentions: [],
    });
  });

  // ── 实例 ──
  for (const inst of onto.instances ?? []) {
    model.instances.push({ id: inst.id, ofClass: inst.ofClass, label: inst.label ?? inst.id });
  }

  // ── 公理 → 它提到的类 ──
  // 🔴 规则里的类型名**两种写法都有**（实测）：`forall r in Rule:`（**裸名**）与
  //    `forall t in :Thing:`（**带前缀**）。只认一种会让另一种全部报成"未涉及任何类型"。
  //    这段逻辑**从原 parseTtl 末尾原样搬来**（判据一字未改）。
  for (const ax of model.axioms) {
    const found = new Set<string>();
    for (const c of model.classes) {
      const bare = c.id.includes(":") ? c.id.slice(c.id.indexOf(":") + 1) : c.id;
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|[^\\w:])${esc(bare)}(?![\\w])`);
      if (re.test(ax.rule)) found.add(c.id);
    }
    ax.mentions = [...found];
  }

  return model;
}


// ────────────────────────────────────────────────────────────
// 2. 布局（确定性网格 + 层次分带；同样的输入必得同样的图 —— 判据 S↑）
// ────────────────────────────────────────────────────────────

interface Box {
  id: string;
  kind: "class" | "relation" | "axiom" | "import" | "instance" | "self";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  fill: string;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  kind: "relation" | "axiom" | "instance" | "import";
  /** 该边**竖直通道**的 x（由布局分配，逐条错开 —— 否则同源多边会叠在一条线上） */
  channelX?: number;
  /** 标签落点（放在**进入目标的那段水平线**上方 ⇒ 每条边落点不同，不互相压） */
  labelAt?: [number, number];
  /** 该边是否绕行（右→左或跨多列）：发射器据此走上方弧线 */
  detour?: boolean;
}

interface Layout {
  boxes: Box[];
  edges: Edge[];
  width: number;
  height: number;
  notes: string[];
}

const RIG_FILL: Record<string, { class: string; label: string }> = {
  rigid: { class: "#1e3a5f", label: "稳定（rigid）" },
  "anti-rigid": { class: "#4a2f5f", label: "易变（anti-rigid）" },
  "semi-rigid": { class: "#2f4a3a", label: "半稳定（semi-rigid）" },
  none: { class: "#3a3f46", label: "未声明刚性" },
};

/**
 * 布局 = **分层 DAG（按关系方向定层）＋ 边只走列间空白**。
 *
 * 🔴 为什么不做网格：第一版用"按刚性分带 + 网格"排版，直线连边**穿过中间的框**、
 * 标签压住框标题（实测：1200×1168 的图里 6 条边穿过 3 个框，完全没法看）。
 * 根因 = **边的几何与框的位置互不知情**。分层布局把关系方向变成空间方向：
 * 第 0 层（无入边 = 源头）在最左，第 N 层（无出边 = 汇聚）在最右，
 * 于是每条边都只在**相邻列之间的竖直空白带**里走 —— 天然不穿框。
 *
 * 分层规则：`level(v) = longest-path-from-source`（最长路，保证所有边都指向右）。
 * 环（互相引用）用 `seen` 兜底：遇到回边就当作同层，边画成"绕行"（见 svg/diagram 发射器）。
 */
interface LayerPlan {
  /** 层号 → 该层的盒子 id（保持稳定顺序 ⇒ 同输入必得同图） */
  layers: string[][];
  level: Map<string, number>;
  /** 兜底：被丢弃的回边（打环时） */
  backEdges: Edge[];
}

function planLayers(ids: string[], edges: Edge[]): LayerPlan {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inc.set(id, []);
  }
  const backEdges: Edge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) {
      backEdges.push(e); // 自环 ⇒ 不参与分层（发射器画成自指小弧）
      continue;
    }
    if (!out.has(e.from) || !inc.has(e.to)) continue;
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(e.from)!.push(e.to);
    inc.get(e.to)!.push(e.from);
  }

  // 🔴 **Kahn 拓扑排序 + 最长路**。
  //    第一版用"递归 DFS + `cached >= depth` 提前返回"，那不是最长路：先访问到的节点会
  //    被后到的更长路径**截断**（实测：home-mail 的 6 个类全部塌进第 0 层 ⇒ 图退化成一列）。
  //    正确做法 = 按拓扑序**依次松弛**，层号只会单调增。
  const level = new Map<string, number>(ids.map((id) => [id, 0]));
  const indeg = new Map<string, number>(ids.map((id) => [id, inc.get(id)!.length]));
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  const processed = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    processed.add(u);
    for (const v of out.get(u) ?? []) {
      level.set(v, Math.max(level.get(v) ?? 0, (level.get(u) ?? 0) + 1));
      const d = (indeg.get(v) ?? 1) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  // 剩下来的节点在环里（拓扑序处理不到）⇒ 保留松弛后的层号，并把"指回已处理节点"的边
  // 登记成回边（发射器会绕行），避免图上出现逆向直线
  for (const id of ids) {
    if (processed.has(id)) continue;
    for (const e of edges) {
      if (e.from === id && processed.has(e.to)) backEdges.push(e);
    }
  }

  const maxLevel = Math.max(0, ...[...level.values()]);
  const layers: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const id of ids) layers[level.get(id) ?? 0]!.push(id);
  return { layers, level, backEdges };
}

/**
 * 框尺寸**由内容反推**（不拍脑袋定常数）。
 *
 *
 * 🔴 为什么必须这样：`diagram` 工具的体检（体检 2）会按**实际文字**算每行宽度，
 * 固定尺寸必然报"标签溢出"（实测：3 行标签需 ≈360px 而框只有 206px）。
 * 这里**照搬 `diagram` 的度量规则**（`src/diagram/dsl-render.ts` 的 `textWidth`：
 * `codePoint > 0x2e80 ⇒ 整宽，否则 0.55×`），保证两边算出来一致 ⇒ 不再报假溢出。
 */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.55;
  return w;
}

/** 一个框：标题 1 行（14px）＋ 正文若干行（11px）⇒ 宽高 */
function measureBox(title: string, lines: string[]): { w: number; h: number } {
  const titleW = textWidth(title, 14) + 20;
  const lineW = Math.max(0, ...lines.map((l) => textWidth(l, 11))) + 20;
  return {
    w: Math.max(140, Math.ceil(Math.max(titleW, lineW))),
    h: Math.ceil(26 + Math.max(1, lines.length) * 16 + 12),
  };
}

function layout(model: OntoModel, opts: { axioms: boolean; instances: boolean; imports: boolean }): Layout {
  const notes: string[] = [];
  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const PAD = 34;
  const COL_GAP = 210; // 列间距 = **边走的通道**：要同时放下「通道 + 标签宽度」（实测 130 不够）
  const ROW_GAP = 30;

  // ── ① 先收集节点 ──
  const nodes: { id: string; kind: Box["kind"]; title: string; lines: string[]; fill: string }[] = [];
  for (const c of model.classes) {
    nodes.push({
      id: `class:${c.id}`,
      kind: "class",
      title: c.label,
      lines: [
        `${c.id}${c.identity.length ? `  ◆ ${c.identity.join(",")}` : ""}`,
        `${c.properties.length} 属性${c.rigidity ? ` ／ ${c.rigidity}` : ""}`,
      ],
      fill: RIG_FILL[c.rigidity ?? "none"]!.class,
    });
  }
  if (opts.instances) {
    for (const i of model.instances) {
      nodes.push({ id: `inst:${i.id}`, kind: "instance", title: i.id, lines: [`属于 ${i.ofClass ?? "?"}`], fill: "#3f3420" });
    }
  }
  if (opts.axioms) {
    for (const a of model.axioms) {
      nodes.push({ id: `ax:${a.id}`, kind: "axiom", title: a.id, lines: [`[${a.type || "rule"}]`], fill: "#5f2f2f" });
    }
  }

  // ── ② 边（只收画得出的）──
  const classIds = new Set(model.classes.map((c) => `class:${c.id}`));
  for (const r of model.relations) {
    const fromId = r.domain ? `class:${r.domain}` : null;
    const toId = r.range ? `class:${r.range}` : null;
    if (fromId && toId && classIds.has(fromId) && classIds.has(toId)) {
      edges.push({ from: fromId, to: toId, label: `${r.label} [${r.cardinality || "?"}]`, kind: "relation" });
    } else {
      const why = [
        !r.domain ? "缺 domain" : !classIds.has(fromId!) ? `domain=${r.domain} 不在本文件的类里` : "",
        !r.range ? "缺 range" : !classIds.has(toId!) ? `range=${r.range} 不在本文件的类里` : "",
      ]
        .filter(Boolean)
        .join(" ／ ");
      notes.push(`关系 \`${r.id}\` 没画成边：${why}`);
    }
  }
  if (opts.axioms) {
    for (const ax of model.axioms) {
      for (const m of ax.mentions) {
        if (classIds.has(`class:${m}`)) edges.push({ from: `ax:${ax.id}`, to: `class:${m}`, label: "", kind: "axiom" });
      }
    }
  }
  if (opts.instances) {
    for (const inst of model.instances) {
      if (inst.ofClass && classIds.has(`class:${inst.ofClass}`)) {
        edges.push({ from: `inst:${inst.id}`, to: `class:${inst.ofClass}`, label: "", kind: "instance" });
      }
    }
  }

  // ── ③ 分层：`level = 最长路`（保证关系边一律由左指向右）──
  const ids = nodes.map((n) => n.id);
  // 自环不进分层（画成自指小弧）；公理/实例边**不参与分层** —— 否则会把层数拉偏
  const layerEdges = edges.filter((e) => e.kind === "relation" && e.from !== e.to);
  const plan = planLayers(ids.filter((i) => classIds.has(i)), layerEdges);

  // 🔴 公理与实例的边是 `→ 类`（"涉及"/"属于"）⇒ 它们必须落在类的**左边**，
  //    否则每条边都逆着流向（第一版就是这么错的）。做法 = 给所有类让出一列。
  const sideNodes = nodes.filter((n) => !classIds.has(n.id));
  const leftCols = sideNodes.length ? 1 : 0;
  const level = new Map<string, number>();
  for (const [id, lv] of plan.level) level.set(id, lv + leftCols);
  for (const n of sideNodes) level.set(n.id, 0);
  // 没有类的兜底：全放第 0 层
  for (const id of ids) if (!level.has(id)) level.set(id, 0);

  const maxLevel = Math.max(0, ...[...level.values()]);
  const layers: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  // 层内顺序：按连接度降序（枢纽靠上），再按 id ⇒ 确定性
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  for (const id of [...nodes].map((n) => n.id).sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b))) {
    layers[level.get(id) ?? 0]!.push(id);
  }

  // ── ④ 定位：列宽 = 该列最宽框；列内纵向均分；**整列垂直居中** ──
  const sizes = new Map(nodes.map((n) => [n.id, measureBox(n.title, n.lines)]));
  const colW: number[] = layers.map((l) => Math.max(140, ...l.map((id) => sizes.get(id)!.w)));
  const colX: number[] = [];
  let cursor = PAD;
  for (let i = 0; i < layers.length; i++) {
    colX.push(cursor);
    cursor += colW[i]! + COL_GAP;
  }
  // 各列总高 → 取最大者，其余列据此"分摊"富余空间（看起来横平竖直）
  const colH: number[] = layers.map((l) =>
    l.reduce((a, id) => a + sizes.get(id)!.h, 0) + Math.max(0, l.length - 1) * ROW_GAP,
  );
  const maxH = Math.max(1, ...colH);
  // ── ④ 先算**顶部标题带**（外部链 ＋ self），再让分层从它下面开始 ──
  // 🔴 顺序很重要：第一版先排分层的 y，再把 self/外部链"塞"进顶部 ⇒ 它们与第一列
  //    **抢同一块空间**（都从 x=PAD 起），叠在一起（实测：self 框压住第一列的框）。
  //    正解 = 顶部带先占位、算出下边界 `headerBottom`，分层从 `headerBottom + 20` 起。
  const headerBoxes: Box[] = [];
  let headerBottom = PAD;
  if (opts.imports && model.meta.imports.length) {
    let ix = PAD;
    model.meta.imports.forEach((im, i) => {
      const s = measureBox("外部链", [im]);
      headerBoxes.push({ id: `import:${i}`, kind: "import", x: ix, y: PAD, w: s.w, h: s.h, title: "外部链", lines: [im], fill: "#4a3b1f" });
      edges.push({ from: "self", to: `import:${i}`, label: "owl:imports", kind: "import" });
      ix += s.w + ROW_GAP;
      headerBottom = Math.max(headerBottom, PAD + s.h);
    });
    cursor = Math.max(cursor, ix + PAD);
  }
  const selfLines = [
    `版本 ${model.meta.version ?? "—"}`,
    `类 ${model.classes.length} ／ 关系 ${model.relations.length} ／ 公理 ${model.axioms.length} ／ 实例 ${model.instances.length}`,
  ];
  const selfSize = measureBox(model.meta.label || basename(model.file), selfLines);
  headerBoxes.push({
    id: "self",
    kind: "self",
    x: PAD,
    y: headerBottom + 16,
    w: selfSize.w,
    h: selfSize.h,
    title: model.meta.label || basename(model.file),
    lines: selfLines,
    fill: "#14524a",
  });
  headerBottom = headerBottom + 16 + selfSize.h;
  boxes.push(...headerBoxes);
  const TOP = headerBottom + 34; // 分层从这里开始 ⇒ 与标题带**物理隔开**

  // ── ⑤ 分层定位 ──
  layers.forEach((l, li) => {
    // 🔴 垂直**均分**（而不是从上往下堆）：列高不足时把富余空间摊到框之间，
    //    否则长边密集的地方（第一列）框会互相压 —— 实测过。
    const slack = Math.max(0, maxH - l.reduce((a, id) => a + sizes.get(id)!.h, 0));
    const gap = l.length > 1 ? slack / (l.length - 1) : 0;
    let y = TOP;
    for (const id of l) {
      const s = sizes.get(id)!;
      const n = nodeById.get(id)!;
      boxes.push({ id, kind: n.kind, x: colX[li]!, y, w: colW[li]!, h: s.h, title: n.title, lines: n.lines, fill: n.fill });
      y += s.h + gap;
    }
  });
  // 🔴 **self 不连类节点**：连第 0 层全部会射出 N 条横穿整图的长边
  //    （实测：home-video-production 的图被 8 条自 self 出发的长线贯穿）。
  //    self 块只是"这张图是谁的"标题，归属由标题与文件名表达。

  // ── ⑤ 顶部：外部链 ＋ self ──
  const width = Math.max(600, cursor);
  const height = Math.max(320, TOP + maxH + PAD);

  // ── ⑥ 逐边分配竖直通道 ──
  // 🔴 不给通道的话，同源（或同列间）的多条边会**叠在同一条竖线**上：标签互相压、
  //    分不清哪条连哪条（实测：mail 的 4 条出边全走 x=527）。
  //    做法 = 按"列间空隙"分组，组内把通道均匀摊开在空隙里（留出首尾边距）。
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const gaps = new Map<string, Edge[]>();
  for (const e of edges) {
    const a = boxById.get(e.from);
    const b = boxById.get(e.to);
    if (!a || !b || a.id === b.id) continue;
    if (b.x < a.x) {
      e.detour = true;
      continue;
    }
    const gapLo = a.x + a.w;
    const gapHi = b.x;
    const key = `${Math.round(gapLo)}:${Math.round(gapHi)}`;
    if (!gaps.has(key)) gaps.set(key, []);
    gaps.get(key)!.push(e);
  }
  for (const [, group] of gaps) {
    if (group.length === 1) {
      const a = boxById.get(group[0]!.from)!;
      const b = boxById.get(group[0]!.to)!;
      group[0]!.channelX = (a.x + a.w + b.x) / 2;
      continue;
    }
    // 组内按"目标 y"排序 ⇒ 通道顺序与目标顺序一致，线不交叉
    group.sort(
      (p, q) =>
        (boxById.get(p.to)?.y ?? 0) - (boxById.get(q.to)?.y ?? 0) ||
        p.label.localeCompare(q.label) ||
        p.to.localeCompare(q.to),
    );
    const lo = Math.min(...group.map((e) => boxById.get(e.from)!.x + boxById.get(e.from)!.w));
    const hi = Math.max(...group.map((e) => boxById.get(e.to)!.x));
    const span = hi - lo;
    const step = span / (group.length + 1);
    group.forEach((e, i) => {
      e.channelX = lo + step * (i + 1);
    });
  }
  return { boxes, edges, width, height, notes };
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * 纯文本版（**任何通道都能看** —— 不依赖图像输入、不依赖浏览器）。
 *
 * 🔴 为什么必要：本模型的当前路由**未声明图像输入**，`diagram` 出的 PNG 贴不进对话
 * （工具会降级落盘）。没有这个视图，我就只能让 owner 去开文件 —— 那等于没"给他看效果"。
 * 形态 = **按带分组的方框清单 ＋ 关系列表**（XML 树状），保留结构信息、丢掉空间信息。
 */
function toText(model: OntoModel, L: Layout, opts: { axioms: boolean }): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const W = 78;
  line("═".repeat(W));
  line(`  ${model.meta.label || basename(model.file)}${model.meta.version ? `  v${model.meta.version}` : ""}`);
  line(`  ${basename(model.file)}  ·  外部链：${model.meta.imports.join(", ") || "（无）"}`);
  line(`  类 ${model.classes.length} ／ 关系 ${model.relations.length} ／ 公理 ${model.axioms.length} ／ 实例 ${model.instances.length}`);
  line("═".repeat(W));

  const relOut = (cid: string) => model.relations.filter((r) => r.domain === cid);
  const relIn = (cid: string) => model.relations.filter((r) => r.range === cid);

  for (const [rigKey, label] of [
    ["rigid", RIG_FILL.rigid!.label],
    ["semi-rigid", RIG_FILL["semi-rigid"]!.label],
    ["anti-rigid", RIG_FILL["anti-rigid"]!.label],
    ["none", RIG_FILL.none!.label],
  ] as [string, string][]) {
    const arr = model.classes.filter((c) => (rigKey === "none" ? c.rigidity === null : c.rigidity === rigKey));
    if (!arr.length) continue;
    line();
    line(`▌${label}  （${arr.length}）`);
    for (const c of arr) {
      line(`  ┌─ ${c.label}   ${c.id}${c.identity.length ? `   ◆ 身份判据：${c.identity.join(", ")}` : ""}`);
      if (c.comment) line(`  │  ${trim(c.comment, 88)}`);
      for (const p of c.properties) line(`  │  · ${p.name}: ${p.type}  [${p.cardinality}]`);
      if (c.parents.length) line(`  │  ↑ 父类：${c.parents.join(", ")}`);
      for (const r of relOut(c.id)) line(`  │  → ${r.label} → ${r.range ?? "?"}  [${r.cardinality}]`);
      for (const r of relIn(c.id)) line(`  │  ← ${r.label} ← ${r.domain ?? "?"}  [${r.cardinality}]`);
      line(`  └─`);
    }
  }

  if (model.instances.length) {
    line();
    line(`▌实例  （${model.instances.length}）`);
    for (const i of model.instances) line(`  · ${i.id}  : ${i.ofClass ?? "?"}`);
  }

  if (opts.axioms && model.axioms.length) {
    line();
    line(`▌公理  （${model.axioms.length}）`);
    for (const a of model.axioms) {
      line(`  [${a.type || "rule"}] ${a.id}${a.mentions.length ? `   涉及：${a.mentions.join(", ")}` : "   ⚠️ 未涉及本文件任何类型"}`);
      line(`      ${a.rule}`);
      if (a.comment) line(`      ↳ ${a.comment}`);
    }
  }

  line();
  line(`▌关系全表  （${model.relations.length}）`);
  for (const r of model.relations) {
    const known = (id: string | null) => (id && model.classes.some((c) => c.id === id) ? "" : "  ⚠️");
    line(`  ${r.domain ?? "?"}${known(r.domain)} ──${r.label}[${r.cardinality}]──▶ ${r.range ?? "?"}${known(r.range)}`);
  }

  if (L.notes.length) {
    line();
    line(`▌没画成边的（${L.notes.length}）`);
    for (const n of L.notes) line(`  - ${n}`);
  }
  if (model.unknownTypes.length) {
    line();
    line(`▌没认出来的类型（${model.unknownTypes.length}）：${model.unknownTypes.join(", ")}`);
  }
  return out.join("\n");
}

// ────────────────────────────────────────────────────────────
// 3. 发射器
// ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** 两盒之间的连线端点（按相对方位取边中点） */
function anchors(a: Box, b: Box): [{ x: number; y: number }, { x: number; y: number }] {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // 分层布局下，主方向是水平 ⇒ 优先用左右边中点（边只在列间通道里走）
  if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
    return dx > 0
      ? [{ x: a.x + a.w, y: a.y + a.h / 2 }, { x: b.x, y: b.y + b.h / 2 }]
      : [{ x: a.x, y: a.y + a.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 }];
  }
  return dy > 0
    ? [{ x: a.x + a.w / 2, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y }]
    : [{ x: a.x + a.w / 2, y: a.y }, { x: b.x + b.w / 2, y: b.y + b.h }];
}

const EDGE_COLOR: Record<Edge["kind"], string> = {
  relation: "#8ab4f8",
  axiom: "#e08a8a",
  instance: "#c8a860",
  import: "#7fd1b9",
};

/**
 * **DOT（Graphviz）** —— 机械生成的**严谨**通路（推荐）。
 *
 * ## 为什么把布局交给 Graphviz
 * 手写的分层布局能满足"不重叠"，但**边绕行 / 标签避让 / 交叉最小化**是图布局的成熟难题，
 * Graphviz 的 `dot` 引擎专做这件事（分层 DAG、`splines=ortho` 正交走线、自动避让节点）。
 * 我们的职责于是收缩成一件事：**把本体忠实地翻译成 DOT**（节点/边/分组/样式），
 * 布局交给引擎 —— 这正是"机械生成 + 可读性好"的正解。
 *
 * ## 输出约束（**只出确定性的东西**）
 * - 节点 id 用**下标**（`n0`/`n1`…）而不是本体名 —— 本体名里有 `:`、`.`、`/`，
 *   直接当 DOT id 需要转义且容易踩坑；真实名字放进 `label`。
 * - 每条语句顺序固定 ⇒ 同一份 `.ttl` **永远出同一份 DOT**（判据 S↑）。
 * - 不写 `pos=`（那是引擎的输出，不是输入）⇒ 可重复生成。
 */
function toDot(model: OntoModel, opts: { axioms: boolean; instances: boolean; imports: boolean }): string {
  const out: string[] = [];
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  const nodeId = (key: string) => key.replace(/[^A-Za-z0-9_]/g, "_");

  out.push(`digraph ontology {`);
  out.push(`  graph [rankdir=LR, splines=ortho, nodesep=0.42, ranksep=0.95, fontname="Noto Sans CJK SC", bgcolor="#12161c", pad=0.3];`);
  out.push(`  node  [shape=box, style="rounded,filled", fontname="Noto Sans CJK SC", fontsize=11, color="#485364", penwidth=1, margin="0.14,0.09"];`);
  out.push(`  edge  [fontname="Noto Sans CJK SC", fontsize=9, color="#8ab4f8", fontcolor="#9fb4cc", arrowsize=0.7, penwidth=1.3];`);
  out.push(`  label=${q(`${model.meta.label || basename(model.file)}${model.meta.version ? `  v${model.meta.version}` : ""}\\n${model.classes.length} 类 / ${model.relations.length} 关系 / ${model.axioms.length} 公理 / ${model.instances.length} 实例`)};`);
  out.push(`  labelloc="t"; fontcolor="#c9d6e4"; fontsize=13;`);

  // ── 外部链 ──
  if (opts.imports) {
    model.meta.imports.forEach((im, i) => {
      out.push(`  ${nodeId(`imp${i}`)} [label=${q(`外部链\\n${im}`)}, fillcolor="#4a3b1f", fontcolor="#e8d5a8", shape=folder];`);
    });
  }

  // ── 类：按刚性分色（同色 = 同刚性，肉眼一眼分辨）──
  const RIG_DOT: Record<string, { fill: string; font: string; name: string }> = {
    rigid: { fill: "#1e3a5f", font: "#dce9f7", name: "rigid 稳定" },
    "anti-rigid": { fill: "#4a2f5f", font: "#e6d5f2", name: "anti-rigid 易变" },
    "semi-rigid": { fill: "#2f4a3a", font: "#d8f0e2", name: "semi-rigid 半稳定" },
    none: { fill: "#3a3f46", font: "#d9dde2", name: "未声明刚性" },
  };
  for (const c of model.classes) {
    const rigid = RIG_DOT[c.rigidity ?? "none"]!;
    const idLine = c.identity.length ? `\\n◆ ${c.identity.join(", ")}` : "";
    const lines = [
      `${c.label}`,
      `${c.id}${idLine}`,
      `${c.properties.length} 个属性`,
    ];
    out.push(
      `  ${nodeId(`c_${c.id}`)} [label=${q(lines.join("\\n"))}, fillcolor="${rigid.fill}", fontcolor="${rigid.font}", tooltip=${q(c.comment)}];`,
    );
  }

  // ── 关系（类 → 类）──
  for (const r of model.relations) {
    const from = nodeId(`c_${r.domain ?? ""}`);
    const to = nodeId(`c_${r.range ?? ""}`);
    if (r.domain && r.range && model.classes.some((c) => c.id === r.domain) && model.classes.some((c) => c.id === r.range)) {
      const card = r.cardinality ? `  [${r.cardinality}]` : "";
      out.push(`  ${from} -> ${to} [label=${q(`${r.label}${card}`)}, tooltip=${q(r.comment)}];`);
    }
  }

  // ── 实例 ──
  if (opts.instances && model.instances.length) {
    out.push(`  subgraph cluster_inst {`);
    out.push(`    label=${q(`实例（${model.instances.length}）`)}; fontcolor="#c8a860"; style=dashed; color="#5b4a28";`);
    for (const i of model.instances) {
      out.push(`    ${nodeId(`i_${i.id}`)} [label=${q(`${i.id}\\n: ${i.ofClass ?? "?"}`)}, fillcolor="#3f3420", fontcolor="#f0dfb8", shape=note];`);
    }
    out.push(`  }`);
    for (const i of model.instances) {
      if (i.ofClass && model.classes.some((c) => c.id === i.ofClass)) {
        out.push(`  ${nodeId(`i_${i.id}`)} -> ${nodeId(`c_${i.ofClass}`)} [style=dotted, color="#c8a860", arrowsize=0.6];`);
      }
    }
  }

  // ── 公理：连到**它提到的类**（虚线 + 浅色，视觉上退到背景）──
  if (opts.axioms && model.axioms.length) {
    out.push(`  subgraph cluster_ax {`);
    out.push(`    label=${q(`公理（${model.axioms.length}）`)}; fontcolor="#e08a8a"; style=dashed; color="#6b3a3a";`);
    for (const a of model.axioms) {
      out.push(
        `    ${nodeId(`a_${a.id}`)} [label=${q(`${a.id}\\n[${a.type || "rule"}]`)}, fillcolor="#5f2f2f", fontcolor="#f5dcdc", shape=note, tooltip=${q(a.rule)}];`,
      );
    }
    out.push(`  }`);
    for (const a of model.axioms) {
      for (const m of a.mentions) {
        out.push(
          `  ${nodeId(`a_${a.id}`)} -> ${nodeId(`c_${m}`)} [style=dashed, color="#e08a8a", fontcolor="#e08a8a", arrowsize=0.6];`,
        );
      }
    }
  }

  // ── self（本体自身）→ 外部链 + 第 0 层 ──
  const selfLabel = `${model.meta.label || basename(model.file)}`;
  out.push(`  ${nodeId("self")} [label=${q(selfLabel)}, fillcolor="#14524a", fontcolor="#d7f2ea", shape=box3d];`);
  if (opts.imports) {
    model.meta.imports.forEach((_, i) => {
      out.push(`  ${nodeId("self")} -> ${nodeId(`imp${i}`)} [label="owl:imports", color="#7fd1b9", fontcolor="#7fd1b9", style=dashed];`);
    });
  }
  // 图例（独立节点，用 HTML 表格 —— Graphviz 的 label 支持有限 HTML）
  out.push(`  legend [shape=none, margin=0, label=<`);
  out.push(`    <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="2" CELLPADDING="1">`);
  out.push(`      <TR><TD ALIGN="LEFT"><FONT COLOR="#c9d6e4" POINT-SIZE="10">图例</FONT></TD></TR>`);
  for (const [k, v] of Object.entries(RIG_DOT)) {
    out.push(
      `      <TR><TD ALIGN="LEFT" BGCOLOR="${v.fill}"><FONT COLOR="${v.font}" POINT-SIZE="9"> ${v.name} </FONT></TD></TR>`,
    );
  }
  out.push(`      <TR><TD ALIGN="LEFT"><FONT COLOR="#9fb4cc" POINT-SIZE="9">实线=对象关系 · 虚线=公理 · 点线=实例 · 绿虚=外部链</FONT></TD></TR>`);
  out.push(`    </TABLE>>];`);
  out.push(`}`);
  return out.join("\n");
}

function toDiagramSource(model: OntoModel, L: Layout, opts: { axioms?: boolean; instances?: boolean }): string {
  const out: string[] = [];
  out.push(
    `<diagram width="${Math.round(L.width)}" height="${Math.round(L.height)}" title="${esc(model.meta.label || basename(model.file))}">`,
  );
  const byId = new Map(L.boxes.map((b) => [b.id, b]));
  // 🔴 `diagram` 的 rect 标签是**单行**渲染（SVG `<text>` 不认 `\n`），且体检按整串估宽
  //    ⇒ 只传标题；多行内容留给 svg/html（那两个是我们自己的渲染器，逐行算宽）。
  for (const b of L.boxes) {
    out.push(
      `  <rect id="${b.id}" box="${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.x + b.w)},${Math.round(b.y + b.h)}" label="${esc(b.title)}" fill="${b.fill}"/>`,
    );
  }
  // 分层布局下，**相邻列**的边用直线即可（列间是空白通道）⇒ 不再穿框
  for (const e of L.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const [p1, p2] = anchors(a, b);
    out.push(`  <arrow from="${Math.round(p1.x)},${Math.round(p1.y)}" to="${Math.round(p2.x)},${Math.round(p2.y)}"/>`);
  }
  for (const e of L.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || !e.label) continue;
    const [p1, p2] = anchors(a, b);
    out.push(
      `  <text x="${Math.round((p1.x + p2.x) / 2)}" y="${Math.round((p1.y + p2.y) / 2) - 4}" align="center">${esc(trim(e.label, 24))}</text>`,
    );
  }
  out.push("</diagram>");
  return out.join("\n");
}

/**
 * 折线路径：
 *  **正向**（相邻/跨列向右）⇒ 出右边界 → 走到**本边专属的竖直通道** → 水平进目标左边界。
 *  **自环** ⇒ 在框右上角画一个小弧；**绕行**（右→左）⇒ 从上方绕过。
 * 每条边的通道由布局逐条错开（`channelX`）—— 否则同源的多条边会叠成一条竖线，
 * 标签也全糊在一起（实测：mail 的 4 条边全走 x=527）。
 */
function edgePath(a: Box, b: Box, e: Edge): { d: string; mid: [number, number] } {
  if (a.id === b.id) {
    const x = a.x + a.w;
    const y = a.y + a.h / 2 - 14;
    return { d: `M ${x} ${y} C ${x + 44} ${y - 30}, ${x + 44} ${y + 44}, ${x} ${y + 28}`, mid: [x + 42, y + 8] };
  }
  if (e.detour || b.x < a.x) {
    const yTop = Math.min(a.y, b.y) - 26;
    return {
      d: `M ${a.x + a.w / 2} ${a.y} L ${a.x + a.w / 2} ${yTop} L ${b.x + b.w / 2} ${yTop} L ${b.x + b.w / 2} ${b.y}`,
      mid: [(a.x + a.w / 2 + b.x + b.w / 2) / 2, yTop],
    };
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const mx = e.channelX ?? (x1 + x2) / 2;
  // 标签放在**竖直通道上、两端 y 的中点**（列间空白的中段）——
  // 放在"进入目标"那段水平线上会压住目标框（实测）。
  const ly = (y1 + y2) / 2;
  return {
    d: `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`,
    mid: e.labelAt ?? [mx, ly],
  };
}

function toSvg(model: OntoModel, L: Layout, opts: { axioms: boolean }): string {
  const byId = new Map(L.boxes.map((b) => [b.id, b]));
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(L.width)}" height="${Math.round(L.height)}" viewBox="0 0 ${Math.round(L.width)} ${Math.round(L.height)}" font-family="Noto Sans CJK SC, Noto Sans, DejaVu Sans, sans-serif">`,
  );
  parts.push(`<defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/>
    </marker>
  </defs>`);
  parts.push(`<rect width="100%" height="100%" fill="#12161c"/>`);
  // 边先画（压在框下面 ⇒ 即便绕不开也看得见框）
  // 🔴 **标签占位表**：多条边的标签可能落到同一处（同列间空隙、目标 y 接近）⇒
  //    逐条记录已占用的矩形，冲突时**沿通道上下推开**（不重叠 = 可读性的底线）。
  const occupied: [number, number, number, number][] = [];
  const boxRects: [number, number, number, number][] = L.boxes.map((b) => [b.x, b.y, b.x + b.w, b.y + b.h]);
  const hits = (r: [number, number, number, number], list: [number, number, number, number][]) =>
    list.some((o) => Math.min(r[2], o[2]) - Math.max(r[0], o[0]) > 2 && Math.min(r[3], o[3]) - Math.max(r[1], o[1]) > 2);
  for (const e of L.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const c = EDGE_COLOR[e.kind];
    const dash = e.kind === "axiom" ? ` stroke-dasharray="6 4"` : e.kind === "instance" ? ` stroke-dasharray="2 3"` : "";
    const { d, mid } = edgePath(a, b, e);
    parts.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.7" marker-end="url(#ah)"${dash} opacity="0.85"/>`,
    );
    if (e.label) {
      const w = textWidth(e.label, 11) + 8;
      let [lx, ly] = mid;
      // 依次尝试：原位 → 上移 → 下移 → 再上 → 再下（每次 15px）
      for (const dy of [0, -15, 15, -30, 30, -45, 45]) {
        const r: [number, number, number, number] = [lx - w / 2, ly + dy - 9, lx + w / 2, ly + dy + 7];
        if (!hits(r, occupied) && !hits(r, boxRects)) {
          parts.push(
            `<rect x="${(lx - w / 2).toFixed(1)}" y="${(ly + dy - 9).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="3" fill="#12161c" opacity="0.95"/>`,
          );
          parts.push(
            `<text x="${lx.toFixed(1)}" y="${(ly + dy + 2.5).toFixed(1)}" fill="${c}" font-size="11" text-anchor="middle">${esc(trim(e.label, 26))}</text>`,
          );
          occupied.push(r);
          break;
        }
      }
    }
  }
  for (const b of L.boxes) {
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${b.fill}" stroke="#48536488" stroke-width="1"/>`);
    parts.push(
      `<text x="${b.x + 12}" y="${b.y + 22}" fill="#eef3f8" font-size="14" font-weight="600">${esc(trim(b.title, 30))}</text>`,
    );
    b.lines.slice(0, 2).forEach((ln, i) => {
      parts.push(
        `<text x="${b.x + 12}" y="${b.y + 40 + i * 15}" fill="#b8c4d2" font-size="11" font-family="DejaVu Sans Mono, monospace">${esc(trim(ln, 36))}</text>`,
      );
    });
  }
  parts.push("</svg>");
  return parts.join("\n");
}

interface NodePayload {
  id: string;
  kind: Box["kind"];
  title: string;
  comment: string;
  rows: string[][];
  linksIn: string[];
  linksOut: string[];
  axioms: string[];
}

function payloads(model: OntoModel, L: Layout): NodePayload[] {
  const out: NodePayload[] = [];
  const relByClass = (cid: string) => ({
    out: model.relations.filter((r) => r.domain === cid).map((r) => `${r.label} → ${r.range ?? "?"} (${r.cardinality})`),
    in: model.relations.filter((r) => r.range === cid).map((r) => `${r.domain ?? "?"} → ${r.label} (${r.cardinality})`),
  });
  out.push({
    id: "self",
    kind: "self",
    title: model.meta.label || basename(model.file),
    comment: model.meta.comment ?? "",
    rows: [
      ["文件", basename(model.file)],
      ["版本", model.meta.version ?? "—"],
      ["外部链", model.meta.imports.join(", ") || "（无）"],
      ["类／关系／公理／实例", `${model.classes.length} / ${model.relations.length} / ${model.axioms.length} / ${model.instances.length}`],
    ],
    linksIn: [],
    linksOut: model.meta.imports.map((i) => `owl:imports ${i}`),
    axioms: [],
  });
  for (const c of model.classes) {
    const rel = relByClass(c.id);
    out.push({
      id: `class:${c.id}`,
      kind: "class",
      title: c.label,
      comment: c.comment,
      rows: [
        ["标识", c.id],
        ["刚性", c.rigidity ?? "未声明"],
        ["身份判据", c.identity.join(", ") || "—（无 identity ⇒ M4 会警告）"],
        ...(c.parents.length ? [["父类", c.parents.join(", ")]] : []),
        ...c.properties.map((p) => [`属性 ${p.name}`, `${p.type} ／ ${p.cardinality}`]),
      ],
      linksIn: rel.in,
      linksOut: rel.out,
      axioms: model.axioms.filter((a) => a.mentions.includes(c.id)).map((a) => `${a.id}: ${a.rule}`),
    });
  }
  for (const ax of model.axioms) {
    out.push({
      id: `ax:${ax.id}`,
      kind: "axiom",
      title: ax.id,
      comment: ax.comment,
      rows: [["类型", ax.type], ["规则", ax.rule], ["涉及", ax.mentions.join(", ") || "（本文件里没有它提到的类型）"]],
      linksIn: [],
      linksOut: ax.mentions.map((m) => `涉及 ${m}`),
      axioms: [],
    });
  }
  for (const inst of model.instances) {
    out.push({
      id: `inst:${inst.id}`,
      kind: "instance",
      title: inst.id,
      comment: "",
      rows: [["属于", inst.ofClass ?? "?"]],
      linksIn: [],
      linksOut: [],
      axioms: [],
    });
  }
  return out;
}

function toHtml(model: OntoModel, L: Layout, svg: string): string {
  const data = JSON.stringify(payloads(model, L));
  const notes = L.notes.length
    ? `<div class="notes"><b>未画出的边（${L.notes.length}）</b><ul>${L.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
    : "";
  const unknowns = model.unknownTypes.length
    ? `<div class="notes"><b>没认出来的类型（${model.unknownTypes.length}）</b> ${esc(model.unknownTypes.join(", "))}</div>`
    : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${esc(model.meta.label || basename(model.file))} — 本体结构图</title>
<style>
 :root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--dim:#8b949e;--line:#30363d}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Noto Sans CJK SC",system-ui,sans-serif;overflow:hidden}
 #wrap{display:flex;height:100vh}
 #stage{flex:1;position:relative;overflow:hidden;cursor:grab}
 #stage.drag{cursor:grabbing}
 #stage svg{position:absolute;left:0;top:0;transform-origin:0 0}
 #side{width:340px;min-width:340px;background:var(--panel);border-left:1px solid var(--line);overflow-y:auto;padding:16px}
 #bar{position:absolute;left:12px;top:12px;display:flex;gap:8px;align-items:center;background:#161b22dd;border:1px solid var(--line);border-radius:8px;padding:8px 10px;backdrop-filter:blur(6px);z-index:5;flex-wrap:wrap;max-width:calc(100% - 24px)}
 button,label{background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer}
 button:hover{background:#30363d}
 input{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;width:150px}
 h1{font-size:15px;margin:0 0 4px}
 h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 6px;border-bottom:1px solid var(--line);padding-bottom:4px}
 .meta{color:var(--dim);font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12px}
 td{padding:3px 4px;vertical-align:top;border-bottom:1px solid #21262d}
 td:first-child{color:var(--dim);width:34%}
 code,.mono{font-family:DejaVu Sans Mono,monospace;font-size:11.5px;word-break:break-all}
 .notes{margin-top:14px;font-size:12px;color:#d2a24c}
 .notes ul{margin:4px 0 0 14px;padding:0}
 .tag{display:inline-block;background:#21262d;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:11px;margin-right:4px}
 .pill{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px}
</style></head><body>
<div id="wrap">
  <div id="stage">
    <div id="bar">
      <input id="q" placeholder="搜索类 / 关系 / 公理…">
      <button id="fit">适应窗口</button>
      <button id="reset">100%</button>
      <span class="meta" id="hint">拖动平移 · 滚轮缩放 · 点节点看详情</span>
    </div>
    ${svg.replace("<svg ", '<svg id="graph" ')}
  </div>
  <div id="side">
    <h1>${esc(model.meta.label || basename(model.file))}</h1>
    <div class="meta">${esc(basename(model.file))}${model.meta.version ? " · v" + esc(model.meta.version) : ""}</div>
    <div class="meta" style="margin-top:6px">
      <span class="tag">类 ${model.classes.length}</span><span class="tag">关系 ${model.relations.length}</span>
      <span class="tag">公理 ${model.axioms.length}</span><span class="tag">实例 ${model.instances.length}</span>
      <span class="tag">外部链 ${model.meta.imports.length}</span>
    </div>
    <div id="detail"><div class="meta">点左侧任一方块看它的详情（注释 / 属性 / 进出关系 / 涉及的公理）。</div></div>
    ${notes}${unknowns}
    <h2>图例</h2>
    <div class="meta">
      <div><span class="pill" style="background:#1e3a5f">稳定 rigid</span> <span class="pill" style="background:#4a2f5f">易变 anti-rigid</span> <span class="pill" style="background:#2f4a3a">半稳定</span> <span class="pill" style="background:#3a3f46">未声明</span></div>
      <div style="margin-top:6px">蓝线=对象关系（带基数） · 红虚线=公理涉及 · 黄虚线=实例归属 · 绿线=外部链</div>
    </div>
  </div>
</div>
<script>
const DATA=${data}; const BY=new Map(DATA.map(d=>[d.id,d]));
const svg=document.getElementById('graph'), stage=document.getElementById('stage');
let k=1,tx=0,ty=0;
function apply(){svg.style.transform=\`translate(\${tx}px,\${ty}px) scale(\${k})\`}
function fit(){const w=svg.viewBox.baseVal.width,h=svg.viewBox.baseVal.height;
 const r=stage.getBoundingClientRect(); k=Math.min((r.width-40)/w,(r.height-40)/h,1.4); tx=(r.width-w*k)/2; ty=(r.height-h*k)/2; apply()}
stage.addEventListener('mousedown',e=>{if(e.target.closest('#bar'))return;let sx=e.clientX,sy=e.clientY;const ox=tx,oy=ty;stage.classList.add('drag');
 const mv=ev=>{tx=ox+ev.clientX-sx;ty=oy+ev.clientY-sy;apply()};
 const up=()=>{stage.classList.remove('drag');window.removeEventListener('mousemove',mv);window.removeEventListener('mouseup',up)};
 window.addEventListener('mousemove',mv);window.addEventListener('mouseup',up)});
stage.addEventListener('wheel',e=>{e.preventDefault();const r=stage.getBoundingClientRect();const mx=e.clientX-r.left,my=e.clientY-r.top;
 const f=e.deltaY<0?1.12:1/1.12;const nk=Math.max(.15,Math.min(6,k*f));tx=mx-(mx-tx)*(nk/k);ty=my-(my-ty)*(nk/k);k=nk;apply()},{passive:false});
svg.querySelectorAll('rect[id]').forEach(el=>{el.style.cursor='pointer';
 el.addEventListener('click',ev=>{ev.stopPropagation();show(el.id);highlight(el.id)})});
svg.querySelectorAll('rect').forEach(el=>{if(!el.id)el.style.pointerEvents='none'});
function highlight(id){svg.querySelectorAll('rect[id]').forEach(r=>r.setAttribute('stroke',r.id===id?'#e6edf3':'#48536488'));
 svg.querySelectorAll('rect[id]').forEach(r=>r.setAttribute('stroke-width',r.id===id?'2.5':'1'))}
function show(id){const d=BY.get(id);if(!d)return;
 const row=(a,b)=>\`<tr><td>\${esc(a)}</td><td class="mono">\${esc(b)}</td></tr>\`;
 let h=\`<h1>\${esc(d.title)}</h1>\`;
 if(d.comment)h+=\`<div class="meta" style="margin-bottom:8px">\${esc(d.comment)}</div>\`;
 h+='<table>'+d.rows.map(r=>row(r[0],r[1])).join('')+'</table>';
 if(d.linksOut.length)h+='<h2>出去的关系</h2>'+d.linksOut.map(x=>\`<div class="mono">\${esc(x)}</div>\`).join('');
 if(d.linksIn.length)h+='<h2>进来的关系</h2>'+d.linksIn.map(x=>\`<div class="mono">\${esc(x)}</div>\`).join('');
 if(d.axioms&&d.axioms.length)h+='<h2>涉及的公理</h2>'+d.axioms.map(x=>\`<div class="mono">\${esc(x)}</div>\`).join('');
 document.getElementById('detail').innerHTML=h}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
document.getElementById('fit').onclick=fit;
document.getElementById('reset').onclick=()=>{k=1;tx=0;ty=0;apply()};
document.getElementById('q').oninput=e=>{const q=e.target.value.toLowerCase();
 svg.querySelectorAll('rect[id]').forEach(r=>{if(!q){r.style.opacity=1;return}
  const d=BY.get(r.id);const hay=(r.id+' '+JSON.stringify(d||'')).toLowerCase();
  r.style.opacity=hay.includes(q)?1:.16})};
fit();
</script></body></html>`;
}

export { fromEngine, layout, toSvg, toHtml, toText, toDot, toDiagramSource, type OntoModel };
