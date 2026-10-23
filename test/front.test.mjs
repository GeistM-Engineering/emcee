import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import front from '../lib/front.mjs';

const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => ok(s)); });
const portOf = (s) => s.address().port;

// One request through the front, answered by `upstream`; returns what each side saw.
async function through(upstream, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  let seen = null;
  const up = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }; upstream(req, res); });
  });
  const door = await listen(front({ upstream: `http://127.0.0.1:${portOf(up)}` }));
  const answer = await new Promise((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port: portOf(door), method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', fail);
    r.end(body);
  });
  up.close(); door.close();
  return { seen, answer };
}

test('the site is chosen by the visitor\'s Host; forwarding names this socket, not what the visitor claims', async () => {
  const { seen, answer } = await through((req, res) => res.end('ok'), {
    path: '/2026/10/a-post/?utm_source=meta',
    headers: { host: 'popdust.com', 'x-forwarded-for': '10.0.4.5', 'x-forwarded-proto': 'https' },
  });
  assert.equal(answer.status, 200);
  assert.equal(seen.headers.host, 'popdust.com');
  assert.equal(seen.url, '/2026/10/a-post/?utm_source=meta');
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen.headers['x-forwarded-proto'], 'http');
});

test('a POST body reaches the upstream whole', async () => {
  const body = 'log=admin&pwd=' + 'x'.repeat(70000);
  const { seen } = await through((req, res) => res.end(), {
    method: 'POST', path: '/wp-login.php', body,
    headers: { host: 'findbet.com', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
  });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body.toString(), body);
});

test('the answer comes back as the upstream sent it: status, headers, compressed bytes', async () => {
  const page = gzipSync('<html>' + 'popdust '.repeat(5000) + '</html>');
  const { answer } = await through((req, res) => {
    res.writeHead(301, { location: 'https://popdust.com/', 'content-encoding': 'gzip', 'x-cache': 'HIT', 'set-cookie': ['a=1', 'b=2'] });
    res.end(page);
  }, { headers: { host: 'popdust.com', 'accept-encoding': 'gzip' } });
  assert.equal(answer.status, 301);
  assert.equal(answer.headers.location, 'https://popdust.com/');
  assert.equal(answer.headers['content-encoding'], 'gzip');
  assert.equal(answer.headers['x-cache'], 'HIT');
  assert.deepEqual(answer.headers['set-cookie'], ['a=1', 'b=2']);
  assert.deepEqual(answer.body, page);
});

test('connection-specific headers stay on their own hop', async () => {
  const { seen } = await through((req, res) => res.end(), {
    headers: { host: 'paypath.com', connection: 'keep-alive, x-hop', 'x-hop': 'only-for-this-hop', 'proxy-authorization': 'Basic Zm9v', te: 'trailers' },
  });
  assert.equal(seen.headers['x-hop'], undefined);
  assert.equal(seen.headers['proxy-authorization'], undefined);
  assert.equal(seen.headers.te, undefined);
});

test('an upstream that is not there is a 502, not a hang', async () => {
  const gone = await listen(() => {});
  const port = portOf(gone);
  await new Promise((ok) => gone.close(ok));
  const door = await listen(front({ upstream: `http://127.0.0.1:${port}` }));
  const status = await new Promise((ok) => http.get({ host: '127.0.0.1', port: portOf(door), headers: { host: 'trueself.com' } }, (res) => { res.resume(); ok(res.statusCode); }));
  door.close();
  assert.equal(status, 502);
});

test('no upstream is a mistake at mount time, not at the first request', () => {
  assert.throws(() => front({}), /no upstream/);
});
