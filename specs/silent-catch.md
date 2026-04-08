# Spec : outil `silent_catch` — detection des catches silencieux

> **Ce fichier est une spec a implementer.** Il contient tout le contexte necessaire.
> L'instance qui implemente cet outil n'a pas le contexte de la conversation qui a produit cette spec.

---

## Pourquoi cet outil existe

### Le probleme

Un `catch` qui avale une erreur en silence cree des **bugs invisibles**. L'utilisateur voit un ecran vide ou un mode degrade, mais pas d'erreur. Ca peut rester des semaines sans etre detecte.

### Incident reel (INC-001 — Cathodix, 2026-04-06)

Migration ExcelJS → SheetJS partielle. L'`ExcelService` retournait un workbook vide au lieu d'une erreur. Le frontend avait un fallback silencieux (mode "saisie libre") → les techniciens ne voyaient plus les mesures Excel. `tsc` compilait, les tests passaient, aucune erreur visible. Le bug a ete decouvert par un utilisateur terrain.

**Cause racine** : un `catch` qui retournait `[]` sans logger, dans un service critique.

### Objectif

Detecter automatiquement les catches silencieux dans un projet TypeScript/JavaScript. Signaler les cas suspects avec un niveau de severite. Laisser le developpeur (ou Claude) juger et corriger.

---

## Architecture — ou ca s'integre

### Fichiers existants a modifier

| Fichier | Modification |
|---|---|
| `src/tools/tool-definitions.ts` | Ajouter la definition de l'outil `silent_catch` |
| `src/index.ts` | Ajouter le case `'silent_catch'` dans le switch des outils |

### Fichiers a creer

| Fichier | Role |
|---|---|
| `src/tools/silent-catch.ts` | Logique de detection + formatage du resultat |

### Ce qu'il ne faut PAS modifier

- **Ne pas modifier `base-parser.ts`** — cet outil ne change pas le format FileNode. Il travaille directement avec ts-morph sur les fichiers source, pas sur l'index.
- **Ne pas modifier les autres outils** — `silent_catch` est un outil independant.

---

## Design de l'outil

### Input (arguments MCP)

```typescript
{
  name: 'silent_catch',
  description: 'Detecte les blocs catch qui avalent les erreurs silencieusement — catch vides, return sans log, .catch(() => default). A lancer lors d\'un audit ou apres /review.',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['all', 'critical', 'high'],
        description: 'Filtre par severite minimum. "critical" = catch vides uniquement. "high" = catch sans log. "all" = tout (defaut).',
      },
    },
  },
}
```

- **Pas de `filePath`** : l'outil scanne TOUT le projet (comme `health` et `schema_check`).
- **`severity` optionnel** : permet de filtrer les resultats. Defaut = `'all'`.

### Output

```typescript
export interface SilentCatchIssue {
  /** Severite du probleme */
  severity: 'critical' | 'high' | 'medium';
  /** Chemin du fichier */
  file: string;
  /** Numero de ligne du catch */
  line: number;
  /** Description du probleme */
  message: string;
  /** Code du catch (extrait, max 3 lignes) */
  snippet: string;
}

export interface SilentCatchResult {
  /** Nombre total de try/catch et .catch() analyses */
  totalCatches: number;
  /** Nombre de catches suspects trouves */
  issueCount: number;
  /** Repartition par severite */
  bySeverity: { critical: number; high: number; medium: number };
  /** Liste des catches suspects */
  issues: SilentCatchIssue[];
}
```

### Format de sortie MCP (texte)

```
## Silent Catch — [nom du projet]

**Catches analyses** : 47 | **Suspects** : 5

| Sev | Fichier | Ligne | Probleme |
|-----|---------|-------|----------|
| CRITICAL | src/services/excel.service.ts | 42 | Catch vide — aucun traitement |
| HIGH | src/services/tournees.service.ts | 118 | Return [] sans log |
| MEDIUM | src/utils/analytics.ts | 23 | console.log au lieu de logger.error |

### Detail

**src/services/excel.service.ts:42** (CRITICAL)
```catch {}```
→ Catch completement vide. L'erreur disparait sans trace.

**src/services/tournees.service.ts:118** (HIGH)
```catch (e) { return []; }```
→ Retourne un tableau vide sans logger. Impossible de savoir si c'est "pas de donnees" ou "erreur".
```

---

## Logique de detection

### Approche technique

L'outil utilise **ts-morph** (deja dans les dependencies du projet) pour parser les fichiers TypeScript et analyser l'AST. Il ne passe PAS par l'index CodeGuard — il parse les fichiers source directement.

