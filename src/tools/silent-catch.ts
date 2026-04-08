/**
 * Outil MCP : silent_catch
 * Detecte les blocs catch qui avalent les erreurs silencieusement.
 * Parse les fichiers source avec ts-morph (pas l'index CodeGuard).
 * Ref spec : specs/silent-catch.md
 */

import { Project, SyntaxKind } from 'ts-morph';
import type { CatchClause } from 'ts-morph';
import { scanProject } from '../utils/scanner.js';

export interface SilentCatchIssue {
  severity: 'critical' | 'high' | 'medium';
  file: string;
  line: number;
  message: string;
  snippet: string;
}

export interface SilentCatchResult {
  totalCatches: number;
  issueCount: number;
  bySeverity: { critical: number; high: number; medium: number };
  issues: SilentCatchIssue[];
}

/** Fichiers a exclure de l'analyse */
function shouldSkipFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    /\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(normalized) ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/test/') ||
    normalized.includes('/scripts/') ||
    normalized.includes('/seeds/') ||
    normalized.includes('/migrations/') ||
    normalized.includes('node_modules/')
  );
}

/** Extrait un snippet de max 3 lignes du texte */
function extractSnippet(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length <= 3) return text.trim();
  return lines.slice(0, 3).join('\n') + '\n...';
}

/** Classifie un CatchClause (try/catch) */
function classifyCatchClause(catchClause: CatchClause): 'critical' | 'high' | 'medium' | 'ok' {
  const body = catchClause.getBlock();
  const statements = body.getStatements();
  const fullText = body.getText();

  // 1. Catch vide (0 statements)
  if (statements.length === 0) {
    // Convention : prefixe _ = intentionnel
    const param = catchClause.getVariableDeclaration();
    if (param && param.getName().startsWith('_')) return 'ok';
    // Commentaire dans le catch = intentionnel
    if (fullText.includes('//') || fullText.includes('/*')) return 'ok';
    return 'critical';
  }

  // 2. Contient un throw → l'erreur est propagee = OK
  if (fullText.includes('throw ')) return 'ok';

  // 3. Contient un logger structure → OK
  if (/logger\.(error|warn|fatal)/.test(fullText)) return 'ok';

  // 4. Contient un return de valeur par defaut sans log → HIGH
  const hasDefaultReturn = HAS_DEFAULT_RETURN.test(fullText);
  const hasAnyLog = /logger\.|console\.(error|warn|log)/.test(fullText);
  if (hasDefaultReturn && !hasAnyLog) return 'high';

  // 5. Assigne une valeur par defaut sans log (variable = default, setState(default)) → HIGH
  const hasDefaultAssign = HAS_DEFAULT_ASSIGN.test(fullText);
  if (hasDefaultAssign && !hasAnyLog && !hasDefaultReturn) return 'high';

  // 6. Contient console.log (pas un logger structure) → MEDIUM
  const hasConsoleLog = /console\.(log|error|warn)/.test(fullText);
  if (hasConsoleLog) return 'medium';

  // 7. Parametre catch non utilise
  const param = catchClause.getVariableDeclaration();
  if (param) {
    const paramName = param.getName();
    if (!paramName.startsWith('_')) {
      const usageCount = fullText.split(paramName).length - 1;
      if (usageCount <= 0) return 'high';
    }
  }

  return 'ok';
}

// --- Patterns de valeurs par defaut (partages entre try/catch et .catch) ---

/** Return d'une valeur par defaut dans un catch */
const HAS_DEFAULT_RETURN = new RegExp(
  'return\\s+(' +
    // Litteraux simples
    'null|undefined|false|true|0|-1|NaN' +
    "|''|\"\"|``" +
    // Collections vides
    '|\\[\\]|\\{\\}' +
    // Constructeurs vides
    '|new\\s+(Map|Set|Array|Date|Error|Buffer|RegExp|Object)\\s*\\(' +
    // Objets inline (ex: { message: "...", success: false })
    '|\\{\\s*\\w+\\s*:' +
    // Promise.resolve fallback
    '|Promise\\.resolve\\s*\\(' +
    // RxJS fallback
    '|of\\s*\\(|EMPTY|Observable\\.empty' +
  ')',
);

