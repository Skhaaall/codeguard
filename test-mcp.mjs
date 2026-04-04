/**
 * Test du serveur MCP CodeGuard
 * Lance le serveur, envoie des requetes JSON-RPC (NDJSON), verifie les reponses.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SERVER_PATH = resolve('dist/index.js');
const PROJECT_ROOT = resolve('.');

// --- Helpers de test ---

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    testsPassed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    testsFailed++;
  }
}

// --- Lancer le serveur ---

async function runTests() {
  console.log('=== Test MCP CodeGuard ===\n');
  console.log(`Serveur : ${SERVER_PATH}`);
  console.log(`Projet cible : ${PROJECT_ROOT}\n`);

  const server = spawn('node', [SERVER_PATH, PROJECT_ROOT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  const responseQueue = [];
  let resolveWait = null;

  server.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    // NDJSON : chaque ligne est un message JSON complet
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // garder le dernier fragment incomplet
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        responseQueue.push(msg);
        if (resolveWait) resolveWait();
      } catch {
        // pas du JSON, ignorer
      }
    }
  });

  let stderrOutput = '';
  server.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  function send(obj) {
    server.stdin.write(JSON.stringify(obj) + '\n');
  }

  async function waitForResponse(timeoutMs = 15000) {
    const start = Date.now();
    while (responseQueue.length === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout (${timeoutMs}ms) — pas de reponse du serveur`);
      }
      await new Promise((r) => {
        resolveWait = r;
        setTimeout(r, 100);
      });
    }
    return responseQueue.shift();
  }

  try {
    // Attendre que le serveur demarre
    await new Promise((r) => setTimeout(r, 1000));

    // --- Test 1 : Initialize ---
    console.log('--- Test 1 : Initialize ---');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    const initResp = await waitForResponse();
    assert(initResp?.result?.serverInfo?.name === 'skhaall-codeguard', 'Serveur identifie comme "skhaall-codeguard"');
    assert(initResp?.result?.serverInfo?.version === '0.1.0', 'Version 0.1.0');
    assert(initResp?.result?.capabilities?.tools !== undefined, 'Capabilities "tools" presentes');

    // Notification initialized
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 300));

    // --- Test 2 : List Tools ---
    console.log('\n--- Test 2 : List Tools ---');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const listResp = await waitForResponse();
    const tools = listResp?.result?.tools ?? [];
    const toolNames = tools.map((t) => t.name);
    console.log(`  Outils trouves : ${toolNames.join(', ')}`);

    assert(toolNames.includes('impact'), 'Outil "impact" present');
    assert(toolNames.includes('search'), 'Outil "search" present');
    assert(toolNames.includes('reindex'), 'Outil "reindex" present');
    assert(toolNames.includes('status'), 'Outil "status" present');
    assert(toolNames.includes('dependencies'), 'Outil "dependencies" present');
    assert(tools.length === 13, `13 outils exposes (got ${tools.length})`);

    // Verifier les schemas d'input
    const impactTool = tools.find((t) => t.name === 'impact');
    assert(impactTool?.inputSchema?.required?.includes('filePath'), 'impact exige "filePath"');

    const searchTool = tools.find((t) => t.name === 'search');
    assert(searchTool?.inputSchema?.required?.includes('query'), 'search exige "query"');

    // --- Test 3 : Reindex ---
    console.log('\n--- Test 3 : Reindex (indexer CodeGuard lui-meme) ---');
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'reindex', arguments: {} },
    });

    const reindexResp = await waitForResponse(30000);
    const reindexText = reindexResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${reindexText.replace(/\n/g, '\n  ')}`);

    assert(!reindexResp?.result?.isError, 'Reindex sans erreur');
    assert(reindexText.includes('Indexation terminee'), 'Message "Indexation terminee"');

    const fileCountMatch = reindexText.match(/Fichiers indexes\s*:\s*(\d+)/);
    const fileCount = fileCountMatch ? parseInt(fileCountMatch[1], 10) : 0;
    console.log(`  -> ${fileCount} fichiers indexes`);
    assert(fileCount >= 11, `Au moins 11 fichiers indexes (got ${fileCount})`);

    const edgeMatch = reindexText.match(/Aretes.*:\s*(\d+)/);
    const edgeCount = edgeMatch ? parseInt(edgeMatch[1], 10) : 0;
    assert(edgeCount > 0, `Aretes > 0 (graphe non vide, got ${edgeCount})`);

    // --- Test 4 : Status ---
    console.log('\n--- Test 4 : Status ---');
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    });

    const statusResp = await waitForResponse();
    const statusText = statusResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${statusText.replace(/\n/g, '\n  ')}`);

    assert(!statusResp?.result?.isError, 'Status sans erreur');
    assert(statusText.includes('CodeGuard'), 'Contient "CodeGuard"');
    assert(statusText.includes(`${fileCount}`), 'Nombre de fichiers coherent avec reindex');

    // --- Test 5 : Impact sur base-parser.ts (fichier tres importe) ---
    console.log('\n--- Test 5 : Impact (base-parser.ts — fichier partage) ---');
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'impact', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const impactResp = await waitForResponse();
    const impactText = impactResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${impactText.replace(/\n/g, '\n  ')}`);

    assert(!impactResp?.result?.isError, 'Impact sans erreur');
    assert(impactText.includes('Risque'), 'Score de risque affiche');

    // base-parser exporte FileNode qui est utilise partout — on attend des dependants
    const hasDirectDeps = impactText.includes('Dependants directs');
    assert(hasDirectDeps, 'Dependants directs listes');

    // Verifier que des fichiers connus apparaissent
    const mentionsParser = impactText.includes('typescript-parser');
    const mentionsStore = impactText.includes('index-store');
    const mentionsImpact = impactText.includes('impact-resolver');
    assert(mentionsParser || mentionsStore || mentionsImpact,
      'Dependants connus detectes (ts-parser, store, ou impact-resolver)');

    // --- Test 6 : Impact sur index.ts (point d'entree — personne ne l'importe) ---
    console.log('\n--- Test 6 : Impact (index.ts — entry point) ---');
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'impact', arguments: { filePath: 'src/index.ts' } },
    });

    const impact2Resp = await waitForResponse();
    const impact2Text = impact2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${impact2Text.replace(/\n/g, '\n  ')}`);

    assert(!impact2Resp?.result?.isError, 'Impact index.ts sans erreur');
    // Personne n'importe index.ts — impact devrait etre faible
    const impact2Count = impact2Text.match(/Fichiers impactes\D*(\d+)/);
    const indexImpactCount = impact2Count ? parseInt(impact2Count[1], 10) : -1;
    assert(indexImpactCount === 0, `index.ts: 0 fichier impacte attendu (got ${indexImpactCount})`);

    // --- Test 7 : Search "FileNode" (symbole tres utilise) ---
    console.log('\n--- Test 7 : Search "FileNode" ---');
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'FileNode' } },
    });

    const search1Resp = await waitForResponse();
    const search1Text = search1Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${search1Text.replace(/\n/g, '\n  ')}`);

    assert(!search1Resp?.result?.isError, 'Search FileNode sans erreur');
    assert(search1Text.includes('FileNode'), 'Trouve "FileNode"');

    const search1CountMatch = search1Text.match(/(\d+)\s*resultats?/);
    const search1Count = search1CountMatch ? parseInt(search1CountMatch[1], 10) : 0;
    assert(search1Count >= 3, `Au moins 3 resultats pour FileNode (got ${search1Count})`);

    // Verifier que la definition ET les imports sont trouves
    assert(search1Text.includes('base-parser'), 'Definition dans base-parser trouvee');

    // --- Test 8 : Search "DependencyGraph" ---
    console.log('\n--- Test 8 : Search "DependencyGraph" ---');
    send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'DependencyGraph' } },
    });

    const search2Resp = await waitForResponse();
    const search2Text = search2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${search2Text.replace(/\n/g, '\n  ')}`);

    assert(!search2Resp?.result?.isError, 'Search DependencyGraph sans erreur');
    assert(search2Text.includes('dependency-graph'), 'Trouve dans dependency-graph.ts');

    // --- Test 9 : Dependencies de index.ts ---
    console.log('\n--- Test 9 : Dependencies (index.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'dependencies', arguments: { filePath: 'src/index.ts' } },
    });

    const depsResp = await waitForResponse();
    const depsText = depsResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${depsText.replace(/\n/g, '\n  ')}`);

    assert(!depsResp?.result?.isError, 'Dependencies sans erreur');
    assert(depsText.includes('depend de'), 'Section "depend de" presente');

    // index.ts importe : typescript-parser, index-store, scanner, logger, impact, search, dependency-graph
    const expectedDeps = ['typescript-parser', 'index-store', 'scanner', 'logger', 'impact', 'search', 'dependency-graph'];
    let foundDeps = 0;
    for (const dep of expectedDeps) {
      if (depsText.includes(dep)) foundDeps++;
    }
    assert(foundDeps >= 5, `Au moins 5/7 dependances de index.ts detectees (got ${foundDeps}/7)`);

    // index.ts n'est importe par personne
    const usedByMatch = depsText.match(/Utilise par \((\d+)\)/);
    const usedByCount = usedByMatch ? parseInt(usedByMatch[1], 10) : -1;
    assert(usedByCount === 0, `index.ts utilise par 0 fichier (got ${usedByCount})`);

    // --- Test 10 : Dependencies de base-parser.ts (beaucoup de dependants) ---
    console.log('\n--- Test 10 : Dependencies (base-parser.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'dependencies', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const deps2Resp = await waitForResponse();
    const deps2Text = deps2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${deps2Text.replace(/\n/g, '\n  ')}`);

    assert(!deps2Resp?.result?.isError, 'Dependencies base-parser sans erreur');

    const usedBy2Match = deps2Text.match(/Utilise par \((\d+)\)/);
    const usedBy2Count = usedBy2Match ? parseInt(usedBy2Match[1], 10) : 0;
    assert(usedBy2Count >= 3, `base-parser utilise par au moins 3 fichiers (got ${usedBy2Count})`);

    // --- Test 11 : Fichier inexistant (robustesse) ---
    console.log('\n--- Test 11 : Impact sur fichier inexistant ---');
    send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'impact', arguments: { filePath: 'src/nope/fantome.ts' } },
    });

    const errResp = await waitForResponse();
    assert(errResp?.result !== undefined, 'Pas de crash sur fichier inexistant');
    // On accepte une erreur gracieuse ou un resultat vide
    console.log(`  Reponse : ${errResp?.result?.content?.[0]?.text?.slice(0, 100) ?? 'aucune'}`);

    // --- Test 12 : Search sans resultat ---
    console.log('\n--- Test 12 : Search sans resultat ---');
    send({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'ZzzNonExistent999XyzAbc' } },
    });

    const noResp = await waitForResponse();
    const noText = noResp?.result?.content?.[0]?.text ?? '';
    console.log(`  Reponse : ${noText}`);

    assert(!noResp?.result?.isError, 'Search vide sans erreur');
    assert(noText.includes('Aucun resultat'), '"Aucun resultat" affiche');

    // --- Test 13 : Outil inexistant ---
    console.log('\n--- Test 13 : Outil inexistant ---');
    send({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'nope_pas_un_outil', arguments: {} },
    });

    const unknownResp = await waitForResponse();
    const unknownText = unknownResp?.result?.content?.[0]?.text ?? '';
    console.log(`  Reponse : ${unknownText}`);
    assert(unknownResp?.result?.isError === true, 'Outil inconnu retourne isError: true');

    // --- Test 14 : Guard sur base-parser.ts (fichier partage = risques) ---
    console.log('\n--- Test 14 : Guard (base-parser.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'guard', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const guardResp = await waitForResponse();
    const guardText = guardResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${guardText.replace(/\n/g, '\n  ')}`);

    assert(!guardResp?.result?.isError, 'Guard sans erreur');
    assert(guardText.includes('Guard'), 'Contient "Guard"');
    assert(guardText.includes('Risque'), 'Affiche le risque');
    assert(guardText.includes('Avertissements') || guardText.includes('Exports'), 'Contient des details');
    // base-parser a beaucoup d'exports — devrait les lister
    assert(guardText.includes('FileNode'), 'Liste FileNode dans les exports');
    // base-parser a 4+ dependants directs — devrait les lister pour verification
    assert(guardText.includes('verifier apres') || guardText.includes('Fichiers'), 'Liste les fichiers a verifier');

    // --- Test 15 : Guard sur index.ts (entry point = faible risque) ---
    console.log('\n--- Test 15 : Guard (index.ts — faible risque) ---');
    send({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'guard', arguments: { filePath: 'src/index.ts' } },
    });

    const guard2Resp = await waitForResponse();
    const guard2Text = guard2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${guard2Text.replace(/\n/g, '\n  ')}`);

    assert(!guard2Resp?.result?.isError, 'Guard index.ts sans erreur');
    assert(guard2Text.includes('OK'), 'index.ts = OK (safe)');

    // --- Test 16 : Check sur base-parser.ts (pas de modification = pas de probleme) ---
    console.log('\n--- Test 16 : Check (base-parser.ts — aucune modification) ---');
    send({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'check', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const checkResp = await waitForResponse(15000);
    const checkText = checkResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${checkText.replace(/\n/g, '\n  ')}`);

    assert(!checkResp?.result?.isError, 'Check sans erreur');
    assert(checkText.includes('Check'), 'Contient "Check"');
    assert(checkText.includes('Re-indexe') && checkText.includes('oui'), 'Fichier re-indexe avec succes');
    // Pas de modification → pas de probleme
    assert(checkText.includes('OK') || checkText.includes('Aucun probleme'), 'Aucun probleme detecte (fichier inchange)');

    // --- Test 17 : Check sur logger.ts (fichier simple) ---
    console.log('\n--- Test 17 : Check (logger.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: { name: 'check', arguments: { filePath: 'src/utils/logger.ts' } },
    });

    const check2Resp = await waitForResponse(15000);
    const check2Text = check2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${check2Text.replace(/\n/g, '\n  ')}`);

    assert(!check2Resp?.result?.isError, 'Check logger.ts sans erreur');
    assert(check2Text.includes('Re-indexe'), 'Re-indexation mentionnee');

    // --- Test 18 : Health ---
    console.log('\n--- Test 18 : Health (score de sante) ---');
    send({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'health', arguments: {} },
    });

    const healthResp = await waitForResponse();
    const healthText = healthResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${healthText.replace(/\n/g, '\n  ')}`);

    assert(!healthResp?.result?.isError, 'Health sans erreur');
    assert(healthText.includes('Health'), 'Contient "Health"');
    assert(/[ABCDF]/.test(healthText), 'Note affichee (A-F)');
    assert(healthText.includes('/100'), 'Score sur 100');
    assert(healthText.includes('Metriques'), 'Section metriques presente');
    assert(healthText.includes('Imports casses'), 'Metrique imports casses');
    assert(healthText.includes('Dependances circulaires'), 'Metrique dependances circulaires');

    // --- Test 19 : Regression map sur base-parser.ts ---
    console.log('\n--- Test 19 : Regression Map (base-parser.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: { name: 'regression_map', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const regResp = await waitForResponse();
    const regText = regResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${regText.replace(/\n/g, '\n  ')}`);

    assert(!regResp?.result?.isError, 'Regression map sans erreur');
    assert(regText.includes('Regression Map'), 'Contient "Regression Map"');
    assert(regText.includes('retester'), 'Contient "retester"');

    // --- Test 20 : Regression map sur index.ts (entry point, 0 cibles) ---
    console.log('\n--- Test 20 : Regression Map (index.ts — aucune cible) ---');
    send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'regression_map', arguments: { filePath: 'src/index.ts' } },
    });

    const reg2Resp = await waitForResponse();
    const reg2Text = reg2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${reg2Text.replace(/\n/g, '\n  ')}`);

    assert(!reg2Resp?.result?.isError, 'Regression map index.ts sans erreur');

    // --- Test 21 : Graph complet ---
    console.log('\n--- Test 21 : Graph (complet) ---');
    send({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'graph', arguments: {} },
    });

    const graphResp = await waitForResponse();
    const graphText = graphResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${graphText.split('\n').slice(0, 5).join('\n  ')}...`);

    assert(!graphResp?.result?.isError, 'Graph complet sans erreur');
    assert(graphText.includes('mermaid'), 'Contient un bloc mermaid');
    assert(graphText.includes('graph LR'), 'Diagramme Mermaid valide');
    assert(graphText.includes('-->'), 'Contient des aretes');
    assert(graphText.includes('classDef'), 'Contient des styles');

    // --- Test 22 : Graph focus ---
    console.log('\n--- Test 22 : Graph (focus base-parser.ts) ---');
    send({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'graph', arguments: { filePath: 'src/parsers/base-parser.ts' } },
    });

    const graph2Resp = await waitForResponse();
    const graph2Text = graph2Resp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${graph2Text.split('\n').slice(0, 5).join('\n  ')}...`);

    assert(!graph2Resp?.result?.isError, 'Graph focus sans erreur');
    assert(graph2Text.includes('focus'), 'Mode focus indique');
    assert(graph2Text.includes('fill:#ff6b6b'), 'Fichier focus en rouge');

    // --- Test 23 : Reindex incremental ---
    console.log('\n--- Test 23 : Reindex incremental ---');
    send({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'reindex', arguments: { incremental: true } },
    });

    const incrResp = await waitForResponse(30000);
    const incrText = incrResp?.result?.content?.[0]?.text ?? '';
    console.log(`  ${incrText.replace(/\n/g, '\n  ')}`);

    assert(!incrResp?.result?.isError, 'Reindex incremental sans erreur');
    assert(incrText.includes('incremental'), 'Mode incremental indique');
    assert(incrText.includes('Inchanges'), 'Affiche les fichiers inchanges');

    // --- Test 24 : Verification tools/list inclut les 10 outils ---
    console.log('\n--- Test 24 : List Tools (10 outils) ---');
    send({ jsonrpc: '2.0', id: 24, method: 'tools/list', params: {} });

    const list2Resp = await waitForResponse();
    const tools2 = list2Resp?.result?.tools ?? [];
    const toolNames2 = tools2.map((t) => t.name);
    console.log(`  Outils : ${toolNames2.join(', ')}`);

    assert(tools2.length === 13, `13 outils exposes (got ${tools2.length})`);
    assert(toolNames2.includes('graph'), '"graph" present');

    // --- Test 25 : Pas de stderr (regle MCP critique) ---
    console.log('\n--- Test 25 : Zero stderr ---');
    assert(stderrOutput.trim() === '', `Aucune sortie stderr (got ${stderrOutput.length} bytes)`);

    // --- Resume ---
    console.log('\n========================================');
    console.log(`  RESULTATS : ${testsPassed} PASS / ${testsFailed} FAIL`);
    console.log('========================================\n');

  } catch (error) {
    console.error(`\nERREUR FATALE : ${error.message}\n`);
    testsFailed++;
    console.log(`\n  RESULTATS PARTIELS : ${testsPassed} PASS / ${testsFailed} FAIL\n`);
  } finally {
    server.kill('SIGTERM');
    process.exit(testsFailed > 0 ? 1 : 0);
  }
}

runTests();
