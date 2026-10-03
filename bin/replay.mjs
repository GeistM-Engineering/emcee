#!/usr/bin/env node
// Replay nginx access logs through emcee's identification, and roll up what it
// would have recorded live.
//
//   node bin/replay.mjs [--snapshot sources.json] [--out report.json] access.log[.gz] …
//
// --snapshot  the verification sources to check against. Read when present;
//             whatever is missing is fetched and the file is (re)written, so the
//             report can always be recomputed from the same inputs.
// --out       the full rollup as JSON. A summary is printed either way.
//
// Prefixes are fetched today and applied to past traffic. Operators move addresses
// slowly, but a replay is only as current as its snapshot — the snapshot dates say so.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import Identify from '../lib/identify.mjs';
import { parse } from '../lib/nginx-log.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const snapshotPath = opt('--snapshot');
const outPath = opt('--out');
const files = args;
if (!files.length) {
  console.error('usage: replay.mjs [--snapshot sources.json] [--out report.json] access.log[.gz] …');
  process.exit(2);
}

const snapshot = snapshotPath && fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : undefined;
const identify = await Identify.create({ snapshot });
if (snapshotPath) fs.writeFileSync(snapshotPath, JSON.stringify(identify.sources.snapshot, null, 2));

const rollup = newRollup();
for (const file of files) await replay(file);
const report = finish(rollup);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
print(report);

async function replay(file) {
  const input = fs.createReadStream(file).pipe(file.endsWith('.gz') ? zlib.createGunzip() : new (await import('node:stream')).PassThrough());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let batch = [];
  for await (const line of lines) {
    batch.push(line);
    if (batch.length === 2000) { await run(batch, file); batch = []; }
  }
  if (batch.length) await run(batch, file);
}

async function run(batch, file) {
  await Promise.all(batch.map(async (line) => {
    rollup.lines++;
    const rec = parse(line);
    if (!rec) { rollup.unparsed++; return; }
    const facts = await identify.evidence(rec);
    tally(rec, facts, file);
  }));
}

function newRollup() {
  return { lines: 0, unparsed: 0, files: [], byClass: {}, byAgent: {}, bySite: {}, paid: null, fromAi: {}, aiServed: {} };
}

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

function tally(rec, facts, file) {
  if (!rollup.files.includes(file)) rollup.files.push(file);
  const c = (rollup.byClass[facts.class] ||= { requests: 0, cacheHit: 0, php: 0, rtSeconds: 0, verifiedOk: 0, verifiedFail: 0, unverifiable: 0 });
  c.requests++;
  if (rec.cache === 'HIT') c.cacheHit++;
  if (rec.php) c.php++;
  if (rec.rt) c.rtSeconds += rec.rt;

  if (facts.claim) {
    const a = (rollup.byAgent[facts.claim.agent] ||= { operator: facts.claim.operator, class: facts.class, requests: 0, verifiedOk: 0, verifiedFail: 0, unverifiable: 0, cacheHit: 0, php: 0, methods: {}, failIps: {} });
    a.requests++;
    if (rec.cache === 'HIT') a.cacheHit++;
    if (rec.php) a.php++;
    if (!facts.verified) { a.unverifiable++; c.unverifiable++; }
    else if (facts.verified.ok) { a.verifiedOk++; c.verifiedOk++; bump(a.methods, facts.verified.method); }
    else { a.verifiedFail++; c.verifiedFail++; bump(a.failIps, rec.ip); }
  }

  if (rec.host) bump((rollup.bySite[rec.host] ||= {}), facts.class);

  if (facts.class.startsWith('ai-')) {
    const s = (rollup.aiServed[facts.class] ||= {});
    bump(s, `${String(rec.status)[0]}xx`);
  }

  if (facts.fromAi) bump(rollup.fromAi, facts.fromAi);

  if (facts.paid) {
    const p = (rollup.paid ||= { landings: 0, byClass: {}, byInApp: {}, byReferrer: {}, byUtmSource: {}, clickIds: {}, claimedBotUnverified: 0, scout: { gcid: 0, gdpid: 0, viaReferrer: 0, any: 0 } });
    p.landings++;
    bump(p.byClass, facts.class);
    if (facts.inApp) bump(p.byInApp, facts.inApp);
    bump(p.byReferrer, facts.referrer || '(none)');
    bump(p.byUtmSource, facts.paid.utm.source || '(none)');
    for (const id of facts.paid.clickIds) bump(p.clickIds, id);
    const sc = facts.paid.scout;
    if (sc.gcid) p.scout.gcid++;
    if (sc.gdpid) p.scout.gdpid++;
    if (sc.viaReferrer) p.scout.viaReferrer++;
    if (sc.gcid || sc.gdpid || sc.viaReferrer) p.scout.any++;
    if (facts.verified && !facts.verified.ok) p.claimedBotUnverified++;
  }
}

