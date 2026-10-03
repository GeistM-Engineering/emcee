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
  constructor({ timeoutMs = 4000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.cache = new Map();    // ip -> Promise<{ptr, confirmed}>
  }

  // {ptr, confirmed} — confirmed is true only when PTR and forward lookup agree.
  lookup(ip) {
    if (!this.cache.has(ip)) this.cache.set(ip, this._lookup(ip));
    return this.cache.get(ip);
  }

  // Does `ip` forward-confirm to a name under one of `domains`?
  async matches(ip, domains) {
    const { ptr, confirmed } = await this.lookup(ip);
    if (!ptr || !confirmed) return { ok: false, ptr };
    const ok = domains.some((d) => ptr === d || ptr.endsWith('.' + d));
    return { ok, ptr };
  }

  async _lookup(ip) {
    try {
      const [ptr] = await this._bounded(dns.reverse(ip));
      if (!ptr) return { ptr: null, confirmed: false };
      const name = ptr.toLowerCase().replace(/\.$/, '');
      const forward = await this._bounded(net.isIPv6(ip) ? dns.resolve6(name) : dns.resolve4(name)).catch(() => []);
      return { ptr: name, confirmed: forward.includes(ip) };
    } catch {
      return { ptr: null, confirmed: false };
    }
  }

  _bounded(promise) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), this.timeoutMs).unref())]);
  }
}
