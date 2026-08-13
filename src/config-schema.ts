/**
 * config-schema.ts — CCC 配置 (.dsh/serenity.json) zod schema
 *
 * 与 opencode 插件的 .opencode/serenity.json 语义对齐，DSH 侧路径为 .dsh/serenity.json。
 */

import { z } from 'zod';

export const DshSerenityConfigSchema = z.object({
  loop: z
    .object({
      defaultModel: z.string().optional(),
    })
    .optional(),
  sessionKeeper: z
    .object({
      threshold: z.number().int().positive().optional(),
    })
    .optional(),
  safeMode: z
    .object({
      blacklist: z.array(z.string()).optional(),
    })
    .optional(),
});

export type DshSerenityConfig = z.infer<typeof DshSerenityConfigSchema>;

export const DEFAULT_SESSION_KEEPER_THRESHOLD = 150;

export function parseDshSerenityConfig(raw: unknown): DshSerenityConfig {
  const parsed = DshSerenityConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid .dsh/serenity.json: ${parsed.error.message}`);
  }
  return parsed.data;
}