**Pourquoi pas l'index ?** L'index (FileNode) ne contient pas les blocs try/catch. Il contient les imports, exports, fonctions, types, routes. Ajouter les try/catch dans FileNode alourdirait l'index pour un seul outil. Mieux vaut parser a la demande.

### Etapes

```
1. Lister les fichiers .ts/.tsx du projet (reutiliser le scanner existant)
2. Pour chaque fichier, parser avec ts-morph
3. Trouver tous les CatchClause (try/catch) et CallExpression .catch() (Promises)
4. Pour chaque catch, analyser le corps :
   - Vide ? → CRITICAL
   - Contient un return/valeur par defaut mais pas de log ? → HIGH
   - Contient un console.log mais pas un logger structuré ? → MEDIUM
   - Contient un logger.error/warn ou un throw ? → OK (ignorer)
5. Exclure les fichiers de test (*.test.ts, *.spec.ts, __tests__/)
6. Retourner le resultat trie par severite
```

### Classification detaillee

```typescript
function classifyCatch(catchClause: CatchClause): 'critical' | 'high' | 'medium' | 'ok' {
  const body = catchClause.getBlock();
  const statements = body.getStatements();
  const fullText = body.getText();

  // 1. Catch vide (0 statements ET pas de commentaire justificatif)
  if (statements.length === 0) {
    // Convention : prefixe _ = intentionnel
    const param = catchClause.getVariableDeclaration();
    if (param && param.getName().startsWith('_')) return 'ok';
    // Commentaire dans le catch = intentionnel
    if (body.getLeadingCommentRanges().length > 0 ||
        body.getTrailingCommentRanges().length > 0 ||
        fullText.includes('//') || fullText.includes('/*')) return 'ok';
    return 'critical';
  }

  // 2. Contient un throw → l'erreur est propagee = OK
  if (fullText.includes('throw ')) return 'ok';

  // 3. Contient un logger structure → OK
  const hasStructuredLog = /logger\.(error|warn|fatal)/.test(fullText);
  if (hasStructuredLog) return 'ok';

  // 4. Contient un return de valeur par defaut sans log → HIGH
  const hasReturn = /return\s+(null|undefined|\[\]|\{\}|false|0|''|"")/.test(fullText);
  const hasAnyLog = /logger\.|console\.(error|warn|log)/.test(fullText);
  if (hasReturn && !hasAnyLog) return 'high';

  // 5. Contient console.log (pas un logger structure) → MEDIUM
  const hasConsoleLog = /console\.(log|error|warn)/.test(fullText);
  if (hasConsoleLog && !hasStructuredLog) return 'medium';

  // 6. Parametre catch non utilise
  const param = catchClause.getVariableDeclaration();
  if (param) {
    const paramName = param.getName();
    if (!paramName.startsWith('_')) {
      // Le parametre existe mais est-il utilise dans le body ?
      const bodyWithoutParam = fullText.replace(new RegExp(paramName, 'g'), '');
      if (bodyWithoutParam === fullText) return 'high'; // parametre declare mais jamais utilise
    }
  }

  return 'ok';
}
```

### Detection des .catch() sur les Promises

En plus des `try/catch`, detecter les `.catch()` chaines :

```typescript
// Pattern a detecter :
somePromise.catch(() => [])
somePromise.catch(() => null)
somePromise.catch(() => {})
somePromise.catch((_e) => {}) // OK si prefixe _

// Comment les trouver avec ts-morph :
// 1. Chercher les CallExpression ou l'expression est un PropertyAccessExpression avec le nom "catch"
// 2. Inspecter le callback (premier argument) de la meme maniere que les CatchClause
```

### Fichiers a exclure

```typescript
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
```

Ce pattern est deja utilise dans `health.ts` (lignes 88-100) — reutiliser la meme logique.

---

## Integration dans le projet

### 1. tool-definitions.ts

Ajouter a la fin du tableau `TOOL_DEFINITIONS` :

```typescript
{
  name: 'silent_catch',
  description:
    'Detecte les blocs catch qui avalent les erreurs silencieusement — catch vides, return sans log, .catch(() => default). A lancer lors d\'un audit ou apres /review.',
  inputSchema: {
    type: 'object',
    properties: {
      severity: {
        type: 'string',
        enum: ['all', 'critical', 'high'],
        description:
          'Filtre par severite minimum. "critical" = catch vides uniquement. "high" = catch + return sans log. "all" = tout (defaut).',
      },
    },
  },
},
```

