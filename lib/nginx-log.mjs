// Read the publisher fleet's nginx access logs into request records, for replay.
//
// Two formats are live on the fleet today (2026-10-01):
//   wp-1  `cached`:  ip host=… xff="…" [time] "REQ" status=… bytes=… cache=… rt=… urt=… uct=… uht=… upstream="…" ref="…" ua="…"
//   wp-2  combined:  ip - - [time] "REQ" status bytes "ref" "ua" cache=…
// wp-2's carries no host, timing or upstream, so its records have host/rt/upstream null.

const CACHED = /^(\S+) host=(\S+) xff="[^"]*" \[([^\]]+)\] "([^"]*)" status=(\d+) bytes=\d+ cache=(\S+) rt=(\S+) urt=\S+ uct=\S+ uht=\S+ upstream="([^"]*)" ref="([^"]*)" ua="(.*)"$/;
const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) \d+ "([^"]*)" "(.*)" cache=(\S+)$/;

const dash = (v) => (v === '-' || v === '' ? null : v);

export function parse(line) {
  let m = CACHED.exec(line);
  if (m) {
    const [, ip, host, time, request, status, cache, rt, upstream, ref, ua] = m;
    return record({ ip, host, time, request, status, cache, rt, upstream, ref, ua });
  }
  m = COMBINED.exec(line);
  if (m) {
    const [, ip, time, request, status, ref, ua, cache] = m;
    return record({ ip, host: null, time, request, status, cache, rt: null, upstream: null, ref, ua });
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
