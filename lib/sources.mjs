// The published facts a claim is checked against: each operator's IP prefixes,
// fetched from where the operator publishes them.
//
// Every source is held as {url, fetchedAt, prefixes[]} so a verdict can always say
// which list, fetched when, it was checked against. A snapshot of all of them is a
// plain JSON object — the replay writes one beside its report, so anyone can
// recompute the same facts from the same inputs.

import net from 'node:net';

const ASN_PREFIXES = (asn) => `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`;

export default class Sources {
  constructor(snapshot = {}) {
    this.snapshot = snapshot;      // key -> {url, fetchedAt, prefixes[]}
    this.lists = new Map();        // key -> net.BlockList
    for (const [key, src] of Object.entries(snapshot)) this._index(key, src);
  }

  // Fetch every source the catalog names that isn't already held.
  async load(catalog) {
    const wanted = new Map();
    for (const entry of catalog) {
      for (const url of entry.verify?.ranges || []) wanted.set(url, url);
      if (entry.verify?.asn) wanted.set(`AS${entry.verify.asn}`, ASN_PREFIXES(entry.verify.asn));
    }
    await Promise.all([...wanted].filter(([key]) => !this.snapshot[key]).map(async ([key, url]) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`source ${key}: ${url} answered ${res.status}`);
      const body = await res.json();
      const prefixes = key.startsWith('AS')
        ? body.data.prefixes.map((p) => p.prefix)
        : body.prefixes.map((p) => p.ipv4Prefix || p.ipv6Prefix).filter(Boolean);
      if (!prefixes.length) throw new Error(`source ${key}: ${url} listed no prefixes`);
      this.snapshot[key] = { url, fetchedAt: new Date().toISOString(), prefixes };
      this._index(key, this.snapshot[key]);
    }));
    return this;
  }

  // Does `ip` fall inside the source named `key`? null when the source isn't held.
  contains(key, ip) {
    const list = this.lists.get(key);
    if (!list) return null;
    return list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
  }

  _index(key, src) {
    const list = new net.BlockList();
    for (const prefix of src.prefixes) {
      const [addr, bits] = prefix.split('/');
      list.addSubnet(addr, Number(bits), net.isIPv6(addr) ? 'ipv6' : 'ipv4');
    }
    this.lists.set(key, list);
  }
}