### 2. index.ts

Ajouter l'import :

```typescript
import { runSilentCatch, formatSilentCatchResult } from './tools/silent-catch.js';
```

Ajouter le case dans le switch (apres `changelog`) :

```typescript
case 'silent_catch': {
  const severity = (args?.severity as string) ?? 'all';
  const result = await runSilentCatch(resolvedRoot, severity);
  return {
    content: [{ type: 'text' as const, text: formatSilentCatchResult(result) }],
  };
}
```

**Note** : c'est le seul outil `async` qui ne depend pas de l'index. Il parse les fichiers directement avec ts-morph.

### 3. silent-catch.ts

Creer `src/tools/silent-catch.ts` avec :
- `runSilentCatch(projectRoot: string, severityFilter: string): Promise<SilentCatchResult>`
- `formatSilentCatchResult(result: SilentCatchResult): string`
- Fonctions internes de classification (voir section "Logique de detection")

**Dependencies** : `ts-morph` (deja dans package.json), `scanner.ts` (pour lister les fichiers du projet).

### Utiliser le scanner existant

```typescript
import { scanProjectFiles } from '../utils/scanner.js';

const files = await scanProjectFiles(projectRoot);
const tsFiles = files.filter(f => /\.(ts|tsx)$/.test(f) && !shouldSkipFile(f));
```

Verifier que `scanProjectFiles` est bien exporte dans `src/utils/scanner.ts`. Si ce n'est pas le cas, il faudra l'exporter.

---

## Tests

### Cas de test a couvrir

```typescript
// CRITICAL — catch vide
try { doSomething(); } catch {}
try { doSomething(); } catch (e) {}

// CRITICAL mais OK grace au prefixe _ → ne PAS signaler
try { doSomething(); } catch (_e) {}

// CRITICAL mais OK grace au commentaire → ne PAS signaler
try { doSomething(); } catch {
  // intentionally empty: cleanup failure is non-critical
}

// HIGH — return sans log
try { data = await fetch(); } catch (e) { return []; }
try { data = await fetch(); } catch { return null; }

// HIGH — parametre non utilise
try { doSomething(); } catch (error) { return fallback; }

// MEDIUM — console.log au lieu de logger
try { doSomething(); } catch (e) { console.log(e); return []; }

// OK — logger structure
try { doSomething(); } catch (e) { logger.error('Failed', { error: e }); return []; }

// OK — throw (erreur propagee)
try { doSomething(); } catch (e) { throw new AppError(e); }

// Promise .catch — HIGH
fetchData().catch(() => [])
fetchData().catch(() => null)

// Promise .catch — OK (prefixe _)
fetchData().catch((_e) => {})
```

### Comment tester

Creer un fichier `test/fixtures/silent-catch-samples.ts` avec tous ces cas, puis verifier que l'outil retourne les bonnes severites pour chaque cas.

---

## Limites connues (a documenter dans le README)

| Limite | Explication |
|---|---|
| **Pas de contexte business** | L'outil ne sait pas si un catch est dans un service critique ou non-critique. Il signale tous les catches suspects, le developpeur juge. |
| **Pas de detection des fallbacks implicites** | `data ?? []` ou `data \|\| defaultValue` hors d'un catch ne sont pas detectes. Trop de faux positifs. |
| **Pas de detection des Error Boundaries React** | `componentDidCatch` n'est pas scanne. C'est un pattern React specifique, pas un catch standard. |
| **JavaScript non supporte** | Seuls les fichiers `.ts` et `.tsx` sont scannes (ts-morph). Les `.js` sont ignores. |

---

## Checklist d'implementation

- [ ] Creer `src/tools/silent-catch.ts` avec les types + logique de detection
- [ ] Utiliser `ts-morph` pour parser les fichiers (pas l'index CodeGuard)
- [ ] Classifier : critical (vide), high (return sans log), medium (console.log), ok (logger/throw)
- [ ] Respecter les conventions : prefixe `_`, commentaires = intentionnel
- [ ] Detecter les `.catch()` sur les Promises (pas juste try/catch)
- [ ] Exclure les fichiers de test, scripts, migrations
- [ ] Ajouter la definition dans `tool-definitions.ts`
- [ ] Ajouter le case dans `index.ts`
- [ ] Formater le resultat en markdown (tableau + details)
- [ ] Tester avec des fixtures qui couvrent tous les cas
- [ ] `npm run build` sans erreur
- [ ] Tester l'outil via MCP (comme les autres outils dans `test-mcp.mjs`)
