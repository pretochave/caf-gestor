# CaféGestor — versão independente

Aplicativo em português com site público, cadastro próprio, confirmação de e-mail por link, login e senha, sessão e área privada por produtor. A autenticação padrão usa Firebase Authentication. O visitante não precisa de conta Google, ChatGPT ou OpenAI para criar sua conta com e-mail e senha.

## Estado da publicação

Site independente publicado em [cafegestor.cafegestor.workers.dev](https://cafegestor.cafegestor.workers.dev), com banco D1 remoto configurado. O código está no [GitHub](https://github.com/pretochave/caf-gestor). O endereço workers.dev permite manter o acesso público sem registrar um domínio próprio.

O Firebase `cafegestor-77252` está integrado à versão publicada: E-mail/senha habilitado, domínio autorizado, variáveis do Worker aplicadas e cinco migrações do D1 concluídas. O endpoint de configuração confirma `provider: firebase`, `verificationMethod: link` e nenhuma configuração ausente. O envio usa o próprio Firebase, sem comprar domínio nem configurar Resend. O teste de recebimento e confirmação em uma caixa de entrada real ainda está pendente; configuração válida não comprova entrega. Veja [AUTHENTICATION.md](AUTHENTICATION.md).

Os links usam a página de ação padrão do Firebase. O console recusou a personalização dos modelos e da URL de ação neste projeto; após confirmar ou redefinir a senha nessa página, o cliente volta ao CaféGestor para entrar.

## Começar

Requer Node.js 22.13+ com npm.

```powershell
npm ci
npm run db:cloudflare -- --local
npm run dev:cloudflare
```

A prévia abre em http://127.0.0.1:5174. Use `.dev.vars` ignorado pelo Git para os valores de desenvolvimento. O banco independente fica em `.cloudflare-runtime/state`, separado da antiga prévia do Sites.

A configuração padrão exige `AUTH_PROVIDER=firebase`, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `SITE_URL` e `BETTER_AUTH_SECRET`, além do binding D1 `DB`. `ADMIN_EMAIL` define o administrador após a confirmação do e-mail. Os valores ficam no servidor; o `.env.example` contém somente nomes e exemplos vazios.

## Fluxo de autenticação

1. Nome, e-mail e senha de 10 a 128 caracteres em `/cadastro`.
2. Link de confirmação enviado pelo Firebase. O cliente abre o link recebido para confirmar o e-mail. O reenvio tem intervalo mínimo de 60 segundos.
3. Conta ativada entra por e-mail e senha em `/login`.
4. “Esqueci minha senha” solicita um link seguro ao Firebase. A validade e a aplicação do código de ação são verificadas pelo serviço; a troca encerra as sessões anteriores da aplicação.
5. Sessão persistente com cookie HttpOnly/Secure em HTTPS; o botão Sair revoga a sessão no banco.
6. Páginas e operações privadas verificam a sessão no servidor. Administração exige o e-mail configurado em `ADMIN_EMAIL` com verificação concluída.

O servidor usa a API HTTPS oficial do Firebase Authentication para cadastro, login, confirmação e recuperação. As sessões da aplicação usam cookies opacos e HttpOnly, com tokens do provedor criptografados no D1. O cliente não recebe os tokens de renovação. A identidade privada depende do UID confirmado pelo Firebase; a coincidência de e-mail não vincula contas antigas a contas novas.

O fluxo anterior BetterAuth/Resend foi preservado como alternativa legada e permanece inativo quando `AUTH_PROVIDER=firebase`. Ele exige suas próprias credenciais e um remetente verificado, e não é necessário para o Firebase.

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

Foram aprovados 66 testes, sem testes ignorados, além da validação de tipos e do build independente. A cobertura inclui autenticação Firebase, respostas inválidas do provedor, exclusão de conta, fluxo legado, operações de gestão, autorização, isolamento por produtor, limites atômicos, suporte, Excel e pagamentos Stripe simulados. Um teste com workerd e D1 reais também confere as chamadas aos provedores e a rejeição de redirecionamentos. Na publicação, a conexão real ao Firebase foi validada com login de credenciais inválidas e solicitação de recuperação para endereço reservado sem conta; o dashboard sem sessão redirecionou para o login próprio. Esses testes não comprovam entrega de mensagem em uma caixa de entrada.

Para a validação independente dos arquivos Excel, configure `CAFEGESTOR_TEST_PYTHON` com um Python que possua openpyxl. Sem isso, apenas esse teste é sinalizado como ignorado.

## Pendências comerciais anteriores

A integração Stripe permanece condicionada a credenciais, homologação real e configuração das regras de upgrade/downgrade. Veja [BILLING.md](BILLING.md). Revisão dos termos/política, dados do controlador, retenção/backups e observabilidade externa continuam necessários antes do lançamento comercial. A exportação em PDF usa a função Imprimir/Salvar como PDF do navegador.

Foto ilustrativa de cafezal: [Crest Coffee Roasters — Fazenda Dutra](https://www.crestcoffeeroasters.com/shop/p/medium-roast-brazil). A imagem não representa propriedade de cliente cadastrado.
