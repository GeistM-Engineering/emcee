import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, normalizeDomain } from '../lib/site-stats.mjs';

const days = ['2026-10-02', '2026-10-03'];
const t = (day, cls, requests, extra = {}) => ({ _id: { day, class: cls, agent: null, operator: null, verified: null, ...extra }, requests, php: 0 });

test('domains normalize to the bare host', () => {
  assert.equal(normalizeDomain('https://www.Popdust.com/a/b'), 'popdust.com');
});

test('traffic sums by kind, impostors and verified AI are counted', () => {
  const s = shape({
    domain: 'popdust.com', days,
    traffic: [
      t('2026-10-02', 'browser', 100), t('2026-10-02', 'in-app', 20),
      t('2026-10-02', 'ai-crawler', 30, { agent: 'GPTBot', operator: 'OpenAI', verified: 'ok' }),
      t('2026-10-02', 'search', 10, { agent: 'Googlebot', operator: 'Google', verified: 'failed' }),
      t('2026-10-03', 'ai-index', 5, { agent: 'ExaSearchBot', operator: 'Exa', verified: 'none' }),
    ],
    fleetByDay: [{ _id: { day: '2026-10-02', known: true }, requests: 60 }, { _id: { day: '2026-10-02', known: false }, requests: 40 }],
    paid: [], metaClicks: [],
  });
  assert.equal(s.totals.requests, 165);
  assert.equal(s.totals.human, 120);
  assert.equal(s.totals.ai, 35);
  assert.equal(s.totals.aiVerified, 30);
  assert.equal(s.totals.impostors, 10);
  assert.equal(s.coverage.siteKnownShare, 0.6);
  assert.deepEqual(s.agents.find((a) => a.agent === 'Googlebot'), { agent: 'Googlebot', operator: 'Google', class: 'search', requests: 10, verified: 0, failed: 10, unverifiable: 0 });
});

test('Meta comparison counts only ads that land solely on this site', () => {
  const s = shape({
    domain: 'popdust.com', days, traffic: [], fleetByDay: [],
    adIds: ['A1'],
    sharedAds: [{ adId: 'A2', sites: ['popdust.com', 'trueself.com'] }],
    paid: [
      { day: '2026-10-02', network: 'META', metaAdId: 'A1', clicks: 8, clicksByArrival: { 'human-shaped': 7, preview: 1 } },
      { day: '2026-10-02', network: 'META', metaAdId: 'A2', clicks: 50, clicksByArrival: { 'human-shaped': 50 } },
    ],
    metaClicks: [{ _id: { day: new Date('2026-10-02T00:00:00Z'), adId: 'A1' }, clicks: 10 }],
  });
  assert.deepEqual(s.totals.meta, { ads: 1, linkClicks: 10, arrived: 8, human: 7, sharedAds: 1 });
  assert.equal(s.totals.paid.clicks, 58);              // all paid arrivals still counted as traffic
  assert.equal(s.totals.paid.byNetwork.META.human, 57);
});
