// Meta's own record of a day's campaigns, and the one rule for matching a landing
// to it.
//
// The record is bluefire.stat_v4: pass `ad|device_platform` summed over devices,
// `window: null` (clicks and impressions carry no attribution window). Every ad,
// adset and campaign id seen that day becomes an entity, with its names.
//
// A landing matches by what its URL says:
//   1. any 15–20 digit number that IS one of Meta's ids — most specific level wins
//      (advertisers' templates put ids under ad_id, campaignid, utm_id, abid…)
//   2. else an exact utm value that IS a Meta campaign name, refined by an exact ad
//      name within that campaign (templates that carry names, not ids)
// A name that isn't unique at its level matches nothing.

export const METRICS = ['spend', 'impressions', 'link_click', 'landing_page_view'];
const LEVEL_RANK = { ad: 0, adset: 1, campaign: 2 };

export default class MetaRecords {
  constructor(entities) {
    this.entities = entities;                       // id -> {level, account, accountName, name, campaignsetId, campaignset, metrics}
    this.byName = { campaign: new Map(), ad: new Map() };
    for (const e of entities.values()) {
      const m = this.byName[e.level];
      if (!m || !e.name) continue;
      m.set(e.name, m.has(e.name) && m.get(e.name) !== e ? null : e);
    }
  }

  // bluefire: a Db handle. day: 'YYYY-MM-DD'.
  static async load(bluefire, day) {
    const time = new Date(`${day}T00:00:00Z`);
    const accounts = await bluefire.collection('account').find({ 'codes.name': 'META' }, { projection: { _id: 1, name: 1 } }).toArray();
    const entities = new Map();
    for (const acct of accounts) {
      const rows = await bluefire.collection('stat_v4').aggregate([
        { $match: { _account: acct._id, network: 'META', _pass: 'ad|device_platform', _time: time, metric: { $in: METRICS }, window: null } },
        { $group: { _id: { ad: '$adId', adset: '$adsetId', cs: '$campaignsetId', metric: '$metric' }, v: { $sum: '$value' }, adName: { $first: '$ad' }, adsetName: { $first: '$adset' }, csName: { $first: '$campaignset' } } },
      ], { maxTimeMS: 120000 }).toArray();
      for (const r of rows) {
        const base = { account: acct._id, accountName: acct.name, campaignsetId: r._id.cs, campaignset: r.csName };
        for (const [level, id, name] of [['ad', r._id.ad, r.adName], ['adset', r._id.adset, r.adsetName], ['campaign', r._id.cs, r.csName]]) {
          if (!id) continue;
          if (!entities.has(id)) entities.set(id, { id, level, name, ...base, metrics: {} });
          const e = entities.get(id);
          e.metrics[r._id.metric] = (e.metrics[r._id.metric] || 0) + r.v;
        }
      }
    }
    return new MetaRecords(entities);
  }

  // ids: [{param, id}] from landing.platformIds. names: utm values.
  // → {entity, by} where by names what proved it ('<param>' or 'name'), or null.
  match(ids = [], names = []) {
    const hit = ids.map((p) => ({ by: p.param, entity: this.entities.get(p.id) })).filter((h) => h.entity)
      .sort((a, b) => LEVEL_RANK[a.entity.level] - LEVEL_RANK[b.entity.level])[0];
    if (hit) return hit;
    const camp = names.map((v) => this.byName.campaign.get(v)).find(Boolean);
    const ads = names.map((v) => this.byName.ad.get(v)).filter(Boolean);
    const ad = camp ? ads.find((a) => a.campaignsetId === camp.campaignsetId) : ads[0];
    if (ad) return { by: 'name', entity: ad };
    if (camp) return { by: 'name', entity: camp };
    return null;
  }
}