/** Assignation d'une valeur par defaut dans un catch (variable = default, setState(default)) */
const HAS_DEFAULT_ASSIGN = new RegExp(
  '(' +
    // Variable = default
    '\\w+\\s*=\\s*(null|undefined|false|\\[\\]|\\{\\}|0|\'\'|""|new\\s+\\w+\\s*\\()' +
    // React setState/set* avec default
    '|set\\w+\\s*\\(\\s*(null|undefined|false|\\[\\]|\\{\\}|0|\'\'|"")\\s*\\)' +
  ')',
);

/** Classifie un .catch() sur une Promise */
function classifyPromiseCatch(callbackBody: string): 'critical' | 'high' | 'medium' | 'ok' {
  const trimmed = callbackBody.trim();

  // .catch(() => {}) ou .catch(() => void 0)
  if (trimmed === '{}' || trimmed === '' || trimmed === 'void 0') return 'critical';

  // .catch((_e) => {}) — prefixe _ = intentionnel
  if (/^\(\s*_/.test(callbackBody)) return 'ok';

  // Contient throw → OK
  if (trimmed.includes('throw ')) return 'ok';

  // Contient logger → OK
  if (/logger\.(error|warn|fatal)/.test(trimmed)) return 'ok';

  // Return/assign valeur par defaut sans log → HIGH
  const hasAnyLog = /logger\.|console\.(error|warn|log)/.test(trimmed);
  if ((HAS_DEFAULT_RETURN.test(trimmed) || HAS_DEFAULT_ASSIGN.test(trimmed)) && !hasAnyLog) return 'high';
  // Callback qui retourne directement un literal (ex: .catch(() => []))
  if (/^(null|undefined|\[\]|\{\}|false|0|''|""|new\s+\w+\s*\()$/.test(trimmed)) return 'high';

  // console.log → MEDIUM
  if (/console\.(log|error|warn)/.test(trimmed)) return 'medium';

  return 'ok';
}

/** Retourne un message lisible selon la severite et le contenu du catch */
function issueMessage(severity: 'critical' | 'high' | 'medium', catchText: string): string {
  switch (severity) {
    case 'critical':
      return 'Catch vide — aucun traitement, l\'erreur disparait sans trace';
    case 'high': {
      if (HAS_DEFAULT_ASSIGN.test(catchText) && !HAS_DEFAULT_RETURN.test(catchText)) {
        return 'Assigne une valeur par defaut sans log — masque l\'erreur dans l\'etat';
      }
      if (/return\s+\{/.test(catchText)) {
        return 'Retourne un objet fallback sans log — l\'appelant ne sait pas que c\'est une erreur';
      }
      return 'Valeur par defaut sans log — impossible de distinguer "pas de donnees" de "erreur"';
    }
    case 'medium':
      return 'console.log au lieu de logger structure — pas de trace fiable en production';
  }
}

export async function runSilentCatch(
  projectRoot: string,
  severityFilter: string,
): Promise<SilentCatchResult> {
  const result: SilentCatchResult = {
    totalCatches: 0,
    issueCount: 0,
    bySeverity: { critical: 0, high: 0, medium: 0 },
    issues: [],
  };

  // Lister les fichiers .ts/.tsx du projet
  const scan = scanProject(projectRoot);
  const tsFiles = scan.files.filter(
    (f) => /\.(ts|tsx)$/.test(f) && !shouldSkipFile(f),
  );

  // Parser avec ts-morph
  const project = new Project({ skipAddingFilesFromTsConfig: true });

  for (const filePath of tsFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);

      // --- try/catch ---
      const catchClauses = sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause);
      for (const cc of catchClauses) {
        result.totalCatches++;
        const severity = classifyCatchClause(cc);
        if (severity === 'ok') continue;
        if (severityFilter === 'critical' && severity !== 'critical') continue;
        if (severityFilter === 'high' && severity === 'medium') continue;

        result.bySeverity[severity]++;
        result.issueCount++;
        result.issues.push({
          severity,
          file: filePath,
          line: cc.getStartLineNumber(),
          message: issueMessage(severity, cc.getBlock().getText()),
          snippet: extractSnippet(cc.getBlock().getText()),
        });
      }

      // --- .catch() sur Promises ---
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExpressions) {
        const expr = call.getExpression();
        if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

        const propAccess = expr.asKind(SyntaxKind.PropertyAccessExpression);
        if (!propAccess || propAccess.getName() !== 'catch') continue;

        result.totalCatches++;
        const args = call.getArguments();
        if (args.length === 0) continue;

        const callback = args[0];
        const callbackText = callback.getText();

        // Extraire le corps du callback
        let bodyText = '';
        if (callback.getKind() === SyntaxKind.ArrowFunction) {
          const arrowFn = callback.asKind(SyntaxKind.ArrowFunction);
          if (arrowFn) {
            const body = arrowFn.getBody();
            bodyText = body.getText();
          }
        } else {
          bodyText = callbackText;
        }

        // Verifier prefixe _ dans les params
        if (/^\(\s*_/.test(callbackText) || /^_/.test(callbackText)) continue;

        const severity = classifyPromiseCatch(bodyText);
        if (severity === 'ok') continue;
        if (severityFilter === 'critical' && severity !== 'critical') continue;
        if (severityFilter === 'high' && severity === 'medium') continue;

        result.bySeverity[severity]++;
        result.issueCount++;
        result.issues.push({
          severity,
          file: filePath,
          line: call.getStartLineNumber(),
          message: issueMessage(severity, bodyText),
          snippet: extractSnippet(callbackText),
        });
      }

      // Liberer la memoire
      project.removeSourceFile(sourceFile);
    } catch {
      // Fichier non parsable — skip silencieusement
    }
  }

  // Trier par severite (critical > high > medium)
  const severityOrder = { critical: 0, high: 1, medium: 2 };
  result.issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return result;
}

