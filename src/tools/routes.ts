/**
 * Outil MCP : route_guard
 * Coherence des routes frontend ↔ backend.
 * Detecte les routes fantomes, les appels dans le vide, et les routes sensibles sans auth.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { RouteInfo, ApiCallInfo } from '../parsers/base-parser.js';

export interface RouteIssue {
  severity: 'info' | 'warn' | 'danger';
  message: string;
  /** Route backend ou appel frontend concerne */
  route?: { method: string; path: string };
  /** Fichier source */
  filePath: string;
  line: number;
}

export interface RouteGuardResult {
  /** Toutes les routes backend detectees */
  backendRoutes: RouteInfo[];
  /** Tous les appels API frontend detectes */
  frontendCalls: Array<ApiCallInfo & { filePath: string }>;
  /** Problemes detectes */
  issues: RouteIssue[];
  /** Resume */
  summary: { total: number; danger: number; warn: number; info: number };
}

/** Domaines sensibles — routes qui DOIVENT avoir un middleware d'auth */
const SENSITIVE_PATTERNS = [
  /\/admin/i,
  /\/auth\/delete/i,
  /\/auth\/reset/i,
  /\/users\/.*delete/i,
  /\/payment/i,
  /\/billing/i,
  /\/settings/i,
  /\/account/i,
];

/** Routes qui n'ont pas besoin d'auth (login, register, health, public) */
const PUBLIC_ROUTE_PATTERNS = [
  /\/auth\/login/i,
  /\/auth\/register/i,
  /\/auth\/signup/i,
  /\/auth\/callback/i,
  /\/health/i,
  /\/public/i,
  /\/webhook/i,
];

export function runRouteGuard(index: ProjectIndex): RouteGuardResult {
  const backendRoutes = collectBackendRoutes(index);
  const frontendCalls = collectFrontendCalls(index);
  const issues: RouteIssue[] = [];

  // 1. Routes backend pas appelees par le frontend (routes fantomes)
  for (const route of backendRoutes) {
    const isCalled = frontendCalls.some((call) => routeMatchesCall(route, call));
    if (!isCalled) {
      issues.push({
        severity: 'info',
        message: `Route backend jamais appelee par le frontend : ${route.method} ${route.path}`,
        route: { method: route.method, path: route.path },
        filePath: route.filePath,
        line: route.line,
      });
    }
  }

  // 2. Appels frontend vers des routes inexistantes (appels dans le vide)
  for (const call of frontendCalls) {
    const exists = backendRoutes.some((route) => routeMatchesCall(route, call));
    if (!exists) {
      issues.push({
        severity: 'warn',
        message: `Appel frontend vers une route inexistante : ${call.method} ${call.url}`,
        route: { method: call.method, path: call.url },
        filePath: call.filePath,
        line: call.line,
      });
    }
  }

  // 3. Routes sensibles sans middleware d'auth
  for (const route of backendRoutes) {
    if (!isSensitiveRoute(route.path)) continue;
    if (isPublicRoute(route.path)) continue;

    const hasAuth = route.authGuards && route.authGuards.length > 0;
    if (!hasAuth) {
      issues.push({
        severity: 'danger',
        message: `Route sensible sans middleware d'auth : ${route.method} ${route.path}`,
        route: { method: route.method, path: route.path },
        filePath: route.filePath,
        line: route.line,
      });
    }
  }

  const summary = {
    total: issues.length,
    danger: issues.filter((i) => i.severity === 'danger').length,
    warn: issues.filter((i) => i.severity === 'warn').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };

  return { backendRoutes, frontendCalls, issues, summary };
}

/** Collecte toutes les routes definies dans le backend */
function collectBackendRoutes(index: ProjectIndex): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of Object.values(index.files)) {
    if (file.routes.length > 0) {
      routes.push(...file.routes);
    }
  }
  return routes;
}

