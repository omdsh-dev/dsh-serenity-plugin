# dsp 微信桥媒体接收（图片/文件）— 方案设计 v0.2

> 状态：**方案 v0.2（2026-09-01，用户拍板修订后）** — 用户裁决：① 只关心 ACC 层 ② 让 zhaocai 拿得到文件最重要 ③ 处理的先不管 ④ 可执行文件不要防护。
> 前置：`docs/weixin-bot-api.md`（iLink 协议全解，§6 媒体 CDN/AES）、`docs/weixin-bridge-design.md`（桥主体方案，P3 媒体期）。
> 需求来源：用户 "研究下微信发图片和文件我们桥该怎么处理，只要让会话知道文件的存在并可以拿到即可" → 修订 "只关心ACC层，让zhaocai拿得到文件最重要，处理的先不管，可执行文件不要防护"。

---

## 1. 需求层

| # | 需求 | 用户原话/来源 | 状态 |
|---|------|--------------|------|
| R1 | 微信发图片/文件 → **下载并落盘到 CCC 内**，会话（如 zhaocai）**知道文件存在且能拿到路径** | "只要让会话知道文件的存在并可以拿到即可" / "让zhaocai拿得到文件最重要" | 协议已验证可行 |
| R2 | **ACC 层职责边界**：只做"可达性"——下载、解密、落盘、注入存在性；**不做内容理解/识别编排/解析引导** | "只关心ACC层" / "处理的先不管" | 设计约束 |
| R3 | **不做可执行文件防护** | "可执行文件 不要防护"（用户明确否决 M5） | 用户拍板 |

**边界（不在本方案）**：
- **不做内容处理**：识别（vlm-describe）、解析（pdf-extract 等）、任何 MSM 编排——全部归角色 LLM/CCC 侧（ACC 不绑 role，D17）
- **不做发送媒体**（桥回复图片/文件）——P3 期
- **不做视频**（type 5）——后置（接口可扩展）
- **不做可执行文件防护**——照单落盘（用户拍板）
- **不做媒体清理自动化**——P2（`_tmp/` gitignored，无仓库污染）

## 2. 范围层

**做（ACC 层，最小闭环）**：
- `weixin-api.ts`：CDN 媒体下载 + AES-128-ECB 解密（纯函数可单测）+ 图片 magic-byte 嗅探（仅用于扩展名命名）
- `weixin-route.ts`：媒体提取（image/file item → 媒体清单）+ 落盘路径规划 + 文件名净化（路径安全）
- `weixin-bridge.ts`：`handleIncoming` 媒体处理（下载 → 落盘 → **存在性+路径注入** → askSkiff）；typing 窗口覆盖下载
- 测试：解密已知向量 / 下载 mock / 落盘路径 / 注入消息 / 降级（下载失败）

**不做**：内容识别编排 / 解析引导 / 可执行防护 / 发送媒体 / 视频 / 清理自动化 / weixin-admin 工具（沿用 W8）

## 3. 方案层

### 3.1 架构总览（数据流）

```
微信消息 item_list
  ├─ type 2 IMAGE → image_item.media (CDNMedia)
  └─ type 4 FILE  → file_item.media + file_name
        │
        ▼  weixin-bridge.handleIncoming（typing 窗口已开）
  extractWeixinMedia(msg) → [{kind, media, fileName?}]
        │
        ▼  weixin-api.downloadMedia（纯 fetch，30s 超时）
  URL = full_url 或 CDN_BASE/download?encrypted_query_param=<param>
  → AES-128-ECB 解密（key: item.aeskey / media.aes_key，hex 或 base64）
        │
        ▼  落盘（CCC 根内，gitignored）
  _tmp/weixin-inbound/<userhash>/<文件名>
  （图片 magic-byte 嗅探扩展名；文件用净化后的 file_name）
        │
        ▼  注入 question（只报存在 + 路径，不教怎么处理）
  「原文 + （用户发送了图片/文件 X，已保存到 <path>）」
        │
        ▼  askSkiff（角色 LLM 自行决定怎么用这个文件）
```

