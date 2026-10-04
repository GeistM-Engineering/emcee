// Forward-confirmed reverse DNS: the IP's PTR name must end in one of the
// operator's domains, AND that name must resolve back to the same IP. The second
// half is the whole point — anyone can set a PTR on an address they hold; only the
// operator controls what its own domain resolves to.
//
// Lookups are cached per IP for the life of the process; a crawler arrives from a
// few hundred addresses, not hundreds of thousands.

import dns from 'node:dns/promises';
import net from 'node:net';

export default class Rdns {
  constructor({ timeoutMs = 4000, retryMs = 10 * 60 * 1000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.cache = new Map();    // ip -> Promise<{ptr, confirmed}>
  }

  // {ptr, confirmed} — confirmed is true only when PTR and forward lookup agree.
  // A lookup that errs or times out is {ptr: null, confirmed: null}: no answer is not
  // a "no" — it must never be recorded as an impostor.
  lookup(ip) {
    if (!this.cache.has(ip)) {
      this.cache.set(ip, this._lookup(ip).then((r) => {
        // An unanswered lookup is retried later; answers are kept for the process.
        if (r.confirmed === null) setTimeout(() => this.cache.delete(ip), this.retryMs).unref();
        return r;
      }));
    }
    return this.cache.get(ip);
  }

  // Does `ip` forward-confirm to a name under one of `domains`?
  async matches(ip, domains) {
    const { ptr, confirmed } = await this.lookup(ip);
    if (confirmed === null) return { ok: null, ptr: null };
    if (!ptr || !confirmed) return { ok: false, ptr };
    const ok = domains.some((d) => ptr === d || ptr.endsWith('.' + d));
    return { ok, ptr };
  }

  async _lookup(ip) {
    try {
      const [ptr] = await this._bounded(dns.reverse(ip));
      if (!ptr) return { ptr: null, confirmed: false };
      const name = ptr.toLowerCase().replace(/\.$/, '');
      const forward = await this._bounded(net.isIPv6(ip) ? dns.resolve6(name) : dns.resolve4(name));
      return { ptr: name, confirmed: forward.includes(ip) };
    } catch (e) {
      // NXDOMAIN / no PTR is an answer: the address has no name. Anything else
      // (timeout, SERVFAIL, refused) is no answer at all.
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { ptr: null, confirmed: false };
      return { ptr: null, confirmed: null };
    }
  }

  _bounded(promise) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), this.timeoutMs).unref())]);
  }
}
