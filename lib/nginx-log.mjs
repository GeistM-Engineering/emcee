// Read the publisher fleet's nginx access logs into request records, for replay.
//
// Three formats are live on the fleet today (2026-10-03):
//   wp-1  `cached`:   ip host=… xff="…" [time] "REQ" status=… bytes=… cache=… rt=… urt=… uct=… uht=… upstream="…" ref="…" ua="…"
//   wp-2  combined:   ip - - [time] "REQ" status bytes "ref" "ua" cache=…
//   journiest (both): ip - - [time] "REQ" status bytes "ref" "ua"        — its own file, journiest.access.log
// The combined forms carry no host, timing or upstream. A file that serves one site
// (journiest's) is read with that site as `host`; otherwise host stays null.

const CACHED = /^(\S+) host=(\S+) xff="[^"]*" \[([^\]]+)\] "([^"]*)" status=(\d+) bytes=\d+ cache=(\S+) rt=(\S+) urt=\S+ uct=\S+ uht=\S+ upstream="([^"]*)" ref="([^"]*)" ua="(.*)"$/;
const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) \d+ "([^"]*)" "(.*?)"(?: cache=(\S+))?$/;

const dash = (v) => (v === '-' || v === '' ? null : v);

export function parse(line, { host: fileHost = null } = {}) {
  let m = CACHED.exec(line);
  if (m) {
    const [, ip, host, time, request, status, cache, rt, upstream, ref, ua] = m;
    return record({ ip, host, time, request, status, cache, rt, upstream, ref, ua });
  }
  m = COMBINED.exec(line);
  if (m) {
    const [, ip, time, request, status, ref, ua, cache = null] = m;
    return record({ ip, host: fileHost, time, request, status, cache, rt: null, upstream: null, ref, ua });
  }
  return null;
}

function record({ ip, host, time, request, status, cache, rt, upstream, ref, ua }) {
  const [method, url = '/'] = request.split(' ');
  return {
    ip,
    host: host ? host.toLowerCase().replace(/^www\./, '') : null,
    time,
    method,
    url,
    status: Number(status),
    cache: dash(cache),
    rt: rt == null ? null : Number(rt),
    // A request that reached PHP: not a cache HIT, and handed to a php-fpm socket.
    php: upstream == null ? null : dash(cache) !== 'HIT' && upstream.startsWith('unix:'),
    referer: dash(ref),
    ua: dash(ua),
  };
}
