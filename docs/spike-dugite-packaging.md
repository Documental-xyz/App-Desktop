# Spike: Empacotamento do Git bundled (dugite) fora do ASAR — T6

**Data:** 2026-08-22 · **Status:** ✅ Concluída · **Build:** `npm run build:linux:dir` (electron-builder 26.15.3, Electron 42.3.3, x64)

## Decisão

**Escolha: `asarUnpack` com `node_modules/dugite/git/**/*`.** Alternativa `extraResources` avaliada e rejeitada (abaixo).

### Mudança no `electron-builder.yml`

```yaml
asarUnpack:
  - node_modules/sqlite3/**/*          # mantido
  - node_modules/dugite/git/**/*       # adicionado
  # - node_modules/keytar/**/*         # REMOVIDO — keytar não está em dependencies (entrada stale)
```

Targets (AppImage/deb x64), `extraResources` (config) e demais macros **não alterados**.

## Racional: asarUnpack vs extraResources

| Critério | asarUnpack ✅ | extraResources (resources/git) ❌ |
|---|---|---|
| Resolução de caminho em prod | Automática: Electron remapeia `node_modules/dugite/...` para `app.asar.unpacked/node_modules/dugite/...` (o header do asar mantém stubs com flag `unpacked`). `require.resolve('dugite')` + paths relativos funcionam igual em dev e prod. | Manual e divergente: em dev o git está em `node_modules/dugite/git`, em prod em `resources/git` → GitRuntime precisaria de branch condicional por ambiente. |
| Coerência com sqlite3 | Mesmo padrão já usado (precedente no projeto). | Novo mecanismo só para um pacote. |
| Risco de drift de versão | Baixo — o git viaja junto ao `node_modules/dugite` do lockfile. | Médio — cópia duplicada pode divergir do pacote dugite instalado. |
| Tamanho do artefato | Idêntico (os mesmos ~147M saem do archive de qualquer forma; extraResources não economiza nada). | Idêntico. |

**Única vantagem de extraResources** seria esconder o git do namespace `node_modules` do asar — irrelevante aqui.

## Estrutura final do artefato (insumo T7/T8/T20)

```
dist/linux-unpacked/
├── documental (binário Electron)          # nome pode variar; ver dist/linux-unpacked/
└── resources/
    ├── app.asar                            # 28M — sem o conteúdo do git (stubs apenas)
    ├── app.asar.unpacked/
    │   ├── node_modules/sqlite3/...
    │   └── node_modules/dugite/
    │       ├── git/
    │       │   ├── bin/{git,scalar}        # -rwxr-xr-x, git 4.0M / scalar 2.3M
    │       │   ├── etc/gitconfig
    │       │   ├── libexec/git-core/...
    │       │   ├── share/...
    │       │   └── ssl/...
    │       ├── script/ e build/ (JS do dugite também unpacked)
    └── config/                             # extraResources existente (runtime-env.json etc.)
```

### Caminho para o GitRuntime (T5) em produção

```
<resources>/app.asar.unpacked/node_modules/dugite/git/bin/git
```

Recomendação T5: resolver via `path.join(path.dirname(require.resolve('dugite/package.json')), 'git', 'bin', 'git')` — em dev cai em `node_modules/dugite/git/bin/git`; em prod o Electron resolve o stub do asar para `app.asar.unpacked/...` automaticamente. Nenhum branch por ambiente necessário. (Alternativa: `process.resourcesPath` + sufixo fixo, se o require.resolve não for confiável no main process packed.)

## Verificações executadas

| Check | Resultado |
|---|---|
| `app.asar.unpacked/.../bin/git --version` | `git version 2.53.0` ✅ |
| Bit executável (`ls -la bin/`) | `-rwxr-xr-x` preservado para `git` e `scalar` ✅ |
| `asar list --is-pack \| grep dugite/git/bin` | todas `unpack` ; packed count = **0** ✅ |
| `asar extract-file app.asar /node_modules/dugite/git/bin/git` | `not found in this archive` (conteúdo fora) ✅ |

⚠️ **Nuance de verificação:** `asar list app.asar | grep -c "dugite/git/bin"` retorna **3**, não 0 — o header do asar mantém *stubs* das entradas unpacked (com flag `unpacked: true`). O critério correto é `--is-pack` (mostra `unpack`) ou o tamanho do archive (28M não comporta 147M). Não usar o grep simples como gate de CI sem `--is-pack`.

## Tamanho do instalador (antes/depois)

- `app.asar` = **28M**; `app.asar.unpacked` = **152M** (dugite/git ≈147M + sqlite3).
- Comparável ao cenário pré-T2 (sem dugite): o acréscimo é **+~147M** independente do método (asarUnpack vs extraResources vs dentro-do-asar) — o git bundle entra no artefato de qualquer forma; asarUnpack não altera o tamanho final, só a localização.
- AppImage/deb usam compressão (squashfs/gzip) que deve reduzir esse delta no instalador final; medir no build de release (T7/T8) se o tamanho for critério.

## Observações de ambiente / limitações

- **Linux tarball do dugite-native v2.53.0-4 NÃO inclui `git-lfs` nem GCM** (confirmado na T2). Se LFS for necessário no Linux, requer provisionamento separado — fora do escopo desta spike.
- Build exigiu `electron-builder.env` com `GITHUB_CLIENT_ID` (gerado dummy local `spike-local-dummy`; arquivo é gitignored, não commitado).
- `npx @electron/rebuild` rebuildou sqlite3 para Electron 42.3.3 sem problemas.

