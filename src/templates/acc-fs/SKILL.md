---
name: acc-fs
description: 文件系统操作工具（cc-fs 语义，DSH 版）。root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find 共 15 个子命令，全部路径限定在 CCC 根内（路径逃逸自动阻断）。reveal 在 OS 文件管理器中打开路径（Linux xdg-open / macOS Finder / Windows Explorer）。与 DSH 原生 read/write/edit 互补。
---

# Skill: acc-fs — 文件系统操作（cc-fs 语义）

## 用途

在 CCC 根内执行安全文件操作。与 DSH 原生 `read`/`write`/`edit`/`glob`/`grep` 互补：
- **原生工具**负责读写文件内容（已有沙箱守卫）
- **本工具**负责结构性操作：树形浏览（tree）、查找（find）、元信息（info）、路径换算（resolve/relative）、以及 mkdir/rm/mv/cp/touch/append

## 操作协议

```bash
bun "<skill 基目录>/scripts/cc-fs.ts" <subcommand> [args...]
```

| 子命令 | 参数 | 说明 |
|--------|------|------|
| `root` | — | 打印 CCC 根目录绝对路径 |
| `resolve` | `<path>` | 相对路径 → 根内绝对路径（JSON） |
| `exists` | `<path>` | 存在性检查（JSON true/false） |
| `list` | `[dir]` | 目录列表（JSON：name/type 数组，默认根） |
| `tree` | `[dir]` | 递归目录树（JSON：path/type 数组，默认根，可 `--depth <n>`） |
| `relative` | `<path>` | 绝对/相对路径 → 相对根路径（JSON） |
| `mkdir` | `<dir>...` | 递归创建目录 |
| `rm` | `<path>...` | 删除文件/目录（批量；`--dry-run` 预览；默认拒绝删除根本身） |
| `mv` | `<src> <dst>` | 移动/重命名 |
| `cp` | `<src> <dst>` | 复制（目录递归） |
| `touch` | `<file>` | 创建空文件 |
| `append` | `<file> <content>` | 追加内容（文件不存在则创建） |
| `info` | `<path>` | 元信息（JSON：exists/type/size/mtime） |
| `find` | `<pattern>` | 从根递归查找匹配文件（名称包含匹配；`regex:` 前缀用正则；JSON） |

## 守卫（强制，与 ACC 标准一致）

1. **路径逃逸阻断**：所有路径参数先解析为绝对路径，越出 CCC 根即报错退出 2
2. **symlink 防御**：目标存在时校验 realpath 仍在根内
3. **根保护**：`rm` 拒绝删除 CCC 根自身
4. 根内完整权限、根外零权限（P3）——与 DSH fs 沙箱叠加生效

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | user 错误（缺参数 / 未知子命令） |
| 2 | system 错误（无 CCC / 路径逃逸 / IO 失败） |

## 何时使用

- 需要目录树/查找/元信息（原生 glob 不够时）
- 批量 mkdir/rm/mv/cp
- 需要"路径是否在根内"的确定性判断

## 参考

- 身份与工具映射总览：`acc-serenity` 技能
- 读写文件内容：DSH 原生 read/write/edit（本技能不重复提供）
