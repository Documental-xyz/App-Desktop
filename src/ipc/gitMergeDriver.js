/**
 * @fileoverview Custom merge driver implementing -X theirs strategy.
 * Used as the `mergeDriver` option of the provider merge operation.
 * @author Documental Team
 * @since 1.0.0
 */

const path = require('path');
const fs = require('fs');
const diff3Merge = require('diff3');

// Same line-splitting strategy isomorphic-git's built-in mergeFile uses,
// so hunks are identical to the engine's own notion of a conflict.
const LINEBREAKS = /^.*(\r?\n|$)/gm;

/**
 * mergeDriver callback equivalente a `git merge -X ours`.
 * Em hunk conflitante mantém o conteúdo LOCAL; mudanças não-conflitantes
 * do outro lado (outros hunks do mesmo arquivo ou outros arquivos) são
 * preservadas pelo diff3.
 *
 * Contrato isomorphic-git (v1.38.4):
 *   callback recebe { branches: string[], contents: string[], path: string }
 *   contents[0] = base, contents[1] = ours, contents[2] = theirs
 *   retorno: { cleanMerge: boolean, mergedText: string }
 *
 * Semântica (hunk-level, igual ao driver theirs — NÃO é 3-way por linha):
 *   - O mergeDriver só é invocado quando AMBOS os lados alteraram o mesmo
 *     blob; o mergedText retornado substitui o arquivo INTEIRO.
 *   - Por isso "retornar contents[1] puro" descartaria hunks remotos
 *     não-conflitantes. Em vez disso, delegamos o particionamento de
 *     hunks ao diff3 (a mesma biblioteca do engine) e decidimos APENAS
 *     os hunks conflitantes: nosso lado (contents[1]) vence.
 *
 * Casos cobertos:
 *   - Texto em conflito: cleanMerge:true, hunk conflitante = ours
 *   - Modify/delete (ours = ''): mantida a deleção local
 *   - Add/add sem base (contents[0] undefined): base tratada como vazia
 *   - Sem conteúdo ours (contents[1] undefined/null): cleanMerge:false
 *   - Binário (decode UTF-8 lossy, detectado via U+FFFD): cleanMerge:false
 *     → chamador deve capturar MergeConflictError e usar resolveBinaryOurs
 *       como fallback (o iso-git chama o driver ATÉ para binários; sem
 *       esse guard, hunks "resolvidos" corromperiam os bytes)
 *
 * @param {{branches: string[], contents: (string|undefined)[], path: string}} args
 * @returns {{cleanMerge: boolean, mergedText?: string}}
 */
function oursMergeDriver({ branches, contents, path }) {
  if (contents[1] === undefined || contents[1] === null) {
    return { cleanMerge: false };
  }
  // Heurística de binário: o merge engine do iso-git decodifica o blob como
  // UTF-8 com perdas antes de invocar o driver; bytes inválidos viram U+FFFD.
  // Qualquer lado "manglado" indica arquivo binário — merge textual corromperia.
  if (
    contents[1].includes('\uFFFD') ||
    (contents[2] && contents[2].includes('\uFFFD')) ||
    (contents[0] && contents[0].includes('\uFFFD'))
  ) {
    // mergedText obrigatório mesmo em conflito: mergeBlobs do iso-git faz
    // Buffer.from(mergedText) incondicionalmente — sem ele, TypeError em vez
    // do MergeConflictError que o chamador espera capturar.
    return { cleanMerge: false, mergedText: contents[1] };
  }
  const ours = contents[1].match(LINEBREAKS) || [''];
  const base = (contents[0] || '').match(LINEBREAKS) || [''];
  const theirs = (contents[2] || '').match(LINEBREAKS) || [''];

  let mergedText = '';
  for (const item of diff3Merge(ours, base, theirs)) {
    if (item.ok) {
      mergedText += item.ok.join('');
    } else if (item.conflict) {
      mergedText += item.conflict.a.join('');
    }
  }
  return { cleanMerge: true, mergedText };
}

// Marker consultado pelo DugiteProvider para mapear a intenção do driver
// para `git merge -X ours` (contrato de detecção documentado lá).
oursMergeDriver.direction = 'ours';