## Evidências

- `.omo/evidence/task-6-unpacked-git.txt` — `git --version` do artefato, `ls -la`, tamanhos
- `.omo/evidence/task-6-asar-check.txt` — checagens asar (`--is-pack`, extract-file)

## Validação sem Git (Task 8, 2026-08-22)

**Método usado (docker indisponível neste ambiente — documentado honestamente):**
sandbox `env -i` com PATH mínimo (`/tmp/opencode/nogit`, symlinks só de coreutils: sh, bash, mkdir, ls, which…) e **nenhum** git acessível — verificado com `which git` → vazio (exit 1). O binário bundled foi invocado sempre por **caminho absoluto**, de dentro da árvore do artefato `dist/linux-unpacked/resources/app.asar.unpacked/node_modules/dugite/git/` (nunca copiado). Nota de transparência: libs compartilhadas (libc, libz) vêm do sistema via dynamic linker — o que a validação prova é que **nenhum git do sistema é usado**; equivalente funcional ao requisito `debian:bookworm-slim` + `which git` vazio.

**Reprodução (comandos):**

```bash
GITDIR=dist/linux-unpacked/resources/app.asar.unpacked/node_modules/dugite/git
RUN="env -i HOME=$WORK PATH=/tmp/opencode/nogit \
  GIT_EXEC_PATH=$GITDIR/libexec/git-core \
  GIT_CONFIG_SYSTEM=$GITDIR/etc/gitconfig \
  GIT_TEMPLATE_DIR=$GITDIR/share/git-core/templates \
  PREFIX=$GITDIR GIT_SSL_CAINFO=$GITDIR/ssl/cacert.pem"

$RUN which git                    # → vazio (exit 1) — nenhum git do sistema
$RUN $GITDIR/bin/git --version    # → git version 2.53.0
$RUN $GITDIR/bin/git init --bare $WORK/test-bare.git
$RUN $GITDIR/bin/git clone $WORK/test-bare.git $WORK/clone   # → OK
$RUN $GITDIR/bin/git -C $WORK/clone -c user.email=test@example.com -c user.name="Test User" \
      commit --allow-empty -m "empty commit test"            # → [master d862e6c]
$RUN $GITDIR/bin/git -C $WORK/clone push origin HEAD:main    # → new branch OK
```

**Resultados:** `--version` → 2.53.0 ✓; `which git` → vazio ✓; `clone` de repo bare local ✓; `commit --allow-empty` com `-c user.email/user.name` ✓; `push` + `ls-remote` ✓. Evidência completa: `.omo/evidence/task-8-gitless-container.txt`.

**Descoberta crítica para o DugiteProvider (Wave 4):** invocar só o binário não basta. O transporte local de `clone`/`push` faz spawn de `git-upload-pack`/`git-receive-pack` — sem `GIT_EXEC_PATH` apontando para `<gitDir>/libexec/git-core`, o clone falha com `git-upload-pack: not found` mesmo com o binário bundled no PATH-argv. Além disso, sem `GIT_TEMPLATE_DIR`/`PREFIX` aparecem warnings (`templates not found in //share/git-core/templates`). O contrato correto é o que o próprio dugite monta em `node_modules/dugite/build/lib/git-environment.js` (`setupEnvironment`): no Linux, `GIT_EXEC_PATH`, `GIT_CONFIG_SYSTEM=<gitDir>/etc/gitconfig`, `GIT_TEMPLATE_DIR`, `PREFIX=<gitDir>` e `GIT_SSL_CAINFO=<gitDir>/ssl/cacert.pem`. Com esse env replicado, execução 100% limpa (zero warnings). **Ação:** o DugiteProvider deve setar esse env ao executar o binário (ou reusar `setupEnvironment` do dugite).

## Assinatura macOS (Task 8)

- `.github/workflows/release.yml`: NÃO assina hoje. `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` (linha 67) desativa explicitamente a descoberta de identidade; comentários nas linhas 7–9 registram os placeholders futuros (`CSC_LINK`/`CSC_KEY_PASSWORD`, `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`/`APPLE_TEAM_ID`) com aviso "never enable on unsigned builds (notarization fails hard)".
- `electron-builder.yml`: bloco `mac:` só define target (dmg/zip x64) e icon — sem `identity`, `entitlements`, `gatekeeperAssess` ou afterSign hook; nenhum script de notarization em `scripts/`.
- **Conclusão: N/A — release não assina hoje.** Os binários extras do dugite (git, scalar, `libexec/git-core/*`) não entram hoje em nenhum escopo de assinatura.
- **Nota para o futuro (quando assinatura for habilitada):** o electron-builder assina por padrão todos os binários dentro do bundle `.app` — o que inclui `Contents/Resources/app.asar.unpacked/node_modules/dugite/git/` (centenas de executáveis Mach-O em `libexec/git-core/`). Impactos esperados: (1) aumento significativo do tempo de assinatura/notarização; (2) `codesign` precisa aceitar binários sem entitlements; (3) avaliar `mac.signIgnore`/`binaries` do electron-builder se necessário; (4) a notarização da Apple pode rejeitar binários sem `com.apple.security.cs.allow-unsigned-executable-memory` inadequado — testar com `xcrun notarytool` antes do primeiro release assinado. Registrar decisão quando CSC_LINK for provisionado.
