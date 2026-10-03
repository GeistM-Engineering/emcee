// What a request says about how it got here: paid-click identifiers, scout's
// attribution ids, and whether it came from an AI answer.
//
// These are read from the request as it arrived. Nothing is inferred: a landing is
// "paid" because it carries a paid-click identifier, and "from scout" because it
// carries scout's ids or scout's referrer.

const AI_REFERRERS = [
  'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com',
  'copilot.microsoft.com', 'meta.ai', 'chat.deepseek.com', 'you.com', 'grok.com', 'kagi.com',
];
const AI_UTM_SOURCES = /^(chatgpt\.com|openai|perplexity|claude|gemini|copilot|meta\.ai|deepseek|grok)/i;
const SCOUT_HOSTS = ['i.blackfire.pro', 'i.geistm.com', 'blackfire.pro'];
const PAID_MEDIUM = /paid|cpc|ppc|cpm/i;

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
};
const under = (host, domains) => !!host && domains.some((d) => host === d || host.endsWith('.' + d));

// url: the request path + query as received. referer: the Referer header or null.
export function landing(url, referer) {
  // Only the query matters here, and request lines are whatever the client sent
  // (scanners send `//?author=1`), so parse the query alone rather than a URL.
  const at = url.indexOf('?');
  const q = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  const get = (name) => {
    for (const [k, v] of q) if (k.toLowerCase() === name) return v;
    return null;
  };
  const ref = hostOf(referer);

  const clickIds = ['fbclid', 'gclid', 'ttclid', 'msclkid'].filter((k) => get(k) !== null);
  const utm = { source: get('utm_source'), medium: get('utm_medium'), campaign: get('utm_campaign') };
  const scout = { gcid: get('gcid'), gdpid: get('gdpid'), viaReferrer: under(ref, SCOUT_HOSTS) };
  const paid = clickIds.length > 0 || !!scout.gcid || !!scout.gdpid || PAID_MEDIUM.test(utm.medium || '');

  return {
    referrer: ref,
    paid: paid ? {
      clickIds,
      utm,
      campaignId: get('campaign_id'),
      adId: get('ad_id'),
      scout,
    } : null,
    fromAi: (under(ref, AI_REFERRERS) ? ref : null) || (AI_UTM_SOURCES.test(utm.source || '') ? utm.source : null),
  };
}