### 3.2 关键设计决策（R↓）

| # | 决策 | 方案 | 理由 / 备选 |
|---|------|------|------------|
| M1 | **下载在桥侧，不进 agent 工具面** | 桥收消息时下载+解密+落盘，agent 只拿到本地路径 | agent 无任意 fetch 工具；CDN URL 有时效+加密参数；落盘后 read/grep/vlm-describe 全通 |
| M2 | **落盘 CCC 根 `_tmp/weixin-inbound/<userhash>/`** | gitignored ✓；agent read/grep/glob 路径边界内 ✓；vlm-describe --image-path 任意路径 ✓；按用户分目录（同用户长期延续语义） | 备选：复用 `_tmp/images_from_user/` + `_tmp/files_from_user/`（WebUI 上传在用，混用易乱） |
| M3 | **注入 = 仅存在性 + 路径** | `（用户发送了图片/文件 X，已保存到 <path>）`——**不附加工具用法提示**（"处理的先不管"） | 用户拍板：ACC 层只保证可达性；识别/解析引导归角色 prompt/CCC 侧 |
| M4 | **降级不静默** | 下载失败 / 超 20MB → 注入说明 + 微信侧告知用户 | 对齐语音无转写降级提示先例 |
| M5 | ~~可执行文件拒收~~ | **删除**（用户拍板"可执行文件 不要防护"）——照单落盘 | 已否决 |
| M6 | **大小上限 20MB** | 超限告知不落盘 | 防磁盘积累；微信媒体本身有限制 |
| M7 | **typing 窗口覆盖下载** | sendTypingStart 提前到媒体处理前 | 用户等待下载时应有状态反馈 |

### 3.3 注入消息格式（E↑ 细则）

```
纯图片：  （用户发送了一张图片，已保存到 _tmp/weixin-inbound/<h>/img_<ts>_<r>.jpg）
纯文件：  （用户发送了文件 <name>，已保存到 _tmp/weixin-inbound/<h>/<name>）
文本+媒体：<原文>\n（用户同时发送了图片/文件 X，已保存到 <path>）
下载失败：（用户发送了图片/文件 <name>，但下载失败——可请用户重发）
超限：    （用户发送了文件 <name>，但超过 20MB 大小限制）
```

- 路径为 **CCC 根相对路径**（agent 的 read/grep/glob 均相对 CCC 根）
- 图片扩展名由 magic-byte 嗅探（FF D8→jpg / 89 50 4E 47→png / 47 49 46→gif / RIFF+WEBP→webp / BM→bmp / 未知→bin 兜底）
- **不做工具引导**（M3）——"可用 vlm-describe 识别"这类提示删除，角色 prompt 里有没有引导是 CCC 的事

### 3.4 外部面纯净（D9/D11/D35 延续）

- 媒体注入在 question 内，走 `includeTrajectory:false`（3100 同款）——不变
- 落盘路径在 CCC 根内，不逃逸；文件名净化（basename + 去控制字符 + 截断 128 字符）
- 输出守卫生效（外部面）——媒体路径/内容不进对外回复除非角色主动引用

## 4. 接口层

### 4.1 weixin-api.ts（Mech，纯确定性）

```ts
export interface CDNMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string }
export interface WeixinMediaRef { kind: 'image' | 'file'; media: CDNMedia; fileName?: string }

export function buildMediaDownloadUrl(media: CDNMedia): string | null
  // full_url 优先；否则 `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encrypt_query_param)}`
export function parseMediaAesKey(keyText?: string): Buffer | null
  // ① /^[0-9a-fA-F]{32,}$/ → hex Buffer(16)  ② base64 解码=16 字节直接用
  // ③ base64 解码=32 字节 → ascii 再 hex → Buffer(16)  其他 → null
export function aes128EcbDecrypt(data: Buffer, key: Buffer): Buffer
  // node:crypto createDecipheriv('aes-128-ecb', key, null)
export function sniffImageExt(data: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | 'bmp' | 'bin'
export async function downloadMedia(params: {
  item: { image_item?: { media?: CDNMedia; aeskey?: string } ; file_item?: { media?: CDNMedia; file_name?: string } }
  mediaType: 'image_item' | 'file_item'
  timeoutMs?: number   // 默认 30_000（对齐参考实现）
}): Promise<{ data: Buffer; fileName?: string } | null>
  // key 提取：item.aeskey || media.aes_key（对齐参考 downloadAndDecryptMedia）
  // 无 encrypt_query_param/full_url → null；fetch 失败/超时 → null（不抛）
```

