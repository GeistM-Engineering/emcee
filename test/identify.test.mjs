import { test } from 'node:test';
import assert from 'node:assert/strict';
import Identify from '../lib/identify.mjs';
import Sources from '../lib/sources.mjs';
import { AGENTS } from '../lib/catalog.mjs';
import { parse } from '../lib/nginx-log.mjs';

// A fixed snapshot: no network, same answer every run.
const snapshot = {
  'https://openai.com/gptbot.json': { url: 'https://openai.com/gptbot.json', fetchedAt: '2026-10-02T00:00:00Z', prefixes: ['132.196.86.0/24'] },
  AS32934: { url: 'ripe', fetchedAt: '2026-10-02T00:00:00Z', prefixes: ['57.141.0.0/24', '2a03:2880::/32'] },
};
const rdns = { matches: async (ip) => (ip === '52.70.240.1' ? { ok: true, ptr: 'x.crawl.amazonbot.amazon' } : { ok: false, ptr: null }) };
const identify = new Identify({ catalog: AGENTS, sources: new Sources(snapshot), rdns });

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)';
const META = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))';

test('a GPTBot claim from a published OpenAI range is verified', async () => {
  const f = await identify.evidence({ ip: '132.196.86.7', ua: GPTBOT });
  assert.equal(f.class, 'ai-crawler');
  assert.deepEqual(f.claim, { agent: 'GPTBot', operator: 'OpenAI' });
  assert.equal(f.verified.ok, true);
  assert.equal(f.verified.method, 'ranges');
});

test('the same claim from elsewhere is recorded as failing, not reclassified', async () => {
  const f = await identify.evidence({ ip: '203.0.113.9', ua: GPTBOT });
  assert.equal(f.class, 'ai-crawler');
  assert.equal(f.verified.ok, false);
});

test('Meta crawlers verify by ASN, v4 and v6', async () => {
  assert.equal((await identify.evidence({ ip: '57.141.0.63', ua: META })).verified.method, 'asn');
  assert.equal((await identify.evidence({ ip: '2a03:2880:f800::1', ua: META })).verified.ok, true);
});

test('Amazonbot verifies by forward-confirmed reverse DNS', async () => {
  const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)';
  assert.equal((await identify.evidence({ ip: '52.70.240.1', ua })).verified.method, 'fcrdns');
  assert.equal((await identify.evidence({ ip: '1.2.3.4', ua })).verified.ok, false);
});

test('an operator that publishes nothing leaves verified null', async () => {
  const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
  const f = await identify.evidence({ ip: '1.2.3.4', ua });
  assert.equal(f.claim.agent, 'ClaudeBot');
  assert.equal(f.verified, null);
});

test('a paid Meta landing: in-app, click id, campaign, scout ids', async () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22H352 [FBAN/FBIOS;FBAV/580.0.0.47.72]';
  const f = await identify.evidence({ ip: '73.113.191.114', ua, url: '/x?utm_source=GeistM&utm_medium=paidsocial&fbclid=abc&campaign_id=1&ad_id=2&gdpid=g1', referer: 'https://facebook.com/' });
  assert.equal(f.class, 'in-app');
  assert.equal(f.inApp, 'facebook');
  assert.deepEqual(f.paid.clickIds, ['fbclid']);
  assert.equal(f.paid.scout.gdpid, 'g1');
  assert.equal(f.paid.campaignId, '1');
  assert.equal(f.referrer, 'facebook.com');
});

test('a visit from an AI answer is named', async () => {
  const f = await identify.evidence({ ip: '1.1.1.1', ua: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', url: '/p?utm_source=chatgpt.com' });
  assert.equal(f.fromAi, 'chatgpt.com');
  assert.equal(f.paid, null);
});

test('both fleet log formats parse', () => {
  const wp1 = parse('57.141.0.63 host=www.popdust.com xff="57.141.0.63" [01/Oct/2026:00:00:05 +0000] "GET /a.html HTTP/1.1" status=301 bytes=178 cache=- rt=0.000 urt=- uct=- uht=- upstream="-" ref="-" ua="' + META + '"');
  assert.equal(wp1.host, 'popdust.com');
  assert.equal(wp1.php, false);
  assert.equal(wp1.referer, null);
  const wp2 = parse('45.148.10.15 - - [02/Oct/2026:00:00:02 +0000] "POST / HTTP/1.1" 404 11457 "-" "Mozilla/5.0 (Windows NT 10.0)" cache=-');
  assert.equal(wp2.host, null);
  assert.equal(wp2.status, 404);
});
