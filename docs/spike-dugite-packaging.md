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
