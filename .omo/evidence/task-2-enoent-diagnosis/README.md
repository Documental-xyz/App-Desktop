# Task 2 — Diagnóstico ENOENT do data-store.json (read-only)

**Data**: 2026-09-10
**Escopo**: diagnóstico documentado, ZERO mudanças de código (decisão registrada em `.omo/notepads/ajustes-wizard-preview-servicos/decisions.md:6`).
**Erro analisado** (Windows, log do usuário citado no request original):

```
ENOENT: no such file or directory, rename '.astro/data-store.json.tmp' -> '.astro/data-store.json'
[glob-loader] Reloaded data from testes2.md
[glob-loader] Reloaded data from testes2.md   ← linha DUPLICADA
```

Referência do erro citada no plano: https://docs.astro.build/en/reference/errors/unknown-filesystem-error/

---

## Veredito

**Hipótese (a) — CONFIRMADA e mais provável: dois dev servers no mesmo repositório.**

O mecanismo exato do ENOENT só é possível entre **processos distintos**, porque o guard anti-concorrência do Astro (`#writing`) é **por processo** (em memória), e o ficheiro `.tmp` é **compartilhado** no disco. Dois servers no mesmo `repoDirPath` produzem simultaneamente:
1. O rename fallhido com ENOENT (o perdedor da corrida renomeia um `.tmp` que o vencedor já consumiu);
2. As linhas duplicadas `[glob-loader] Reloaded data from testes2.md` (cada processo tem seu próprio watcher chokidar e loga o mesmo evento).

A hipótese (b) (loader/coleção duplicada num único server) foi **REFUTADA no código** — ver secção abaixo. A hipótese (c) (antivírus) permanece **residual**, sem sustentação pelas linhas duplicadas.

---

## Evidências

### E1. O mecanismo do erro: `#writeFileAtomic` com guard POR PROCESSO

`Template/node_modules/astro/dist/content/mutable-data-store.js` (Astro 5.18.2):

- **L195**: `#writing = new Set();` — guard é uma propriedade de instância **em memória do processo**; não há lock cross-process (sem lockfile, sem O_EXCL).
- **L197-222**: `async #writeFileAtomic(filePath, data, depth = 0)`:
  - **L202-206**: se `this.#writing.has(fileKey)` → enfileira em `#pending` e retorna (dedupe **dentro** do processo);
  - **L207**: `tempFile = ${filePath}.tmp` → `.astro/data-store.json.tmp` (o ficheiro do erro);
  - **L213**: `await fs.writeFile(tempFile, data);`
  - **L214**: `await fs.rename(tempFile, filePath);` ← **a linha que falha com ENOENT**.
- **L326-338** (`writeToDisk` em `mutable-data-store.js:326-338`): serializa e chama `#writeFileAtomic`; o erro vira `UnknownFilesystemError` (a página de docs citada no log).
- **L9/L145/L163/L193**: debounce `SAVE_DEBOUNCE_MS = 500` — escritas são debounced por processo, mas o debounce NÃO sincroniza processos.

**Corrida entre 2 processos (P-A, P-B) no mesmo repoDirPath**:
```
P-A: writeFile('.astro/data-store.json.tmp')   (L213)
P-B: writeFile('.astro/data-store.json.tmp')   (L213, sobrescreve)
P-A: rename('.tmp' → 'data-store.json')        (L214, consome o .tmp)
P-B: rename('.tmp' → 'data-store.json')        (L214) → ENOENT: .tmp já não existe
```
O caminho do store em dev: `Template/node_modules/astro/dist/content/content-layer.js:338` — `new URL(DATA_STORE_FILE, isDev ? settings.dotAstroDir : settings.config.cacheDir)` (i.e. `<root>/node_modules/.astro/data-store.json`; exibido no log relativo como `.astro/data-store.json`). Dois servers com o mesmo root → **o mesmo ficheiro-alvo e o mesmo `.tmp`**. Confirmado no workspace: `Template/node_modules/.astro/data-store.json` existe.

### E2. As linhas duplicadas: 1 watcher POR INSTÂNCIA de loader, log `[glob-loader]`