/** Collecte les appels API dans les fichiers frontend (pas les fichiers backend) */
function collectFrontendCalls(index: ProjectIndex): Array<ApiCallInfo & { filePath: string }> {
  const calls: Array<ApiCallInfo & { filePath: string }> = [];
  for (const file of Object.values(index.files)) {
    if (!file.apiCalls || file.apiCalls.length === 0) continue;

    // Heuristique : un fichier qui definit des routes est un fichier backend
    // Ses appels API sont des appels inter-services, pas des appels frontend
    if (file.routes.length > 0) continue;

    // Chemins typiquement backend — exclure
    const normalized = file.filePath.replace(/\\/g, '/');
    if (/\/(controllers?|routes?|api|server|middleware)\//i.test(normalized)) continue;

    for (const call of file.apiCalls) {
      calls.push({ ...call, filePath: file.filePath });
    }
  }
  return calls;
}

/** Prefixes courants ajoutes par les clients API (axios baseURL, proxy, etc.) */
const API_PREFIXES = ['/api/v1', '/api/v2', '/api'];

/** Verifie si une route backend correspond a un appel frontend */
function routeMatchesCall(route: RouteInfo, call: ApiCallInfo): boolean {
  // Methode doit correspondre (ou UNKNOWN cote frontend = wildcard)
  if (call.method !== 'UNKNOWN' && call.method !== route.method) return false;

  const routePath = normalizePath(route.path);
  const callUrl = normalizePath(call.url);

  // Match direct
  if (matchPaths(routePath, callUrl)) return true;

  // Retenter en retirant les prefixes courants de l'URL frontend
  for (const prefix of API_PREFIXES) {
    if (callUrl.startsWith(prefix)) {
      const stripped = callUrl.slice(prefix.length) || '/';
      if (matchPaths(routePath, stripped)) return true;
    }
  }

  return false;
}

/** Compare deux chemins segment par segment (supporte :param et [param]) */
function matchPaths(routePath: string, callUrl: string): boolean {
  if (routePath === callUrl) return true;

  const routeSegments = routePath.split('/');
  const callSegments = callUrl.split('/');

  if (routeSegments.length !== callSegments.length) return false;

  return routeSegments.every((seg, i) => {
    if (seg.startsWith(':') || seg.startsWith('[')) return true;
    if (callSegments[i].startsWith(':')) return true;
    return seg === callSegments[i];
  });
}

function normalizePath(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isSensitiveRoute(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Formate le resultat pour affichage MCP */
export function formatRouteGuardResult(result: RouteGuardResult): string {
  const lines: string[] = [];

  lines.push('## Route Guard');
  lines.push(`- Routes backend : ${result.backendRoutes.length}`);
  lines.push(`- Appels API frontend : ${result.frontendCalls.length}`);

  if (result.issues.length === 0) {
    lines.push('');
    lines.push('> Aucun probleme detecte. Les routes frontend et backend sont coherentes.');
    return lines.join('\n');
  }

  lines.push(`- Problemes : ${result.summary.total} (${result.summary.danger} critiques, ${result.summary.warn} alertes, ${result.summary.info} infos)`);

  // Danger en premier
  const dangerIssues = result.issues.filter((i) => i.severity === 'danger');
  if (dangerIssues.length > 0) {
    lines.push('');
    lines.push('### Routes sensibles sans auth');
    for (const issue of dangerIssues) {
      lines.push(`- /!\\ ${issue.message}`);
      lines.push(`  → ${issue.filePath}:${issue.line}`);
    }
  }

  // Warn ensuite
  const warnIssues = result.issues.filter((i) => i.severity === 'warn');
  if (warnIssues.length > 0) {
    lines.push('');
    lines.push('### Appels frontend vers routes inexistantes');
    for (const issue of warnIssues) {
      lines.push(`- ! ${issue.message}`);
      lines.push(`  → ${issue.filePath}:${issue.line}`);
    }
  }

  // Info en dernier
  const infoIssues = result.issues.filter((i) => i.severity === 'info');
  if (infoIssues.length > 0) {
    lines.push('');
    lines.push('### Routes backend non utilisees par le frontend');
    for (const issue of infoIssues) {
      lines.push(`- ${issue.message}`);
      lines.push(`  → ${issue.filePath}:${issue.line}`);
    }
  }

  return lines.join('\n');
}
