#!/usr/bin/env node
// Stage 0: the emcee as an observer. A day of the fleet's access logs, identified and
// rolled up into the `research` database, where Ember and the Site traffic panel
// read it.
//
//   GDB_URI=mongodb://research:…@…/?authSource=admin&replicaSet=gdb \
//   node bin/ingest.mjs --day 2026-10-02 [--snapshot sources.json] [--dry] log.gz … journiest.log.gz@journiest.com
//
// Give it every log for the day in one run. Each run REPLACES that day, so a re-run
// is safe and the day always has one answer.
//
// What it writes (research DB, as the `research` user — the emcee is a role of research):
//
//   emcee_traffic  one row per day · hour · site · class · agent · verification · in-app
//                  {requests, cacheHit, php, rtSeconds, status{2xx…}}
//   emcee_paid     one row per day · site · network · utm_source · utm_campaign · matched Meta ad
//                  {requests, clicks, arrivals{human-shaped, preview, bot, false-claim}}
//                  clicks = distinct click ids (fbclid / tblci / gclid), else address+agent
//   emcee_runs     one row per day: what was read, from where, against which prefix lists
//
// Our observations only. Meta's figures stay in bluefire.stat_v4 and are joined there
// by the matched ids (metaAccount, metaCampaignsetId, metaAdId) — never copied here.
//
// Sites: wp-2's log carries no host, so its rows have site null until its log format
// matches wp-1's. journiest's own log is named file@journiest.com.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { MongoClient } from 'mongodb';
import Identify, { arrivalOf } from '../lib/identify.mjs';
import MetaRecords from '../lib/meta-match.mjs';
import { parse } from '../lib/nginx-log.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const day = opt('--day');
const snapshotPath = opt('--snapshot');
const dry = flag('--dry');
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !args.length || !process.env.GDB_URI) {
  console.error('usage: GDB_URI=… ingest.mjs --day YYYY-MM-DD [--snapshot sources.json] [--dry] log[.gz][@host] …');
  process.exit(2);
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const stamp = (t) => { const m = /^(\d+)\/(\w+)\/(\d+):(\d+)/.exec(t); return { day: `${m[3]}-${String(MONTHS[m[2]] + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`, hour: Number(m[4]) }; };
const idOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 24);
const query = (url) => { const at = url.indexOf('?'); return new URLSearchParams(at < 0 ? '' : url.slice(at + 1)); };

function networkOf(q, facts, match) {
  if (q.get('fbclid') || match) return 'META';
  if (q.get('tblci') || /taboola|^tb\b/i.test(facts.paid.utm.source || '')) return 'TABOOLA';
  if (q.get('gclid')) return 'GOOGLE';
  if (/meta|facebook|^fb$|instagram/i.test(facts.paid.utm.source || '')) return 'META';
  return 'OTHER';
}

const client = await new MongoClient(process.env.GDB_URI).connect();
const meta = await MetaRecords.load(client.db('bluefire'), day);
const snapshot = snapshotPath && fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : undefined;
const identify = await Identify.create({ snapshot });

const traffic = new Map();
const paid = new Map();
const files = [];
let outsideDay = 0;

for (const spec of args) {
  const [file, host = null] = spec.split('@');
  const stats = { file: file.split('/').pop(), host, lines: 0, unparsed: 0 };
  files.push(stats);
  const input = fs.createReadStream(file).pipe(file.endsWith('.gz') ? zlib.createGunzip() : new PassThrough());
  let batch = [];
  const flush = async () => {
    await Promise.all(batch.map(async (rec) => {
      const at = stamp(rec.time);
      if (at.day !== day) { outsideDay++; return; }
      const facts = await identify.evidence(rec);
      const verified = facts.claim ? (facts.verified ? (facts.verified.ok ? 'ok' : 'failed') : 'none') : null;

      const tk = { day, hour: at.hour, site: rec.host, class: facts.class, agent: facts.claim?.agent || null, verified, inApp: facts.inApp };
      const t = traffic.get(idOf(tk)) || traffic.set(idOf(tk), { ...tk, operator: facts.claim?.operator || null, requests: 0, cacheHit: 0, php: 0, rtSeconds: 0, status: {} }).get(idOf(tk));
      t.requests++;
      if (rec.cache === 'HIT') t.cacheHit++;
      if (rec.php) t.php++;
      if (rec.rt) t.rtSeconds += rec.rt;
      const sc = `${String(rec.status)[0]}xx`;
      t.status[sc] = (t.status[sc] || 0) + 1;

      if (!facts.paid) return;
      const q = query(rec.url);
      const hit = meta.match(facts.paid.platformIds, Object.values(facts.paid.utm).filter(Boolean));
      const e = hit?.entity;
      const pk = {
        day, site: rec.host, network: networkOf(q, facts, hit),
        utmSource: facts.paid.utm.source, utmCampaign: facts.paid.utm.campaign,
        metaAccount: e?.account || null, metaCampaignsetId: e?.campaignsetId || null,
        metaAdId: e?.level === 'ad' ? e.id : null, metaLevel: e?.level || null, matchedBy: hit?.by || null,
      };
      const p = paid.get(idOf(pk)) || paid.set(idOf(pk), { ...pk, requests: 0, arrivals: {}, _clicks: new Set(), _clicksBy: {} }).get(idOf(pk));
      const arrival = arrivalOf(facts);
      const click = q.get('fbclid') || q.get('tblci') || q.get('gclid') || `${rec.ip}|${rec.ua}`;
      p.requests++;
      p.arrivals[arrival] = (p.arrivals[arrival] || 0) + 1;
      p._clicks.add(click);
      (p._clicksBy[arrival] ||= new Set()).add(click);
    }));
    batch = [];
  };
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    stats.lines++;
    const rec = parse(line, { host });
    if (rec) batch.push(rec); else stats.unparsed++;
    if (batch.length === 2000) await flush();
  }
  await flush();
}

const trafficRows = [...traffic.entries()].map(([_id, r]) => ({ _id, ...r, rtSeconds: Math.round(r.rtSeconds * 1000) / 1000 }));
const paidRows = [...paid.entries()].map(([_id, { _clicks, _clicksBy, ...r }]) => ({
  _id, ...r, clicks: _clicks.size, clicksByArrival: Object.fromEntries(Object.entries(_clicksBy).map(([k, s]) => [k, s.size])),
}));
const run = {
  _id: day, day, at: new Date(), files, outsideDay,
  sources: Object.fromEntries(Object.entries(identify.sources.snapshot).map(([k, s]) => [k, { fetchedAt: s.fetchedAt, prefixes: s.prefixes.length }])),
  metaEntities: meta.entities.size,
  totals: { requests: trafficRows.reduce((a, r) => a + r.requests, 0), trafficRows: trafficRows.length, paidRows: paidRows.length },
};

if (dry) {
  console.log(JSON.stringify(run, null, 2));
} else {
  const research = client.db('research');
  for (const [name, rows] of [['emcee_traffic', trafficRows], ['emcee_paid', paidRows]]) {
    const c = research.collection(name);
    await c.deleteMany({ day });
    for (let i = 0; i < rows.length; i += 5000) await c.insertMany(rows.slice(i, i + 5000), { ordered: false });
  }
  await research.collection('emcee_runs').replaceOne({ _id: day }, run, { upsert: true });
  console.log(`${day}: ${run.totals.requests.toLocaleString('en-US')} requests → ${trafficRows.length} traffic rows, ${paidRows.length} paid rows (research.emcee_*)`);
}
await client.close();
