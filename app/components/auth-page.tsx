'use client';

import {useEffect, useState} from 'react';
import type {FormEvent} from 'react';
import {ArrowRight, ArrowLeft, ShieldCheck, Leaf, Check, Eye, EyeOff, Mail, KeyRound, CheckCircle2, LoaderCircle, RefreshCw} from 'lucide-react';
import Brand from './brand';
import './auth.css';

type AuthView = 'signup' | 'login' | 'verify' | 'forgot' | 'reset' | 'verified' | 'reset-done' | 'invalid-action';
type AuthStatus = {provider?: string; configured: boolean; mailConfigured: boolean; policies?: {resendInterval: number}};

class AuthRequestError extends Error {
  code: string;
  retryAfter: number;
  constructor(message: string, code = '', retryAfter = 0) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function authMessage(code: string, fallback: string) {
  const messages: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: 'E-mail ou senha incorretos.',
    INVALID_LOGIN_CREDENTIALS: 'E-mail ou senha incorretos.',
    EMAIL_NOT_VERIFIED: 'Confirme seu e-mail para entrar.',
    EMAIL_EXISTS: 'Já existe uma conta com este e-mail. Entre para continuar.',
    USER_ALREADY_EXISTS: 'Já existe uma conta com este e-mail. Entre para continuar.',
    TOO_MANY_ATTEMPTS: 'Muitas tentativas. Aguarde um pouco e tente novamente.',
    TOO_MANY_REQUESTS: 'Muitas tentativas. Aguarde um pouco e tente novamente.',
    INVALID_TOKEN: 'Este link expirou ou já foi utilizado. Solicite um novo link.',
    INVALID_OOB_CODE: 'Este link expirou ou já foi utilizado. Solicite um novo link.',
    EXPIRED_OOB_CODE: 'Este link expirou. Solicite um novo link.',
    USER_NOT_FOUND: 'Não foi possível concluir a solicitação.',
    PASSWORD_TOO_SHORT: 'Use uma senha com pelo menos 10 caracteres.',
    PASSWORD_TOO_LONG: 'A senha pode ter no máximo 128 caracteres.',
    REAUTHENTICATION_REQUIRED: 'Confirme sua senha para solicitar outro link.',
    EMAIL_IS_ALREADY_VERIFIED: 'Este e-mail já foi confirmado. Você já pode entrar.',
  };
  return messages[code] || fallback || 'Não foi possível concluir. Tente novamente.';
}

async function authPost(path: string, body: Record<string, unknown>) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'same-origin',
    referrerPolicy: 'no-referrer', body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try { data = await response.json() as Record<string, unknown>; } catch { /* Errors remain readable if the server has no JSON body. */ }
  if (!response.ok) {
    const code = typeof data.code === 'string' ? data.code : '';
    const fallback = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : '';
    const retry = Number(response.headers.get('Retry-After') || data.retryAfter || 0);
    throw new AuthRequestError(authMessage(code, fallback), code, Number.isFinite(retry) ? retry : 0);
  }
  return data;
}

function initialStep(view: string): AuthView {
  if (view === 'cadastro') return 'signup';
  if (view === 'verificar-email' || view === 'firebase-action') return 'verify';
  if (view === 'recuperar-senha') return 'forgot';
  if (view === 'redefinir-senha') return 'reset';
  return 'login';
}

function safeNext(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/dashboard';
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && !url.pathname.startsWith('/api/') ? url.pathname + url.search + url.hash : '/dashboard';
  } catch { return '/dashboard'; }
}

