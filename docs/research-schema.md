# emcee collections

The emcee writes into whatever database its host configures: on the adnet agency
that is `research` (as the `research` user, beside Ember's own state); on a harness
host it is that host's own database. This is the text to fold into pro-research's
`SchemaDocumentation.mjs` so Ember can answer traffic questions.

Two writers, one shape. The log ingest replaces a whole `day` on each run; the live
observer (harness middleware) adds to the current hour's rows every minute.
Every row carries `day` (`YYYY-MM-DD`, UTC) and `hour`.

## `emcee_traffic` — who asked for what

One row per day · hour · site · class · agent · verification · in-app.

| Field | Is |
|---|---|
| `day`, `hour` | UTC |
| `site` | `popdust.com`, … — **null for wp-2's share** until its log format matches wp-1's |
| `class` | `browser` `in-app` `ai-index` `ai-crawler` `ai-agent` `search` `ads` `preview` `seo` `monitor` `tool` `unknown-bot` `none` |
| `agent`, `operator` | what the User-Agent claims (`GPTBot`/`OpenAI`), null for browsers |
| `verified` | `ok` — the operator's published ranges/ASN/reverse-DNS stand behind the address; `failed` — they don't (an impostor); `unresolved` — the check couldn't complete (reverse DNS gave no answer), never counted as an impostor; `none` — the operator publishes nothing to check; null — no claim |
| `inApp` | `facebook` `instagram` `tiktok` for in-app browsers |
| `requests`, `cacheHit`, `php`, `rtSeconds`, `status{2xx…}` | counts; `php` = requests that reached PHP (wp-1 only) |

Sum `requests` over rows; never average across rows.

## `emcee_paid` — what paid traffic arrived

One row per day · hour · site · network · utm_source · utm_campaign · matched Meta ad.

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

One row per day. From the ingest: the files read (lines, unparsed), requests outside
the day, the verification prefix lists used, and how many Meta entities the day's
matching had. From the live observer: `live: true`, the observing host, and a running
`totals.requests`.
