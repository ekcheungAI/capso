import { nativeAuthHandoff } from "@/lib/native-auth-handoff";
import { color } from "@capso/shared/tokens";

const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function document(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Open Capso</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: ${color.light.background}; color: ${color.light.foreground}; }
    main { width: min(100%, 420px); padding: 40px; border: 1px solid rgba(32,33,31,.1); border-radius: 28px; background: rgba(255,255,255,.78); box-shadow: 0 24px 70px rgba(36,34,29,.12); text-align: center; }
    .mark { width: 52px; height: 52px; margin: 0 auto 24px; display: grid; place-items: center; border-radius: 16px; background: ${color.light.accent}; color: ${color.light["accent-ink"]}; font-size: 24px; font-weight: 700; }
    h1 { margin: 0; font-size: 28px; letter-spacing: -.04em; }
    p { margin: 12px 0 28px; color: ${color.light.muted}; font-size: 15px; line-height: 1.55; }
    a { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; padding: 0 22px; border-radius: 14px; background: ${color.light.accent}; color: ${color.light["accent-ink"]}; font-weight: 650; text-decoration: none; }
    small { display: block; margin-top: 18px; color: ${color.light.muted}; line-height: 1.45; }
    @media (prefers-color-scheme: dark) {
      body { background: ${color.dark.background}; color: ${color.dark.foreground}; }
      main { border-color: rgba(255,255,255,.1); background: rgba(38,39,36,.82); box-shadow: 0 24px 70px rgba(0,0,0,.32); }
      .mark, a { background: ${color.dark.accent}; color: ${color.dark["accent-ink"]}; }
      p, small { color: ${color.dark.muted}; }
    }
  </style>
</head>
<body><main><div class="mark" aria-hidden="true">C</div>${body}</main></body>
</html>`;
}

export function GET(request: Request): Response {
  const handoff = nativeAuthHandoff(new URL(request.url).searchParams);
  const body =
    handoff.kind === "ready"
      ? `<h1>Continue in Capso</h1><p>Sign-in link received. Open the installed Mac app to finish signing in.</p><a href="${handoff.openUrl}">Open Capso</a><small>This one-time link expires shortly and works only with the app that started sign-in.</small>`
      : `<h1>Sign-in link unavailable</h1><p>${handoff.message}</p><small>Nothing was passed to the Capso app.</small>`;
  return new Response(document(body), { status: handoff.kind === "ready" ? 200 : 400, headers: HEADERS });
}
