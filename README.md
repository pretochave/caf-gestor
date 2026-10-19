# CaféGestor + CaféGestor Business

Plataforma em português para organizar propriedades de café, safras, custos, receitas, produção e a operação comercial do SaaS.

## Arquitetura desta entrega

- React 19 + TypeScript, roteamento App Router compatível com Next.js via Vinext e Vite.
- Cloudflare Workers na hospedagem Sites, D1/SQLite persistente e migrações Drizzle.
- Autenticação gerenciada pela plataforma Sites (entrar com ChatGPT). A recuperação e a verificação da conta são feitas pelo provedor de identidade. Não há cadastro nativo por senha, Supabase Auth ou PostgreSQL/RLS nesta implementação.
- Isolamento dos dados por usuário em cada operação do servidor, chaves estrangeiras compostas de propriedade e índices. O cliente não define ownerId, papéis ou assinaturas.
- Administrador autorizado por ADMIN_EMAIL no ambiente do servidor. Não existe cadastro público de administradores nem promoção automática do primeiro usuário.
- Stripe é o provedor escolhido para cobranças. A aplicação permanece no plano gratuito enquanto credenciais e confirmação confiável não estiverem disponíveis.

## Funcionalidades

Site institucional com preços públicos vindos do banco; cadastro e edição de fazendas e talhões; despesas e receitas com filtros; safras e produção; dashboard com cálculos a partir dos registros; simulador condicionado ao plano; cinco relatórios; Excel OOXML real, CSV e impressão para PDF; histórico de chamados e respostas; perfil e exclusão de dados.

Business: indicadores de usuários e assinaturas, CRM e histórico de contatos, suspensão e reativação de contas, configuração de planos e recursos, finanças separando recorrência de caixa, suporte, configurações públicas, comunicados, auditoria e eventos reais. Não exibe disponibilidade fictícia.

A interface inicia sem fazendas ou clientes de exemplo. O botão “Explorar exemplo” usa dados ilustrativos apenas na memória da tela e identifica esse estado. Esses números não são gravados no banco.

## Desenvolvimento local

Requer Node.js 22.13+ com npm e Git para publicação.

```powershell
npm ci
npm run build
```

Crie um arquivo `.dev.vars`, que deve permanecer ignorado pelo Git:

```dotenv
ADMIN_EMAIL=seu-email-administrador
```

Aplique as migrações locais uma vez por arquivo, na ordem do diretório `drizzle/`:

```powershell
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_outgoing_wendell_vaughn.sql
```

Repita o comando substituindo `--file` para cada migração posterior, sem reaplicar arquivos já executados. O banco local é separado do banco hospedado.

```powershell
npm run dev
```

Abra a URL Local impressa no terminal. No perfil portable, o login de desenvolvimento simula apenas a conta fictícia `seedy@sites.test` em loopback. Essa simulação não faz parte da versão publicada. Para testar o Business local, use temporariamente esse endereço em ADMIN_EMAIL; restaure o e-mail correto antes de usar uma conta real.

## Testes

```powershell
node --experimental-strip-types --test tests/*.test.mjs
npx tsc --noEmit
npm run build
```

Os testes cobrem autorização, dados de diferentes produtores, vínculos inválidos, limites atômicos, exclusão de dados, histórico de suporte, geração Excel e integração Stripe com provedor simulado. A validação independente de Excel usa openpyxl quando a variável CAFEGESTOR_TEST_PYTHON aponta para um Python com essa biblioteca; caso não esteja disponível, esse teste específico é sinalizado como ignorado.

## Configuração de produção

A hospedagem gerencia autenticação e o binding DB. Configure segredos pelo gerenciador de ambiente da plataforma. Não inclua credenciais no código, em formulários administrativos ou no manifesto de hospedagem.

- ADMIN_EMAIL: e-mail único autorizado para o Business.
- SITE_URL: origem HTTPS canônica da aplicação.
- STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET: credenciais do mesmo ambiente Stripe.

Cadastros, informações agrícolas e suporte usam o D1 hospedado. Não dependem de localStorage. As alterações de preços aplicam-se às novas contratações; valores de assinaturas existentes são preservados no contrato de cobrança.

## Validação por etapa

| Etapa | Entregue | Validação e limite |
|---|---|---|
| 1. Base e acesso | Identidade gerenciada, banco, permissões por usuário/admin e migrações | Testes de autorização e integridade; login local e respostas da API conferidos. Auth nativa Supabase não implementada. |
| 2. Gestão rural | Fazendas, talhões, safras, custos, receitas e colheitas | Cadastros reais testados na API; fazenda cadastrada pelo navegador e recuperada em nova requisição. |
| 3. Resultados | Dashboard, simulador, cinco relatórios, Excel/CSV/impressão PDF | Cálculos usam dados cadastrados; gates do plano no servidor; Excel aberto independentemente com openpyxl. |
| 4. Business | CRM, usuários, suporte, auditoria e indicadores | Preços, notas, tarefas, histórico e respostas persistidos nos testes administrativos. |
| 5. Planos | Preços, periodicidade, limites, recursos, visibilidade e ordem | Limites conferidos no servidor; alteração de preço refletiu na consulta pública. |
| 6. Pagamentos | Código Stripe, Checkout, portal e webhook autenticado e idempotente | Integração real não ativada sem credenciais. Ensaios usam provedor simulado; não representam homologação Stripe. |
| 7. Operação | Eventos de cadastro/erro, suporte, responsividade, testes e build | Prévia desktop verificada no navegador. Mobile revisado por CSS, sem emulação disponível. Observabilidade externa e preparação comercial continuam pendentes. |

## Antes do lançamento comercial

Ativar e homologar Stripe em ambiente de teste, configurar o portal e regras de migração de contratos, completar dados do controlador e termos/política, definir retenção/backups e conectar observabilidade externa. Reavaliar testes de segurança e carga para a escala prevista. A publicação inicial do Site é privada e não altera sua audiência automaticamente.

O fluxo “Imprimir / PDF” depende da opção Salvar como PDF do navegador; não é um serviço de geração PDF em segundo plano. Solicitações de suporte ficam no aplicativo, sem envio automático de e-mail ou SMS.

## Créditos da imagem

Foto de cafezal usada como ilustração: imagem Fazenda Dutra apresentada por [Crest Coffee Roasters](https://www.crestcoffeeroasters.com/shop/p/medium-roast-brazil). A imagem não identifica propriedades de clientes cadastrados.
