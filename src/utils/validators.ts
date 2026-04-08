/**
 * Schemas de validation zod pour les donnees externes.
 * Tout ce qui entre depuis stdin, le filesystem, ou un client MCP tiers
 * doit etre valide avant d'etre utilise.
 */

import { z } from 'zod';

// --- Validation stdin hook (cli.ts) ---

export const HookInputSchema = z
  .object({
    tool_input: z
      .object({
        file_path: z.string().optional(),
      })
      .optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export type ValidatedHookInput = {
  filePath: string;
  cwd: string;
};

/** Valide et extrait les champs utiles du JSON recu par le hook */
export function validateHookInput(data: unknown): ValidatedHookInput | null {
  const result = HookInputSchema.safeParse(data);
  if (!result.success) return null;

  return {
    filePath: result.data.tool_input?.file_path ?? '',
    cwd: result.data.cwd ?? '',
  };
}

// --- Validation ProjectIndex (index-store.ts) ---

const FileNodeSchema = z
  .object({
    filePath: z.string(),
    language: z.string(),
    imports: z.array(
      z.object({
        name: z.string(),
        source: z.string(),
        isTypeOnly: z.boolean(),
      }),
    ),
    exports: z.array(
      z.object({
        name: z.string(),
        kind: z.string(),
        isTypeOnly: z.boolean(),
      }),
    ),
    functions: z.array(z.any()),
    classes: z.array(z.any()),
    types: z.array(z.any()),
    routes: z.array(z.any()),
    parsedAt: z.number(),
  })
  .passthrough();

export const ProjectIndexSchema = z.object({
  projectRoot: z.string(),
  indexedAt: z.number(),
  fileCount: z.number().int().nonnegative(),
  files: z.record(z.string(), FileNodeSchema),
});

/** Valide un ProjectIndex charge depuis le disque */
export function validateProjectIndex(data: unknown): boolean {
  return ProjectIndexSchema.safeParse(data).success;
}
