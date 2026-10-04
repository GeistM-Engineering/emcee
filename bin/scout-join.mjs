#!/usr/bin/env node
// Scout click → publisher landing, for the clicks that can be followed today.
//
//   GDB_URI=… node bin/scout-join.mjs --day 2026-10-02 [--window 120] [--out join.json] log.gz journiest.log.gz@journiest.com …
//
// A scout click is a `link` event in bluefire.event. What it records decides whether
// it can be followed to the page:
//   classic (i.geistm.com)  — the clicker's address (_dev.ip), the destination url,
//                             and its gcid (some links pass it on as gdpid=)
//   pro (i.blackfire.pro)   — gcid and geo only; no address, no destination, and its
//                             gcid never reaches the landing. Not followable until links
//                             carry gcid={gcid} (FireMacro already has it in the dataset).
//
// A classic click is followed when the landing carries its gcid as gdpid, or — the
// fallback — when the same address requests the destination path within --window
// seconds of the click. Each arrival records which of the two proved it.
//
// Read-only. Connects as the `research` user.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { MongoClient } from 'mongodb';
import Identify from '../lib/identify.mjs';
import { parse } from '../lib/nginx-log.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const day = opt('--day');
const windowS = Number(opt('--window') || 120);
const outPath = opt('--out');
const snapshotPath = opt('--snapshot');
if (!day || !args.length || !process.env.GDB_URI) {
  console.error('usage: GDB_URI=… scout-join.mjs --day YYYY-MM-DD [--window 120] [--out join.json] log[.gz][@host] …');
  process.exit(2);
}

const FLEET = ['findbet.com', 'findkarma.com', 'geistm.com', 'journiest.com', 'libertyproject.com', 'paypath.com', 'popdust.com', 'topdust.com', 'trueself.com'];
const siteOf = (host) => { const h = String(host || '').toLowerCase().replace(/^www\./, ''); return FLEET.find((s) => h === s || h.endsWith('.' + s)) || null; };
const pathOf = (u) => { const p = u.split('?')[0].replace(/\/+$/, ''); return p || '/'; };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const nginxTime = (t) => { const m = /^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+)/.exec(t); return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]); };

// ---------- scout's side ----------

const client = await new MongoClient(process.env.GDB_URI, { readPreference: 'secondary' }).connect();
const events = client.db('bluefire').collection('event');
const from = new Date(`${day}T00:00:00Z`), to = new Date(from.getTime() + 86400e3);
const counts = await events.aggregate([{ $match: { _ns: 'link', _time: { $gte: from, $lt: to } } }, { $group: { _id: '$app', n: { $sum: 1 } } }], { maxTimeMS: 120000 }).toArray();
const clicks = await events.find({ _ns: 'link', app: 'classic', _time: { $gte: from, $lt: to } },
  { projection: { _time: 1, '_dev.ip': 1, url: 1, link: 1, account: 1, publisher: 1, gcid: 1 } }).maxTimeMS(120000).toArray();
await client.close();

const byIp = new Map();
const byGcid = new Map();
for (const c of clicks) {
  let dest = null;
  try { dest = new URL(c.url); } catch { /* no destination recorded */ }
  c.site = dest ? siteOf(dest.hostname) : null;
  c.path = dest ? pathOf(dest.pathname) : null;
  c.t = c._time.getTime();
  c.arrival = null;
  if (c._dev?.ip) (byIp.get(c._dev.ip) || byIp.set(c._dev.ip, []).get(c._dev.ip)).push(c);
  if (c.gcid) byGcid.set(c.gcid, c);
}

// ---------- the landings ----------

const snapshot = snapshotPath && fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : undefined;
const identify = await Identify.create({ snapshot });
const arrive = (c, how, rec, facts, t) => {
  if (c.arrival && (c.arrival.how === 'gdpid' || how !== 'gdpid')) return;   // first proof wins; gdpid outranks address
  c.arrival = { how, delayS: Math.round((t - c.t) / 1000), class: facts.class, claim: facts.claim?.agent || null, inApp: facts.inApp, verifiedOk: facts.verified ? facts.verified.ok : null, ip: rec.ip, ua: rec.ua };
};

