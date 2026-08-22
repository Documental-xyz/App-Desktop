# PRD — Migração de `isomorphic-git` para `dugite` + `dugite-native` (revisto)

**Status:** Proposto (revisto contra a realidade do código em 2026-08-22)
**Estratégia:** Migração gradual com fallback via `GIT_PROVIDER`
**Plataformas atuais:** Windows x64, macOS x64, Linux x64 (ARM64 = fase futura, fora do escopo inicial)
**Empacotamento:** Electron + electron-builder (`electron-builder.yml`)
**Configuração:** `GIT_PROVIDER` (novo mecanismo a ser criado — ver §12)
**Provider atual:** `isomorphic-git@1.38.4`
**Provider alvo:** `dugite@^3.2.3`

---

## 0. Registro da revisão — o que mudou neste documento

Esta revisão corrige o PRD original com base na análise do código atual e em verificação das fontes oficiais do dugite/dugite-native. Correções principais:

| # | Ponto original | Correção aplicada |
|---|---------------|-------------------|
| 1 | Interface `GitProvider` com 10 operações genéricas | O app usa **~24 operações** reais, incluindo `statusMatrix`, `fastForward`/`canFastForward`, `writeRef`, `resolveRef`, `readCommit`, `readBlob`, `merge` com driver customizado, `deleteBranch`, `getConfig`/`setConfig`, `listBranches`/`listRefs`, `getRemoteInfo`, `listServerRefs`, clone raso (`singleBranch`, `depth: 1`). Interface redesenhada (§6). |
| 2 | Validação de SSH, GitLab, servidor privado | O app autentica **exclusivamente via GitHub OAuth token** (`{username: token, password: 'x-oauth-basic'}`) e o token só é anexado para URLs `github.com`. SSH/GitLab/servidor privado **não existem no produto** e saem do escopo obrigatório (§24). |
| 3 | Matriz com 6 targets incluindo ARM64 | O produto hoje é **x64-only**: Linux (AppImage/deb), Windows (NSIS/portable), macOS (dmg/zip). ARM64 é marcado como fase futura (§35). |
| 4 | "`dugite-native` como dependência/toolchain no build" | `dugite-native` **não é pacote npm** — o Git é baixado pelo `postinstall` do dugite a partir de GitHub Releases (tarballs sha256-verificados) para `node_modules/dugite/git/`. Não há integração de toolchain a construir; há requisitos de CI/offline a respeitar (§9, §10). |
| 5 | Empacotamento descrito genericamente (Builder/Forge) | O app usa **electron-builder** com `electron-builder.yml` existente. Correção: `asarUnpack` para `node_modules/dugite/git/**/*` + limpeza de entrada stale (`keytar`) (§21). |
| 6 | `GIT_PROVIDER` como env var simples | Não existe mecanismo de feature flag no app. O padrão existente é `runtime-env.json` (build-time → `resources/config/`) com loader em `src/config/github-config.js` — é esse mecanismo que deve ser estendido, e o valor precisa ser lido **em runtime no main process**, não só em `.env` (§12). |
| 7 | Workflow GitHub Actions genérico a criar | Já existe **um único workflow**: `.github/workflows/release.yml` (tag `v*` / manual, matriz windows/ubuntu/macos, job `prepare` para draft release). Os testes Vitest **não rodam no CI hoje**. O PRD passa a exigir adaptação do `release.yml`, não criação do zero (§17). |
| 8 | Exemplo `exec` do dugite | Confirmado correto para dugite v3 (`exec(args, path, options)`; exit code ≠ 0 **não lança exceção** — é preciso checar `result.exitCode`). A API antiga `GitProcess` foi removida na v3 e não deve aparecer (§8). |
| 9 | Sem menção a cancelamento | `isomorphic-git` honra `AbortSignal` nas operações de rede; o dugite `exec` também aceita `signal` (kill do processo). O layer de timeouts existente (`src/ipc/gitFlowTypes.js`, `_raceTimeout` em `git.js`) deve ficar **acima** da abstração (§26). |
| 10 | Sem menção ao merge driver customizado | `src/ipc/gitMergeDriver.js` (merge `-X theirs` manual via `readBlob`+`add`) torna-se **código morto** com dugite (`git merge -X theirs` nativo) (§6.2). |
| 11 | Licenciamento genérico | Git bundled = **GPLv2**; `dugite-native` também embute **Git LFS** e **Git Credential Manager (GCM)**, que têm termos próprios. Obrigações de notice detalhadas (§39). |

