// The emcee as live middleware: every request the host serves is identified after
// its response finishes, accumulated in a Rollup, and written as deltas on a timer.
//
//   const observer = new Observer({ identify: () => currentIdentify, sink, meta });
//   app.use(observer.middleware());          // ahead of the sites
//   observer.stop();                         // flushes what's left
//
// It never touches the request: no awaits on the request path, no headers, no
// rewrites. If identification or the sink fails, the site serves exactly as before
// and the failure is logged once per flush.
//
// sink(batch) receives { traffic, paid, requests, day, hour } with traffic/paid as
// [{_id, set, inc}] — upsert with $setOnInsert: set, $inc: inc.

import Rollup from './rollup.mjs';

const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
const siteOf = (req) => String(req.hostname || req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '') || null;
const stampOf = (d) => ({ day: d.toISOString().slice(0, 10), hour: d.getUTCHours() });

export default class Observer {
  constructor({ identify, sink, meta = null, flushMs = 60000, clock = () => new Date() }) {
    this.identify = identify;            // () => Identify | null (null while it loads)
    this.sink = sink;
    this.clock = clock;
    this.rollup = new Rollup({ meta });
    this.pending = new Set();            // evidence still resolving
    this.timer = setInterval(() => this.flush().catch(() => {}), flushMs);
    this.timer.unref?.();
  }

  middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const identify = this.identify();
        if (!identify) return;
        const at = this.clock();
        const rec = {
          ip: clientIp(req), host: siteOf(req), method: req.method, url: req.originalUrl || req.url,
          status: res.statusCode, cache: null, php: null,
          rt: Number(process.hrtime.bigint() - started) / 1e9,
          referer: req.get?.('referer') || null, ua: req.get?.('user-agent') || null,
        };
        const p = identify.evidence(rec)
          .then((facts) => this.rollup.add(rec, facts, stampOf(at)))
          .catch((e) => { this.lastError = e.message; })
          .finally(() => this.pending.delete(p));
        this.pending.add(p);
      });
      next();
    };
  }

  async flush() {
    await Promise.all([...this.pending]);
    const now = stampOf(this.clock());
    const batch = this.rollup.drain();
    this.rollup.prune(now);
    if (!batch.traffic.length && !batch.paid.length) return;
    try {
      await this.sink({ ...batch, ...now });
      if (this.lastError) { console.warn('[emcee] identification error since last flush:', this.lastError); this.lastError = null; }
    } catch (e) {
      console.error('[emcee] flush failed, deltas dropped:', e.message);
    }
  }

  async stop() {
    clearInterval(this.timer);
    await this.flush();
  }
}