/**
 * mergeDriver callback equivalente a `git merge -X theirs`.
 * Retorna contents[2] (theirs) sempre que houver conteúdo textual.
 *
 * Contrato isomorphic-git (v1.38.4):
 *   callback recebe { branches: string[], contents: string[], path: string }
 *   branches[0] = base, branches[1] = ours, branches[2+] = theirs
 *   contents[0] = base, contents[1] = ours, contents[2] = theirs
 *   retorno: { cleanMerge: boolean, mergedText: string }
 *
 * Casos cobertos:
 *   - Texto em conflito: cleanMerge:true, mergedText = contents[2] (theirs vence)
 *   - Modify/delete (theirs = ''): mergedText = '' (deleção efetiva)
 *   - Add/add sem base (contents[0] undefined): funciona normalmente com contents[2]
 *   - Binário ou sem ancestor theirs (contents[2] undefined/null): cleanMerge:false
 *     → chamador deve capturar MergeConflictError e usar resolveBinaryTheirs como fallback
 *
 * Observação sobre arquivos binários:
 *   O mergeDriver do isomorphic-git só é invocado para arquivos textuais (o merge
 *   engine decodifica UTF-8 antes de chamar o driver). Arquivos binários em conflito
 *   fazem o merge geral falhar com MergeConflictError ANTES do driver ser chamado,
 *   por isso o fallback resolveBinaryTheirs é necessário no chamador.
 *
 * @param {{branches: string[], contents: (string|undefined)[], path: string}} args
 * @returns {{cleanMerge: boolean, mergedText?: string}}
 */
function theirsMergeDriver({ branches, contents, path }) {
  if (contents[2] === undefined || contents[2] === null) {
    return { cleanMerge: false };
  }
  return { cleanMerge: true, mergedText: contents[2] };
}

/**
 * Fallback para arquivos binários em conflito.
 * Lê o blob do lado theirs (publicador) e grava no working tree + index.
 *
 * Sequência:
 *   1. gitService.readBlob(dir, theirsOid, { filepath }) → bytes do blob no commit theirs
 *   2. fs.writeFileSync(dir/filepath)    → materializa no working tree
 *      (necessário porque git.add exige o arquivo no working tree)
 *   3. gitService.add(dir, filepath)     → hasheia, armazena no object store,
 *                                          e atualiza o index
 *
 * Nota: writeBlob NÃO atualiza working tree nem index, por isso não é usado aqui.
 *       git.add faz tudo (hash + store + index) a partir do arquivo no working tree.
 *
 * @param {import('../git/GitService.js').GitService} gitService - GitService facade
 * @param {string} dir - diretório do repositório (working tree root)
 * @param {string} filepath - caminho do arquivo relativo ao repo
 * @param {string} theirsOid - SHA do commit/tree/blob theirs de onde extrair o blob
 * @returns {Promise<void>}
 * @throws {Error} se theirsOid ou filepath não existirem, ou falha de I/O
 */
async function resolveBinaryTheirs(gitService, dir, filepath, theirsOid) {
  // 1. Lê o blob do lado theirs
  const { blob } = await gitService.readBlob(dir, theirsOid, { filepath });

  // 2. Escreve no working tree (git.add exige arquivo presente no working dir)
  const fullPath = path.join(dir, filepath);
  fs.writeFileSync(fullPath, Buffer.from(blob));

  // 3. Adiciona ao index (hash + object store + index em um passo)
  await gitService.add(dir, filepath);
}

/**
 * Fallback para arquivos binários em conflito, versão OURS.
 * Lê o blob do lado local e grava no working tree + index —
 * espelha resolveBinaryTheirs, invertendo a origem do blob.
 *
 * Sequência:
 *   1. gitService.readBlob(dir, oursOid, { filepath }) → bytes do blob no commit ours
 *   2. fs.writeFileSync(dir/filepath)    → materializa no working tree
 *      (necessário porque git.add exige o arquivo no working tree)
 *   3. gitService.add(dir, filepath)     → hasheia, armazena no object store,
 *                                          e atualiza o index
 *
 * @param {import('../git/GitService.js').GitService} gitService - GitService facade
 * @param {string} dir - diretório do repositório (working tree root)
 * @param {string} filepath - caminho do arquivo relativo ao repo
 * @param {string} oursOid - SHA do commit/tree/blob local de onde extrair o blob
 * @returns {Promise<void>}
 * @throws {Error} se oursOid ou filepath não existirem, ou falha de I/O
 */
async function resolveBinaryOurs(gitService, dir, filepath, oursOid) {
  // 1. Lê o blob do lado ours
  const { blob } = await gitService.readBlob(dir, oursOid, { filepath });

  // 2. Escreve no working tree (git.add exige arquivo presente no working dir)
  const fullPath = path.join(dir, filepath);
  fs.writeFileSync(fullPath, Buffer.from(blob));

  // 3. Adiciona ao index (hash + object store + index em um passo)
  await gitService.add(dir, filepath);
}

module.exports = { theirsMergeDriver, resolveBinaryTheirs, oursMergeDriver, resolveBinaryOurs };
