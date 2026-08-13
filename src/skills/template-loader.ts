/**
 * template-loader.ts — 技能模板加载与占位符替换
 *
 * 模板目录结构：src/templates/<skill-name>/{SKILL.md, manifest.yaml, scripts/, references/}
 * 占位符：{{prefix}}, {{ccc_name}}, {{date}}
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface TemplateContext {
  prefix: string;
  cccName: string;
  date: string;
}

export function renderTemplate(content: string, ctx: TemplateContext): string {
  return content
    .replaceAll('{{prefix}}', ctx.prefix)
    .replaceAll('{{ccc_name}}', ctx.cccName)
    .replaceAll('{{date}}', ctx.date);
}

/**
 * copyTemplateTree — 递归拷贝模板目录到目标目录，做占位符替换
 */
export function copyTemplateTree(templateDir: string, targetDir: string, ctx: TemplateContext): string[] {
  const written: string[] = [];
  const walk = (src: string, dst: string) => {
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const dstPath = join(dst, entry);
      const st = statSync(srcPath);
      if (st.isDirectory()) {
        mkdirSync(dstPath, { recursive: true });
        walk(srcPath, dstPath);
      } else {
        const raw = readFileSync(srcPath, 'utf-8');
        const rendered = renderTemplate(raw, ctx);
        writeFileSync(dstPath, rendered, 'utf-8');
        written.push(relative(targetDir, dstPath));
      }
    }
  };
  mkdirSync(targetDir, { recursive: true });
  walk(templateDir, targetDir);
  return written;
}
