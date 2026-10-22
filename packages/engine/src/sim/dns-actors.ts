import type { DnsCacheEntry, Msg, NodeId } from '../model';
import {
  DNS_CLASS_IN,
  DNS_TYPE_A,
  DNS_TYPE_NS,
  encodeDns,
  type DnsMessage,
  type DnsRecord,
} from '../proto/dns';
import { msg } from '../proto/fields';
import { hex16 } from '../bytes/hex';
import type { World } from './world';

interface CacheItem {
  readonly where: DnsCacheEntry['where'];
  readonly name: string;
  readonly type: 'A' | 'NS';
  readonly value: string;
  readonly ttl: number;
  readonly storedUs: number;
}

/** DNS caches on the laptop (browser + OS) and the resolver. Entries honor their TTLs. */
export class DnsCaches {
  readonly items: CacheItem[] = [];

  put(item: CacheItem): void {
    const i = this.items.findIndex(
      (x) =>
        x.where === item.where &&
        x.name === item.name &&
        x.type === item.type &&
        x.value === item.value,
    );
    if (i >= 0) this.items.splice(i, 1);
    this.items.push(item);
  }

  get(where: CacheItem['where'], name: string, type: 'A' | 'NS', nowUs: number): CacheItem[] {
    return this.items.filter(
      (x) => x.where === where && x.name === name && x.type === type && remaining(x, nowUs) > 0,
    );
  }

  snapshot(nowUs: number): DnsCacheEntry[] {
    return this.items
      .filter((x) => x.storedUs <= nowUs && remaining(x, nowUs) > 0)
      .map((x) => ({ ...x, remaining: remaining(x, nowUs) }));
  }
}

export function remaining(x: CacheItem, nowUs: number): number {
  return x.ttl - Math.floor((nowUs - x.storedUs) / 1_000_000);
}

const PROCESS_US = 200;
const NS1_TIMEOUT_US = 400_000;

export interface DnsResult {
  readonly address: string;
  readonly fromCache: 'browser' | 'resolver' | null;
}

/**
 * Runs a full lookup for `host`: browser cache → OS cache → recursive resolver → root → TLD →
 * authoritative. Calls `done` when the laptop has the address.
 */
