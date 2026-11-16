/**
 * The host page of a picture of an app (app-render/sidecar.ts): what the
 * client's app sandbox is, as small as it can be. One sandboxed iframe
 * (`allow-scripts`, no same origin, as in the client) holds the app's frame,
 * so the app's `window.parent` is a real parent and the `@host` bridge works
 * with no change to the kit or to an old build.
 *
 * The page relays each bridge request from that iframe (and only from it) to
 * `POST /host-call`, which the render's request interception answers through
 * answerRenderHostCall, and posts the answer back. It notes what the app
 * says about itself (ready, ready.hold and ready.release, its errors) in
 * `window.__mantleAppRender`, which the render reads to know when to take the
 * picture. The app cannot reach this page's script (another origin): what it
 * posts is all it can do here, and that only moves the moment of the picture.
 */

/** The longest bridge request the page relays (the render refuses past it). */
export const HOST_CALL_MAX_CHARS = 64 * 1024;

/** The page's CSP: its one nonced script, the frame, and its one call path. */
export function hostPageCsp(origin: string, nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
    `frame-src ${origin}/frame; connect-src ${origin}/host-call; ` +
    "img-src 'none'; base-uri 'none'; form-action 'none'"
  );
}

/** The host page. `nonce` is fresh per render. */
export function hostPageHtml(nonce: string, maxLines: number, maxChars: number): string {
  const args = JSON.stringify([HOST_CALL_MAX_CHARS, maxLines, maxChars]);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>
</head>
<body>
<iframe id="app" sandbox="allow-scripts" src="/frame" title="app"></iframe>
<script nonce="${nonce}">
(function (a) {
  var MAX = a[0], LINES = a[1], CHARS = a[2];
  var f = document.getElementById('app');
  var st = { ready: false, hold: false, released: false, errors: [], inflight: 0, last: Date.now() };
  // Not RENDER_FLAG's name (__mantleRender): RENDER_INIT makes that one fixed.
  Object.defineProperty(window, '__mantleAppRender', { value: st });
  function note(m) {
    if (st.errors.length >= LINES) return;
    var t = String(m && (m.message || m) || 'the app reported an error').slice(0, CHARS);
    if (st.errors.indexOf(t) < 0) st.errors.push(t);
  }
  function relay(m) {
    st.inflight++;
    st.last = Date.now();
    var sent = false;
    function done(r) {
      if (sent) return;
      sent = true;
      st.inflight--;
      st.last = Date.now();
      r = r && typeof r === 'object' ? r : { ok: false, error: 'no answer' };
      try { f.contentWindow.postMessage({ v: 1, id: m.id, ok: r.ok === true, output: r.output, error: r.error, reason: r.reason }, '*'); } catch (_) {}
    }
    var body;
    try { body = JSON.stringify(m); } catch (_) { body = null; }
    if (typeof body !== 'string' || body.length > MAX) {
      done({ ok: false, error: 'This call is too large for a picture.', reason: 'render' });
      return;
    }
    window.fetch('/host-call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
      .then(function (x) { return x.json(); })
      .then(done, function () { done({ ok: false, error: 'The picture could not answer this call.', reason: 'render' }); });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== f.contentWindow) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || m.v !== 1) return;
    if (typeof m.id === 'string') { relay(m); return; }
    if (m.kind === 'ready') st.ready = true;
    else if (m.kind === 'ready.hold') st.hold = true;
    else if (m.kind === 'ready.release') st.released = true;
    else if (m.kind === 'error') note(m);
  });
})(${args});
</script>
</body>
</html>`;
}