`Template/node_modules/astro/dist/content/loaders/glob.js`:
- **L41**: `name: "glob-loader"` — origem do label `[glob-loader]`;
- **L235**: `watcher.add(filePath)` + **L249-250**: `watcher.on("change"|"add", onChange)` — cada instância do loader cria seu próprio watcher chokidar;
- **L246-247**: `await syncData(...); logger.info(\`Reloaded data from ${colors.green(entry)}\`)` — a linha logada **uma vez por watcher** que vê a mudança.

`testes2.md` pertence à coleção `pages` (CMS: `Template/public/admin/config.yml:1867-1873` — `folder: 'pages'`, `create: true`, `slug: '{{slug}}'`). Um save no Sveltia dispara `change`/`add` em TODOS os watchers que assistem `pages/**/*.md` — com 2 processos, são **2 logs idênticos**. Uma única instância de glob-loader loga uma vez (handler único `onChange` em glob.js:238-248).

### E3. O App permite 2 servers: `startDevServer` SEM guard de dedupe

`App-Desktop/src/ipc/processManager.js`:
- **L432**: `async startDevServer(repoDirPath, projectId, ...)` — assinatura; **não há nenhuma consulta** a `activeDocumentalProcesses`/`activeProcesses` por `repoDirPath` antes do spawn (função inteira L432-569+);
- **L501-510**: `spawnNodeChild(actualNpmPath, ['run','dev'], { cwd: repoDirPath, ... })` — spawn incondicional;
- **L525-526**: `const processId = \`dev-${projectId}\`; activeProcesses[processId] = devProcess;` — chave por **projectId**, não por repoDirPath: uma 2ª chamada com o mesmo projectId **sobrescreve o slot do mapa sem matar o 1º filho** (processo órfão continua vivo);
- **L528-533**: `addDocumentalProcess(devProcess.pid, { cwd: repoDirPath, ... })` — tracking por **pid**: dois pids com o mesmo `cwd` coexistem sem conflito;
- **L443**: `const urlRegex = /http:\/\/localhost:\d+\//;` — aceita QUALQUER porta (4321, 4322, ...); **L454**: `globalDevServerUrl = devServerUrl` — o 2º server sobrescreve a URL global.

### E4. O caminho de reprodução está documentado no próprio código do App

- `App-Desktop/renderer/main.html:578-580` (comentário explícito em `confirmCloseProject`):
  > "Paridade intencional: o servidor dev e processos filhos NÃO são encerrados aqui (o fluxo antigo também os mantinha; killAll só dispara no before-quit)."
- 3 callers que chamam `startDevServer` sem verificação prévia de server existente no mesmo repo:
  - `App-Desktop/src/ipc/projectCreation.js:904` — handler `start-project-creation` (Step 5 "npm run dev");
  - `App-Desktop/src/ipc/projectCreation.js:1028` — handler `open-project-only-preview-and-server`;
  - `App-Desktop/src/ipc/projectCreation.js:1148` — handler `reopen-project` (`reopenProject` definido a partir de projectCreation.js:1048; registro IPC em projectCreation.js:1273). O corpo de `reopenProject` (L1048-1159) não consulta processos existentes antes do Step 5.

### E5. Dois servers CABEM no mesmo repo (portas incrementais)

- Default do Astro: `Template/node_modules/astro/dist/core/config/schemas/base.js:36` — `port: 4321`;
- `Template/astro.config.mjs:48-61` — `defineConfig` NÃO define `server` (sem `strictPort`, sem `port` fixa);
- Vite (runtime usado pelo astro dev): `Template/node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:25111-25121` (`httpServerStart`) — em `EADDRINUSE`, se `!strictPort`: `logger.info(\`Port ${port} is in use, trying another one...\`); httpServer.listen(++port, host);` — ou seja, incrementa a porta automaticamente;
- `dep-Dm0c1Wj2.js:38947`: `strictPort: false` é o default do Vite.
→ O 2º `npm run dev` não falha: pega 4322 e compartilha `<root>/node_modules/.astro/` com o 1º.

