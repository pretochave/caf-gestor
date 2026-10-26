# CaféGestor — versão independente

Aplicativo em português com site público, cadastro próprio, verificação por código de e-mail, login e senha, sessão e área privada por produtor. O build independente não exige conta ChatGPT/OpenAI e não usa os cabeçalhos de autenticação da hospedagem antiga.

## Estado da publicação

Site independente publicado em [cafegestor.cafegestor.workers.dev](https://cafegestor.cafegestor.workers.dev), com banco D1 remoto configurado. O código está no [GitHub](https://github.com/pretochave/caf-gestor). `SITE_URL`, `BETTER_AUTH_SECRET` e `ADMIN_EMAIL` já estão configurados no Worker, somente no servidor.

O envio real dos códigos e links de recuperação, assim como a ativação de novas contas, ainda aguarda um domínio/remetente verificado no Resend e a configuração de `RESEND_API_KEY` e `EMAIL_FROM`. Sem essas duas configurações, o cadastro informa a pendência e não simula o envio. Veja [AUTHENTICATION.md](AUTHENTICATION.md).

## Começar

Requer Node.js 22.13+ com npm.

```powershell
npm ci
npm run db:cloudflare -- --local
npm run dev:cloudflare
```

A prévia abre em http://127.0.0.1:5174. Use `.dev.vars` ignorado pelo Git para os valores de desenvolvimento. O banco independente fica em `.cloudflare-runtime/state`, separado da antiga prévia do Sites.

A configuração de autenticação exige `SITE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY` e `EMAIL_FROM`, além do binding D1 `DB`. Veja [AUTHENTICATION.md](AUTHENTICATION.md) para configurar o remetente e os testes. Sem a integração de e-mail, o cadastro retorna um erro explícito e não informa que enviou um código.

## Fluxo de autenticação

1. Nome, e-mail e senha de 10 a 128 caracteres em `/cadastro`.
2. Código numérico de 6 dígitos enviado pelo Resend; validade de 10 minutos, até 5 tentativas e reenvio após 60 segundos. A verificação acontece no próprio site.
3. Conta ativada entra por e-mail e senha em `/login`.
4. “Esqueci minha senha” envia um link válido por 30 minutos e uma única utilização. A troca revoga as sessões anteriores.
5. Sessão persistente com cookie HttpOnly/Secure em HTTPS; o botão Sair revoga a sessão no banco.
6. Páginas e operações privadas verificam a sessão no servidor. Administração exige o e-mail configurado em `ADMIN_EMAIL` com verificação concluída.

BetterAuth 1.7.12 mantém credenciais e sessões no D1 com adaptador Drizzle. As senhas usam o hash scrypt da biblioteca. Códigos e identificadores dos tokens são protegidos por hash/HMAC. Limites de tentativa, intervalo de reenvio e serialização de operações usam D1, preservando o controle entre processos e requisições simultâneas.

## Módulos de gestão

Fazendas e talhões, despesas e receitas, safras e produção, dashboard, simulador, cinco relatórios, Excel/CSV e impressão em PDF, planos e suporte. CaféGestor Business inclui CRM e histórico, usuários, planos, assinaturas, finanças, suporte, configurações e auditoria. O banco usa vínculos compostos de propriedade e predicados de usuário nas operações.

Os registros de demonstração do botão “Explorar exemplo” ficam apenas na memória da interface e são identificados como ilustrativos. Não são gravados como clientes ou dados reais.

## Publicar

Repositório de destino informado pelo proprietário: https://github.com/pretochave/caf-gestor.git.

Consulte [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md). O Worker terá endereço público workers.dev na conta Cloudflare escolhida. O código pode permanecer em repositório privado. Scripts não publicam usando identificadores de banco fictícios.

```powershell
npm run cloudflare:provision
npm run build:cloudflare
npm run deploy:cloudflare
```

O deploy aplica apenas migrações pendentes, usando ledger do D1. Não altere arquivos SQL já aplicados; adicione migrações novas. Os valores reais de secrets ficam nas configurações do Worker ou no gerenciador de credenciais do CI.

O antigo build do Sites foi preservado apenas como histórico de migração; a publicação antiga em `chatgpt.site` não é atualizada pelo comando de deploy independente. Dados antigos não são ligados a uma nova conta por coincidência de e-mail. Essa migração, se necessária, exige mapeamento explícito de usuários para preservar a propriedade dos registros.

## Verificação

```powershell
npm test
npx tsc --noEmit
npm run build:cloudflare
```

Há testes de autenticação com servidor BetterAuth real, SQLite e transporte de e-mail controlado; também há testes do adaptador HTTP do Resend com respostas controladas, autorização, isolamento por produtor, limites atômicos, suporte, geração de Excel e pagamentos Stripe simulados. Os testes de e-mail controlado não equivalem à entrega de mensagem real em uma caixa de entrada.

Para a validação independente dos arquivos Excel, configure `CAFEGESTOR_TEST_PYTHON` com um Python que possua openpyxl. Sem isso, apenas esse teste é sinalizado como ignorado.

## Pendências comerciais anteriores

A integração Stripe permanece condicionada a credenciais, homologação real e configuração das regras de upgrade/downgrade. Veja [BILLING.md](BILLING.md). Revisão dos termos/política, dados do controlador, retenção/backups e observabilidade externa continuam necessários antes do lançamento comercial. A exportação em PDF usa a função Imprimir/Salvar como PDF do navegador.

Foto ilustrativa de cafezal: [Crest Coffee Roasters — Fazenda Dutra](https://www.crestcoffeeroasters.com/shop/p/medium-roast-brazil). A imagem não representa propriedade de cliente cadastrado.
