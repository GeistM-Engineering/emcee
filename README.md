# GeistM emcee

`@geistm/emcee` — the publisher edge that knows who is asking. What it is for, and
why, is the plan on `epistery.com/@geistm/dev-board` (post #3). This README covers
the code.

Today the repo holds the identification layer and a replay tool. The edge itself
(Node on 80/443 behind an NLB, Certify TLS, Epistery Config, proxy to the fleet)
builds on top of it.

## Identification — `lib/identify.mjs`

```js
import Identify from '@geistm/emcee/identify';
const identify = await Identify.create();
const facts = await identify.evidence({ ip, ua, url, referer });
```

Evidence, never a score:

| Field | Is |
| --- | --- |
| `class` | `ai-agent` `ai-index` `ai-crawler` `search` `ads` `preview` `seo` `monitor` `tool` `unknown-bot` `in-app` `browser` `none` |
| `claim` | `{agent, operator}` — what the User-Agent says it is |
| `verified` | `{ok, method, detail}` checked against what the operator publishes; `null` when it publishes nothing |
| `inApp` | `facebook` `instagram` `tiktok` — the shape paid social clicks arrive in |
| `paid` | click ids (`fbclid`, `gclid`…), utm, `campaign_id`/`ad_id`, scout ids (`gcid`, `gdpid`, scout referrer) |
| `fromAi` | the AI answer engine a visitor came from, by referrer or `utm_source` |
| `referrer` | referrer host |

A claim is verified by whichever method its operator publishes (`lib/catalog.mjs`):

- **ranges** — the operator's IP prefix JSON (OpenAI, Google, Bing, Apple, Perplexity)
- **asn** — the operator's announced prefixes, from RIPEstat (Meta, AS32934; its crawler range has no PTR)
- **fcrdns** — forward-confirmed reverse DNS (Amazon, Petal, Yandex, Baidu, Ahrefs, Semrush; Google/Bing/Apple as a second method)

`verified.ok === false` is a request naming an operator that doesn't stand behind
the address. It keeps its claimed class; what to do about it is site policy.

Operators with nothing published (Anthropic, ByteDance, Exa, Common Crawl…) are
recorded as claims. The trust factors are GeistM's to choose: other evidence (an
epistery Bot envelope, scout click history, facts from epistery.com scan) joins
these facts where the edge has it.

| File | Is |
| --- | --- |
| `lib/catalog.mjs` | the agents, their operators, classes and verification methods |
| `lib/sources.mjs` | the fetched prefix lists, as a reproducible snapshot |
| `lib/rdns.mjs` | forward-confirmed reverse DNS, cached per IP |
| `lib/landing.mjs` | how a request got here: paid ids, scout ids, AI referrers |
| `lib/nginx-log.mjs` | the fleet's two nginx log formats, for replay |

## Replay — `bin/replay.mjs`

```bash
node bin/replay.mjs --snapshot sources.json --out report.json wp1.log.gz wp2.log.gz
```

Runs nginx access logs through `evidence()` and rolls up what the edge would have
recorded: by class, by agent (verified / failed / no method), by site, paid landings
(class, in-app, click ids, utm_source, referrer, scout join), AI-answer referrals,
and what the AI classes were served. `--snapshot` pins the prefix lists so a report
can be recomputed from the same inputs.

## Tests

```bash
npm test
```
