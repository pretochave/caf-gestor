import Workspace from '../components/workspace';
import AuthPage from '../components/auth-page';
import {requireChatGPTUser} from '../chatgpt-auth';
import {notFound,redirect} from 'next/navigation';
import {env} from 'cloudflare:workers';
import {isAdmin} from '@/lib/security';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{path:string[]}>}){
  const {path}=await params; const view=path.join('/');
  if(['login','cadastro','recuperar-senha','privacidade','termos'].includes(view))return <AuthPage view={view}/>;
  if(!['dashboard','fazendas','custos','safras','simulador','relatorios','assinatura','suporte','business','business/clientes','business/usuarios','business/planos','business/assinaturas','business/financeiro','business/suporte','business/configuracoes','business/monitoramento'].includes(view))notFound();
  const user=await requireChatGPTUser('/'+view);
  if(view.startsWith('business')&&!isAdmin(user.email,(env as Cloudflare.Env & {ADMIN_EMAIL?:string}).ADMIN_EMAIL))redirect('/dashboard');
  return <Workspace view={view}/>;
}