---

## 1. Resumo executivo

O aplicativo (Electron + electron-builder) usa `isomorphic-git@1.38.4` diretamente em ~7 módulos do main process, com problemas de confiabilidade em `push` (timeouts — hoje mitigados com retry exponencial em `src/ipc/gitOperations.js`). Será criada uma abstração `GitProvider` cobrindo as operações **realmente usadas**, mantendo `isomorphic-git` como provider padrão durante a migração e adicionando `DugiteProvider` selecionável por `GIT_PROVIDER`.

O Git nativo vem do `postinstall` do dugite (tarballs `dugite-native` por plataforma, verificados por sha256) e é empacotado **fora do ASAR** via `asarUnpack`/`extraResources`. O usuário não instala Git nem executa npm.

```text
                         GitProvider
                             │
                 ┌───────────┴───────────┐
                 ▼                       ▼
        IsomorphicGitProvider       DugiteProvider
                 │                       │
                 ▼                       ▼
          isomorphic-git          dugite (exec/spawn)
                                         │
                                         ▼
                              Git bundled (node_modules/dugite/git)
                                         │
                              tarballs dugite-native (GitHub Releases)
```

---

## 2. Problema

A implementação atual acopla ~7 módulos diretamente a `isomorphic-git` (sem fachada): `src/ipc/git.js` (~50 call sites), `gitOperations.js`, `gitPreflight.js`, `gitSafety.js`, `gitMergeDriver.js`, `projects.js`, `projectCreation.js`. Sintomas:

* timeouts em `push` (constantes em `gitFlowTypes.js`: fetch 30s, merge 45s, push 60s, checkout 20s; lock 120s);
* workarounds acumulados: retry de push com backoff exponencial e classificação de erros, race de mkdir no clone, retry de checkout não-recursivo, polling de "repo readiness";
* comentário no código acknowledges que `AbortSignal` é ignorado pelo isomorphic-git em operações locais.

Além disso, o app deve funcionar em máquinas sem Git instalado/fora do `PATH`, offline na instalação e sem permissão para instalar software — instalar Git como pré-requisito não é solução.

---

## 3. Objetivos

1. Criar abstração `GitProvider` cobrindo as ~24 operações inventariadas em §6.
2. Encapsular `isomorphic-git` em `IsomorphicGitProvider` **sem alterar comportamento** (strangler pattern).
3. Adicionar `DugiteProvider` com Git bundled (dugite + tarballs dugite-native).
4. Mecanismo `GIT_PROVIDER` (runtime, via extensão do padrão `runtime-env.json`).
5. Adaptar `electron-builder.yml` e `release.yml` para empacotar e validar o Git bundled.
6. Suíte de testes comum aos dois providers (Vitest já existente).
7. Benchmark comparativo focado em `push` (motivador principal).
8. Rollback imediato (`GIT_PROVIDER=isomorphic-git`).
9. Migração definitiva só após critérios de §34.

## 4. Não objetivos

* Remover `isomorphic-git` imediatamente.
* Alterar servidor Git / formato de repositórios / fluxo OAuth atual.
* Suportar SSH, GitLab ou servidores Git privados **nesta etapa** (não usados pelo produto).
* Recompilar manualmente o Git (os tarballs `dugite-native` prontos são usados).
* Builds ARM64 (x64-only hoje; ARM64 fica como fase futura condicionada à matriz oficial do produto).
* Instalar Git ou npm na máquina do usuário.

---

## 5. Arquitetura proposta

```text
Application (main process, src/ipc/*)
        │
        ▼
   GitService  (fachada única — novo)
        │
        ▼
   GitProvider (interface)
        │
        ├── IsomorphicGitProvider ── isomorphic-git (+ http/node)
        │
        └── DugiteProvider ── dugite exec/spawn ── Git bundled (GitRuntime)
```