export default function AuthPage({view}: {view: string}) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [step, setStep] = useState<AuthView>(initialStep(view));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [remember, setRemember] = useState(true);
  const [token, setToken] = useState('');
  const [next, setNext] = useState('/dashboard');
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const legal = ['privacidade', 'termos'].includes(view);

  useEffect(() => {
    let active = true;
    fetch('/api/data', {cache: 'no-store'}).then(r => r.json()).then(data => {
      if (active) setSettings((data as {settings?: Record<string, string>}).settings || {});
    }).catch(() => {});
    if (!legal) fetch('/api/auth/status', {cache: 'no-store'}).then(r => r.json()).then(data => {
      if (active) setStatus(data as AuthStatus);
    }).catch(() => {});
    const query = new URLSearchParams(window.location.search);
    const actionCode = query.get('oobCode') || query.get('token') || '';
    const mode = query.get('mode');
    const actionView = ['firebase-action', 'verificar-email', 'redefinir-senha'].includes(view);
    setToken(actionView ? actionCode : '');
    setNext(safeNext(query.get('next')));
    if (actionView) {
      if (mode && !actionCode) setStep('invalid-action');
      else if (mode === 'resetPassword') setStep('reset');
      else if (mode === 'verifyEmail') setStep('verify');
      else if (view === 'firebase-action') setStep('invalid-action');
    }
    if (query.get('verified') === '1') setNotice('E-mail confirmado. Entre para continuar.');
    else if (query.get('reset') === '1') setNotice('Senha atualizada. Entre com sua nova senha.');
    return () => { active = false; };
  }, [legal, view]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const emailValue = email.trim().toLowerCase();
  const success = step === 'verified' || step === 'reset-done';
  const verifyingLink = step === 'verify' && Boolean(token);
  const resendInterval = status?.policies?.resendInterval || 60;
  const loginUrl = '/login?' + new URLSearchParams({next}).toString();

  function clearActionCode() {
    setToken('');
    window.history.replaceState({}, '', window.location.pathname);
  }

  function catchError(value: unknown) {
    const failure = value instanceof Error ? value : new Error('Não foi possível concluir. Tente novamente.');
    setError(failure.message);
    if (!(failure instanceof AuthRequestError)) return;
    if (failure.retryAfter > 0) setCountdown(Math.min(3600, failure.retryAfter));
    if (failure.code === 'EMAIL_NOT_VERIFIED') {
      setPassword('');
      setStep('verify');
      setNotice('Sua conta ainda precisa da confirmação. Abra o link que recebeu ou solicite outro abaixo.');
    } else if (failure.code === 'REAUTHENTICATION_REQUIRED') {
      setNeedsReauthentication(true);
    } else if (failure.code === 'EMAIL_IS_ALREADY_VERIFIED') {
      setPassword('');
      setError('');
      setNotice('Seu e-mail já está confirmado. Entre com sua senha para continuar.');
      setStep('verified');
    }
  }

  async function sendVerification() {
    await authPost('send-verification-email', {email: emailValue, ...(password ? {password} : {})});
    setPassword('');
    setNeedsReauthentication(false);
    setNotice('Enviamos um novo link de confirmação. Confira sua caixa de entrada e a pasta de spam.');
    setCountdown(resendInterval);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (['forgot', 'verify'].includes(step) && !verifyingLink && countdown > 0)) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (step === 'signup') {
        await authPost('sign-up/email', {name: name.trim(), email: emailValue, password});
        setPassword('');
        setConfirmPassword('');
        setStep('verify');
        setCountdown(resendInterval);
        setNotice('Enviamos o link de confirmação. Abra seu e-mail e toque no link para ativar sua conta.');
      } else if (step === 'login') {
        await authPost('sign-in/email', {email: emailValue, password, rememberMe: remember});
        setPassword('');
        window.location.assign(next);
      } else if (step === 'verify') {
        if (token) {
          await authPost('verify-email', {oobCode: token});
          clearActionCode();
          setStep('verified');
        } else {
          await sendVerification();
        }
      } else if (step === 'forgot') {
        await authPost('request-password-reset', {email: emailValue});
        setNotice('Se este e-mail estiver cadastrado, enviaremos um link para redefinir a senha. Confira também a pasta de spam.');
        setCountdown(resendInterval);
      } else if (step === 'reset') {
        if (password !== confirmPassword) {
          setError('As senhas precisam ser iguais.');
          return;
        }
        await authPost('reset-password', {token, newPassword: password});
        clearActionCode();
        setPassword('');
        setConfirmPassword('');
        setStep('reset-done');
      }
    } catch (failure) {
      if (step === 'reset') {
        setPassword('');
        setConfirmPassword('');
        setShowPassword(false);
      }
      catchError(failure);
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<AuthView, string> = {
    signup: 'Seu próximo capítulo começa aqui.', login: 'Bom ter você por aqui.',
    verify: 'Confirme seu e-mail.', forgot: 'Vamos recuperar seu acesso.',
    reset: 'Uma nova senha, um novo começo.', verified: 'Tudo pronto para começar.',
    'reset-done': 'Senha atualizada.', 'invalid-action': 'Vamos encontrar o caminho.',
  };
  const descriptions: Record<AuthView, string> = {
    signup: 'Crie sua conta no CaféGestor e comece a organizar sua fazenda com o plano Grátis.',
    login: 'Entre com seu e-mail e senha para acompanhar sua fazenda e seus resultados.',
    verify: verifyingLink ? 'Confirme abaixo para ativar sua conta no CaféGestor.' : 'Abra o link enviado ao seu e-mail para ativar sua conta. Depois, entre com sua senha.',
    forgot: 'Informe seu e-mail. Enviaremos um link seguro para você definir uma nova senha.',
    reset: 'Escolha uma senha forte. Após salvar, entre novamente em seus dispositivos.',
    verified: 'Seu e-mail foi confirmado. Agora você pode entrar e cuidar da sua gestão.',
    'reset-done': 'Sua nova senha foi salva e as sessões anteriores foram encerradas. Entre novamente para continuar.',
    'invalid-action': 'Este link de acesso está incompleto ou não é compatível. Entre na sua conta ou solicite uma nova recuperação.',
  };
  const needsPassword = ['signup', 'login', 'reset'].includes(step) || (step === 'verify' && !token && needsReauthentication);
  const incompleteReset = step === 'reset' && !token;
  const submitDisabled = busy || (['forgot', 'verify'].includes(step) && !verifyingLink && countdown > 0);

  return <div className="auth-page">
    <div className="auth-visual">
      <Brand name={settings.platformName} logo={settings.logo}/>
      <div><span className="eyebrow">CULTIVE O FUTURO DA SUA GESTÃO</span><h1>Seu café.<br/>Sua história.<br/><em>Novas possibilidades.</em></h1><p>Do primeiro talhão à próxima safra, tenha clareza para seguir crescendo.</p></div>
      <small>Gestão feita para quem vive o café.</small>
    </div>
    <main className="auth-main">
      <a href="/" className="back-link"><ArrowLeft size={16}/>Voltar ao início</a>
      {legal ? <div className="legal-copy">
        <span className="eyebrow">CAFÉGESTOR</span><h1>{view === 'privacidade' ? 'Privacidade e seus dados' : 'Termos de uso'}</h1>
        <p style={{whiteSpace: 'pre-wrap'}}>{(view === 'privacidade' ? settings.privacy : settings.terms) || (view === 'privacidade' ? 'Seus registros ficam associados à sua conta. O acesso depende de uma sessão autenticada, e cada produtor acessa apenas seus próprios dados. Você pode solicitar suporte e excluir seus dados na área Minha conta.' : 'O CaféGestor organiza os registros fornecidos pelo produtor. Recursos e limites seguem o plano contratado. Os termos comerciais completos devem ser publicados pelo responsável pela plataforma.')}</p>
        {settings.supportEmail && <a href={'mailto:' + settings.supportEmail}>Contato: {settings.supportEmail}</a>}
      </div> : <div className={'auth-card native-auth-card ' + (step === 'verify' ? 'auth-card-verify' : '')}>
        <span className={'auth-leaf ' + (success ? 'native-auth-success-icon' : '')}>{success ? <CheckCircle2 size={29}/> : step === 'verify' ? <Mail size={27}/> : ['forgot', 'reset'].includes(step) ? <KeyRound size={27}/> : <Leaf size={27}/>}</span>
        <span className="eyebrow">{step === 'verify' ? 'SÓ MAIS UM PASSO' : success ? 'SEU ESPAÇO ESTÁ PRONTO' : 'BEM-VINDO AO CAFÉGESTOR'}</span>
        <h1>{titles[step]}</h1><p>{descriptions[step]}</p>
        {status?.configured === false && !success && <div className="native-auth-setup" role="status"><ShieldCheck size={18}/><span>O acesso por e-mail está em preparação. Tente novamente em breve ou fale com o responsável pela plataforma.</span></div>}
        {error && <div className="native-auth-error" role="alert">{error}</div>}
        {notice && <div className="native-auth-notice" role="status">{notice}</div>}
        {success ? <a className="btn btn-primary auth-signin" href={loginUrl + (step === 'verified' ? '&verified=1' : '&reset=1')}>Entrar na minha conta<ArrowRight size={17}/></a> : step === 'invalid-action' ? <div className="native-auth-actions"><a className="btn btn-primary auth-signin" href={loginUrl}>Entrar na minha conta<ArrowRight size={17}/></a><a className="native-auth-text-link" href="/recuperar-senha">Solicitar recuperação de senha</a></div> : <form onSubmit={submit} className="native-auth-form">
          {step === 'signup' && <label className="field">Seu nome<input name="name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="Como podemos chamar você?" required minLength={2} maxLength={120} disabled={busy}/></label>}
          {(['signup', 'login', 'forgot'].includes(step) || (step === 'verify' && !token)) && <label className="field">E-mail<div className="native-auth-input"><Mail size={17}/><input name="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={event => {setEmail(event.target.value); if (step === 'verify') {setPassword(''); setNeedsReauthentication(false);}}} placeholder="voce@exemplo.com" required maxLength={254} disabled={busy}/></div></label>}
          {needsPassword && <label className="field">{step === 'reset' ? 'Nova senha' : step === 'verify' ? 'Confirme sua senha' : 'Senha'}<div className="native-auth-input"><KeyRound size={17}/><input name="password" type={showPassword ? 'text' : 'password'} autoComplete={step === 'login' || step === 'verify' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder={step === 'login' || step === 'verify' ? 'Sua senha' : 'Pelo menos 10 caracteres'} required minLength={step === 'login' || step === 'verify' ? 1 : 10} maxLength={128} disabled={busy}/><button type="button" className="native-password-visibility" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div>{['signup', 'reset'].includes(step) && <span className="native-field-help">Use uma combinação única de letras, números e símbolos.</span>}</label>}
          {step === 'reset' && <label className="field">Confirme a nova senha<div className="native-auth-input"><KeyRound size={17}/><input name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required minLength={10} maxLength={128} disabled={busy}/></div></label>}
          {step === 'login' && <div className="native-login-options"><label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/>Continuar conectado</label><a href="/recuperar-senha">Esqueci minha senha</a></div>}
          {incompleteReset ? <div className="native-auth-error">O link de recuperação está incompleto. <a href="/recuperar-senha">Solicite um novo link.</a></div> : <button type="submit" className="btn btn-primary auth-signin" disabled={submitDisabled}>{busy ? <><LoaderCircle size={17} className="native-spin"/>Processando...</> : <>{step === 'signup' ? 'Criar conta' : step === 'login' ? 'Entrar' : step === 'verify' ? verifyingLink ? 'Confirmar meu e-mail' : countdown > 0 ? `Reenviar em ${countdown}s` : 'Reenviar link de confirmação' : step === 'forgot' ? countdown > 0 ? `Solicitar novamente em ${countdown}s` : 'Enviar link de recuperação' : 'Salvar nova senha'}{step === 'verify' && !verifyingLink ? <RefreshCw size={16}/> : <ArrowRight size={17}/>}</>}</button>}
          {step === 'verify' && !token && <div className="native-auth-resend"><span>Não recebeu? Confira a pasta de spam.</span><a className="native-auth-text-link" href={loginUrl}>Já confirmei, quero entrar<ArrowRight size={13}/></a></div>}
          {step === 'verify' && token && error && <p className="native-resend-timer"><a className="native-auth-text-link" href="/verificar-email">Solicitar outro link de confirmação</a></p>}
        </form>}
        {!success && <div className="auth-security"><ShieldCheck size={17}/><span>Sua fazenda, seus dados. Acesso protegido.</span></div>}
        {step === 'signup' && <div className="auth-benefits"><span><Check size={16}/>Sem cartão de crédito</span><span><Check size={16}/>Comece com uma fazenda</span></div>}
        <p className="auth-switch">{step === 'signup' ? <>Já tem uma conta? <a href={loginUrl}>Entrar</a></> : step === 'login' ? <>Ainda não tem conta? <a href={'/cadastro?' + new URLSearchParams({next}).toString()}>Criar conta</a></> : !success ? <a href={loginUrl}><ArrowLeft size={13}/>Voltar para entrar</a> : null}</p>
        {step === 'signup' && <small>Ao criar sua conta, você concorda com os <a href="/termos">Termos de uso</a> e a <a href="/privacidade">Política de privacidade</a>.</small>}
      </div>}
      <footer>© {new Date().getFullYear()} CaféGestor · Da lavoura às melhores decisões.</footer>
    </main>
  </div>;
}
