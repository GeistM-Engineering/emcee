// One site's traffic, as the emcee observed it, for the last N ingested days.
//
//   const stats = await siteStats({ research, bluefire }, 'popdust.com', { days: 7 });
//
// Two halves, so the shape can be tested without a database:
//   load()   reads research.emcee_traffic / emcee_paid / emcee_runs, and Meta's link
//            clicks for the ads that land on the site from bluefire.stat_v4
//   shape()  turns those rows into the answer
//
// Our observations come from research.emcee_*; Meta's figures are read from
// stat_v4 at answer time, never copied (the matched ad id is the join).
//
// Coverage, stated in the answer rather than hidden: traffic rows carry a site only
// where the log names the host (wp-1's `cached` format, journiest's own file). wp-2's
// share has site null, so `coverage.siteKnownShare` says what fraction of the fleet's
// requests the site figures can see. Paid arrivals are attributed more fully: an ad's
// destination is one page, so a site-less row matched to an ad that lands on this site
// is this site's.

const MAX_DAYS = 31;
const AI = new Set(['ai-agent', 'ai-index', 'ai-crawler']);
const HUMAN = new Set(['browser', 'in-app']);

export const normalizeDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export async function load({ research, bluefire }, domain, { days = 7 } = {}) {
  const n = Math.max(1, Math.min(MAX_DAYS, Number(days) || 7));
  const runs = await research.collection('emcee_runs').find({}, { projection: { _id: 1, totals: 1 } }).sort({ _id: -1 }).limit(n).toArray();
  const dayList = runs.map((r) => r._id).sort();
  if (!dayList.length) return { domain, days: [], traffic: [], fleetByDay: [], paid: [], metaClicks: [], adIds: [], sharedAds: [] };

  const traffic = await research.collection('emcee_traffic').aggregate([
    { $match: { day: { $in: dayList }, site: domain } },
    { $group: { _id: { day: '$day', class: '$class', agent: '$agent', operator: '$operator', verified: '$verified' }, requests: { $sum: '$requests' }, php: { $sum: '$php' } } },
  ]).toArray();
  const fleetByDay = await research.collection('emcee_traffic').aggregate([
    { $match: { day: { $in: dayList } } },
    { $group: { _id: { day: '$day', known: { $ne: ['$site', null] } }, requests: { $sum: '$requests' } } },
  ]).toArray();

  // Ads whose landings name this site. An ad counts as this site's only when every
  // landing of it that names a site names this one: catalog / multi-publisher ads
  // send clicks to several sites, and Meta's per-ad clicks can't be split among them
  // without guessing — those are reported apart, not apportioned.
  const touching = await research.collection('emcee_paid').distinct('metaAdId', { day: { $in: dayList }, site: domain, metaAdId: { $ne: null } });
  const sitesOf = await research.collection('emcee_paid').aggregate([
    { $match: { day: { $in: dayList }, metaAdId: { $in: touching }, site: { $ne: null } } },
    { $group: { _id: '$metaAdId', sites: { $addToSet: '$site' } } },
  ]).toArray();
  const adIds = sitesOf.filter((a) => a.sites.length === 1).map((a) => a._id);
  const sharedAds = sitesOf.filter((a) => a.sites.length > 1).map((a) => ({ adId: a._id, sites: a.sites }));
  const paid = await research.collection('emcee_paid').find({
    day: { $in: dayList },
    $or: [{ site: domain }, { site: null, metaAdId: { $in: adIds } }],
  }, { projection: { _id: 0 } }).toArray();

  // Meta's own link clicks for those ads, per day — read where Meta's numbers live.
  // Per account: every stat_v4 index leads with _account, and an unanchored adId
  // query would scan the collection.
  const adsByAccount = {};
  for (const p of paid) if (p.metaAdId && adIds.includes(p.metaAdId)) (adsByAccount[p.metaAccount] ||= new Set()).add(p.metaAdId);
  const times = dayList.map((d) => new Date(`${d}T00:00:00Z`));
  const metaClicks = [];
  // No ad data on this host (e.g. the harness): Meta's side is simply absent.
  for (const [account, ads] of bluefire ? Object.entries(adsByAccount) : []) {
    metaClicks.push(...await bluefire.collection('stat_v4').aggregate([
      { $match: { _account: account, network: 'META', _pass: 'ad|device_platform', _time: { $in: times }, metric: 'link_click', window: null, adId: { $in: [...ads] } } },
      { $group: { _id: { day: '$_time', adId: '$adId' }, clicks: { $sum: '$value' } } },
    ], { maxTimeMS: 60000 }).toArray());
  }

  return { domain, days: dayList, traffic, fleetByDay, paid, metaClicks, adIds, sharedAds };
}

