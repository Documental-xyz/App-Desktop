# Fluxo de release com GitHub Actions no Documental

## Instruções gerais

Este guia descreve como cortar um release do app Desktop (Documental) usando o workflow `.github/workflows/release.yml`. Ao receber o push de uma tag `v*`, o workflow compila o app para Windows, Linux e macOS e publica todos os instaladores como release em **rascunho (draft)** no GitHub. Nada chega ao público sem revisão: você confere o rascunho e publica manualmente.

OBS: este documento cobre apenas o que o workflow implementa hoje. Assinatura de código e publicação na Snap Store não estão implementadas (veja as seções 8 e 9).

## 1. Visão geral

O workflow é disparado por push de tag `v*` (ex.: `v1.2.0`) e executa:

1. **Job `prepare`**: pré-cria o release em rascunho de forma idempotente (`gh release view || gh release create --draft`), antes de qualquer build. Todos os jobs de build sobem seus artefatos para esse mesmo rascunho. Isso elimina a race de drafts duplicados que existe no GitHub publisher da electron-builder 26.15.3 (issue #10026 do electron-builder).
2. **Job `build`** (matrix de 3 sistemas operacionais, sem fail-fast):
   - `windows-latest`: instalador NSIS + executável portable (`npm run build:win`)
   - `ubuntu-latest`: AppImage + deb + rpm (`npm run build:linux -- AppImage deb rpm`)
   - `macos-latest`: dmg + zip, apenas x64 (`npm run build:macos`)
   - Antes do empacotamento, cada leg roda suítes de teste **escopadas** por provider Git (seção 10) e, depois do build, o passo `verify:bundled-git` valida o Git embutido no `dist/`.
3. **Job `snap`** (best-effort, isolado): empacota o `.snap` com `continue-on-error: true`. Snap é historicamente instável em CI; se o job falhar, o release segue sem esse artefato.

A autenticação com o GitHub usa apenas o `secrets.GITHUB_TOKEN` automático do runner (nenhum PAT). A versão dos instaladores não vem do `package.json`: ela deriva da tag (seção 3).

## 2. Pré-requisitos (one-time)

### 2.1 Configurar o secret `GH_CLIENT_ID`

O build exige o client ID do GitHub Device Flow. Sem ele, o workflow falha logo no início com erro claro (o `generate-runtime-env.js` faz `exit 1` quando não encontra o ID).

No GitHub: **Settings → Secrets and variables → Actions → New repository secret**, nome `GH_CLIENT_ID`, valor = o client ID da aplicação OAuth (o mesmo usado no `.env` local).

OBS: o nome **não pode** ser `GITHUB_CLIENT_ID`. O GitHub rejeita secrets cujo nome comece com o prefixo `GITHUB_` — ele é reservado para a plataforma (ex.: o `GITHUB_TOKEN` automático do runner). O workflow lê `secrets.GH_CLIENT_ID` e injeta o valor como a variável `GITHUB_CLIENT_ID` no ambiente do build, que é o nome que o `generate-runtime-env.js` e o app esperam.

Para conferir se já está configurado:

```
gh secret list
```

### 2.2 Configurar os valores de tema (obrigatório)

A aparência do app empacotado vem da configuração do repositório. Os valores `THEME` e `THEME_MODE` são **obrigatórios**: sem eles o build falha logo no passo de geração do `electron-builder.env`, com erro claro. No GitHub: **Settings → Secrets and variables → Actions**, crie (como **Variables** ou **Secrets**):

- `THEME` — nome do tema (ex.: `documental`)
- `THEME_MODE` — modo do tema (ex.: `dark`)

O workflow lê `vars.THEME || secrets.THEME` (e o mesmo para `THEME_MODE`): se o valor existir como repository variable, ele vence; caso contrário, o valor vem do secret. Hoje o repositório usa **Secrets** para ambos — funciona igual. Variables é o lugar certo para configuração não sensível; Secrets, para valores que você prefere não expor.

O mecanismo é o mesmo do `GH_CLIENT_ID`: o workflow injeta os valores no `electron-builder.env`, o `generate-runtime-env.js` os embute no `runtime-env.json` e o app os lê em runtime. Depois de cada build, um passo de verificação lê o `runtime-env.json` empacotado e confere se os valores chegaram exatamente como configurados — se não, o job falha com erro. Um build com tema errado nunca chega silenciosamente ao release.

### 2.3 Workflow mergeado na `main` antes da tag

Um push de tag executa a versão do workflow presente **no commit da tag**, não a da branch `main`. Portanto: merge do workflow para a `main` ANTES de cortar qualquer tag de release real. Tags em commits de branch de trabalho rodam o workflow daquele commit, o que é aceitável justamente para as tags de smoke da seção 7.

## 3. Como cortar um release

Com as mudanças aprovadas e já na `main`:

```
git checkout main
git pull
git tag v1.2.0
git push origin v1.2.0
```

Depois:

1. Acompanhe os jobs na aba **Actions** do repositório (ou com `gh run watch`).
2. Ao final, abra **Releases** e revise o rascunho da tag: notas e artefatos esperados (seção 4).
3. Publique o release manualmente quando estiver satisfeito.

**Formato de tag é OBRIGATÓRIO: `v` + semver** (`vMAJOR.MINOR.PATCH`, ex.: `v1.2.0`). Motivos:

- O gatilho do workflow é `tags: ['v*']`; tag sem o prefixo `v` não dispara nada.
- A versão dos instaladores deriva da tag: o workflow roda `npm pkg set version="${GITHUB_REF_NAME#v}"` antes de cada build. O electron-builder NÃO deriva a versão da tag por conta própria; sem esse passo os pacotes sairiam com a versão antiga do `package.json`.

## 4. O que aparece no rascunho

Oito artefatos de instalação são o esperado num release completo:

| Plataforma | Artefato | Formato |
|------------|----------|---------|
| Windows | Instalador NSIS (Setup) | `.exe` |
| Windows | Executável portable (sem instalação) | `.exe` |
| Linux | AppImage | `.AppImage` |
| Linux | Pacote Debian | `.deb` |
| Linux | Pacote RPM | `.rpm` |
| Linux (job snap) | Snap | `.snap` (pode estar ausente, ver seção 5) |
| macOS | Imagem de disco | `.dmg` |
| macOS | Arquivo compactado | `.zip` |

Além deles, o electron-builder anexa os arquivos de metadados de auto-update: `latest.yml` (Windows), `latest-linux.yml` (Linux) e `latest-mac.yml` (macOS). Eles descrevem hash e URL da versão mais recente para ferramentas de atualização como o electron-updater. **Não apague esses arquivos do release.**

## 5. Políticas (re-run, re-tag, falhas)

### Re-run de job falho é seguro

O job `prepare` é idempotente (`gh release view || gh release create --draft`) e o rascunho já existe. Re-rodar apenas o job que falhou (botão "Re-run failed jobs" na aba Actions) sobe os artefatos faltantes para o mesmo rascunho.

### ANTES de re-push de tag: deletar o rascunho antigo

Se você precisa re-cortar a mesma tag (ex.: build quebrado descoberto depois do fato), o comportamento do electron-builder ao encontrar assets duplicados num rascunho existente é indefinido. Delete o rascunho e a tag antes de recomeçar:

```
gh release delete v1.2.0 --yes
git tag -d v1.2.0
git push origin :refs/tags/v1.2.0
# agora corte a tag novamente normalmente (seção 3)
```

### Snap pode falhar sem prejudicar o release

O job `snap` roda com `continue-on-error: true`. Se falhar, os demais jobs nem percebem e o release fica com os outros 7 artefatos; apenas o `.snap` fica de fora.

### Falha parcial deixa o rascunho incompleto

A matrix roda sem fail-fast: se a leg de um sistema falhar, as outras completam normalmente e o rascunho fica com os artefatos das plataformas que passaram. Re-rodando o job faltante (primeira política desta seção) o rascunho é completado. Antes de publicar, confira na tabela da seção 4 se nada além do `.snap` está faltando.

## 6. workflow_dispatch (build-only)

O workflow também aceita disparo manual (`workflow_dispatch`): aba **Actions → Release → Run workflow**.

No disparo manual o workflow roda em modo **build-only**:

- **Não publica nada**: os builds usam `--publish never` e nenhum rascunho é criado ou alterado.
- **Não altera a versão** dos pacotes: o passo de versão só roda para refs de tag.

O publish é sempre condicionado a `github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')`. Isso evita o footgun do `GITHUB_REF_NAME` virar o nome da branch (ex.: `main`) num disparo manual e produzir pacotes "versão main" publicados como lixo.

Use o dispatch para testar mudanças no workflow (caches, steps, runners) sem criar releases.

## 7. Testes E2E / tag de smoke

Procedimento reutilizável para validar o pipeline de ponta a ponta (workflow novo, mudança estrutural, runner alterado) sem poluir o repositório. Pré-requisitos: `gh` autenticado com acesso de push, workflow já presente na `main` (ou no commit que será tagado), secret `GH_CLIENT_ID` configurado.

```
# tag de teste com timestamp (nunca reutilize o mesmo nome)
TAG="v0.0.1-ci-smoke.$(date +%s)"
git tag "$TAG" && git push origin "$TAG"

# acompanhar a run até o fim (primeira execução sem cache: 30-40 min)
gh run watch

# asserir: exatamente 1 rascunho para a tag (prova que o prepare eliminou a race)
gh api repos/SEU_OWNER/SEU_REPO/releases \
  --jq "[.[] | select(.draft) | select(.tag_name==\"$TAG\")] | length"
# esperado: 1

# cleanup OBRIGATÓRIO (deleta o rascunho e a tag remota)
gh release delete "$TAG" --yes --cleanup-tag
git tag -d "$TAG"

# confirmar que a tag sumiu do remoto
git ls-remote --tags origin | grep -c "$TAG"
# esperado: 0
```

O rascunho de teste deve conter os artefatos da seção 4 (o `.snap` é opcional). Nenhuma release publicada pode ser criada por engano: a contagem de releases não-rascunho não pode aumentar.

## 8. Assinatura futura (apêndice)

Os builds de hoje são **não assinados**. Quando houver certificados, basta adicionar os secrets abaixo e descomentar os placeholders de env comentados no topo de `.github/workflows/release.yml`. Nenhum outro redesign é necessário.

**Windows** (assinatura de código):

- `CSC_LINK` (certificado em base64)
- `CSC_KEY_PASSWORD` (senha do certificado)

**macOS** (assinatura + notarização via App Store Connect API):

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Cuidado: NUNCA defina as variáveis `APPLE_*` em build não assinado. A notarização falha de imediato quando não encontra uma identidade de assinatura válida. É por isso que os placeholders ficam comentados até a assinatura existir de verdade.

## 9. Limitações conhecidas

- **Builds não assinados (Windows)**: o SmartScreen exibe "O Windows protegeu o computador". Para prosseguir: "Mais informações" → "Executar assim mesmo".
- **Builds não assinados (macOS)**: o Gatekeeper bloqueia aplicativo de desenvolvedor não identificado. Libere com botão direito → **Abrir**, ou removendo o atributo de quarentena:
  ```
  xattr -cr /Applications/Documental.app
  ```
- **Tags de prerelease podem perder o snap**: tags como `v1.2.3-rc.1` podem ser rejeitadas pelas regras de formato de versão do snapcraft. O job snap falha e a falha é absorvida pelo `continue-on-error`; os demais artefatos saem normalmente.
- **macOS apenas x64**: dmg e zip são gerados somente para x64. Macs Apple Silicon executam o app via Rosetta.

## 10. Providers Git no pipeline (testes escopados, cache do dugite e verificação do Git embutido)

O app suporta dois providers Git (`isomorphic-git` e `dugite`). O release pipeline os cobre em três pontos:

### Testes escopados por provider (antes do build)

Logo após o `npm ci` e antes de qualquer comando `build:*`, cada leg da matrix roda **duas** suítes escopadas:

- **Test (isomorphic-git)**: `GIT_PROVIDER=isomorphic-git npx vitest run tests/ipc tests/git-providers tests/git-layer-boundary.test.js tests/build-scripts.test.js`
- **Test (dugite)**: `GIT_PROVIDER=dugite npx vitest run tests/git-providers`

Deliberadamente **não** se roda o `npm test` completo: a suíte cheia inclui os casos quarentenados em `KNOWN-FAILURES`, que não dizem respeito ao empacotamento e falhariam o release sem trazer sinal útil.

### Cache do dugite (`DUGITE_CACHE_DIR`)

O postinstall do dugite baixa binários Git por sistema operacional. Os jobs definem `DUGITE_CACHE_DIR=${{ runner.temp }}/dugite-cache` e um passo `actions/cache@v4` (chave `${runner.os}-dugite-<hash do lockfile>`) persiste essa pasta entre runs, evitando o download em cada build. O cache é usado nos jobs da matrix e no job snap.

### `verify:bundled-git` (depois do build)

Após o passo de build de cada job, `npm run verify:bundled-git` procura o diretório `*-unpacked` no `dist/` e valida que os binários Git embutidos existem e que a versão bate com o `embedded-git.json`. **Decisão de posicionamento**: o publish acontece *dentro* do comando do electron-builder (`--publish always` no próprio `build:win`/`build:linux`/`build:macos`), não num passo separado — portanto o verify roda logo após esse passo e antes da verificação de tema. Ele não impede o upload (que já ocorreu), mas falha o job de forma visível: um rascunho com Git embutido quebrado nunca chega silenciosamente à revisão. O job snap também roda o verify; lá a falha é absorvida pelo `continue-on-error`, como todo o job.

## Resumo

| Situação | O que fazer |
|----------|-------------|
| Cortar release | `git tag vX.Y.Z && git push origin vX.Y.Z`, revisar rascunho, publicar |
| Job falhou | Re-run do job (seguro; rascunho já existe) |
| Re-cortar a mesma tag | `gh release delete vX.Y.Z --yes`, deletar a tag local e remota, cortar de novo |
| Testar o workflow sem release | Disparo manual (workflow_dispatch, build-only) |
| Validar E2E | Tag de smoke `v0.0.1-ci-smoke.<timestamp>` + cleanup (seção 7) |
