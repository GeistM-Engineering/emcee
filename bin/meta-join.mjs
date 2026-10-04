#!/usr/bin/env node
// What Meta reports against what arrived: join one day of paid landings, as the
// emcee sees them, to Meta's own per-ad figures in bluefire.stat_v4.
//
//   GDB_URI=mongodb://research:…@…/?authSource=admin&replicaSet=gdb \
//   node bin/meta-join.mjs --day 2026-10-02 [--out join.json] access.log.gz journiest.log.gz@journiest.com …
//
// A log written for a single site (journiest's own file) is named `file@host`.
//
// The join key is whatever Meta id the landing URL carries. Advertisers build their
// own URL templates (ad_id=, campaignid=, utm_content=<id>…), so a parameter name
// proves nothing; a number that IS one of Meta's ad, adset or campaign ids in
// stat_v4 does. Each landing joins at the most specific level it matches.
//
// Meta's side: the `ad|device_platform` pass summed over devices, `window: null`
// (clicks and impressions carry no attribution window). A day is the ad account's
// day in Meta and the UTC day in our logs, so a single day's ratio is approximate
// at the edges; the shape holds across days.
//
// Read-only. Connects as the `research` user (read on bluefire).

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { MongoClient } from 'mongodb';
import Identify, { arrivalOf } from '../lib/identify.mjs';
import MetaRecords from '../lib/meta-match.mjs';
import { parse } from '../lib/nginx-log.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const day = opt('--day');
const outPath = opt('--out');
const snapshotPath = opt('--snapshot');
if (!day || !args.length || !process.env.GDB_URI) {
  console.error('usage: GDB_URI=… meta-join.mjs --day YYYY-MM-DD [--out join.json] [--snapshot sources.json] log[.gz][@host] …');
  process.exit(2);
}

// ---------- our side: paid landings carrying Meta ids ----------

const snapshot = snapshotPath && fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : undefined;
const identify = await Identify.create({ snapshot });
const landings = [];            // {ids:[{param,id}], bucket, site, click}
const paidTotals = { paid: 0, withIds: 0, byBucket: {} };

for (const spec of args) {
  const [file, host = null] = spec.split('@');
  const input = fs.createReadStream(file).pipe(file.endsWith('.gz') ? zlib.createGunzip() : new PassThrough());
  let batch = [];
  const flush = async () => {
    await Promise.all(batch.map(async (rec) => {
      const facts = await identify.evidence(rec);
      if (!facts.paid) return;
      const b = arrivalOf(facts);
      paidTotals.paid++;
      paidTotals.byBucket[b] = (paidTotals.byBucket[b] || 0) + 1;
      if (facts.paid.platformIds.length || facts.paid.utm.content || facts.paid.utm.campaign || facts.paid.utm.term) {
        paidTotals.withIds++;
        // A click is Meta's fbclid — minted once per click. Requests without one
        // (previews, crawlers) count by address + agent instead.
        const at = rec.url.indexOf('?');
        const fbclid = new URLSearchParams(at < 0 ? '' : rec.url.slice(at + 1)).get('fbclid');
        landings.push({ ids: facts.paid.platformIds, names: Object.values(facts.paid.utm).filter(Boolean), source: facts.paid.utm.source, medium: facts.paid.utm.medium, bucket: b, site: rec.host, click: fbclid || `${rec.ip}|${rec.ua}` });
      }
    }));
    batch = [];
  };
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    const rec = parse(line, { host });
    if (rec) batch.push(rec);
    if (batch.length === 2000) await flush();
  }
  await flush();
}

// ---------- Meta's side: stat_v4 for the day ----------

const client = await new MongoClient(process.env.GDB_URI, { readPreference: 'secondary' }).connect();
const bluefire = client.db('bluefire');
const meta = await MetaRecords.load(bluefire, day);
await client.close();

// ---------- the join ----------

