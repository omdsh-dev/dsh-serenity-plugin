# assets/diagram — 出图用的内置字型（**为什么必须随包分发**）

这三个字型是 `diagram` 工具在**光栅化**时必须喂给 resvg-wasm 的，原因是一次**实测**：

> 在 docker 里给容器装好中文字体（`fc-list` 认得它）之后，resvg-wasm 渲染中文**仍然得到空白画布**，
> 且 `loadSystemFonts: true|false` 两份 PNG **逐字节相同** ⇒ **wasm 对系统字体完全不可见**。
> 只有 `fontBuffers`（把字体字节直接递给它）才画得出字。
> ⇒ 顺带白拿一条：**输出与机器无关**（同一份内置字型 ⇒ 逐字节可复现）。

## 0. 三个字型各修好了什么（**每一个都由一张实测对照图证明**）

| 字型 | 覆盖 | 没有它会怎样（实测） |
|---|---|---|
| `DroidSansFallbackFull.ttf` | 汉字 | 中文**全变方框** |
| `NotoSans-Regular.ttf` | 拉丁 | `diagram` ／ `parseDsl` 全变方框（Droid 是 **CJK 兜底字型**，**不含拉丁**） |
| `DejaVuSans.ttf` | 符号 | `① ② ③` ／ `⇒` ／ `→` 仍是方框（**前两个都没有这些字形**） |

🔴 **判据的教训**：起初的验收是"有字 vs 无字逐字节不同" —— 它只证明**有墨**，
**没证明墨是那个字**（方框也是墨）⇒ 拉丁全变方框时它**照样绿**。
⇒ 现在每条覆盖声明都配一条**点名字符集**的差分用例：**同长度不同字形必须出不同墨**。

## 1. `DroidSansFallbackFull.ttf`（汉字，3.8 MB，Apache-2.0）

```
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Droid
Source: https://android.googlesource.com/platform/frameworks/base/
Files: *
Copyright: Copyright © 2006, 2007, 2008, 2009, 2010 Google Corp.
           Droid is a trademark of Google Corp.
License: Apache-2
 On Debian systems, the complete text of the Apache License Version 2.0
 can be found in `/usr/share/common-licenses/Apache-2.0'.
```

取件处（本机）：`/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf`（Debian `fonts-droid-fallback`）。
许可证全文随包：`LICENSE-Apache-2.0.txt`。

## 2. `NotoSans-Regular.ttf`（拉丁，500 KB，OFL-1.1）—— v1.51.1 新增

🔴 **为什么必须补第二个字型**：`DroidSansFallbackFull` 是**汉字兜底字型**（Android 当年把它与
`DroidSans.ttf` 配成一对），它**不含拉丁字母** ⇒ v1.51.0 只带它时，图里 `diagram` ／ `parseDsl` ／
`·` 全部渲染成**方框**（owner 实测图上肉眼可见）。

```
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Noto
Source: https://github.com/notofonts/noto-fonts
License: OFL-1.1
```

取件处（本机）：`/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf`（Debian `fonts-noto-core`）。
许可证全文随包：`LICENSE-OFL-1.1.txt`（即该包的 Debian `copyright` 文件，内含 OFL-1.1 全文与出处）。

## 3. `DejaVuSans.ttf`（符号，742 KB）—— v1.51.1 续（D108）

🔴 **为什么还要第三个**：补完拉丁之后**再看了一眼真图**，发现 `① ② ③` 与 `⇒` ／ `→` **仍然是方框**
—— 前两个字型都没有这些字形（`DroidSansFallbackFull` 有汉字但没有象征符号；`NotoSans-Regular`
有拉丁与常用标点，但没有带圈数字与箭头）。而本仓自己的文档**满屏 `⇒`** ⇒ 图里出现它是常态。

**选型是量出来的**（各喂一个缓冲单独渲染一张对照图，肉眼看）：

| 候选 | 结果 |
|---|---|
| `NotoSansSymbols2-Regular.ttf` | ❌ 只有 `▲ ● ★ ✓ ✗`；`①`／`⇒`／`→` 仍是方框 |
| `NotoSansSymbols-Regular.ttf` | ❌ 同上量级（未单独出图，覆盖面是 Symbols2 的子集方向） |
| `DejaVuSans.ttf` | ✅ **全覆盖**：`① ② ③ ⇒ → ← ▲ ● ★ ✓ ✗ ·— ≥ ≠ ×` |

```
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: DejaVu
Source: https://github.com/dejavu-fonts/dejavu-fonts
License: Bitstream-Vera
```

取件处（本机）：`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`（Debian `fonts-dejavu-core`）。
许可证全文随包：`LICENSE-DejaVu.txt`（即该包的 Debian `copyright` 文件）。

## 4. 家族名与文件必须以同一份事实为准

家族名（`'Noto Sans'` ／ `'DejaVu Sans'` ／ `'Droid Sans Fallback'`）、资产路径与 SVG 家族栈的
**唯一真相源** = `src/diagram/fonts.ts`；`src/diagram/rasterize.ts` 负责按路径把字节读进来喂 wasm。

🔴 **家族名是量出来的**：三个名字取自各文件 `name` 表 `nameID=1`（平台 3 ／ UTF-16BE）。
必须这样量一次的原因：写错名字时 resvg 的**自动回退仍可能把字画出来**（**图上看不出来**）
⇒ "栈里的名字是对的"这件事只有直接读字体文件才能证明。

三个资产**都必须在 `package.json` 的 `files` 白名单里**，并被 `dsh-develop pack-check` 的
`required` 清单硬断言（漏了 = 装得上但画不出字，v1.26.15 事故同族）。