---

## Caminho de Reprodução (inferido)

1. Usuário abre/cria um projeto → `start-project-creation` chama `startDevServer` (projectCreation.js:904) → **server #1** em `http://localhost:4321`, watcher #1 em `pages/**/*.md`.
2. Usuário clica **"Fechar Ambiente"** → `confirmCloseProject` (main.html:560) navega para a seleção; comentário main.html:578-580 confirma que **o server #1 NÃO é morto** (killAll só no before-quit).
3. Usuário reabre o mesmo projeto → `reopen-project` (projectCreation.js:1273 → 1148) chama `startDevServer` **sem guard** (processManager.js:432) → **server #2** no mesmo `repoDirPath`; Vite acha 4321 ocupado e incrementa para 4322 (evidência E5).
4. Usuário salva `pages/testes2.md` no Sveltia CMS (`/admin`) → chokidar dispara em **ambos** os watchers → **2×** `[glob-loader] Reloaded data from testes2.md` (glob.js:41,247).
5. Ambos os processos, cada um com seu `MutableDataStore` (guard `#writing` isolado — mutable-data-store.js:195), fazem debounce 500ms e depois `writeFile(.tmp)` + `rename(.tmp → data-store.json)` (L213-214) sobre o **mesmo** `node_modules/.astro/data-store.json` → o perdedor da corrida recebe **ENOENT no rename**.

---

## Hipóteses Eliminadas/Confirmadas

### (a) Dois dev servers no mesmo repo — **CONFIRMADA** (veredito)
Evidências E3, E4, E5 (App sem guard + "Fechar Ambiente" mantém server + porta incremental). Explica **simultaneamente** o ENOENT (corrida cross-process no `.tmp` compartilhado — E1) e as linhas duplicadas (2 watchers — E2).

### (b) Loader/coleção duplicada num único server — **REFUTADA no código**
Contagem explícita de registros da coleção pages (`createPagesLoader`):
- `Template/src/content.config.ts:5` — `createPagesLoader({ base: './pages' })` — **1 registro** (coleção `pages`, L9). Este é o ÚNICO content config carregado por um dev server do Template (Astro carrega apenas o `src/content.config.ts` da raiz do projeto).
- `Template/astro.config.mjs` — **0 registros** (sem coleções; apenas integração `core()`, L52-60).
- `Core/src/content.config.ts:25` — 1 registro, mas este ficheiro é o content config **do próprio repo Core** (playground/dev do pacote — `npm run dev` do Core, package.json scripts), **NÃO é carregado pelo Template**. O Template importa somente `@documental-xyz/core/loader` (Template/src/content.config.ts:2), que mapeia para `Core/src/content/loader.ts` (Core/package.json exports `"./loader": "./src/content/loader.ts"`).
- `Core/src/content/loader.ts:16-28` — `createPagesLoader` retorna **exatamente 1** `glob()` (L23-28): 1 chamada = 1 instância de glob-loader = 1 watcher.
- A integração `core()` NÃO regista coleções: `Core/integration.ts:70` (`astro:config:setup`) usa apenas `injectRoute` (L80-89), cópia do admin shell (L98-112), `injectScript` (L116-119) e `updateConfig` de plugins Vite (L124-134) — **sem `injectContentConfig`** (grep sem ocorrência em integration.ts).

**Total efetivo por server do Template: 1 coleção `pages` / 1 glob-loader.** → Um único server logaria `Reloaded data from testes2.md` **uma vez** por save. Hipótese (b) não explica nem as duplicadas nem o ENOENT. *(Nota: Core/src/content.config.ts:42,46 tem 2 `glob()` adicionais, mas para `blog/` e `geostorys/` — bases diferentes, irrelevantes para `pages/testes2.md`, e só aplicam ao dev do próprio Core.)*