Nenhum módulo fora de `src/git/` poderá fazer `require('isomorphic-git')` ou `require('dugite')`. Hoje o require está espalhado por 7 arquivos — a Fase 1 os migra incrementalmente para a fachada.

---

## 6. Interface `GitProvider` (baseada no inventário real)

### 6.1 Operações inventariadas no código atual

**Rede:** `clone` (com `noCheckout`), `fetch` (sempre rasa: `singleBranch: true, depth: 1`), `pull` (fallback), `push`, `getRemoteInfo`, `listServerRefs`
**Escrita local:** `add`, `remove`, `commit`, `branch`, `deleteBranch`, `checkout`, `merge` (com estratégia customizável), `fastForward`, `writeRef`
**Leitura/status:** `statusMatrix`, `status`, `currentBranch`, `listBranches`, `listRefs`, `resolveRef`, `readCommit`, `readBlob`, `getConfig`, `setConfig`

### 6.2 Forma alvo da interface

```ts
export interface GitProvider {
  // rede
  clone(url, path, opts?: { noCheckout?, singleBranch?, depth?, auth? }): Promise<void>
  fetch(path, opts?: { singleBranch?, depth?, refspec?, auth?, signal? }): Promise<FetchResult>
  pull(path, opts?: { fastForwardOnly?, auth?, signal? }): Promise<void>
  push(path, opts?: { remote?, branch?, force?, auth?, signal? }): Promise<void>
  getRemoteInfo(url, opts?: { auth? }): Promise<RemoteInfo>
  listServerRefs(url, opts?: { auth? }): Promise<Ref[]>

  // escrita local
  add(path, files: string[]): Promise<void>
  remove(path, files: string[]): Promise<void>
  commit(path, message, opts?: { author? }): Promise<CommitOid>
  branch(path, name, opts?: { checkout?, from? }): Promise<void>
  deleteBranch(path, name): Promise<void>
  checkout(path, ref, opts?: { createBranch? }): Promise<void>
  merge(path, theirRef, opts?: { strategy?: 'theirs' | 'ours' | 'ort', signal? }): Promise<MergeResult>
  fastForward(path, opts?: { ref?, auth?, signal? }): Promise<boolean>
  writeRef(path, ref, oid): Promise<void>

  // leitura/status
  statusMatrix(path): Promise<StatusRow[]>
  currentBranch(path): Promise<string | null>
  listBranches(path): Promise<BranchInfo[]>
  listRefs(path): Promise<Ref[]>
  resolveRef(path, ref): Promise<string>
  readCommit(path, oid): Promise<CommitObject>
  readBlob(path, oid): Promise<Blob>
  getConfig(path, key): Promise<string | null>
  setConfig(path, key, value): Promise<void>
}
```

### 6.3 Notas de mapeamento dugite

* `statusMatrix` → `git status --porcelain=v2 -z --branch` (atenção: semântica de rename detection difere; a suíte comum deve fixar os casos usados pelo app).
* `merge` com driver custom (`gitMergeDriver.js`) → `git merge -X theirs` nativo; **o módulo `gitMergeDriver.js` torna-se código morto e será removido na Fase 7**.
* `canFastForward` pode ser derivado de `git rev-list --count` ou `git merge-base` nos dois providers.
* `auth` nos dois providers representa apenas `{ token: string }` (GitHub PAT/OAuth); ver §24.

---

## 7. Provider atual — `IsomorphicGitProvider`

Criar `src/git/providers/IsomorphicGitProvider.ts` movendo a lógica existente **sem alterações de comportamento**, preservando: `onAuth` com `{username: token, password: 'x-oauth-basic'}`, transporte `isomorphic-git/http/node`, semântica de shallow fetch. Regra da Fase 1: refatoração pura, zero mudança de comportamento, testes existentes (`tests/ipc/git*.test.js` ~20 arquivos) devem passar sem alteração de assertions.

## 8. Novo `DugiteProvider`

```ts
import { exec } from 'dugite'

const result = await exec(['push', remote, branch], repoPath, { signal })
if (result.exitCode !== 0) {
  throw new GitError({ operation: 'push', provider: 'dugite', exitCode: result.exitCode, stderr: result.stderr })
}
```