export function startLookup(
  w: World,
  caches: DnsCaches,
  host: string,
  answer: string,
  done: (r: DnsResult) => void,
): void {
  const site = w.site;
  const cfg = w.config;
  const N = w.nodes;

  // Pre-warm caches according to the scenario. Entries were stored "earlier" (negative time).
  if (cfg.warmDnsCache === 'browser') {
    caches.put({
      where: 'browser',
      name: host,
      type: 'A',
      value: answer,
      ttl: 60,
      storedUs: -12_000_000,
    });
    caches.put({
      where: 'os',
      name: host,
      type: 'A',
      value: answer,
      ttl: 3600,
      storedUs: -12_000_000,
    });
  }
  if (cfg.warmDnsCache === 'resolver' || cfg.warmDnsCache === 'browser') {
    const age = -(w.rng.fork('dns-age').int(300, 2400) * 1_000_000);
    caches.put({
      where: 'resolver',
      name: host,
      type: 'A',
      value: answer,
      ttl: 3600,
      storedUs: age,
    });
    caches.put({
      where: 'resolver',
      name: site.tld,
      type: 'NS',
      value: site.tldServer,
      ttl: 172800,
      storedUs: age,
    });
  }

  w.log('state', 'browser', 'laptop', msg('ev.enter', { url: `https://${host}/` }));
  w.after(30, () => {
    const hit = caches.get('browser', host, 'A', w.now)[0];
    w.log(
      'cache',
      'application',
      'laptop',
      hit
        ? msg('ev.cache.browser.hit', { host, address: hit.value })
        : msg('ev.cache.browser.miss', { host }),
    );
    if (hit) {
      done({ address: hit.value, fromCache: 'browser' });
      return;
    }
    w.after(150, () => {
      const os = caches.get('os', host, 'A', w.now)[0];
      w.log(
        'cache',
        'application',
        'laptop',
        os ? msg('ev.cache.os.hit', { host }) : msg('ev.cache.os.miss', { host }),
      );
      if (os) {
        done({ address: os.value, fromCache: 'browser' });
        return;
      }
      w.after(20, () => stubQuery());
    });
  });

  const query = (id: number, rd: boolean): DnsMessage => ({
    id,
    flags: { qr: false, opcode: 0, aa: false, tc: false, rd, ra: false, rcode: 0 },
    questions: [{ name: host, type: DNS_TYPE_A, cls: DNS_CLASS_IN }],
    answers: [],
    authority: [],
    additional: [],
  });

  const response = (
    q: DnsMessage,
    opts: {
      aa: boolean;
      ra: boolean;
      answers?: DnsRecord[];
      authority?: DnsRecord[];
      additional?: DnsRecord[];
    },
  ): DnsMessage => ({
    id: q.id,
    flags: { qr: true, opcode: 0, aa: opts.aa, tc: false, rd: q.flags.rd, ra: opts.ra, rcode: 0 },
    questions: q.questions,
    answers: opts.answers ?? [],
    authority: opts.authority ?? [],
    additional: opts.additional ?? [],
  });

  const sendDns = (
    from: NodeId,
    to: NodeId,
    sport: number,
    dport: number,
    m: DnsMessage,
    step: number,
    name: string,
    nameMsg: Msg,
    story: Msg,
    onArrive?: () => void,
  ): void => {
    w.send(
      {
        from,
        to,
        l4: { kind: 'udp', header: { srcPort: sport, dstPort: dport } },
        payload: encodeDns(m),
        meta: {
          proto: 'DNS',
          name,
          nameMsg,
          topLayer: 'application',
          flow: 'dns',
          connId: null,
          retransmit: false,
          encrypted: false,
          dnsStep: step,
          story,
          stopHint: 'dns',
          tls: null,
          tcp: null,
        },
      },
      onArrive ? () => onArrive() : undefined,
    );
  };

  const stubQuery = (): void => {
    const port = w.ephemeralPort();
    const id = w.rngDnsId.u16();
    const q = query(id, true);
    sendDns(
      'laptop',
      'resolver',
      port,
      53,
      q,
      1,
      `A ${host}?`,
      msg('p.dns.q', { host }),
      msg('story.dns.1'),
      () => w.after(PROCESS_US, () => resolverHandle(q, port)),
    );
  };

  const resolverHandle = (clientQ: DnsMessage, clientPort: number): void => {
    const cached = caches.get('resolver', host, 'A', w.now)[0];
    if (cached) {
      const ttl = remaining(cached, w.now);
      w.log('cache', 'application', 'resolver', msg('ev.cache.resolver.hit', { host, ttl }));
      reply(clientQ, clientPort, ttl, true);
      return;
    }
    w.log('cache', 'application', 'resolver', msg('ev.cache.resolver.miss', { host }));
    const tldCached = caches.get('resolver', site.tld, 'NS', w.now)[0];
    if (tldCached) askTld(clientQ, clientPort);
    else askRoot(clientQ, clientPort);
  };

  const upstream = (
    to: NodeId,
    step: number,
    label: string,
    story: Msg,
    handler: (q: DnsMessage) => DnsMessage | null,
    next: (r: DnsMessage) => void,
  ): void => {
    const port = w.ephemeralPort();
    const q = query(w.rngDnsId.u16(), false);
    sendDns(
      'resolver',
      to,
      port,
      53,
      q,
      step,
      label,
      msg('p.dns.q.to', { host, server: N[to].name }),
      story,
      () => {
        const r = handler(q);
        if (!r) {
          w.log('drop', 'application', to, msg('ev.dns.silent', { server: N[to].name }));
          return;
        }
        w.after(PROCESS_US, () => {
          const ansStep = step + 1;
          const ansLabel =
            r.answers.length > 0
              ? `${answer} · TTL 3600`
              : `ask ${r.authority[0]?.data.kind === 'NS' ? r.authority[0].data.host : '?'}`;
          sendDns(
            to,
            'resolver',
            53,
            port,
            r,
            ansStep,
            ansLabel,
            r.answers.length > 0
              ? msg('p.dns.a', { host, address: answer, ttl: 3600 })
              : msg('p.dns.ref', {
                  server: r.authority[0]?.data.kind === 'NS' ? r.authority[0].data.host : '?',
                }),
            msg(`story.dns.${ansStep}`),
            () => next(r),
          );
        });
      },
    );
  };

  const askRoot = (clientQ: DnsMessage, clientPort: number): void => {
    upstream(
      'root',
      2,
      `A ${host}? → root`,
      msg('story.dns.2'),
      (q) =>
        response(q, {
          aa: false,
          ra: false,
          authority: [
            {
              name: site.tld,
              type: DNS_TYPE_NS,
              cls: DNS_CLASS_IN,
              ttl: 172800,
              data: { kind: 'NS', host: site.tldServer },
            },
          ],
          additional: [
            {
              name: site.tldServer,
              type: DNS_TYPE_A,
              cls: DNS_CLASS_IN,
              ttl: 172800,
              data: { kind: 'A', address: N.tld.address },
            },
          ],
        }),
      () => {
        caches.put({
          where: 'resolver',
          name: site.tld,
          type: 'NS',
          value: site.tldServer,
          ttl: 172800,
          storedUs: w.now,
        });
        w.log(
          'cache',
          'application',
          'resolver',
          msg('ev.cache.store.ns', { zone: site.tld, server: site.tldServer }),
        );
        w.after(PROCESS_US, () => askTld(clientQ, clientPort));
      },
    );
  };

  const askTld = (clientQ: DnsMessage, clientPort: number): void => {
    upstream(
      'tld',
      4,
      `A ${host}? → .${site.tld}`,
      msg('story.dns.4'),
      (q) =>
        response(q, {
          aa: false,
          ra: false,
          authority: site.nsHosts.map((ns) => ({
            name: host,
            type: DNS_TYPE_NS,
            cls: DNS_CLASS_IN,
            ttl: 172800,
            data: { kind: 'NS' as const, host: ns },
          })),
          additional: [
            {
              name: site.nsHosts[0],
              type: DNS_TYPE_A,
              cls: DNS_CLASS_IN,
              ttl: 172800,
              data: { kind: 'A', address: N.ns1.address },
            },
            {
              name: site.nsHosts[1],
              type: DNS_TYPE_A,
              cls: DNS_CLASS_IN,
              ttl: 172800,
              data: { kind: 'A', address: N.ns2.address },
            },
          ],
        }),
      () => {
        caches.put({
          where: 'resolver',
          name: host,
          type: 'NS',
          value: site.nsHosts[0],
          ttl: 172800,
          storedUs: w.now,
        });
        w.log(
          'cache',
          'application',
          'resolver',
          msg('ev.cache.store.ns', { zone: host, server: site.nsHosts[0] }),
        );
        w.after(PROCESS_US, () => askAuth(clientQ, clientPort, 'ns1'));
      },
    );
  };

  const askAuth = (clientQ: DnsMessage, clientPort: number, server: 'ns1' | 'ns2'): void => {
    let answered = false;
    const silent = server === 'ns1' && cfg.ns1Timeout;
    upstream(
      server,
      6,
      server === 'ns1' ? `A ${host}? → ns1` : `A ${host}? → ns2 (retry)`,
      server === 'ns1' ? msg('story.dns.6') : msg('story.dns.retry'),
      (q) =>
        silent
          ? null
          : response(q, {
              aa: true,
              ra: false,
              answers: [
                {
                  name: host,
                  type: DNS_TYPE_A,
                  cls: DNS_CLASS_IN,
                  ttl: 3600,
                  data: { kind: 'A', address: answer },
                },
              ],
            }),
      () => {
        answered = true;
        caches.put({
          where: 'resolver',
          name: host,
          type: 'A',
          value: answer,
          ttl: 3600,
          storedUs: w.now,
        });
        w.log(
          'cache',
          'application',
          'resolver',
          msg('ev.cache.store.a', { host, address: answer, ttl: 3600 }),
        );
        reply(clientQ, clientPort, 3600, false);
      },
    );
    if (silent) {
      w.timer(NS1_TIMEOUT_US, () => {
        if (answered) return;
        w.log(
          'timeout',
          'application',
          'resolver',
          msg('ev.dns.timeout', { server: site.nsHosts[0], ms: 400 }),
        );
        askAuth(clientQ, clientPort, 'ns2');
      });
    }
  };

  const reply = (
    clientQ: DnsMessage,
    clientPort: number,
    ttl: number,
    fromCache: boolean,
  ): void => {
    w.after(PROCESS_US, () => {
      const r = response(clientQ, {
        aa: false,
        ra: true,
        answers: [
          {
            name: host,
            type: DNS_TYPE_A,
            cls: DNS_CLASS_IN,
            ttl,
            data: { kind: 'A', address: answer },
          },
        ],
      });
      sendDns(
        'resolver',
        'laptop',
        53,
        clientPort,
        r,
        8,
        `${answer} · TTL ${ttl}`,
        msg('p.dns.a', { host, address: answer, ttl }),
        fromCache ? msg('story.dns.8warm') : msg('story.dns.8'),
        () => {
          w.after(50, () => {
            caches.put({ where: 'os', name: host, type: 'A', value: answer, ttl, storedUs: w.now });
            caches.put({
              where: 'browser',
              name: host,
              type: 'A',
              value: answer,
              ttl: Math.min(ttl, 60),
              storedUs: w.now,
            });
            w.log(
              'cache',
              'application',
              'laptop',
              msg('ev.cache.store.laptop', { host, address: answer, id: `0x${hex16(clientQ.id)}` }),
            );
            done({ address: answer, fromCache: fromCache ? 'resolver' : null });
          });
        },
      );
    });
  };
}
