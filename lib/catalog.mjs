// The catalog of agents that announce themselves in the User-Agent, and how each
// one's claim can be checked.
//
// A User-Agent is a claim, nothing more. What makes a claim checkable is that the
// operator publishes something we can test it against:
//
//   ranges  — the operator publishes its IP prefixes as JSON ({prefixes:[{ipv4Prefix|ipv6Prefix}]})
//   asn     — the operator crawls from its own autonomous system; its announced prefixes are public
//   fcrdns  — forward-confirmed reverse DNS: the IP's PTR ends in the operator's domain AND that
//             name resolves back to the same IP
//
// An entry with no `verify` has no published method. Its claim is recorded as a
// claim, never promoted and never punished: we simply cannot check it.
//
// Order matters: the first pattern that matches wins, so the specific names come
// before the general ones (Claude-User before ClaudeBot, AdsBot-Google before Googlebot).
//
// class is what the caller IS, in our vocabulary:
//   ai-agent     fetching on a person's behalf, right now (ChatGPT-User, Claude-User)
//   ai-index     building an answer engine's retrieval index (OAI-SearchBot, meta-webindexer)
//   ai-crawler   collecting for model training or bulk AI use (GPTBot, ClaudeBot)
//   search       a classic search engine
//   ads          ad-platform landing-page checks
//   preview      link unfurling for a share/post
//   seo          backlink and SEO tools
//   monitor      uptime checks
// Anything that announces as a bot but isn't catalogued is `unknown-bot`.

const OPENAI = 'https://openai.com';
const GOOGLE = 'https://developers.google.com/static/crawling/ipranges';