Fatos verificados (dugite v3.2.3):
* `exec(args, path, options?)` → `Promise<IGitResult>` com `stdout`, `stderr`, `exitCode`. **Exit code ≠ 0 NÃO lança** — sempre checar `result.exitCode`. Somente falhas de spawn lançam `ExecError`.
* Opções úteis: `env`, `stdin`, `signal` (AbortSignal → kill do processo), `processCallback`, `encoding`, `maxBuffer`.
* A API `GitProcess` (v1/v2) foi **removida** na v3 — não usar.
* `spawn(args, path)` retorna ChildProcess cru para operações com output grande (clone).

Responsabilidades: montar args como array (nunca string), injetar credenciais via `GIT_ASKPASS` (script helper que ecoa o token) ou `http.<url>.extraheader` — **nunca na URL nem em argv** (§25), interpretar `--porcelain` outputs, converter para o modelo interno, nunca vazar tipos do dugite.

## 9. Papel do `dugite-native` (corrigido)

* `dugite` = camada Node.js (npm, MIT).
* `dugite-native` = **repo de build** que publica tarballs de Git por plataforma como **GitHub Releases** (não é npm). O `postinstall` do dugite baixa o tarball (`script/embedded-git.json`, sha256 verificado) para `node_modules/dugite/git/`. Release embutido atual: **dugite-native v2.53.0-4 (Git 2.53.0)**, cobrindo win32 x64/x86/arm64, macOS x64/arm64, ubuntu x64/x86/arm64.
* O Git bundled inclui também **Git LFS** e **Git Credential Manager** — relevantes para licenciamento (§39) e opcionalmente para auth.
* Implicações práticas:
  * CI precisa de rede no `npm ci` (postinstall); cache via `DUGITE_CACHE_DIR` (honra `HTTP(S)_PROXY`).
  * Ambientes CI com npm cache **devem preservar `node_modules/dugite/git`** ou pré-popular o cache.
  * A versão do Git bundled fica pinada pelo lockfile do dugite — registrar a versão no artefato para suporte.

## 10. Dependências

Durante a migração:

```json
{ "dependencies": { "dugite": "^3.2.3", "isomorphic-git": "^1.38.4" } }
```

Fixar via lockfile (já pinado em 1.38.4). Remoção de `isomorphic-git` somente na Fase 8.

## 11–12. Seleção do provider e `GIT_PROVIDER` (corrigido)

Não existe feature flag hoje. Implementar em três camadas, estendendo o padrão existente (`src/config/github-config.js`, `scripts/generate-runtime-env.js`, `resources/config/runtime-env.json`):

1. **Dev:** `.env` → `GIT_PROVIDER=dugite`.
2. **Build:** `electron-builder.env` → baking em `runtime-env.json` junto de `GITHUB_CLIENT_ID`.
3. **Runtime:** loader no main process lê `runtime-env.json` na inicialização; default `isomorphic-git` durante a migração; valor inválido → erro explícito (não fallback silencioso).

`GitProviderFactory` cria o provider uma vez por app session. Rollback = rebuild com valor diferente (ou toggle em staging).

## 13. Configuração por ambiente

* **Dev:** `dugite` (exposição contínua ao novo provider).
* **CI/testes:** a suíte comum roda contra **os dois** providers.
* **Staging:** `dugite`.
* **Produção inicial:** `isomorphic-git` (default), mudança para `dugite` sem alteração arquitetural.

## 14. Empacotamento

Requisito mantido: usuário instala `AppImage/deb/exe/portable/dmg/zip` e o Git já está embutido. Nenhum `npm install` em runtime.

## 15–17. Build e CI (corrigido ao workflow existente)

Já existe `.github/workflows/release.yml`: trigger por tag `v*` ou manual, job `prepare` (draft release para contornar bug do electron-builder), matriz `windows-latest`/`ubuntu-latest`/`macos-latest`, `npm ci` por runner. Adaptações necessárias (não substituir o workflow):

