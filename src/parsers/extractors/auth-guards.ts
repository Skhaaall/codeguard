/**
 * Detection des decorateurs d'authentification sur les routes NestJS.
 * Detecte @UseGuards, @Public, @Roles, @Auth, @Authorized sur les methodes et classes.
 */

import type { MethodDeclaration, ClassDeclaration } from 'ts-morph';

const AUTH_DECORATORS = ['UseGuards', 'Public', 'Roles', 'Auth', 'Authorized'];

/** Extrait les decorateurs d'auth sur une methode ou sa classe */
export function extractAuthGuards(method: MethodDeclaration, cls: ClassDeclaration): string[] {
  const guards: string[] = [];

  // Decorateurs sur la methode
  for (const deco of method.getDecorators()) {
    if (AUTH_DECORATORS.includes(deco.getName())) {
      guards.push(
        `@${deco.getName()}(${deco
          .getArguments()
          .map((a) => a.getText())
          .join(', ')})`,
      );
    }
  }

  // Decorateurs sur la classe (s'appliquent a toutes les routes)
  for (const deco of cls.getDecorators()) {
    if (AUTH_DECORATORS.includes(deco.getName())) {
      guards.push(
        `@${deco.getName()}(${deco
          .getArguments()
          .map((a) => a.getText())
          .join(', ')})`,
      );
    }
  }

  return guards;
}