export const AGENTS = [
  // OpenAI
  { agent: 'ChatGPT-User', operator: 'OpenAI', class: 'ai-agent', ua: /ChatGPT-User/i, verify: { ranges: [`${OPENAI}/chatgpt-user.json`] } },
  { agent: 'OAI-SearchBot', operator: 'OpenAI', class: 'ai-index', ua: /OAI-SearchBot/i, verify: { ranges: [`${OPENAI}/searchbot.json`] } },
  { agent: 'GPTBot', operator: 'OpenAI', class: 'ai-crawler', ua: /GPTBot/i, verify: { ranges: [`${OPENAI}/gptbot.json`] } },

  // Anthropic — no published ranges or reverse-DNS convention we can test against
  { agent: 'Claude-User', operator: 'Anthropic', class: 'ai-agent', ua: /Claude-User/i },
  { agent: 'Claude-SearchBot', operator: 'Anthropic', class: 'ai-index', ua: /Claude-SearchBot/i },
  { agent: 'ClaudeBot', operator: 'Anthropic', class: 'ai-crawler', ua: /ClaudeBot|anthropic-ai/i },

  // Perplexity
  { agent: 'Perplexity-User', operator: 'Perplexity', class: 'ai-agent', ua: /Perplexity-User/i, verify: { ranges: ['https://www.perplexity.ai/perplexity-user.json'] } },
  { agent: 'PerplexityBot', operator: 'Perplexity', class: 'ai-index', ua: /PerplexityBot/i, verify: { ranges: ['https://www.perplexity.ai/perplexitybot.json'] } },

  // Meta — crawls from AS32934; the 57.141.0.0/24 crawler range has no PTR, so ASN is the method
  { agent: 'meta-externalfetcher', operator: 'Meta', class: 'ai-agent', ua: /meta-externalfetcher/i, verify: { asn: 32934 } },
  { agent: 'meta-webindexer', operator: 'Meta', class: 'ai-index', ua: /meta-webindexer/i, verify: { asn: 32934 } },
  { agent: 'meta-externalagent', operator: 'Meta', class: 'ai-crawler', ua: /meta-externalagent/i, verify: { asn: 32934 } },
  { agent: 'facebookexternalhit', operator: 'Meta', class: 'preview', ua: /facebookexternalhit|facebookcatalog|Facebot/i, verify: { asn: 32934 } },

  // Google
  { agent: 'AdsBot-Google', operator: 'Google', class: 'ads', ua: /AdsBot-Google|Mediapartners-Google/i, verify: { ranges: [`${GOOGLE}/special-crawlers.json`], fcrdns: ['google.com', 'googlebot.com'] } },
  { agent: 'Google-user-fetch', operator: 'Google', class: 'ai-agent', ua: /Google-Read-Aloud|Google-NotebookLM|Google-Site-Verification|FeedFetcher-Google/i, verify: { ranges: [`${GOOGLE}/user-triggered-fetchers.json`] } },
  { agent: 'GoogleOther', operator: 'Google', class: 'ai-crawler', ua: /GoogleOther|Google-CloudVertexBot/i, verify: { ranges: [`${GOOGLE}/common-crawlers.json`], fcrdns: ['google.com', 'googlebot.com'] } },
  { agent: 'Googlebot', operator: 'Google', class: 'search', ua: /Googlebot|Storebot-Google|Google-InspectionTool/i, verify: { ranges: [`${GOOGLE}/common-crawlers.json`], fcrdns: ['google.com', 'googlebot.com'] } },

  // Microsoft
  { agent: 'bingbot', operator: 'Microsoft', class: 'search', ua: /bingbot|BingPreview|msnbot/i, verify: { ranges: ['https://www.bing.com/toolbox/bingbot.json'], fcrdns: ['search.msn.com'] } },

  // Apple
  { agent: 'Applebot', operator: 'Apple', class: 'search', ua: /Applebot/i, verify: { ranges: ['https://search.developer.apple.com/applebot.json'], fcrdns: ['applebot.apple.com'] } },

  // Amazon
  { agent: 'Amazonbot', operator: 'Amazon', class: 'ai-crawler', ua: /Amazonbot/i, verify: { fcrdns: ['crawl.amazonbot.amazon'] } },

  // Others that announce an AI purpose, unverifiable today
  { agent: 'DuckAssistBot', operator: 'DuckDuckGo', class: 'ai-agent', ua: /DuckAssistBot/i },
  { agent: 'YouBot', operator: 'You.com', class: 'ai-index', ua: /YouBot/i },
  { agent: 'ExaSearchBot', operator: 'Exa', class: 'ai-index', ua: /ExaSearchBot|exa\.ai/i },
  { agent: 'LinkupBot', operator: 'Linkup', class: 'ai-index', ua: /LinkupBot/i },
  { agent: 'Reflectionbot', operator: 'Reflection AI', class: 'ai-crawler', ua: /Reflectionbot/i },
  { agent: 'Bytespider', operator: 'ByteDance', class: 'ai-crawler', ua: /Bytespider/i },
  { agent: 'CCBot', operator: 'Common Crawl', class: 'ai-crawler', ua: /CCBot/i },
  { agent: 'PetalBot', operator: 'Huawei', class: 'search', ua: /PetalBot/i, verify: { fcrdns: ['petalsearch.com'] } },

  // Search engines
  { agent: 'DuckDuckBot', operator: 'DuckDuckGo', class: 'search', ua: /DuckDuckBot/i },
  { agent: 'YandexBot', operator: 'Yandex', class: 'search', ua: /Yandex/i, verify: { fcrdns: ['yandex.ru', 'yandex.net', 'yandex.com'] } },
  { agent: 'Baiduspider', operator: 'Baidu', class: 'search', ua: /Baiduspider/i, verify: { fcrdns: ['baidu.com', 'baidu.jp'] } },
  { agent: 'Sogou', operator: 'Sogou', class: 'search', ua: /Sogou/i },
  { agent: 'SeznamBot', operator: 'Seznam', class: 'search', ua: /SeznamBot/i },

  // Link previews
  { agent: 'Twitterbot', operator: 'X', class: 'preview', ua: /Twitterbot/i },
  { agent: 'LinkedInBot', operator: 'LinkedIn', class: 'preview', ua: /LinkedInBot/i },
  { agent: 'Slackbot', operator: 'Slack', class: 'preview', ua: /Slackbot|Slack-ImgProxy/i },
  { agent: 'Discordbot', operator: 'Discord', class: 'preview', ua: /Discordbot/i },
  { agent: 'WhatsApp', operator: 'Meta', class: 'preview', ua: /WhatsApp/i },
  { agent: 'TelegramBot', operator: 'Telegram', class: 'preview', ua: /TelegramBot/i },
  { agent: 'Pinterestbot', operator: 'Pinterest', class: 'preview', ua: /Pinterest/i },

  // SEO
  { agent: 'AhrefsBot', operator: 'Ahrefs', class: 'seo', ua: /AhrefsBot|AhrefsSiteAudit/i, verify: { fcrdns: ['ahrefs.com', 'ahrefs.net'] } },
  { agent: 'SemrushBot', operator: 'Semrush', class: 'seo', ua: /SemrushBot|SiteAuditBot/i, verify: { fcrdns: ['semrush.com'] } },
  { agent: 'MJ12bot', operator: 'Majestic', class: 'seo', ua: /MJ12bot/i },
  { agent: 'DotBot', operator: 'Moz', class: 'seo', ua: /DotBot|rogerbot/i },
  { agent: 'DataForSeoBot', operator: 'DataForSEO', class: 'seo', ua: /DataForSeoBot/i },
  { agent: 'SERankingBacklinksBot', operator: 'SE Ranking', class: 'seo', ua: /SERanking/i },
  { agent: 'Barkrowler', operator: 'Babbar', class: 'seo', ua: /Barkrowler/i },

  // Monitors
  { agent: 'UptimeRobot', operator: 'UptimeRobot', class: 'monitor', ua: /UptimeRobot/i },
];

// In-app browsers. These are people (or things dressed as people) inside a
// social app — the shape every paid Meta click arrives in.
export const IN_APP = [
  { app: 'instagram', ua: /Instagram/i },
  { app: 'facebook', ua: /FBAN|FBAV|FB_IAB|FBIOS/i },
  { app: 'tiktok', ua: /musical_ly|BytedanceWebview|TikTok/i },
];

// Programmatic clients that don't pretend to be anything.
export const TOOL = /^(curl|wget|python|Python-urllib|python-requests|Go-http-client|Java\/|okhttp|axios|node-fetch|undici|Scrapy|libwww|aiohttp|GuzzleHttp|PHP\/)|HeadlessChrome/i;

// Announces itself as automated without being catalogued.
export const GENERIC_BOT = /bot\b|bot\/|crawl|spider|scrape|fetcher/i;
