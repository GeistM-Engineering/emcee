// The emcee as the front door: every request is passed whole to the upstream that
// serves the sites (nginx on a publisher host), streamed both ways.
//
//   app.use(emcee.observe());                                 // who asked — after the response
//   app.use(emcee.front({ upstream: 'http://127.0.0.1:8080' })); // what serves them
//
// Mount it ahead of any body parser, CORS or site router: it owns the request from
// here on and never calls next(). Nothing is buffered or rewritten. The Host header
// is kept, so the upstream picks the site as before.
//
// The emcee is the edge: an NLB in front passes TCP through, so this socket is the
// visitor and this process terminated TLS. Whatever X-Forwarded-* a visitor sends is
// theirs to claim and is replaced: X-Forwarded-For is the socket's address and
// X-Forwarded-Proto is whether this hop was https (WordPress reads it to know).
//
// The upstream must trust this hop — on nginx, `set_real_ip_from 127.0.0.1;` with
// `real_ip_header X-Forwarded-For;` — or every visitor reaches it as 127.0.0.1.

import http from 'node:http';

// RFC 9110 §7.6.1 connection-specific headers: they describe one hop, not the request.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const strip = (headers) => {
  const named = String(headers.connection || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k) && !named.includes(k)) out[k] = v;
  return out;
};

export default function front({ upstream, timeoutMs = 60000 } = {}) {
  if (!upstream) throw new Error('emcee front: no upstream');
  const target = new URL(upstream);
  const agent = new http.Agent({ keepAlive: true });

  return (req, res) => {
    const headers = strip(req.headers);
    headers['x-forwarded-for'] = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';

    const up = http.request({
      agent, host: target.hostname, port: target.port || 80,
      method: req.method, path: req.originalUrl || req.url, headers,
    });
    up.setTimeout(timeoutMs, () => up.destroy(new Error(`no answer in ${timeoutMs / 1000}s`)));

    up.on('response', (answer) => {
      res.writeHead(answer.statusCode, answer.statusMessage, strip(answer.headers));
      answer.pipe(res);
    });
    up.on('error', (e) => {
      console.error(`[emcee] upstream ${target.host}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway');
      else res.destroy();
    });
    // a visitor who leaves mid-response takes the upstream request with them
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  };
}
