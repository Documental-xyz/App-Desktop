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
 * Espelha oursMergeDriver: particionamento de hunks via diff3, decidindo
 * APENAS os hunks conflitantes pelo lado theirs.
 *
 * Contrato isomorphic-git (v1.38.4):
 *   callback recebe { branches: string[], contents: string[], path: string }
 *   branches[0] = base, branches[1] = ours, branches[2+] = theirs
 *   contents[0] = base, contents[1] = ours, contents[2] = theirs
 *   retorno: { cleanMerge: boolean, mergedText: string }
 *
 * Semântica (hunk-level — igual ao oursMergeDriver e ao `-X theirs`
 * nativo do dugite; NÃO é substituição arquivo-inteiro):
 *   - Retornar contents[2] puro descartaria hunks OURS não-conflitantes
 *     do mesmo arquivo. Em vez disso, o diff3 particiona os hunks e só
 *     os CONFLITANTES são resolvidos pelo theirs (contents[2]).
 *
 * Casos cobertos:
 *   - Texto em conflito: cleanMerge:true, hunk conflitante = theirs
 *   - Modify/delete (theirs = ''): mergedText = '' (deleção efetiva)
 *   - Add/add sem base (contents[0] undefined): base tratada como vazia
 *   - Sem conteúdo theirs (contents[2] undefined/null): cleanMerge:false
 *   - Binário (decode UTF-8 lossy, detectado via U+FFFD): cleanMerge:false
 *     com mergedText obrigatório (mergeBlobs faz Buffer.from incondicional)
 *     → chamador deve capturar MergeConflictError e usar resolveBinaryTheirs
 *       como fallback
 *
 * @param {{branches: string[], contents: (string|undefined)[], path: string}} args
 * @returns {{cleanMerge: boolean, mergedText?: string}}
 */
