import { describe, it, expect } from 'vitest'
import { collectNonImageFiles, fileNoteTemplate } from '../src/client/file-fallback-api.js'

/** 构造剪贴板 item 桩（kind/type/getAsFile） */
function item(kind: string, type: string, file?: File): { kind: string; type: string; getAsFile: () => File | null } {
  return { kind, type, getAsFile: () => file ?? null }
}

function file(name: string, type: string): File {
  return new File(['x'], name, { type })
}

describe('file-fallback-api: collectNonImageFiles（非图片文件筛选）', () => {
  it('只收集非图片文件（图片留给 DSH 原生 rail）', () => {
    const files = collectNonImageFiles([
      item('file', 'image/png', file('a.png', 'image/png')),
      item('file', 'application/pdf', file('b.pdf', 'application/pdf')),
      item('file', '', file('c.md', '')),
      item('string', 'text/plain'),
    ])
    expect(files.map((f) => f.name)).toEqual(['b.pdf', 'c.md'])
  })

  it('空剪贴板 / 无文件 → 空数组', () => {
    expect(collectNonImageFiles([])).toEqual([])
    expect(collectNonImageFiles([item('string', 'text/plain')])).toEqual([])
  })

  it('getAsFile 返回 null 的 item 跳过（不可读文件）', () => {
    expect(collectNonImageFiles([item('file', 'application/pdf', undefined)])).toEqual([])
  })
})

describe('file-fallback-api: fileNoteTemplate（draft 追加模板，随发送进消息）', () => {
  it('单文件：The user provided a file (path: ...)', () => {
    expect(fileNoteTemplate(['_tmp/files_from_user/a.pdf'])).toBe(
      'The user provided a file (path: _tmp/files_from_user/a.pdf)',
    )
  })

  it('多文件：每行一条路径', () => {
    const note = fileNoteTemplate(['_tmp/files_from_user/a.pdf', '_tmp/files_from_user/b.zip'])
    expect(note).toBe('The user provided 2 files:\n- _tmp/files_from_user/a.pdf\n- _tmp/files_from_user/b.zip')
  })
})