const byCampaign = new Map();   // campaignsetId -> {account, campaignset, meta{}, observed{}, matchedAt{}, params{}}
let unmatched = 0;
const unmatchedBy = {};   // utm_source · utm_medium of paid requests no Meta record explains
for (const l of landings) {
  const hit = meta.match(l.ids, l.names);
  if (!hit) {
    unmatched++;
    const k = `${l.source || '(no utm_source)'} · ${l.medium || '(no utm_medium)'}`;
    unmatchedBy[k] = (unmatchedBy[k] || 0) + 1;
    continue;
  }
  const { entity: e, by: param } = hit;
  const c = byCampaign.get(e.campaignsetId) || { account: e.account, accountName: e.accountName, campaignset: e.campaignset, observed: {}, matchedAt: {}, params: {}, sites: {} };
  c.observed[l.bucket] = (c.observed[l.bucket] || 0) + 1;
  c.observed.total = (c.observed.total || 0) + 1;
  (c.clicks ||= {});
  (c.clicks[l.bucket] ||= new Set()).add(l.click);
  (c.clicks.total ||= new Set()).add(l.click);
  c.matchedAt[e.level] = (c.matchedAt[e.level] || 0) + 1;
  c.params[`${param}→${e.level}`] = (c.params[`${param}→${e.level}`] || 0) + 1;
  if (l.site) c.sites[l.site] = (c.sites[l.site] || 0) + 1;
  byCampaign.set(e.campaignsetId, c);
}
for (const [id, c] of byCampaign) {
  c.meta = meta.entities.get(id)?.metrics || {};
  c.arrived = Object.fromEntries(Object.entries(c.clicks).map(([k, set]) => [k, set.size]));   // distinct clicks that arrived
  delete c.clicks;
}

const campaigns = [...byCampaign.entries()].map(([id, c]) => ({ campaignsetId: id, ...c })).sort((a, b) => (b.meta.link_click || 0) - (a.meta.link_click || 0));
const report = { day, generatedAt: new Date().toISOString(), paidTotals, matchedLandings: landings.length - unmatched, unmatchedLandings: unmatched, unmatchedBy, campaigns };
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

// ---------- summary ----------

const n = (v) => Math.round(v || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
console.log(`\n${day}: ${n(paidTotals.paid)} paid landings, ${n(paidTotals.withIds)} carry a Meta id or utm name, ${n(report.matchedLandings)} matched stat_v4, ${n(unmatched)} matched nothing in Meta's records`);
console.log('paid landings by arrival:', JSON.stringify(paidTotals.byBucket));
console.log('unmatched by utm_source · utm_medium:', JSON.stringify(Object.fromEntries(Object.entries(unmatchedBy).sort((a, b) => b[1] - a[1]).slice(0, 12))));
const sum = (k, f) => campaigns.reduce((a, c) => a + (f(c)[k] || 0), 0);
const tClicks = sum('link_click', (c) => c.meta), tLpv = sum('landing_page_view', (c) => c.meta), tSpend = sum('spend', (c) => c.meta), tReq = sum('total', (c) => c.observed), tArr = sum('total', (c) => c.arrived), tHuman = sum('human-shaped', (c) => c.arrived), tPrev = sum('preview', (c) => c.observed);
console.log(`\nACROSS MATCHED CAMPAIGNS  Meta: link clicks ${n(tClicks)} · landing-page views ${n(tLpv)} · spend $${n(tSpend)}`);
console.log(`  observed: ${n(tReq)} paid requests → ${n(tArr)} distinct clicks arrived (${pct(tArr, tClicks)} of Meta clicks) · human-shaped ${n(tHuman)} (${pct(tHuman, tClicks)}) · ${n(tPrev)} preview fetches`);
console.log('\nACCOUNT  CAMPAIGN                                                   META clicks   LPV   spend │ ARRIVED  human  │ requests preview bot │ arrived/click');
for (const c of campaigns.slice(0, 40)) {
  const a = c.arrived, o = c.observed, m = c.meta;
  console.log(`${c.account.padEnd(8)} ${String(c.campaignset || c.campaignsetId).slice(0, 58).padEnd(58)} ${n(m.link_click).padStart(8)} ${n(m.landing_page_view).padStart(5)} ${('$' + n(m.spend)).padStart(7)} │ ${n(a.total).padStart(7)} ${n(a['human-shaped']).padStart(6)} │ ${n(o.total).padStart(8)} ${n(o.preview).padStart(7)} ${n((o.bot || 0) + (o['false-claim'] || 0)).padStart(3)} │ ${pct(a['human-shaped'], m.link_click).padStart(8)}`);
}
