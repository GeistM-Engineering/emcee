// Who is asking. The evidence for one request, never a score.
//
//   const identify = await Identify.create();
//   const facts = await identify.evidence({ ip, ua, url, referer });
//
// facts = {
//   class,                 ai-agent | ai-index | ai-crawler | search | ads | preview | seo |
//                          monitor | tool | unknown-bot | in-app | browser | none
//   claim:    {agent, operator} | null      what the User-Agent says it is
//   verified: {ok, method, detail} | null   checked against what the operator publishes;
//                                           null when the operator publishes nothing to check
//   inApp:    'facebook' | 'instagram' | … | null
//   referrer, paid, fromAi                  how it got here (landing.mjs)
// }
//
// verified.ok === null means a check could not be completed (reverse DNS timed out):
// recorded as unresolved, never as an impostor.
// verified.ok === false is the interesting fact: a request that names an operator
// with a published method, from an address that operator doesn't stand behind.
// It is recorded as such — what anyone does about it is site policy, not ours to
// decide here.
//
// The trust factors are GeistM's to choose. This module produces the evidence the
// edge can establish on its own; other evidence (an epistery Bot envelope, scout's
// click history, facts from epistery.com scan) joins it where the edge has it.

import { AGENTS, IN_APP, TOOL, GENERIC_BOT } from './catalog.mjs';
import Sources from './sources.mjs';
import Rdns from './rdns.mjs';
import { landing } from './landing.mjs';

// How a request arrived, in the buckets marketing asks about.
export function arrivalOf(facts) {
  if (facts.class === 'in-app' || facts.class === 'browser') return 'human-shaped';
  if (facts.class === 'preview') return 'preview';
  if (facts.verified?.ok === false) return 'false-claim';
  return 'bot';
}

export default class Identify {
  constructor({ catalog = AGENTS, sources, rdns }) {
    this.catalog = catalog;
    this.sources = sources;
    this.rdns = rdns;
  }

  // snapshot: a prior Sources snapshot to verify against (reproducible replays);
  // anything the catalog needs that it lacks is fetched.
  static async create({ catalog = AGENTS, snapshot, rdns = new Rdns() } = {}) {
    const sources = await new Sources(snapshot).load(catalog);
    return new Identify({ catalog, sources, rdns });
  }

  claimOf(ua) {
    if (!ua || ua === '-') return null;
    return this.catalog.find((entry) => entry.ua.test(ua)) || null;
  }

  async evidence({ ip, ua, url = '/', referer = null }) {
    const facts = { class: 'browser', claim: null, verified: null, inApp: null, ...landing(url, referer) };
    const entry = this.claimOf(ua);
    if (entry) {
      facts.class = entry.class;
      facts.claim = { agent: entry.agent, operator: entry.operator };
      facts.verified = entry.verify ? await this.verify(ip, entry.verify) : null;
      return facts;
    }
    if (!ua || ua === '-') facts.class = 'none';
    else if (TOOL.test(ua)) facts.class = 'tool';
    else if (GENERIC_BOT.test(ua)) facts.class = 'unknown-bot';
    else {
      const app = IN_APP.find((a) => a.ua.test(ua));
      if (app) { facts.class = 'in-app'; facts.inApp = app.app; }
    }
    return facts;
  }

  // Each method the operator publishes is tried; any one standing behind the
  // address is enough. The failure names every method that was tried.
  async verify(ip, verify) {
    for (const url of verify.ranges || []) {
      if (this.sources.contains(url, ip)) return { ok: true, method: 'ranges', detail: url };
    }
    if (verify.asn && this.sources.contains(`AS${verify.asn}`, ip)) {
      return { ok: true, method: 'asn', detail: `AS${verify.asn}` };
    }
    if (verify.fcrdns) {
      const { ok, ptr } = await this.rdns.matches(ip, verify.fcrdns);
      if (ok) return { ok: true, method: 'fcrdns', detail: ptr };
      if (ok === null) return { ok: null, method: 'fcrdns', detail: 'reverse DNS gave no answer' };
      return { ok: false, method: this._methods(verify), detail: ptr ? `ptr ${ptr}` : 'no confirmed ptr' };
    }
    return { ok: false, method: this._methods(verify), detail: 'address outside published ranges' };
  }

  _methods(verify) {
    return ['ranges', 'asn', 'fcrdns'].filter((m) => verify[m]).join('+');
  }
}
