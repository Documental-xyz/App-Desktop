/**
 * @fileoverview Custom merge driver implementing -X theirs strategy for isomorphic-git
 * @author Documental Team
 * @since 1.0.0
 */

const path = require('path');
const fs = require('fs');

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
 * Sequência (verificada via docs isomorphic-git v1.38.4):
 *   1. readBlob(oid=theirsOid, filepath) → bytes do blob no commit theirs
 *   2. fs.writeFileSync(dir/filepath)    → materializa no working tree
 *      (necessário porque git.add exige o arquivo no working tree)
 *   3. git.add(filepath)                → hasheia, armazena no object store,
 *                                          e atualiza o index
 *
 * Nota: writeBlob NÃO atualiza working tree nem index, por isso não é usado aqui.
 *       git.add faz tudo (hash + store + index) a partir do arquivo no working tree.
 *
 * @param {object} gitMod - instância isomorphic-git (require('isomorphic-git'))
 * @param {object} fsMod - filesystem module (Node fs ou fsClient do isomorphic)
 * @param {string} dir - diretório do repositório (working tree root)
 * @param {string} filepath - caminho do arquivo relativo ao repo
 * @param {string} theirsOid - SHA do commit/tree/blob theirs de onde extrair o blob
 * @returns {Promise<void>}
 * @throws {Error} se theirsOid ou filepath não existirem, ou falha de I/O
 */
async function resolveBinaryTheirs(gitMod, fsMod, dir, filepath, theirsOid) {
  // 1. Lê o blob do lado theirs
  const { blob } = await gitMod.readBlob({
    fs: fsMod,
    dir,
    oid: theirsOid,
    filepath,
  });

  // 2. Escreve no working tree (git.add exige arquivo presente no working dir)
  const fullPath = path.join(dir, filepath);
  fsMod.writeFileSync(fullPath, Buffer.from(blob));

  // 3. Adiciona ao index (hash + object store + index em um passo)
  await gitMod.add({ fs: fsMod, dir, filepath });
}

module.exports = { theirsMergeDriver, resolveBinaryTheirs };
