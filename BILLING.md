# Cobranças Stripe

O provedor escolhido é o **Stripe**. Checkout hospedado, portal do cliente e webhook foram implementados. A integração não foi executada contra uma conta Stripe real porque as credenciais não foram fornecidas. Nenhuma cobrança real foi criada nos testes.

## Configuração necessária

Defina no ambiente do Worker, fora do código e dos formulários públicos:

- `STRIPE_SECRET_KEY`: chave secreta da conta Stripe (`sk_test_...` durante homologação; `sk_live_...` em produção).
- `STRIPE_WEBHOOK_SECRET`: segredo `whsec_...` do destino de webhook correspondente ao mesmo modo.
- `SITE_URL`: origem HTTPS canônica da aplicação, sem caminho, consulta ou fragmento. HTTP é aceito somente em localhost com chave de teste.

Nunca publique essas chaves no navegador, no repositório ou em anexos. `GET /api/billing` informa somente provedor, modo, configuração concluída e nomes das configurações ausentes.

As migrações de `drizzle/` devem ser aplicadas antes de habilitar cobranças. Clientes, sessões, assinaturas e pagamentos são separados por `livemode`; dados de teste não liberam benefícios nem entram na receita quando o ambiente usa modo real. Sem chave configurada, as consultas usam apenas o modo real.

## Checkout e confirmação

O usuário autenticado envia `POST /api/billing` com `{ "action": "checkout", "planId": "pro" }`. O servidor consulta o plano persistido, valida preço e disponibilidade, grava uma cotação imutável e cria uma sessão Stripe com valores em centavos de BRL. A periodicidade opcional deve corresponder à configuração do plano; um plano anual deve ser cadastrado com periodicidade anual e preço total anual. O navegador recebe `{ "url": "...", "sessionId": "..." }` e encaminha o usuário ao Checkout.

O retorno `?billing=success` não concede acesso. Benefícios são concedidos somente após webhook autenticado e consulta da assinatura atual na API Stripe, com conferência do cliente, usuário, plano, cotação, moeda, quantidade e preço. Assinaturas `active` ou `trialing` precisam ter confirmação persistida e período vigente. Inadimplência, assinatura incompleta, suspensão e preço desconhecido não concedem benefícios.

Períodos de teste seguem a configuração do plano e somente podem ser usados uma vez por cliente em cada modo. A cotação aceita preserva o preço contratado mesmo que o administrador altere posteriormente o preço público. Sessões em aberto são reutilizadas e operações de criação usam chaves de idempotência.

## Webhook

Cadastre um destino de eventos **snapshot** em:

`https://SEU-DOMINIO/api/billing/webhook`

A integração fixa as consultas REST na versão `2025-06-30.basil`. Configure o destino de webhook nessa versão e habilite os eventos utilizados:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`.
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`.
- `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`, `invoice.marked_uncollectible`.
- `charge.refunded`.

O handler autentica os bytes originais com HMAC SHA-256 via WebCrypto, aceita múltiplas assinaturas `v1` durante rotação e aplica tolerância de cinco minutos. Eventos são registrados por ID e modo. Uma reserva no D1 serializa a consulta atual de cada assinatura; revisões impedem gravações por processos cuja reserva expirou. Atualizações financeiras e confirmação de processamento são gravadas em lote. Falhas retornam erro para que o Stripe repita a entrega. A ordem e o segundo de criação dos eventos não determinam o estado da assinatura.

O processamento é síncrono e adequado ao fluxo inicial. Antes de aumento substancial de volume, mova o processamento autenticado para uma fila durável, mantendo idempotência e conciliação. Nenhum indicador de disponibilidade externo é simulado.

## Portal, cancelamento e alterações de plano

Configure e ative o portal do cliente no painel Stripe, incluindo cancelamento e atualização de meios de pagamento. `POST /api/billing` com `{ "action": "portal" }` usa somente o cliente Stripe vinculado à identidade autenticada. O webhook confirma cancelamentos e mantém acesso até o fim do período quando o Stripe mantém a assinatura ativa durante esse intervalo.

**Upgrade e downgrade com migração comercial ainda exigem implementação de um catálogo Stripe mapeado aos planos e regras explícitas de consentimento/prorrateio.** O checkout atual usa preços inline. Não habilite troca arbitrária de produtos no portal: uma alteração de preço sem correspondência com a cotação original bloqueia o acesso pago e gera evento de revisão. A plataforma não cria uma segunda assinatura para substituir uma assinatura não cancelada. Esse recurso não deve ser anunciado como concluído.

A exclusão de conta é bloqueada enquanto houver assinatura real não encerrada ou checkout real ainda vigente, evitando cobranças recorrentes sem vínculo local. O cancelamento no provedor deve ser confirmado antes da exclusão dos dados.

## Receita e validação

MRR usa assinaturas vigentes; pagamentos usam registros de pagamento de faturas e PaymentIntents confirmados pelo Stripe. Faturas liquidadas por crédito ou fora do provedor não são inventadas como novos recebimentos. Estornos atualizam o valor líquido e o valor estornado. Esses valores são recebimentos brutos do provedor antes de taxas e não equivalem a conciliação de depósitos bancários.

Execute `node --test tests/billing.test.mjs tests/database.test.mjs tests/security.test.mjs`. Os testes usam respostas Stripe controladas e SQLite real com a cadeia de migrações; cobrem assinatura HMAC, replay, idempotência, concorrência, mudança de ordem, preço imutável, estorno e isolamento entre teste e produção.

Antes de comercializar, valide em sandbox com a Stripe CLI: contratação, pagamento recusado, período de teste, renovação, cancelamento imediato e no fim do período, entregas duplicadas, eventos fora de ordem, estorno e troca das chaves de teste por produção. Depois confirme o destino público e o portal da conta real.

Documentação oficial: [Checkout](https://docs.stripe.com/api/checkout/sessions/create), [portal do cliente](https://docs.stripe.com/api/customer_portal/sessions/create), [webhooks, assinaturas e ordem dos eventos](https://docs.stripe.com/webhooks), [idempotência](https://docs.stripe.com/api/idempotent_requests), [pagamentos de faturas](https://docs.stripe.com/api/invoice-payment/list).
