// The one accounting of what the emcee observed — used by the log ingest (a whole
// day, written once) and by the live observer (deltas, written every minute).
//
//   const rollup = new Rollup({ meta });                // meta: MetaRecords, or null where there's no ad data
//   rollup.add(rec, facts, { day, hour });
//   rollup.rows()    → { traffic, paid }  absolute rows (ingest replaces a day with these)
//   rollup.drain()   → { traffic, paid, requests }  what changed since the last drain, as $inc deltas
//   rollup.prune(keep) drops rows whose day·hour isn't `keep` (the live observer keeps only the current hour)
//
// Rows (one shape for both writers, read by lib/site-stats.mjs):
//   emcee_traffic  day · hour · site · class · agent · verified · inApp  → requests, cacheHit, php, rtSeconds, status{2xx…}
//   emcee_paid     day · hour · site · network · utmSource · utmCampaign · matched Meta ad
//                  → requests, clicks, arrivals{…}, clicksByArrival{…}
// A click is a click id (fbclid / tblci / gclid), else address+agent; distinct per row.

import crypto from 'node:crypto';
import { arrivalOf } from './identify.mjs';

export const idOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 24);
const query = (url) => { const at = url.indexOf('?'); return new URLSearchParams(at < 0 ? '' : url.slice(at + 1)); };
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

function networkOf(q, facts, match) {
  if (q.get('fbclid') || match) return 'META';
  if (q.get('tblci') || /taboola|^tb\b/i.test(facts.paid.utm.source || '')) return 'TABOOLA';
  if (q.get('gclid')) return 'GOOGLE';
  if (/meta|facebook|^fb$|instagram/i.test(facts.paid.utm.source || '')) return 'META';
  return 'OTHER';
}

export default class Rollup {
  constructor({ meta = null } = {}) {
    this.meta = meta;
    this.traffic = new Map();   // _id -> {key, operator, total{}, delta{}}
    this.paid = new Map();      // _id -> {key, total{}, delta{}, clicks:Set, clicksBy:{arrival:Set}}
    this.requests = 0;          // since the last drain
  }

  add(rec, facts, { day, hour }) {
    this.requests++;
    const verified = facts.claim ? (facts.verified ? ({ true: 'ok', false: 'failed', null: 'unresolved' })[facts.verified.ok] : 'none') : null;
    const tk = { day, hour, site: rec.host, class: facts.class, agent: facts.claim?.agent || null, verified, inApp: facts.inApp };
    const tid = idOf(tk);
    const t = this.traffic.get(tid) || this.traffic.set(tid, { key: tk, operator: facts.claim?.operator || null, total: {}, delta: {} }).get(tid);
    for (const into of [t.total, t.delta]) {
      bump(into, 'requests');
      if (rec.cache === 'HIT') bump(into, 'cacheHit');
      if (rec.php) bump(into, 'php');
      if (rec.rt) bump(into, 'rtSeconds', rec.rt);
      bump(into, `status.${String(rec.status)[0]}xx`);
    }

    if (!facts.paid) return;
    const q = query(rec.url);
    const hit = this.meta ? this.meta.match(facts.paid.platformIds, Object.values(facts.paid.utm).filter(Boolean)) : null;
    const e = hit?.entity;
    const pk = {
      day, hour, site: rec.host, network: networkOf(q, facts, hit),
      utmSource: facts.paid.utm.source, utmCampaign: facts.paid.utm.campaign,
      metaAccount: e?.account || null, metaCampaignsetId: e?.campaignsetId || null,
      metaAdId: e?.level === 'ad' ? e.id : null, metaLevel: e?.level || null, matchedBy: hit?.by || null,
    };
    const pid = idOf(pk);
    const p = this.paid.get(pid) || this.paid.set(pid, { key: pk, total: {}, delta: {}, clicks: new Set(), clicksBy: {} }).get(pid);
    const arrival = arrivalOf(facts);
    const click = q.get('fbclid') || q.get('tblci') || q.get('gclid') || `${rec.ip}|${rec.ua}`;
    const fresh = !p.clicks.has(click);
    const freshBy = !(p.clicksBy[arrival] ||= new Set()).has(click);
    p.clicks.add(click);
    p.clicksBy[arrival].add(click);
    for (const into of [p.total, p.delta]) {
      bump(into, 'requests');
      bump(into, `arrivals.${arrival}`);
      if (fresh) bump(into, 'clicks');
      if (freshBy) bump(into, `clicksByArrival.${arrival}`);
    }
  }

  // Absolute rows, nested the way they're stored.
  rows() {
    const nest = (flat) => {
      const out = {};
      for (const [k, v] of Object.entries(flat)) {
        const [a, b] = k.split('.');
        if (b) (out[a] ||= {})[b] = v; else out[a] = k === 'rtSeconds' ? Math.round(v * 1000) / 1000 : v;
      }
      return out;
    };
    return {
      traffic: [...this.traffic.entries()].map(([_id, t]) => ({ _id, ...t.key, operator: t.operator, cacheHit: 0, php: 0, rtSeconds: 0, status: {}, ...nest(t.total) })),
      paid: [...this.paid.entries()].map(([_id, p]) => ({ _id, ...p.key, clicks: 0, arrivals: {}, clicksByArrival: {}, ...nest(p.total) })),
    };
  }

  // What changed since the last drain: [{_id, set, inc}] ready for an upsert with $setOnInsert/$inc.
  drain() {
    const out = { traffic: [], paid: [], requests: this.requests };
    for (const [_id, t] of this.traffic) {
      if (!Object.keys(t.delta).length) continue;
      out.traffic.push({ _id, set: { ...t.key, operator: t.operator }, inc: t.delta });
      t.delta = {};
    }
    for (const [_id, p] of this.paid) {
      if (!Object.keys(p.delta).length) continue;
      out.paid.push({ _id, set: p.key, inc: p.delta });
      p.delta = {};
    }
    this.requests = 0;
    return out;
  }

  prune({ day, hour }) {
    for (const map of [this.traffic, this.paid]) {
      for (const [id, r] of map) if ((r.key.day !== day || r.key.hour !== hour) && !Object.keys(r.delta).length) map.delete(id);
    }
  }
}