1. Adicionar passo `npm test` (Vitest) em todos os jobs — **hoje os testes não rodam no CI**.
2. Garantir cache `DUGITE_CACHE_DIR` (evitar re-download e flakiness de rede).
3. Novo script `verify:bundled-git` no `package.json`: valida no artefato empacotado que `node_modules/dugite/git/bin/git` (ou equivalente por plataforma) existe, executa `git --version` com o binário bundled e compara com a versão esperada do lockfile.
4. `npm ci` isolado por runner (já é o caso — manter; nunca compartilhar `node_modules` entre plataformas).
5. Testes rodam com ambos os providers no CI (`GIT_PROVIDER=dugite` e `=isomorphic-git` em passos separados).

## 16. Isolamento entre plataformas

Mantido: cada job gera seu próprio `node_modules`; o tarball dugite-native é por plataforma/arquitetura.

## 18. Spike obrigatória (primeiro deliverable)

Prova de conceito **antes** de migrar operações:

```
dugite postinstall (CI e dev) → Git bundled correto → electron-builder package
→ asarUnpack do git/ → instalação em VM/container sem Git → git --version
→ clone → commit → push (GitHub com PAT)
```

Targets mínimos: **Windows x64, macOS x64, Linux x64** (targets reais do produto; ARM64 sai da spike).

Ponto de atenção específico do projeto: no macOS, o Git bundled executa dentro do bundle `.app` — validar assinatura/notarização (se o release atual assina, o binário git entra no escopo da assinatura).

## 19. Validação do artefato

O CI deve validar o **artefato final**: extrair o instalador em ambiente limpo (sem `git` no `PATH`) e verificar presença, executabilidade, versão e operações básicas (`clone`/`commit`/`push` contra repo de teste com PAT efêmero).

## 20. Teste em máquina sem Git

Mantido: container/VM sem Git e sem entrada no `PATH`; instalar o app; executar clone/status/commit/push; tudo deve funcionar usando o Git bundled.

## 21. ASAR (corrigido para electron-builder)

`electron-builder.yml` atual já tem `asarUnpack` (sqlite3; entrada stale `keytar` — remover). Adicionar:

```yaml
asarUnpack:
  - node_modules/dugite/git/**/*
```

Alternativa a avaliar na spike: mover `dugite/git` para `extraResources` (`resources/git/`) com `GitRuntime` apontando para lá — padrão usado pelo GitHub Desktop. Decidir na spike; o requisito é: **o executável Git nunca fica comprimido dentro do ASAR**.

## 22. Resolução do caminho do Git

```ts
interface GitRuntime { getGitDir(): string }  // resolve resources/git ou node_modules/dugite/git
```

O dugite resolve o binário de `node_modules/dugite/git` automaticamente (`resolveGitDir`/`resolveGitBinary` são exportados e úteis nos testes). Em produção empacotada, `GitRuntime` aponta para o local desempacotado. **Importante:** o dugite força `GIT_CONFIG_SYSTEM` para o próprio gitconfig embutido — configs de sistema do usuário são ignoradas (comportamento desejado: isolamento), mas qualquer config necessária deve vir via `-c` ou env.

## 23. Proteção contra fallback involuntário

Mantido e reforçado: se `GIT_PROVIDER=dugite` e o Git bundled não for encontrado, erro fatal explícito `Bundled Git runtime not found` — nunca `PATH`. O `verify:bundled-git` no CI fecha esse elo.

## 24. Autenticação (reduzida ao escopo real)

O app usa **somente GitHub OAuth/PAT via HTTPS** (`{username: token, password: 'x-oauth-basic'}`), token do `secureTokenService` (safeStorage + fallback cifrado), anexado apenas para URLs `github.com`. Portanto:

* **Obrigatório:** HTTPS + PAT contra GitHub, nos dois providers.
* **Fora de escopo:** SSH, GitLab, servidor privado (não usados; removidos dos critérios de aceitação).
* **Mapeamento no DugiteProvider:** token injetado via `GIT_ASKPASS` helper ou `http.extraheader` `AUTHORIZATION: basic <base64(token:x-oauth-basic)>`; **nunca** na URL do remote, nunca em argv, nunca logado.
* GCM vem bundled (dugite-native) e pode ser habilitado futuramente, mas não substitui o fluxo OAuth atual nesta etapa.