/** Formate le resultat pour affichage MCP */
export function formatSilentCatchResult(result: SilentCatchResult): string {
  const lines: string[] = [];

  lines.push('## Silent Catch');
  lines.push('');
  lines.push(`**Catches analyses** : ${result.totalCatches} | **Suspects** : ${result.issueCount}`);

  if (result.issueCount === 0) {
    lines.push('');
    lines.push('> Aucun catch silencieux detecte. Bien joue.');
    return lines.join('\n');
  }

  lines.push(`Repartition : ${result.bySeverity.critical} critical, ${result.bySeverity.high} high, ${result.bySeverity.medium} medium`);

  // Tableau resume
  lines.push('');
  lines.push('| Sev | Fichier | Ligne | Probleme |');
  lines.push('|-----|---------|-------|----------|');
  for (const issue of result.issues) {
    const shortFile = issue.file.replace(/\\/g, '/').split('/').slice(-2).join('/');
    lines.push(`| ${issue.severity.toUpperCase()} | ${shortFile} | ${issue.line} | ${issue.message} |`);
  }

  // Details
  lines.push('');
  lines.push('### Detail');
  for (const issue of result.issues) {
    const shortFile = issue.file.replace(/\\/g, '/').split('/').slice(-2).join('/');
    lines.push('');
    lines.push(`**${shortFile}:${issue.line}** (${issue.severity.toUpperCase()})`);
    lines.push('```');
    lines.push(issue.snippet);
    lines.push('```');
  }

  return lines.join('\n');
}