for (const spec of args) {
  const [file, host = null] = spec.split('@');
  const input = fs.createReadStream(file).pipe(file.endsWith('.gz') ? zlib.createGunzip() : new PassThrough());
  let batch = [];
  const flush = async () => {
    await Promise.all(batch.map(async (rec) => {
      const t = nginxTime(rec.time);
      const at = rec.url.indexOf('?');
      const gdpid = new URLSearchParams(at < 0 ? '' : rec.url.slice(at + 1)).get('gdpid');
      const byId = gdpid && byGcid.get(gdpid);
      const near = (byIp.get(rec.ip) || []).filter((c) => c.path && c.path === pathOf(rec.url) && t >= c.t - 2000 && t - c.t <= windowS * 1000);
      if (!byId && !near.length) return;
      const facts = await identify.evidence(rec);
      if (byId) arrive(byId, 'gdpid', rec, facts, t);
      for (const c of near) arrive(c, 'address', rec, facts, t);
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

// ---------- roll up ----------

const tally = () => ({ clicks: 0, toFleet: 0, arrived: 0, byGdpid: 0, byAddress: 0, human: 0, arrivedAs: {}, delays: [] });
const accountOf = (a) => (a && typeof a === 'object' ? a._id || a.id || JSON.stringify(a) : a || '?');
const all = tally(), byAccount = {}, bySite = {};
for (const c of clicks) {
  for (const t of [all, (byAccount[accountOf(c.account)] ||= tally()), ...(c.site ? [(bySite[c.site] ||= tally())] : [])]) {
    t.clicks++;
    if (c.site) t.toFleet++;
    if (c.arrival) {
      t.arrived++;
      t[c.arrival.how === 'gdpid' ? 'byGdpid' : 'byAddress']++;
      if (c.arrival.class === 'in-app' || c.arrival.class === 'browser') t.human++;
      const as = c.arrival.claim ? `${c.arrival.class}:${c.arrival.claim}${c.arrival.verifiedOk === false ? '(false)' : ''}` : c.arrival.class;
      t.arrivedAs[as] = (t.arrivedAs[as] || 0) + 1;
      t.delays.push(c.arrival.delayS);
    }
  }
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fin = (t) => { const { delays, ...rest } = t; return { ...rest, medianDelayS: median(delays) }; };
const report = {
  day, windowS, generatedAt: new Date().toISOString(),
  linkEventsByApp: Object.fromEntries(counts.map((c) => [c._id || '?', c.n])),
  classic: fin(all),
  byAccount: Object.fromEntries(Object.entries(byAccount).map(([k, v]) => [k, fin(v)]).sort((a, b) => b[1].toFleet - a[1].toFleet)),
  bySite: Object.fromEntries(Object.entries(bySite).map(([k, v]) => [k, fin(v)]).sort((a, b) => b[1].toFleet - a[1].toFleet)),
};
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

const n = (v) => (v || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
console.log(`\n${day}: scout link events ${JSON.stringify(report.linkEventsByApp)}`);
const c = report.classic;
console.log(`classic: ${n(c.clicks)} clicks, ${n(c.toFleet)} to a fleet site → ${n(c.arrived)} arrived (${pct(c.arrived, c.toFleet)}), human-shaped ${n(c.human)} (${pct(c.human, c.toFleet)}) · proved by gdpid ${n(c.byGdpid)}, by address ${n(c.byAddress)} · median ${c.medianDelayS}s click→page`);
console.log('\nSITE                 to fleet  arrived  human   median s');
for (const [k, v] of Object.entries(report.bySite)) console.log(`${k.padEnd(20)} ${n(v.toFleet).padStart(8)} ${pct(v.arrived, v.toFleet).padStart(8)} ${pct(v.human, v.toFleet).padStart(6)} ${String(v.medianDelayS ?? '—').padStart(9)}`);
console.log('\narrived as (all classic):', JSON.stringify(Object.fromEntries(Object.entries(report.classic.arrivedAs).sort((a, b) => b[1] - a[1]))));
console.log('\nACCOUNT              to fleet  arrived  human   arrived as');
for (const [k, v] of Object.entries(report.byAccount).filter(([, v]) => v.toFleet).slice(0, 15)) console.log(`${k.padEnd(20)} ${n(v.toFleet).padStart(8)} ${pct(v.arrived, v.toFleet).padStart(8)} ${pct(v.human, v.toFleet).padStart(6)}   ${JSON.stringify(Object.fromEntries(Object.entries(v.arrivedAs).sort((a, b) => b[1] - a[1]).slice(0, 4)))}`);
// who the non-human arrivals are: top addresses/agents behind them
const who = {};
for (const c of clicks) if (c.arrival && !['in-app', 'browser'].includes(c.arrival.class)) { const k = `${c.arrival.ip} ${String(c.arrival.ua || '-').slice(0, 70)}`; who[k] = (who[k] || 0) + 1; }
console.log('\nTOP NON-HUMAN ARRIVALS (address · agent)');
for (const [k, v] of Object.entries(who).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${String(v).padStart(6)}  ${k}`);
