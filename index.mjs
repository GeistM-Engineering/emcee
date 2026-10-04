// GeistM emcee, as a module a harness mounts — the same shape as the adnet exchange.
//
//   const emcee = new Emcee({ data });        // data: the harness's resolved config
//   emcee.attach(router);                     // e.g. the factory, at /emcee
//
// The emcee is a role of research: it reads with the `research` identity, from the
// harness config's [research] section:
//
//   [research]
//   mongoHost=mongodb://research:…@oak.gdb.blackfire.pro,birch…/?authSource=admin&replicaSet=gdb
//
// Routes (public for now; controls on this data come later):
//   GET /status                 version, readiness, the days ingested
//   GET /site/:domain?days=7    one site's traffic and paid arrivals (lib/site-stats.mjs)
//
// Without [research] mongoHost every route answers 503 and says so — it never guesses
// a connection.

import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { siteStats, normalizeDomain } from './lib/site-stats.mjs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CACHE_MS = 10 * 60 * 1000;   // the data changes once a day, at ingest
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export default class Emcee {
  constructor(config = {}) {
    this.config = config;
    this.client = null;
    this.ready = false;
    this.failure = null;
    this.cache = new Map();          // `${domain}|${days}` -> {at, body}
  }

  async attach(router) {
    // Readiness gate first and synchronous: the harness doesn't await attach().
    router.use((req, res, next) => {
      if (this.ready) return next();
      res.status(503).json({ status: this.failure ? 'unavailable' : 'starting', service: 'emcee', reason: this.failure });
    });

    router.get('/status', async (req, res) => {
      const runs = await this.research.collection('emcee_runs').find({}, { projection: { _id: 1, at: 1, 'totals.requests': 1 } }).sort({ _id: -1 }).limit(31).toArray();
      res.json({ status: 'ready', service: 'emcee', version: VERSION, days: runs.map((r) => ({ day: r._id, ingestedAt: r.at, requests: r.totals?.requests })) });
    });

    router.get('/site/:domain', async (req, res) => {
      const domain = normalizeDomain(req.params.domain);
      if (!DOMAIN_RE.test(domain)) return res.status(400).json({ status: 'error', message: 'not a domain' });
      const key = `${domain}|${req.query.days || ''}`;
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
      try {
        const body = { status: 'success', ...(await siteStats({ research: this.research, bluefire: this.bluefire }, domain, { days: req.query.days })) };
        this.cache.set(key, { at: Date.now(), body });
        res.json(body);
      } catch (e) {
        res.status(502).json({ status: 'error', message: `emcee could not read: ${e.message}` });
      }
    });

    const uri = this.config.data?.research?.mongoHost;
    if (!uri) {
      this.failure = 'no [research] mongoHost in config';
      console.error('[emcee]', this.failure);
      return;
    }
    try {
      this.client = await new MongoClient(uri, { readPreference: 'secondaryPreferred' }).connect();
      this.research = this.client.db('research');
      this.bluefire = this.client.db('bluefire');
      this.ready = true;
    } catch (e) {
      this.failure = `cannot reach research: ${e.message}`;
      console.error('[emcee]', this.failure);
    }
  }

  async cleanup() {
    await this.client?.close();
  }
}