### 4.2 weixin-route.ts（纯逻辑，可单测）

```ts
export function extractWeixinMedia(msg: { item_list?: … }): WeixinMediaRef[]
  // type 2 image_item / type 4 file_item → 媒体清单（file 带 file_name）
export function sanitizeFileName(name: string): string
  // basename + 去控制字符/路径分隔 + 截断 128
export function weixinInboundDir(root: string, fromUserId: string): string
  // `${root}/_tmp/weixin-inbound/${sha256(fromUserId).slice(0,12)}/`
```

### 4.3 weixin-bridge.ts（装配）

```
handleIncoming 扩展（typing 窗口提前）：
  sendTypingStart（提前到媒体处理前）
  text = extractWeixinText(msg)
  media = extractWeixinMedia(msg)
  for each media（逐个 try/catch）:
    downloadMedia → 落盘 → refs.push({path, name})
    失败/超限 → degraded.push(说明)
  question = [text, ...refs 注入, ...degraded 说明].filter(Boolean).join('\n')
  if (!question) { 语音无转写降级提示（已有）; return }
  askSkiff(question) → 回复回写
  sendTypingStop（finally）
```

## 5. 测试策略

- **单元**：`parseMediaAesKey`（hex/base64/无效三型）/ `aes128EcbDecrypt`（已知向量：`crypto.createCipheriv` 预生成 fixture）/ `sniffImageExt`（各魔数）/ `sanitizeFileName`（路径穿越/控制字符）/ `buildMediaDownloadUrl`（full_url 优先 + encrypted_query_param 构造）
- **集成（weixin.test.ts）**：mock fetch 返回加密 bytes → handleIncoming 落盘 → question 含路径注入 → 回复回写；下载失败 → 降级提示；图片+文本混合
- **联调**：真实微信发图/发文件（用户动作）——不进 CI

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| CDN URL 时效 / 腾讯限速 | 下载失败 | 降级提示不静默（M4）；失败可请用户重发 |
| 可执行文件落盘（用户拍板不防护） | 磁盘存在可执行物 | 用户明确接受；agent 不执行文件（read 只读文本），风险自担 |
| `_tmp/` 磁盘积累 | 空间增长 | gitignored 无仓库污染；P2 清理策略（TTL/手动） |
| 隐私（文件内容在 CCC） | 外部面暴露风险 | 落盘 CCC 根内 + 输出守卫生效（对外回复不自动带路径内容） |
| 文件名为路径穿越 | 落盘逃逸 | `sanitizeFileName`（basename + 净化）强制 |

## 7. 默认决策（用户已拍板 / ACC 层默认）

| # | 项 | 结论 |
|---|----|------|
| ① | 落盘位置 | `_tmp/weixin-inbound/<userhash>/`（专属，按用户分目录） |
| ② | 可执行文件 | **不防护**，照单落盘（用户拍板） |
| ③ | 内容处理 | **ACC 层不做**——识别/解析编排归角色/CCC 侧（"处理的先不管"） |
| ④ | 大小上限 | 20MB（ACC 层默认，防磁盘积累） |
| ⑤ | 版本节奏 | 与语音+typing 同轮 bump（用户验证后 1.27.3 一起发） |

## 8. 关联

- `docs/weixin-bot-api.md` §6（媒体 CDN/AES 协议真相源）
- `docs/weixin-bridge-design.md` §5 P3（媒体期原计划，本方案为其细化）
- vlm-describe MSM（zhaocai 白名单已有）——图片识别通道（角色侧决策，ACC 不编排）
- S149 memory-tool / mail-tool（角色依赖）
