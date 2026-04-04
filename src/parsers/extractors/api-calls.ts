/**
 * Extraction des appels API depuis le code source (fetch, axios, custom clients).
 * Patterns supportes : fetch('/api/...'), axios.get('/api/...'), api.post('/api/...'),
 * template literals avec expressions (`/api/users/${id}`).
 */

import { Node } from 'ts-morph';
import type { SourceFile, CallExpression } from 'ts-morph';
import type { ApiCallInfo } from '../base-parser.js';

const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Extrait tous les appels API d'un fichier source */
export function extractApiCalls(sourceFile: SourceFile): ApiCallInfo[] {
  const calls: ApiCallInfo[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();

    // Pattern 1 : fetch('/api/...') ou fetch(`/api/...`)
    if (Node.isIdentifier(expr) && expr.getText() === 'fetch') {
      const url = extractUrlArg(node);
      if (url) {
        const method = inferFetchMethod(node);
        calls.push({ method, url, line: node.getStartLineNumber() });
      }
      return;
    }

    // Pattern 2 : axios.get('/api/...'), api.post('/api/...'), apiClient.delete('/api/...')
    if (Node.isPropertyAccessExpression(expr)) {
      const methodName = expr.getName().toLowerCase();
      if (HTTP_METHOD_NAMES.has(methodName)) {
        const url = extractUrlArg(node);
        if (url) {
          calls.push({
            method: methodName.toUpperCase() as ApiCallInfo['method'],
            url,
            line: node.getStartLineNumber(),
          });
        }
      }
      return;
    }
  });

  return calls;
}

/** Extrait l'URL du premier argument d'un call (string literal ou template literal) */
function extractUrlArg(callExpr: CallExpression): string | null {
  const args = callExpr.getArguments();
  if (args.length === 0) return null;

  const firstArg = args[0];

  // String literal : fetch('/api/users')
  if (Node.isStringLiteral(firstArg)) {
    const value = firstArg.getLiteralValue();
    return isApiUrl(value) ? value : null;
  }

  // Template literal avec expressions : fetch(`/api/users/${id}`) → /api/users/:param
  if (Node.isTemplateExpression(firstArg)) {
    const head = firstArg.getHead().getLiteralText();
    if (!isApiUrl(head)) return null;
    let url = head;
    for (const span of firstArg.getTemplateSpans()) {
      url += ':param' + span.getLiteral().getLiteralText();
    }
    return url;
  }

  // Template literal sans expression (NoSubstitutionTemplateLiteral)
  if (Node.isNoSubstitutionTemplateLiteral(firstArg)) {
    const value = firstArg.getLiteralValue();
    return isApiUrl(value) ? value : null;
  }

  return null;
}

/**
 * Verifie si l'URL ressemble a un appel API.
 * Patterns reconnus : /api/..., /auth/..., /v1/..., http://..., https://...
 */
function isApiUrl(url: string): boolean {
  return /^(\/api|\/auth|\/v\d|https?:\/\/)/.test(url);
}

/** Infere la methode HTTP depuis les options de fetch (default: GET) */
function inferFetchMethod(callExpr: CallExpression): ApiCallInfo['method'] {
  const args = callExpr.getArguments();
  if (args.length < 2) return 'GET';

  const options = args[1];
  if (!Node.isObjectLiteralExpression(options)) return 'GET';

  const methodProp = options.getProperty('method');
  if (!methodProp || !Node.isPropertyAssignment(methodProp)) return 'GET';

  const initializer = methodProp.getInitializer();
  if (!initializer) return 'GET';

  const text = initializer.getText().replace(/['"]/g, '').toUpperCase();
  const valid = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
  if (valid.includes(text as typeof valid[number])) {
    return text as ApiCallInfo['method'];
  }

  return 'UNKNOWN';
}