function finish(r) {
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  for (const a of Object.values(r.byAgent)) a.failIps = top(a.failIps, 5);
  if (r.paid) {
    r.paid.byReferrer = top(r.paid.byReferrer, 12);
    r.paid.byUtmSource = top(r.paid.byUtmSource, 12);
  }
  return {
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(identify.sources.snapshot).map(([k, s]) => [k, { url: s.url, fetchedAt: s.fetchedAt, prefixes: s.prefixes.length }])),
    ...r,
  };
}

function print(rep) {
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
  const total = rep.lines - rep.unparsed;
  console.log(`\n${rep.lines} lines, ${rep.unparsed} unparsed, files: ${rep.files.join(', ')}`);
  console.log('\nCLASS            requests   share   hit   php     verified ok / FAILED / no method');
  for (const [k, c] of Object.entries(rep.byClass).sort((a, b) => b[1].requests - a[1].requests)) {
    console.log(`${k.padEnd(14)} ${String(c.requests).padStart(10)} ${pct(c.requests, total).padStart(7)} ${pct(c.cacheHit, c.requests).padStart(6)} ${String(c.php).padStart(6)}     ${c.verifiedOk} / ${c.verifiedFail} / ${c.unverifiable}`);
  }
  console.log('\nAGENT                    operator        class        requests   verified   FAILED  no-method');
  for (const [k, a] of Object.entries(rep.byAgent).sort((x, y) => y[1].requests - x[1].requests).slice(0, 30)) {
    console.log(`${k.padEnd(24)} ${a.operator.padEnd(15)} ${a.class.padEnd(11)} ${String(a.requests).padStart(9)} ${String(a.verifiedOk).padStart(10)} ${String(a.verifiedFail).padStart(8)} ${String(a.unverifiable).padStart(10)}`);
  }
  if (rep.paid) {
    const p = rep.paid;
    console.log(`\nPAID LANDINGS ${p.landings}`);
    console.log('  by class    ', JSON.stringify(p.byClass));
    console.log('  in-app      ', JSON.stringify(p.byInApp));
    console.log('  click ids   ', JSON.stringify(p.clickIds));
    console.log('  utm_source  ', JSON.stringify(p.byUtmSource));
    console.log('  referrer    ', JSON.stringify(p.byReferrer));
    console.log(`  scout join   gcid ${p.scout.gcid} · gdpid ${p.scout.gdpid} · scout referrer ${p.scout.viaReferrer} · any ${p.scout.any} (${pct(p.scout.any, p.landings)})`);
    console.log(`  claimed bots failing verification: ${p.claimedBotUnverified}`);
  }
  console.log('\nFROM AI ANSWERS', JSON.stringify(rep.fromAi));
  console.log('AI CLASSES SERVED', JSON.stringify(rep.aiServed));
  console.log('\nSOURCES');
  for (const [k, s] of Object.entries(rep.sources)) console.log(`  ${k.padEnd(60)} ${String(s.prefixes).padStart(5)} prefixes  fetched ${s.fetchedAt}`);
}
