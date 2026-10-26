# Publicação independente do CaféGestor

Esta versão roda na conta Cloudflare do proprietário, em um Worker público com D1. O visitante abre o endereço diretamente e usa o cadastro e a sessão do CaféGestor. A configuração não importa o plugin Sites, o proxy de conectores ou a autenticação ChatGPT. A versão antiga hospedada em `chatgpt.site` não é alterada por estes comandos.

## O que precisa ser fornecido

1. Acesso à conta GitHub na qual o repositório será criado. O código pode ficar em um repositório privado; a aplicação hospedada pode ser pública.
2. Acesso à conta Cloudflare e seu `CLOUDFLARE_ACCOUNT_ID`. Para CI, um token limitado à conta com permissões de publicar Workers e administrar o D1 selecionado. Use a interface da Cloudflare ou secrets do GitHub, sem colar tokens em chats.
3. O identificador real do banco D1. `cloudflare:provision` cria ou reutiliza `cafegestor-db` na conta selecionada e grava seu UUID. O UUID inicialmente presente no arquivo é exclusivo do desenvolvimento local; o comando de publicação recusa esse valor.
4. Os secrets e o remetente do serviço de e-mail usados pela autenticação nativa, descritos no guia de autenticação. Sem um remetente autorizado e uma chave de envio, nenhuma entrega real de código ou recuperação de senha pode ser confirmada.
5. O endereço HTTPS definitivo em `SITE_URL`, após a primeira publicação. As credenciais de autenticação e e-mail são configuradas como secrets no Worker, nunca como variáveis `VITE_` ou código no navegador.

## Preparar e conferir localmente

Requer Node.js 22.13 ou superior, npm e as dependências do projeto.

```powershell
npm ci --include=dev --include=optional
npm run db:cloudflare -- --local
npm run dev:cloudflare
```

A prévia usa `http://127.0.0.1:5174`. O banco e os logs locais ficam em `.cloudflare-runtime/`, separados do banco de teste antigo do Sites. As migrações são copiadas sem alteração do diário Drizzle e aplicadas pelo ledger `cafegestor_migrations`, para que novas execuções não repitam alterações já aplicadas.

`wrangler.jsonc` usa JSON válido, embora a extensão também aceite comentários. Mantenha o arquivo como JSON válido: os scripts o leem para conferir conta, Worker e banco de destino.

## Provisionar e publicar na sua conta

Primeiro faça login pela autenticação oficial do Wrangler:

```powershell
npx wrangler login
$env:CLOUDFLARE_ACCOUNT_ID = "ID_REAL_DA_SUA_CONTA"
npm run cloudflare:provision
npm run build:cloudflare
npm run deploy:cloudflare -- --dry-run
npm run deploy:cloudflare
```

O comando `deploy:cloudflare` valida o destino, confere se a compilação usa a mesma conta e o mesmo banco, aplica apenas migrações pendentes no D1 remoto e publica os arquivos gerados em `dist-cloudflare/server/wrangler.json`. A opção `--dry-run` valida e empacota o Worker sem aplicar migrações remotas ou publicar.

O Wrangler informa o endereço `https://cafegestor.<subdominio-da-conta>.workers.dev`. Copie o endereço retornado pela Cloudflare; o subdomínio não deve ser adivinhado. Configure `SITE_URL` com essa origem e os secrets de autenticação e e-mail no painel **Workers & Pages → cafegestor → Settings → Variables and Secrets**. Quando configurados, valide o fluxo com um endereço de e-mail seu antes de divulgar o link na bio.

Também é possível usar um domínio próprio pelo painel Cloudflare. Alterar a origem exige atualizar `SITE_URL` e conferir os retornos da autenticação e do pagamento.

## Publicação contínua pelo GitHub

O workflow `.github/workflows/cloudflare.yml` instala dependências, confere os tipos e executa os testes quando a branch `main` recebe alterações ou pela ação manual. A publicação fica desabilitada até a configuração da conta estar concluída. Configure no repositório:

- Ambiente GitHub `production` com secret `CLOUDFLARE_API_TOKEN`.
- Variáveis `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_D1_DATABASE_ID`, com os valores reais.
- Os secrets de execução da aplicação ficam no Worker. O workflow não grava senhas ou chaves no repositório e não altera os secrets já configurados.

Depois de conferir o token e os identificadores, crie a variável de repositório `CLOUDFLARE_DEPLOY_ENABLED` com o valor `true` em **Settings → Secrets and variables → Actions → Variables**. Ela deve ser uma variável do repositório, pois é avaliada antes de iniciar o ambiente `production`. Com essa flag, o job de publicação executa somente depois da validação passar. Sem a flag ou com outro valor, a validação continua e o job de publicação é ignorado. Para desativar a publicação automática, altere a flag para `false`.

Se preferir **Cloudflare Workers Builds**, conecte o repositório GitHub ao Worker chamado `cafegestor`. Use `npm run build:cloudflare` como comando de build e `npm run deploy:cloudflare` como comando de publicação. Configure os identificadores da conta e do D1 no ambiente de build. Use apenas uma automação de publicação por branch para evitar deploys duplicados.

## Migração de dados e de usuários

O D1 independente é outro banco. O provisionamento não copia dados de produção do Sites nem vincula automaticamente contas nativas a contas ChatGPT que tenham o mesmo e-mail. Uma migração desses registros exige exportação autorizada, mapeamento explícito de usuários e validação das permissões. Isso evita atribuir dados privados a alguém apenas por informar um endereço de e-mail.

O código continua separando os registros por usuário. O cadastro de administrador depende do endereço configurado e da verificação exigida pela autenticação nativa; informar o e-mail do administrador em um formulário não concede acesso.

## Referências oficiais

- [Vinext e Cloudflare Workers](https://github.com/cloudflare/vinext#cloudflare-workers)
- [Workers Builds e GitHub](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Migrações D1](https://developers.cloudflare.com/d1/reference/migrations/)
- [Secrets de Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
