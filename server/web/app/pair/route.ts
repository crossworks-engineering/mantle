/**
 * GET /pair — where a BROWSER lands when it scans the "Sign in on your phone"
 * QR (the phone app parses the URL itself and never opens it). The code is in
 * the URL fragment, which never reaches this server, and this page never
 * reads or shows it: it only explains what to do. Public (auth-constants
 * PUBLIC_PATHS), static, no-store.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in on your phone</title>
<style>
  body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  main{max-width:28rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#bbb}
</style></head>
<body><main>
<h1>Sign in on your phone</h1>
<p>This code is for the Jackdaw app. Open Jackdaw on your phone, tap <strong>Scan a sign-in code</strong> on the sign-in screen, and point it at the QR code shown on the web app.</p>
<p>The code expires after about a minute and works once. Nothing else to do here.</p>
</main></body></html>
`;

export function GET() {
  return new Response(PAGE, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