## 25. Segurança

Mantido: args sempre array (sem shell), sem `shell: true`, sem tokens em logs/URLs/argv; adicionar sanitização de `result.stderr`/`stdout` antes de incluir em `GitError` (o Git pode ecoar URLs); limpar env de credenciais após uso.

## 26. Modelo de erro e cancelamento

```ts
export class GitError extends Error {
  operation: GitOperation; provider: 'isomorphic-git' | 'dugite';
  exitCode?: number; stderr?: string; cause?: unknown;
}
```

**Cancelamento (novo):** o layer de timeouts/retry existente (`gitFlowTypes.js`, `_raceTimeout`, AbortController de lock em `git.js`) permanece **acima** da interface. `signal` no dugite mata o processo filho (mais confiável que o AbortSignal do isomorphic-git, que ignora sinais em operações locais). O classificador de erros retryáveis de push (`gitOperations.js` `_pushWithRetry`) deve ser portado para a camada comum — os códigos de erro diferem entre providers e a interface deve normalizar `errorType` (timeout | auth | network | conflict | unknown).

## 27. Normalização de resultados

Mantida a ideia; forma concreta derivada do uso real:

```ts
interface StatusMatrix { rows: [file, headStatus, workdirStatus, stageStatus][] }
```

(com `git status --porcelain=v2 -z` no dugite; definir fixtures comuns na suíte para fixar divergências de rename/untracked.)

## 28. Testes automatizados

Suíte comum Vitest (`describeGitProvider`) rodando contra ambos os providers, reusando a estrutura de `tests/ipc/git*.test.js` (que já inclui mocks extensos e testes com isomorphic-git real em temp fs). Rodar os dois modos no CI.

## 29. Testes específicos de push

Cenários ajustados à realidade (sem GitLab/servidor privado): push pequeno/grande/muitos arquivos; após commit/fetch; branch nova/existente; rejeitado (fast-forward); sem conexão; timeout (kill via signal); autenticado (GitHub PAT); **e paridade do retry/backoff existente**.

## 30–32. Benchmark, observabilidade, teste comparativo

Mantidos conforme original, com adição: registrar `git.bundled_version` e `git.cancelled` (kill por signal) nas métricas. Nunca logar tokens.

## 33. Estratégia de rollout (ajustada)

* **Fase 0 — Spike** (primeiro deliverable): packaging + máquina limpa (§18).
* **Fase 1 — Abstração:** introduzir `src/git/` + `IsomorphicGitProvider`; migrar os 7 módulos consumidores para a fachada **sem mudança de comportamento**; testes existentes passam intocados.
* **Fase 2 — DugiteProvider** + `GitRuntime` + auth via askpass.
* **Fase 3 — CI:** adaptar `release.yml` (testes nos dois modos, `verify:bundled-git`, cache dugite), ajustar `electron-builder.yml` (`asarUnpack`; remover `keytar` stale).
* **Fase 4 — Testes/benchmark** comparativos.
* **Fase 5 — Staging** com `GIT_PROVIDER=dugite`.
* **Fase 6 — Produção controlada** (default `isomorphic-git`, switch imediato).
* **Fase 7 — Default `dugite`**; remover `gitMergeDriver.js` (código morto).
* **Fase 8 — Remoção** de `isomorphic-git`, `IsomorphicGitProvider`, switch `GIT_PROVIDER`.

## 34. Critérios para remover `isomorphic-git`

Checklist original mantido, com adições:
* suíte comum (§28) verde nos dois providers no CI;
* workarounds existentes (retry de mkdir no clone, retry de checkout, polling de readiness) revisados/removidos ou justificados;
* timeouts de push resolvidos com evidência de benchmark;
* SSH/GitLab **não** são critério (fora de escopo do produto).

## 35. Matriz de aceitação (corrigida aos targets reais)

