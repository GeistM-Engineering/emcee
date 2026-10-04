import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Observer from '../lib/observe.mjs';
import Rollup from '../lib/rollup.mjs';

// A request/response pair as Express hands them to middleware.
function exchange(url, { host = 'www.rootz.global', ip = '::ffff:203.0.113.5', ua = 'Mozilla/5.0 (Macintosh) Safari/605.1.15', status = 200 } = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  const headers = { 'user-agent': ua, host };
  const req = { ip, hostname: host, method: 'GET', originalUrl: url, headers, get: (h) => headers[h.toLowerCase()] };
  return { req, res };
}
const identify = { evidence: async (rec) => ({ class: /bot/i.test(rec.ua) ? 'ai-crawler' : 'browser', claim: /bot/i.test(rec.ua) ? { agent: 'GPTBot', operator: 'OpenAI' } : null, verified: /bot/i.test(rec.ua) ? { ok: false } : null, inApp: null, paid: null }) };

test('the middleware passes through at once and records after finish', async () => {
  const batches = [];
  const at = new Date('2026-10-05T14:30:00Z');
  const o = new Observer({ identify: () => identify, sink: async (b) => batches.push(b), flushMs: 1e9, clock: () => at });
  const mw = o.middleware();
  let nexted = 0;
  for (const [url, ua] of [['/', undefined], ['/a', undefined], ['/b', 'GPTBot/1.4']]) {
    const { req, res } = exchange(url, ua ? { ua } : {});
    mw(req, res, () => nexted++);
    res.emit('finish');
  }
  assert.equal(nexted, 3);
  await o.stop();
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(b.requests, 3);
  assert.equal(b.day, '2026-10-05');
  const browser = b.traffic.find((r) => r.set.class === 'browser');
  assert.equal(browser.set.site, 'rootz.global');
  assert.equal(browser.set.hour, 14);
  assert.equal(browser.inc.requests, 2);
  assert.equal(browser.inc['status.2xx'], 2);
  assert.equal(b.traffic.find((r) => r.set.agent === 'GPTBot').set.verified, 'failed');
});

test('a second flush sends only what changed', async () => {
  const batches = [];
  const o = new Observer({ identify: () => identify, sink: async (b) => batches.push(b), flushMs: 1e9, clock: () => new Date('2026-10-05T14:30:00Z') });
  const mw = o.middleware();
  const hit = () => { const { req, res } = exchange('/'); mw(req, res, () => {}); res.emit('finish'); };
  hit(); hit();
  await o.flush();
  hit();
  await o.flush();
  await o.flush();                       // nothing new: no batch
  assert.equal(batches.length, 2);
  assert.equal(batches[0].traffic[0].inc.requests, 2);
  assert.equal(batches[1].traffic[0].inc.requests, 1);
});

test('nothing is recorded while identification is still loading', async () => {
  const batches = [];
  const o = new Observer({ identify: () => null, sink: async (b) => batches.push(b), flushMs: 1e9 });
  const { req, res } = exchange('/');
  let nexted = false;
  o.middleware()(req, res, () => { nexted = true; });
  res.emit('finish');
  await o.stop();
  assert.equal(nexted, true);
  assert.equal(batches.length, 0);
});

test('rows() and drain() agree on a paid click counted once', () => {
  const r = new Rollup();
  const facts = { class: 'in-app', claim: null, verified: null, inApp: 'facebook', paid: { platformIds: [], utm: { source: 'facebook' }, clickIds: ['fbclid'] } };
  const rec = (u) => ({ ip: '1.1.1.1', ua: 'FBAN', host: 'popdust.com', url: u, status: 200, cache: null, rt: 0.1 });
  r.add(rec('/p?fbclid=X'), facts, { day: '2026-10-05', hour: 1 });
  r.add(rec('/p?fbclid=X&page=2'), facts, { day: '2026-10-05', hour: 1 });
  const { paid } = r.rows();
  assert.equal(paid[0].requests, 2);
  assert.equal(paid[0].clicks, 1);
  assert.equal(paid[0].network, 'META');
  assert.equal(paid[0].clicksByArrival['human-shaped'], 1);
  assert.equal(r.drain().paid[0].inc.clicks, 1);
});