function theirsMergeDriver({ branches, contents, path }) {
  if (contents[2] === undefined || contents[2] === null) {
    return { cleanMerge: false };
  }
  // Heurística de binário — mesma do oursMergeDriver (ver lá).
  if (
    contents[2].includes('\uFFFD') ||
    (contents[1] && contents[1].includes('\uFFFD')) ||
    (contents[0] && contents[0].includes('\uFFFD'))
  ) {
    return { cleanMerge: false, mergedText: contents[2] };
  }
  const ours = (contents[1] || '').match(LINEBREAKS) || [''];
  const base = (contents[0] || '').match(LINEBREAKS) || [''];
  const theirs = contents[2].match(LINEBREAKS) || [''];

  let mergedText = '';
  for (const item of diff3Merge(ours, base, theirs)) {
    if (item.ok) {
      mergedText += item.ok.join('');
    } else if (item.conflict) {
      mergedText += item.conflict.b.join('');
    }
  }
  return { cleanMerge: true, mergedText };
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

/**
 * mergeDriver callback FULL-LOCAL (decisão de produto 2026-08-25:
 * "total local" do modal de estratégia de conflito).
 *
 * SEMÂNTICA EXATA (JSDoc obrigatório — leitura confirmada com o usuário):
 *   "Full" = prioridade TOTAL do lado local, mas mudanças NÃO-conflitantes
 *   do outro lado continuam entrando no merge. Só os HUNKS/ARQUIVOS
 *   conflitantes é que viram integrais do lado vencedor.
 *
 *   Por isso o driver NÃO retorna contents[1] puro (substituição
 *   arquivo-inteiro): isso descartaria hunks remotos não-conflitantes do
 *   MESMO arquivo (ex.: linha 2 conflita, linha 6 editada só pelo remoto —
 *   a linha 6 deve sobreviver). O particionamento de hunks é delegado ao
 *   diff3 (mesma lib do engine) e APENAS os hunks conflitantes são
 *   decididos: lado local integral.
 *
 *   Consequência honesta: para ARQUIVOS DE TEXTO o resultado é idêntico ao
 *   oursMergeDriver (por-hunk) — a semântica "full" do usuário COINCIDE com
 *   `-X ours` no nível de hunk. Os drivers seguem separados porque são
 *   INTENÇÕES de produto distintas (markers `direction` diferentes para o
 *   DugiteProvider) e podem divergir no futuro (ex.: binários, add/add).
 *
 * Contrato isomorphic-git (v1.38.4): idem oursMergeDriver —
 *   contents[0]=base, contents[1]=ours, contents[2]=theirs;
 *   retorno { cleanMerge, mergedText }.
 *
 * Casos cobertos (espelham oursMergeDriver):
 *   - Texto em conflito: cleanMerge:true, hunk conflitante = local
 *   - Modify/delete: mantida a versão local
 *   - Add/add sem base: base tratada como vazia
 *   - Sem contents[1]: cleanMerge:false
 *   - Binário (U+FFFD): cleanMerge:false + mergedText obrigatório
 *     → chamador usa resolveBinaryFullLocal como fallback
 *
 * @param {{branches: string[], contents: (string|undefined)[], path: string}} args
 * @returns {{cleanMerge: boolean, mergedText?: string}}
 */
function fullLocalMergeDriver(args) {
  return oursMergeDriver(args);
}

// Marker consultado pelo DugiteProvider.mergeDriverFavor: full-local é
// traduzido para `git merge -X ours` (por-hunk; ver JSDoc acima). NÃO usar
// `-s ours`: a strategy ours do git descarta o remoto INTEIRO (todos os
// arquivos, incluindo não-conflitantes) — semântica proibida pelo usuário.
fullLocalMergeDriver.direction = 'full-local';

/**
 * mergeDriver callback FULL-REMOTE — espelha fullLocalMergeDriver para o
 * lado remoto (prioridade total remota nos hunks conflitantes; hunks
 * locais não-conflitantes preservados).
 *
 * Semântica exata e equivalência com `-X theirs`: ver fullLocalMergeDriver.
 * Não existe `-s theirs` nativo no git; NÃO usar `checkout --theirs` pós
 * merge conflitado: substituiria arquivos inteiros e descartaria hunks
 * locais não-conflitantes do mesmo arquivo — a camada JS (diff3) entrega
 * exatamente a semântica pedida.
 *
 * @param {{branches: string[], contents: (string|undefined)[], path: string}} args
 * @returns {{cleanMerge: boolean, mergedText?: string}}
 */
function fullRemoteMergeDriver(args) {
  return theirsMergeDriver(args);
}

fullRemoteMergeDriver.direction = 'full-remote';

/**
 * Fallback binário FULL-LOCAL: mesmo comportamento de resolveBinaryOurs
 * (blob local integral no working tree + index). Separado por paridade de
 * nome com fullLocalMergeDriver; semântica idêntica — binário não tem
 * hunk, "full" é a ÚNICA forma de decidir local vs remoto.
 *
 * @param {import('../git/GitService.js').GitService} gitService - GitService facade
 * @param {string} dir - diretório do repositório (working tree root)
 * @param {string} filepath - caminho do arquivo relativo ao repo
 * @param {string} oursOid - SHA do commit/tree/blob local de onde extrair o blob
 * @returns {Promise<void>}
 * @throws {Error} se oursOid ou filepath não existirem, ou falha de I/O
 */
async function resolveBinaryFullLocal(gitService, dir, filepath, oursOid) {
  return resolveBinaryOurs(gitService, dir, filepath, oursOid);
}

/**
 * Fallback binário FULL-REMOTE: mesmo comportamento de resolveBinaryTheirs
 * (blob remoto integral no working tree + index).
 *
 * @param {import('../git/GitService.js').GitService} gitService - GitService facade
 * @param {string} dir - diretório do repositório (working tree root)
 * @param {string} filepath - caminho do arquivo relativo ao repo
 * @param {string} theirsOid - SHA do commit/tree/blob theirs de onde extrair o blob
 * @returns {Promise<void>}
 * @throws {Error} se theirsOid ou filepath não existirem, ou falha de I/O
 */
async function resolveBinaryFullRemote(gitService, dir, filepath, theirsOid) {
  return resolveBinaryTheirs(gitService, dir, filepath, theirsOid);
}

module.exports = {
  theirsMergeDriver,
  resolveBinaryTheirs,
  oursMergeDriver,
  resolveBinaryOurs,
  fullLocalMergeDriver,
  resolveBinaryFullLocal,
  fullRemoteMergeDriver,
  resolveBinaryFullRemote,
};
