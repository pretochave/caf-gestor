import Workspace from '../components/workspace';
import AuthPage from '../components/auth-page';
import {requireAppUser} from '@/lib/auth-server';
import {notFound,redirect} from 'next/navigation';
import {env} from 'cloudflare:workers';
import {verifiedAdministrator} from '@/lib/auth-policy';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{path:string[]}>}){
  const {path}=await params; const view=path.join('/');
  if(['login','cadastro','verificar-email','recuperar-senha','redefinir-senha','firebase-action','privacidade','termos'].includes(view))return <AuthPage key={view} view={view}/>;
  if(!['dashboard','fazendas','custos','safras','simulador','relatorios','assinatura','suporte','business','business/clientes','business/usuarios','business/planos','business/assinaturas','business/financeiro','business/suporte','business/configuracoes','business/monitoramento'].includes(view))notFound();
  const user=await requireAppUser('/'+view);
  if(view.startsWith('business')&&!verifiedAdministrator(user.email,user.emailVerified,(env as Cloudflare.Env & {ADMIN_EMAIL?:string}).ADMIN_EMAIL))redirect('/dashboard');
  return <Workspace view={view}/>;
}
