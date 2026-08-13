/**
 * name.ts — 名称工具
 */

/** kebab-case 校验（CCC 名只允许小写字母+数字+连字符） */
export function isValidCccName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}