### (c) Interferência externa (antivírus/Defender segurando o `.tmp` no rename) — **RESIDUAL, não sustentada como causa primária**
- É consistente com o local do erro (rename em mutable-data-store.js:214) e com Windows;
- Mas **não explica as linhas duplicadas** do glob-loader (E2), que são o sintoma acompanhante observado no log do usuário;
- O guard `#writing` (mutable-data-store.js:195,202-206) já exclui corrida INTRA-processo, então qualquer corrida precisa ser externa ao processo — 2 processes (a) é a explicação com evidência direta no código do App; AV é possível mas secundário.
- **Mitigação de usuário (sem fix no app)**: excluir o diretório do repositório (ou ao menos `<repo>/node_modules/.astro/`) da varredura em tempo real do Windows Defender/antivírus.

---

## Recomendação

1. **Fix no App-Desktop (Tasks 5/6 do plano)**: adicionar guard de dedupe em `startDevServer` (processManager.js:432) — antes do spawn, consultar processos existentes por `repoDirPath` (via `activeDocumentalProcesses[].cwd`, populated em processManager.js:528-533) e reutilizar/matar o server existente em vez de criar o 2º. Este diagnóstico é o insumo da Task 5 (chave de dedupe).
2. **Template/Core: SEM mudança necessária para este bug** — a hipótese (b) foi refutada; não há loader/coleção duplicada a corrigir. Conforme decisão do usuário (decisions.md:6), QUALQUER alteração futura em Template/Core permanece **PENDENTE de aprovação explícita**; para este diagnóstico, a pendência é "não aplicável" (nenhuma mudança proposta).
3. **Mitigação documentada para (c)**: exclusão do Defender acima, a registrar no checklist manual do Windows (`.omo/evidence/windows-manual-checklist.md` — F3).

---

## Versão do Astro

- **5.18.2** — `Template/package.json:13` (`"astro": "^5.0.0"`) resolvido em `Template/package-lock.json:2111-2112` (`"node_modules/astro": { "version": "5.18.2" }`) e confirmado em `Template/node_modules/astro/package.json` (`.version` = 5.18.2).
- **Issues conhecidas do writeFileAtomic**: o pacote instalado **não shipa CHANGELOG.md** (verificado: `ls Template/node_modules/astro/CHANGELOG.md` → inexistente), logo a busca local por issues conhecidas não é possível offline. Nota técnica: em 5.18.2 o `#writeFileAtomic` mantém apenas o guard por processo (L195) — sem lock cross-process — que é exatamente a janela explorada pela hipótese (a).

---

## Rastreabilidade das fontes (file:line)

| # | Ficheiro | Linhas | O quê |
|---|----------|--------|-------|
| E1 | Template/node_modules/astro/dist/content/mutable-data-store.js | 195, 197-222, 213-214, 326-338 | guard por processo; write .tmp + rename |
| E1b | Template/node_modules/astro/dist/content/content-layer.js | 338 | data-store.json em `dotAstroDir` (dev) |
| E2 | Template/node_modules/astro/dist/content/loaders/glob.js | 41, 235, 246-250 | label `[glob-loader]`; watcher por instância; log `Reloaded data from` |
| E3 | App-Desktop/src/ipc/processManager.js | 432, 501-510, 525-533, 443, 454 | startDevServer sem guard; spawn incondicional; chave dev-projectId; urlRegex qualquer porta |
| E4 | App-Desktop/renderer/main.html | 578-580 | "Fechar Ambiente" NÃO mata server (comentário) |
| E4b | App-Desktop/src/ipc/projectCreation.js | 904, 1028, 1148, 1048, 1273 | 3 callers sem verificação prévia |
| E5 | astro/dist/core/config/schemas/base.js; vite/dist/node/chunks/dep-Dm0c1Wj2.js | 36; 25111-25121, 38947 | porta default 4321; incremento automático em EADDRINUSE (strictPort false) |
| Hb | Template/src/content.config.ts; Core/src/content.config.ts; Core/src/content/loader.ts; Core/integration.ts; Template/astro.config.mjs | 2,5,9; 25,42,46; 16-28; 70-134; 48-61 | contagem createPagesLoader = 1 efetiva; integração sem injectContentConfig |
| V | Template/package.json; Template/package-lock.json | 13; 2111-2112 | astro 5.18.2 |