| Requisito | Windows x64 (NSIS/portable) | macOS x64 (dmg/zip) | Linux x64 (AppImage/deb) |
|---|:-:|:-:|:-:|
| Instala sem Git no sistema | ✅ | ✅ | ✅ |
| Git bundled (dugite-native) | ✅ | ✅ | ✅ |
| `git --version` (bundled) | ✅ | ✅ | ✅ |
| clone / fetch / pull / commit / push | ✅ | ✅ | ✅ |
| HTTPS + GitHub PAT | ✅ | ✅ | ✅ |
| SSH / GitLab / ARM64 | — fora de escopo nesta fase (fase futura condicionada à matriz oficial do produto) | | |

## 36. Estrutura de código final

```text
src/git/
├── GitProvider.ts        # interface (§6.2)
├── GitService.ts         # fachada usada por src/ipc/*
├── GitError.ts
├── GitTypes.ts
├── GitRuntime.ts         # resolução do Git bundled
├── GitProviderFactory.ts # lê runtime-env (GIT_PROVIDER)
└── providers/
    ├── IsomorphicGitProvider.ts
    └── DugiteProvider.ts
```

## 37. Dependências (resumo)

Durante a migração: `dugite@^3.2.3` + `isomorphic-git@^1.38.4`. O Git nativo chega via postinstall do dugite (tarballs dugite-native); não há dependência npm adicional nem toolchain própria a manter.

## 38. Fluxo final de produção

Mantido do original (GitHub Actions por plataforma → npm ci → Git bundled → electron-builder → instaladores → usuário sem Git/npm), com a correção de que o pipeline real é o `release.yml` existente adaptado.

## 39. Licenciamento (detalhado)

* `dugite`: MIT.
* Git bundled (dugite-native): **GPLv2** — incluir texto da licença e notices no instalador (`THIRD-PARTY-NOTICES`).
* O tarball também embute **Git LFS** e **Git Credential Manager**, com termos próprios — incluir nos notices.
* Revisão jurídica/compliance antes do primeiro release com Git bundled.

## 40. Riscos principais (mantidos + novos)

| Risco | Mitigação |
|---|---|
| Git não entra no instalador / errado por plataforma | `verify:bundled-git` no artefato; builds separados por runner |
| Git do sistema usado sem querer | `GitRuntime` + erro fatal se bundled ausente |
| Executável dentro do ASAR | `asarUnpack`/`extraResources` (definir na spike) |
| Postinstall do dugite falhar em CI restrito | cache `DUGITE_CACHE_DIR`; proxy support |
| Divergência semântica statusMatrix vs porcelain | fixtures comuns na suíte dos providers |
| Perda de retry/backoff de push | portar `_pushWithRetry` para camada comum com `errorType` normalizado |
| Assinatura/notarização macOS quebrada por binário novo | incluir git/ no escopo da assinatura na spike |
| Licença GPLv2/GCM/LFS | THIRD-PARTY-NOTICES + compliance |
| Regressão do novo provider | `GIT_PROVIDER` rollback |
| `GIT_CONFIG_SYSTEM` sobrescrito pelo dugite | replicar configs necessárias via `-c`/env (§22) |

## 41. Critério de sucesso

Usuário baixa o instalador (AppImage/deb/exe/portable/dmg/zip), instala em máquina **sem Git no PATH**, abre o app, clona um repositório GitHub (via OAuth do produto), edita, commita e faz push — sem instalar Git, Node.js, npm ou GCM manualmente.

## 42. Decisão final

**Seguir com `dugite` + Git bundled (dugite-native via postinstall), mantendo `isomorphic-git` atrás da mesma interface durante toda a migração.** O primeiro deliverable é a **Spike de §18** (packaging → máquina limpa), que elimina a maior incerteza técnica. As correções desta revisão (interface baseada nas ~24 operações reais, auth restrita a GitHub PAT, targets x64-only, adaptação do `release.yml`/`electron-builder.yml` existentes, licenças GPLv2/GCM/LFS) são vinculativas para as fases seguintes.

---

## TODOs (para execução via /start-work)

- [ ] 1. Mover este documento para `docs/prd-dugite-migration.md` (pedido original do usuário)

  **What to do**: copiar este arquivo para `docs/prd-dugite-migration.md` e removê-lo de `.omo/plans/` (ou mantê-lo como referência, a critério do usuário).
  **QA Scenarios**: `ls docs/prd-dugite-migration.md` → arquivo existe e contém "Registro da revisão".
