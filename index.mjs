// GeistM emcee, as a module a host mounts.
//
// The host decides where the data lives — the emcee never chooses a database:
//
//   new Emcee({ data })                  the adnet factory: its resolved config's [research] url
//                                        → the `research` DB, with bluefire alongside for Meta's
//                                        own figures (the emcee is a role of research there)
//   new Emcee({ url, database, name })   any other host (the harness): the host's own [mongo]
//                                        url and database; no ad data
//
// Two roles, either or both:
//
//   app.use(emcee.observe())   live: identify every request the host serves, keep hourly
//                              rollups in the host's database (lib/observe.mjs)
//   emcee.attach(router)       read: GET /status, GET /site/:domain?days=7
//                              (public for now; controls on this data come later)
//
// Unconfigured, observe() is a pass-through and the read routes answer 503 naming
// what's missing — it never guesses a connection.

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import Identify from './lib/identify.mjs';
import Observer from './lib/observe.mjs';
import { siteStats, normalizeDomain } from './lib/site-stats.mjs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CACHE_MS = 10 * 60 * 1000;          // reads: a site's figures, cached per domain
const SOURCES_REFRESH_MS = 24 * 3600e3;   // operators' published ranges, re-fetched daily
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export default class Emcee {
  constructor(config = {}) {
    if (config.data) {                     // the factory's harness config
      this.url = config.data.research?.url;
      this.database = 'research';
      this.adData = 'bluefire';
      this.name = 'GeistM research';
      this.missing = 'no [research] url in config';
    } else {
      this.url = config.url;
      this.database = config.database || null;   // null: the database named in the url
      this.adData = config.adData || null;
      this.name = config.name || null;
      this.missing = config.missing || 'no database url configured by the host';
    }
    this.client = null;
    this.ready = false;
    this.failure = null;
    this.cache = new Map();                // `${domain}|${days}` -> {at, body}
    this.connecting = this.url ? this._connect() : this._unconfigured();
  }

  async _unconfigured() {
    this.failure = this.missing;
    console.error('[emcee]', this.missing);
  }

  async _connect() {
    try {
      this.client = await new MongoClient(this.url, { readPreference: 'secondaryPreferred' }).connect();
      this.store = this.database ? this.client.db(this.database) : this.client.db();
      this.ads = this.adData ? this.client.db(this.adData) : null;
      this.ready = true;
    } catch (e) {
      this.failure = `cannot reach the database: ${e.message}`;
      console.error('[emcee]', this.failure);
    }
  }

  // ---------- live ----------

  observe({ flushMs } = {}) {
    if (!this.url) return (req, res, next) => next();
    let identify = null;
    const load = () => Identify.create().then((i) => { identify = i; }).catch((e) => console.error('[emcee] sources:', e.message));
    load();
    this.refresh = setInterval(load, SOURCES_REFRESH_MS);
    this.refresh.unref?.();
    this.observer = new Observer({ identify: () => (this.ready ? identify : null), sink: (b) => this._write(b), flushMs });
    return this.observer.middleware();
  }

  async _write({ traffic, paid, requests, day }) {
    const upserts = (rows) => rows.map(({ _id, set, inc }) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: set, $inc: inc }, upsert: true } }));
    if (traffic.length) await this.store.collection('emcee_traffic').bulkWrite(upserts(traffic), { ordered: false });
    if (paid.length) await this.store.collection('emcee_paid').bulkWrite(upserts(paid), { ordered: false });
    await this.store.collection('emcee_runs').updateOne(
      { _id: day },
      { $set: { day, live: true, at: new Date(), observer: os.hostname() }, $inc: { 'totals.requests': requests } },
      { upsert: true },
    );
  }

  // ---------- read ----------

  async attach(router) {
    // Readiness gate first and synchronous: hosts don't await attach().
    router.use((req, res, next) => {
      if (this.ready) return next();
      res.status(503).json({ status: this.failure ? 'unavailable' : 'starting', service: 'emcee', reason: this.failure });
    });

    router.get('/status', async (req, res) => {
      const runs = await this.store.collection('emcee_runs').find({}, { projection: { _id: 1, at: 1, live: 1, 'totals.requests': 1 } }).sort({ _id: -1 }).limit(31).toArray();
      res.json({
        status: 'ready', service: 'emcee', version: VERSION,
        store: this.name || this.store.databaseName, adData: !!this.ads,
        days: runs.map((r) => ({ day: r._id, live: !!r.live, at: r.at, requests: r.totals?.requests })),
      });
    });

    router.get('/site/:domain', async (req, res) => {
      const domain = normalizeDomain(req.params.domain);
      if (!DOMAIN_RE.test(domain)) return res.status(400).json({ status: 'error', message: 'not a domain' });
      const key = `${domain}|${req.query.days || ''}`;
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
      try {
        const body = { status: 'success', store: this.name || this.store.databaseName, ...(await siteStats({ research: this.store, bluefire: this.ads }, domain, { days: req.query.days })) };
        this.cache.set(key, { at: Date.now(), body });
        res.json(body);
      } catch (e) {
        res.status(502).json({ status: 'error', message: `emcee could not read: ${e.message}` });
      }
    });

    await this.connecting;
  }

  async cleanup() {
    clearInterval(this.refresh);
    await this.observer?.stop();
    await this.client?.close();
  }
}
