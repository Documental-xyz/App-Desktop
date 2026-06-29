# Git LFS como pré-requisito operacional no Documental 2.0

## Instruções gerais

Binários (imagens, vídeos, PDFs) sempre serão armazenados em `public/uploads/` e devem ser tratados com Git LFS. Colocar no `.gitignore` não é a melhor estratégia, pois assim os arquivos não vão para o repositório. O Git LFS resolve isso: os binários ficam versionados, mas o repositório continua leve e rápido.

OBS: Git LFS é um pré-requisito operacional do repositório do usuário, não uma dependência do app. O setup abaixo deve ser feito uma única vez por repositório.

## Por que usar Git LFS

- **Repositórios pequenos:** o Git guarda apenas ponteiros LFS no histórico, não o conteúdo binário completo. Clones e pulls ficam rápidos mesmo com centenas de imagens.
- **Operações rápidas:** `git push`, `git pull` e `git rebase` não sofrem com o peso de arquivos grandes travando o repositório.
- **Evita conflitos de merge em binários:** arquivos binários não têm diff textual. Sem LFS, qualquer alteração concorrente na mesma imagem vira um conflito difícil de resolver. Com LFS, o ponteiro é pequeno e o histórico permanece limpo.

## 1. Instalar o `git lfs` localmente

Baixe e instale o Git LFS a partir do site oficial: [https://git-lfs.com](https://git-lfs.com)

Disponível para Windows, macOS e Linux. A instalação adiciona o comando `git lfs` ao seu Git existente.

## 2. Inicializar o LFS no repositório

```
# Dentro da pasta do repositório
git lfs install
```

Esse comando configura os filtros LFS no repositório local. Só precisa rodar uma vez por máquina/clonagem.

## 3. Rastrear a pasta de binários

```
# Track todos os arquivos dentro de public/uploads
git lfs track "public/uploads/**"
```

Isso cria (ou atualiza) o arquivo `.gitattributes` na raiz do repositório com a regra de rastreamento.

## 4. Commitar o `.gitattributes`

O `.gitattributes` é um arquivo como qualquer outro no repositório e precisa ser commitado para que a regra LFS valha para todos que clonarem o projeto.

```
git add .gitattributes
git commit -m "Configura Git LFS para public/uploads"
git push origin preview
```

Depois disso, qualquer novo arquivo adicionado em `public/uploads/` é automaticamente enviado como objeto LFS.

## 5. Verificar o plano do GitHub

No GitHub, confirme que o plano do repositório comporta o uso de LFS:

- **Free tier:** 1 GB de armazenamento + 1 GB/mês de banda.
- **Plano Data Pack (pago):** US$ 5/mês por 50 GB de armazenamento + 50 GB/mês de banda.

Repositórios com muitas imagens ou vídeos tendem a ultrapassar o limite gratuito rapidamente. Monitore o consumo em **Settings → Billing → Git LFS Data**.

## Exemplo de `.gitattributes`

Após rodar `git lfs track "public/uploads/**"`, o arquivo `.gitattributes` na raiz do repositório ficará assim:

```
public/uploads/** filter=lfs diff=lfs merge=lfs -text
```

Mantenha esse arquivo versionado. Sem ele, o LFS não funciona para outros colaboradores.

## Por que o app não implementa LFS em código

O Documental usa **isomorphic-git** (puro JavaScript, v1.38.4) para todas as operações Git dentro do Electron. O isomorphic-git não tem suporte nativo a Git LFS. Implementar LFS no app significaria reimplementar o protocolo de smudge/clean filters, o servidor de transferência LFS e o cache de objetos, tudo isso fora do escopo do isomorphic-git.

Mais importante: **LFS é uma preocupação operacional do repositório do usuário, não do app.** O app lê e escreve arquivos no diretório de trabalho. Se o repositório está configurado para LFS, o Git LFS nativo do sistema (instalado no passo 1) cuida do smudge/clean transparentemente. O app não precisa saber que LFS existe.

O app se mantém neutro: funciona com ou sem LFS. A decisão e a configuração são do usuário, no nível do repositório.

## O que acontece quando um binário NÃO está no LFS e conflita durante o publish

Durante a publicação (rebase de `preview` para `main`), o app roda seu próprio `mergeDriver`. Quando ele detecta um conflito em um arquivo binário que não está sob LFS, o comportamento é o seguinte:

1. O `mergeDriver` identifica que o arquivo é binário (sem diff textual possível).
2. Ele cai no fallback gracioso: escreve o blob da versão "theirs" via `writeBlob`, ou seja, a versão recebida prevalece.
3. Uma mensagem de aviso é exibida para o usuário informando o conflito e a resolução automática.

Isso evita que o publish quebre, **mas não é recomendado para arquivos grandes.** Sem LFS, o conteúdo binário completo entra no histórico do Git a cada versão, o que infla o repositório e torna futuros clones e pulls lentos. Use LFS sempre que possível.

## Resumo

| Passo | Comando | Frequência |
|-------|---------|------------|
| Instalar Git LFS | Download em [https://git-lfs.com](https://git-lfs.com) | Uma vez por máquina |
| Inicializar no repo | `git lfs install` | Uma vez por clone |
| Rastrear binários | `git lfs track "public/uploads/**"` | Uma vez por repositório |
| Commitar `.gitattributes` | `git add .gitattributes && git commit` | Uma vez por repositório |
| Verificar plano GitHub | Settings → Billing → Git LFS Data | Monitoramento contínuo |

Configurado uma vez, o LFS trabalha silenciosamente. O app não precisa de nenhuma mudança para funcionar com ele.
