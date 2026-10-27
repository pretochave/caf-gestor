# Autenticação com Firebase, sem domínio pago

O cliente cria sua conta com nome, e-mail e senha no CaféGestor. Firebase Authentication cuida das credenciais e envia os links de confirmação e recuperação. O aplicativo continua hospedado na Cloudflare em [cafegestor.cafegestor.workers.dev](https://cafegestor.cafegestor.workers.dev). O cliente não precisa de conta Google, ChatGPT ou OpenAI.

## Estado da ativação

A integração Firebase está publicada no Worker, com a migração `0004_firebase_sessions` aplicada. O projeto `cafegestor-77252` está no plano Spark, E-mail/senha está habilitado e `cafegestor.cafegestor.workers.dev` consta nos domínios autorizados. Os seis secrets do Worker foram aplicados; `/api/auth/status` confirmou Firebase por link, configuração completa e nenhuma variável ausente. O teste de recebimento e confirmação em uma caixa de entrada real ainda está pendente. A presença de código e variáveis não comprova entrega de e-mail.

O console deste projeto recusou alterações de modelos de e-mail com a mensagem “As atualizações de modelos de e-mail não estão disponíveis para este projeto” e orientou entrar em contato com o Suporte do Firebase. Assim, permanecem o remetente padrão `noreply@cafegestor-77252.firebaseapp.com` e a página de ação `https://cafegestor-77252.firebaseapp.com/__/auth/action`. O cliente confirma o e-mail ou redefine a senha nessa página e volta ao CaféGestor para entrar. O servidor solicita o idioma português pelo cabeçalho oficial `X-Firebase-Locale: pt-BR`; a mensagem recebida ainda precisa ser conferida.

O fluxo anterior BetterAuth/Resend é uma alternativa legada, inativa quando `AUTH_PROVIDER=firebase`. `RESEND_API_KEY` e `EMAIL_FROM` não são necessários para o fluxo Firebase.

## Configurar o projeto Firebase

1. No [console Firebase](https://console.firebase.google.com/), selecionar o projeto `cafegestor-77252`. Manter o plano **Spark**, sem vincular uma conta de faturamento.
2. Em **Authentication → Sign-in method**, habilitar apenas **E-mail/senha**. A autenticação por link sem senha não é necessária: o usuário continuará usando sua senha.
3. Em **Authentication → Settings → Authorized domains**, adicionar `cafegestor.cafegestor.workers.dev`, sem `https://` e sem caminho.
4. Em **Project settings → General**, registrar um aplicativo Web para o CaféGestor. Não é necessário ativar Firebase Hosting; o site permanece na Cloudflare. Obter o ID do projeto e a chave de API correspondente.
5. Em **Authentication → Templates**, conferir os modelos de confirmação de e-mail e recuperação de senha. Neste projeto, a edição foi recusada pelo console; os modelos padrão permanecem em uso.
6. Se o Firebase liberar a edição no futuro, a integração já aceita a URL de ação `https://cafegestor.cafegestor.workers.dev/firebase-action`. Configurar somente essa URL: o Firebase acrescenta parâmetros como `mode` e `oobCode` ao enviar a mensagem. Não inserir códigos fixos no modelo. Conferir o fluxo antes de trocar o manipulador padrão.

Os manipuladores padrão hospedados pelo Firebase validam os links na configuração atual. O usuário conclui a ação na página do Firebase e volta ao CaféGestor para entrar. Isso não exige uma conta Google do cliente nem a compra de um domínio.

O envio nativo de confirmação e recuperação usa a infraestrutura do Firebase, sem autenticar um domínio próprio no Resend. O plano Spark possui cotas; na documentação consultada, são até **1.000 e-mails de confirmação por dia** e **150 e-mails de recuperação por dia**. Esses limites podem mudar e não representam envio ilimitado. Consulte os [limites oficiais](https://firebase.google.com/docs/auth/limits).

## Configuração no servidor Cloudflare

| Nome | Valor |
| --- | --- |
| `AUTH_PROVIDER` | `firebase`. |
| `FIREBASE_PROJECT_ID` | `cafegestor-77252`, ID do projeto criado. |
| `FIREBASE_API_KEY` | Chave de API do mesmo projeto, autorizada a usar Firebase Authentication. |
| `SITE_URL` | `https://cafegestor.cafegestor.workers.dev`, sem caminho ou query. |
| `BETTER_AUTH_SECRET` | Segredo aleatório de pelo menos 32 caracteres, mantido estável no servidor para proteger a sessão e os tokens armazenados. |
| `ADMIN_EMAIL` | E-mail do administrador informado pelo proprietário, configurado somente no servidor. O e-mail precisa estar confirmado pelo Firebase. |
| `DB` | Binding para o banco D1 migrado. Não é uma variável textual. |

Configurar em **Workers & Pages → cafegestor → Settings → Variables and Secrets**, ou com `wrangler secret put NOME`. Fazer Deploy após aplicar os valores. O `.env.example` contém os nomes; `.dev.vars` e arquivos de ambiente locais são ignorados pelo Git.

Em SDKs convencionais, a chave Firebase identifica o projeto e não é uma chave privada de conta de serviço. Nesta arquitetura, as chamadas ao Firebase saem do servidor e a chave permanece na configuração do Worker. Não é necessário colocar uma conta de serviço ou chave privada no navegador. Não enviar chaves, senhas ou tokens ao GitHub ou ao chat.

## Fluxo e proteção de dados

- Cadastro: nome, e-mail e senha; o servidor solicita o envio do link de confirmação.
- Ativação: o Firebase valida o código de ação recebido no link. O aplicativo exige e-mail confirmado antes de liberar dados privados.
- Login: e-mail e senha, com verificação da identidade no servidor.
- Reenvio: intervalo mínimo de 60 segundos e limite de cinco solicitações em 15 minutos por e-mail, além dos limites por IP persistidos no D1. Pode exigir a senha novamente.
- Recuperação: link de ação emitido pelo Firebase, validado no servidor antes de trocar a senha. Links inválidos, usados ou expirados não autorizam a troca. A validade dos links é definida pelo Firebase, não pelos prazos do fluxo legado.
- Sessão: cookie opaco HttpOnly, Secure em HTTPS e SameSite=Lax. Com a opção de continuar conectado, a sessão da aplicação dura até sete dias; sem essa opção, o cookie é de sessão e o registro expira em até 24 horas. Tokens do Firebase ficam criptografados com AES-GCM no D1; o cookie é armazenado como hash HMAC e a senha não é persistida pela aplicação.
- Conta pendente: a sessão limitada de 15 minutos permite somente reenviar a confirmação; não libera dados privados.
- Revogação: o servidor renova e consulta os tokens no Firebase ao autorizar acesso, para validar o estado atual da conta. Sair revoga a sessão da aplicação; redefinir a senha encerra as sessões anteriores.
- Área privada: usa a identidade `firebase:projectId:uid`, obtida do provedor, nunca um e-mail ou identificador fornecido pelo navegador. Cabeçalhos da hospedagem antiga não autenticam um usuário.

Uma conta nova não herda registros de uma conta legada por ter o mesmo e-mail. Uma migração de dados exige mapeamento explícito de usuários e conferência das permissões.

## Endpoints da aplicação

| Método e caminho | Dados principais |
| --- | --- |
| POST `/api/auth/sign-up/email` | `name`, `email`, `password`. |
| POST `/api/auth/sign-in/email` | `email`, `password`, `rememberMe`. |
| POST `/api/auth/send-verification-email` | `email` e, quando necessário, `password` para reautenticação. |
| POST `/api/auth/verify-email` | `oobCode` recebido no link. |
| POST `/api/auth/request-password-reset` | `email`. |
| POST `/api/auth/reset-password` | `token` (o `oobCode` do Firebase), `newPassword`. |
| POST `/api/auth/sign-out` | Objeto JSON vazio. |
| GET `/api/auth/get-session` | Consulta da sessão atual. |
| GET `/api/auth/status` | Estado de configuração e políticas, sem valores de chaves ou tokens. |

As mutações aceitam JSON da origem autorizada. O callback `/firebase-action` encaminha os modos `verifyEmail` e `resetPassword` para a interface correspondente; `/verificar-email` e `/redefinir-senha` também aceitam os parâmetros dos links. As URLs de continuação solicitadas pelo servidor são restritas ao próprio CaféGestor.

O estado de configuração informa `provider: firebase`, `verificationMethod: link`, os nomes de configurações ausentes e as políticas públicas. O campo `configured` não garante entrega na caixa de entrada: somente um envio real seguido da confirmação pelo destinatário comprova o fluxo completo.

## Validar antes de divulgar o cadastro

1. Confirmar que o projeto está no plano Spark e que E-mail/senha está habilitado.
2. Criar uma conta de teste com uma caixa de entrada acessível. Conferir o recebimento real do link e a identidade visual da mensagem.
3. Conferir que o login privado é recusado antes da confirmação do e-mail.
4. Abrir o link, confirmar o e-mail e entrar com a senha. Testar um link inválido, expirado ou já utilizado.
5. Testar reenvio antes e depois do intervalo mínimo e uma falha do serviço de envio. A interface não deve anunciar envio quando o provedor retorna erro.
6. Sair e conferir que a sessão anterior não abre a área privada.
7. Solicitar recuperação, receber o link e trocar a senha. Conferir que senha e sessões anteriores não continuam válidas.
8. Criar outro usuário e testar o isolamento das fazendas, lançamentos e chamados.

Os 66 testes automatizados passaram, sem testes ignorados, assim como a validação de tipos e o build independente. Eles incluem respostas controladas para erros, limites, protocolo do Firebase e exclusão de conta, além de chamadas aos provedores no workerd com D1 real. O transporte usa `redirect: manual`, aceito pelo runtime Cloudflare, e rejeita redirecionamentos sem encaminhar credenciais. Na publicação, o endpoint de configuração, a conexão real ao Firebase com credenciais inválidas e o redirecionamento do dashboard sem sessão foram conferidos. A validação com uma caixa real continua necessária para confirmar a entrega pelo Firebase.

## Referências oficiais

- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth).
- [Confirmação de e-mail e recuperação de senha](https://firebase.google.com/docs/auth/web/manage-users).
- [Manipuladores personalizados de ações por e-mail](https://firebase.google.com/docs/auth/custom-email-handler).
- [Limites do Firebase Authentication](https://firebase.google.com/docs/auth/limits).
- [Secrets da Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/).
