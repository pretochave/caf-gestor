import { authPolicies, nativeAuthStatus, NativeAuthError, type AuthConfig } from "./auth-policy";
export type AuthMail = { to: string; subject: string; text: string; html: string };
export type AuthMailer = (mail: AuthMail) => Promise<void>;
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function verificationMail(email: string, otp: string): AuthMail {
  return { to: email, subject: "Seu código de verificação — CaféGestor", text: `Seu código de verificação do CaféGestor é: ${otp}\n\nDigite esse código no site para ativar sua conta. Ele expira em ${authPolicies.otpExpiresIn / 60} minutos e permite até ${authPolicies.otpAllowedAttempts} tentativas. Se você não solicitou este e-mail, ignore esta mensagem.`, html: `<div style="font-family:Arial,sans-serif;color:#163d2b;max-width:520px"><h1 style="font-size:24px">Verifique seu e-mail</h1><p>Digite o código abaixo no CaféGestor para ativar sua conta.</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f3ebdd;padding:22px;text-align:center">${escapeHtml(otp)}</p><p>Expira em 10 minutos. Máximo de 5 tentativas.</p><p style="font-size:12px;color:#66745d">Se você não solicitou este e-mail, ignore esta mensagem.</p></div>` };
}
export function resetMail(email: string, url: string): AuthMail {
  return { to: email, subject: "Redefina sua senha — CaféGestor", text: `Recebemos uma solicitação para redefinir sua senha do CaféGestor.\n\nAbra este link seguro: ${url}\n\nO link expira em ${authPolicies.resetExpiresIn / 60} minutos e pode ser usado uma única vez. Se você não solicitou a alteração, ignore este e-mail.`, html: `<div style="font-family:Arial,sans-serif;color:#163d2b;max-width:520px"><h1 style="font-size:24px">Uma nova senha para sua conta</h1><p>Recebemos uma solicitação para redefinir sua senha.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#163d2b;color:#fff;padding:14px 22px;border-radius:6px;text-decoration:none">Redefinir minha senha</a></p><p>Este link expira em 30 minutos e pode ser usado uma única vez.</p><p style="font-size:12px;color:#66745d">Se você não solicitou esta alteração, ignore este e-mail.</p></div>` };
}
export function resendMailer(config: AuthConfig, fetcher: typeof fetch = fetch): AuthMailer {
  return async (mail) => {
    if (!nativeAuthStatus(config).mailConfigured) throw new NativeAuthError(503, "EMAIL_NOT_CONFIGURED", "O envio de e-mails ainda não foi configurado pelo responsável pela plataforma.");
    let response: Response;
    try { response = await fetcher("https://api.resend.com/emails", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(12_000), headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ from: config.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }) }); }
    catch { throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Não foi possível enviar o e-mail agora. Aguarde um minuto e tente novamente."); }
    if (!response.ok) throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "O serviço de e-mail não confirmou o envio. Verifique o endereço ou tente novamente em um minuto.");
    let receipt: { id?: string };
    try { receipt = await response.json() as { id?: string }; } catch { throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "O serviço de e-mail não confirmou o envio. Tente novamente em um minuto."); }
    if (!receipt.id) throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "O serviço de e-mail não confirmou o envio. Tente novamente em um minuto.");
  };
}