export function shape({ domain, days, traffic, fleetByDay, paid, metaClicks, adIds = [], sharedAds = [] }) {
  const own = new Set(adIds);
  const blankDay = (day) => ({ day, requests: 0, human: 0, ai: 0, aiVerified: 0, crawlers: 0, impostors: 0, php: 0, paid: { clicks: 0, human: 0, preview: 0, bot: 0 }, meta: { linkClicks: 0, arrived: 0, human: 0 } });
  const daily = new Map(days.map((d) => [d, blankDay(d)]));
  const byClass = {};
  const byAgent = new Map();

  for (const r of traffic) {
    const { day, class: cls, agent, operator, verified } = r._id;
    const d = daily.get(day);
    if (!d) continue;
    d.requests += r.requests;
    d.php += r.php || 0;
    byClass[cls] = (byClass[cls] || 0) + r.requests;
    if (HUMAN.has(cls)) d.human += r.requests;
    else if (AI.has(cls)) { d.ai += r.requests; if (verified === 'ok') d.aiVerified += r.requests; }
    else if (cls !== 'none') d.crawlers += r.requests;
    if (verified === 'failed') d.impostors += r.requests;
    if (agent) {
      const a = byAgent.get(agent) || { agent, operator, class: cls, requests: 0, verified: 0, failed: 0, unverifiable: 0 };
      a.requests += r.requests;
      if (verified === 'ok') a.verified += r.requests;
      else if (verified === 'failed') a.failed += r.requests;
      else a.unverifiable += r.requests;
      byAgent.set(agent, a);
    }
  }

  const byNetwork = {};
  for (const p of paid) {
    const d = daily.get(p.day);
    if (!d) continue;
    const c = p.clicksByArrival || {};
    d.paid.clicks += p.clicks;
    d.paid.human += c['human-shaped'] || 0;
    d.paid.preview += c.preview || 0;
    d.paid.bot += (c.bot || 0) + (c['false-claim'] || 0);
    if (own.has(p.metaAdId)) { d.meta.arrived += p.clicks; d.meta.human += c['human-shaped'] || 0; }
    const net = (byNetwork[p.network] ||= { clicks: 0, human: 0 });
    net.clicks += p.clicks;
    net.human += c['human-shaped'] || 0;
  }
  for (const m of metaClicks) {
    const d = daily.get(m._id.day.toISOString().slice(0, 10));
    if (d) d.meta.linkClicks += m.clicks;
  }

  const known = {}, all = {};
  for (const f of fleetByDay) {
    all[f._id.day] = (all[f._id.day] || 0) + f.requests;
    if (f._id.known) known[f._id.day] = (known[f._id.day] || 0) + f.requests;
  }
  const allSum = Object.values(all).reduce((a, b) => a + b, 0);
  const knownSum = Object.values(known).reduce((a, b) => a + b, 0);
  const days_ = [...daily.values()];
  const sum = (f) => days_.reduce((a, d) => a + f(d), 0);

  return {
    domain,
    days,
    coverage: {
      siteKnownShare: allSum ? Math.round((1000 * knownSum) / allSum) / 1000 : null,
      note: 'Traffic figures cover the requests whose log names the host (wp-1, and journiest on both hosts). Paid arrivals include site-less rows matched to an ad that lands on this site.',
    },
    totals: {
      requests: sum((d) => d.requests),
      human: sum((d) => d.human),
      ai: sum((d) => d.ai),
      aiVerified: sum((d) => d.aiVerified),
      crawlers: sum((d) => d.crawlers),
      impostors: sum((d) => d.impostors),
      php: sum((d) => d.php),
      byClass,
      paid: {
        clicks: sum((d) => d.paid.clicks),
        human: sum((d) => d.paid.human),
        preview: sum((d) => d.paid.preview),
        bot: sum((d) => d.paid.bot),
        byNetwork,
      },
      // Like for like: the ads that land only here — Meta's link clicks for them,
      // and the distinct clicks of theirs that arrived. Ads shared with other sites
      // are listed apart (sharedAds), never apportioned.
      meta: {
        ads: own.size,
        linkClicks: sum((d) => d.meta.linkClicks),
        arrived: sum((d) => d.meta.arrived),
        human: sum((d) => d.meta.human),
        sharedAds: sharedAds.length,
      },
    },
    sharedAds,
    agents: [...byAgent.values()].sort((a, b) => b.requests - a.requests).slice(0, 25),
    daily: days_,
  };
}

export async function siteStats(dbs, domain, opts) {
  return shape(await load(dbs, normalizeDomain(domain), opts));
}
