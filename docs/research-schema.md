# emcee collections in `research`

The emcee is a role of research: it writes its observations into the `research`
database as the `research` user, beside Ember's own state. This is the text to fold
into pro-research's `SchemaDocumentation.mjs` so Ember can answer traffic questions.

Every collection is keyed by `day` (`YYYY-MM-DD`, UTC). A day is replaced whole on each
ingest, so a day has exactly one answer.

## `emcee_traffic` — who asked for what

One row per day · hour · site · class · agent · verification · in-app.

| Field | Is |
|---|---|
| `day`, `hour` | UTC |
| `site` | `popdust.com`, … — **null for wp-2's share** until its log format matches wp-1's |
| `class` | `browser` `in-app` `ai-index` `ai-crawler` `ai-agent` `search` `ads` `preview` `seo` `monitor` `tool` `unknown-bot` `none` |
| `agent`, `operator` | what the User-Agent claims (`GPTBot`/`OpenAI`), null for browsers |
| `verified` | `ok` — the operator's published ranges/ASN/reverse-DNS stand behind the address; `failed` — they don't (an impostor); `none` — the operator publishes nothing to check; null — no claim |
| `inApp` | `facebook` `instagram` `tiktok` for in-app browsers |
| `requests`, `cacheHit`, `php`, `rtSeconds`, `status{2xx…}` | counts; `php` = requests that reached PHP (wp-1 only) |

Sum `requests` over rows; never average across rows.

## `emcee_paid` — what paid traffic arrived

One row per day · site · network · utm_source · utm_campaign · matched Meta ad.

| Field | Is |
|---|---|
| `network` | `META` `TABOOLA` `GOOGLE` `OTHER` — from click ids (`fbclid`/`tblci`/`gclid`) or a Meta match, else `utm_source` |
| `utmSource`, `utmCampaign` | as they arrived — spellings vary by advertiser |
| `metaAccount`, `metaCampaignsetId`, `metaAdId`, `metaLevel`, `matchedBy` | the Meta record this landing matched (by an id on the URL, or an exact campaign/ad name); null when none |
| `requests` | page requests carrying paid parameters |
| `clicks` | distinct click ids (`fbclid`/`tblci`/`gclid`; else address+agent) — a click that arrived |
| `arrivals{…}`, `clicksByArrival{…}` | by how it arrived: `human-shaped` (browser or in-app), `preview` (e.g. Meta's fetcher), `bot`, `false-claim` |

**Meta's own figures are not copied here.** Join them from `bluefire.stat_v4`:

```js
// Meta link clicks vs clicks that arrived, per campaign, one day
const ours = researchDb.collection('emcee_paid').aggregate([
  { $match: { day: '2026-10-02', metaCampaignsetId: { $ne: null } } },
  { $group: { _id: { account: '$metaAccount', cs: '$metaCampaignsetId' }, arrived: { $sum: '$clicks' }, human: { $sum: '$clicksByArrival.human-shaped' } } },
]);
// for each: bluefireDb.collection('stat_v4') { _account, network:'META', _pass:'ad|device_platform',
//   _time: ISODate(day), campaignsetId, metric:'link_click', window:null } → $sum value
```

A Meta day is the ad account's timezone; an emcee day is UTC — compare over several days.

## `emcee_runs` — provenance

One row per day: the files read (lines, unparsed), requests outside the day, the
verification prefix lists used and when they were fetched, and how many Meta entities
the day's matching had.
