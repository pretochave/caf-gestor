import handler from "vinext/server/fetch-handler";
import { independentRequest } from "./lib/standalone-request.mjs";

/** This entry point runs in the owner's Cloudflare account, without Sites dispatch. */
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    // Public visitors cannot supply a trusted identity through legacy proxy headers.
    const response = await handler.fetch(independentRequest(request), env, ctx);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("X-Frame-Options", "DENY");
    if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
