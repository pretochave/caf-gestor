# Configuração da autenticação independente

## Serviço integrado

BetterAuth fornece o cadastro e as sessões. Resend é o serviço integrado de envio de e-mail. A aplicação chama o endpoint oficial `https://api.resend.com/emails` a partir do servidor e exige a confirmação HTTP com identificador da mensagem. Nenhuma chave é importada por componentes de navegador.

## O que o responsável precisa configurar

1. Uma conta Cloudflare com Worker e banco D1 (o projeto inclui provisionamento e publicação).
2. Uma conta Resend com chave API de envio.
3. Um domínio próprio com acesso ao DNS. Adicione esse domínio no Resend e publique os registros solicitados por ele, incluindo SPF/DKIM. Aguarde o estado Verified.
4. Um remetente desse domínio, por exemplo `CaféGestor <acesso@seu-dominio.com.br>`.

O domínio de envio pode ser diferente do endereço público do aplicativo. O site pode usar workers.dev enquanto o remetente usa o seu domínio de e-mail. Como o proprietário informou que ainda não tem domínio, essa etapa e a chave de envio permanecem pendentes.

Não use credenciais de teste ou um remetente não verificado como se fossem um serviço de cadastro público homologado. O domínio de teste do provedor tem restrições de destinatários e não substitui um remetente de produção.

## Secrets do Worker

| Nome | Valor |
|---|---|
| `SITE_URL` | Origem HTTPS exata do endereço publicado, sem caminho, query ou barra adicional. |
| `BETTER_AUTH_SECRET` | Segredo aleatório com pelo menos 32 caracteres, gerado uma vez e mantido apenas no servidor. |
| `RESEND_API_KEY` | Chave API real do Resend, com permissão para enviar pelo domínio escolhido. |
| `EMAIL_FROM` | Remetente verificado; por exemplo CaféGestor <acesso@seu-dominio.com.br>. |
| `ADMIN_EMAIL` | E-mail do administrador informado pelo proprietário, configurado somente no servidor. Só concede administração após verificação do e-mail. |
| `DB` | Binding para o banco D1 provisionado e migrado; não é uma variável textual. |

Configure as chaves no painel Worker → Settings → Variables and Secrets, ou por `wrangler secret put NOME`. Não as envie para o GitHub, para formulários públicos ou para mensagens deste chat. O `.env.example` contém apenas os nomes. `.dev.vars` e arquivos de ambiente estão ignorados pelo Git.

## Endpoints reais

- POST `/api/auth/sign-up/email`: name,email,password.
- POST `/api/auth/email-otp/send-verification-otp`: email,type=email-verification.
- POST `/api/auth/email-otp/verify-email`: email,otp.
- POST `/api/auth/sign-in/email`: email,password,rememberMe.
- POST `/api/auth/request-password-reset`: email,redirectTo.
- POST `/api/auth/reset-password`: token,newPassword.
- POST `/api/auth/sign-out`: objeto JSON vazio.
- GET `/api/auth/status`: informa configuração e políticas, sem devolver os valores secretos.

As mutações aceitam somente JSON da origem configurada. Links de recuperação sempre retornam à página própria `/redefinir-senha`. Rotas opcionais da biblioteca para login por OTP, alteração de e-mail e associação de contas não estão expostas.

## Validar com entrega real após configurar

1. Crie uma conta descartável com um e-mail que você consiga consultar.
2. Confira que o login é recusado antes da verificação.
3. Receba e digite o código no aplicativo. Confirme a ativação e entre com a senha.
4. Verifique um código incorreto, código expirado, limite de cinco tentativas e reenvio antes de 60 segundos.
5. Saia e confira que a sessão anterior não abre a área privada.
6. Solicite recuperação e abra o link recebido. Depois da troca, confira que senha e sessões antigas deixam de funcionar e que o link não pode ser usado novamente.
7. Cadastre outro usuário e confira que não acessa fazendas, lançamentos ou chamados do primeiro.

Os testes automatizados já exercitam esse fluxo com SQLite e envio controlado. A entrega real pelo Resend só pode ser confirmada depois de configurar a chave e o remetente e concluir esta validação com uma caixa de entrada real.
