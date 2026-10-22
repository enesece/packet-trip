import type { SiteId } from '../model';

export type ResourceKind = 'document' | 'stylesheet' | 'script' | 'font';

export interface SiteResource {
  readonly path: string;
  readonly kind: ResourceKind;
  readonly contentType: string;
  /** Text body, or null for binary (fonts) which get `size` pseudo-random bytes. */
  readonly text: string | null;
  readonly size: number;
  readonly cache: 'HIT' | 'MISS';
  readonly maxAge: number;
}

export interface SiteDef {
  readonly id: SiteId;
  readonly host: string;
  readonly title: string;
  readonly tld: string;
  readonly tldServer: string;
  readonly nsHosts: readonly [string, string];
  readonly cdn: boolean;
  /** One-way latency between the CDN (or the ISP edge, without a CDN) and the origin, ms. */
  readonly originLatencyMs: number;
  readonly htmlThinkMs: number;
  readonly resources: readonly SiteResource[];
  readonly criticalCss: string;
}

const pad = (label: string, n: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < n; i++)
    lines.push(
      `/* ${label} line ${String(i + 1).padStart(3, '0')} — padding so the file has a realistic size. */`,
    );
  return lines.join('\n');
};

const EXAMPLE_CSS = `@font-face {
  font-family: "Trip Sans";
  src: url(/font.woff2) format("woff2");
  font-display: swap;
}
html { background: #eef0f3; }
body {
  margin: 0;
  padding: 40px 16px;
  font-family: "Trip Sans", Georgia, serif;
  font-size: 16px;
  line-height: 1.5;
  color: #23262b;
}
.card {
  max-width: 520px;
  margin: 0 auto;
  padding: 28px 32px;
  background: #ffffff;
  border-radius: 12px;
}
h1 {
  font-size: 30px;
  line-height: 1.2;
  margin: 0 0 14px;
  color: #101215;
}
p { margin: 0 0 12px; }
.note { font-size: 14px; color: #5b616b; }
a { color: #3346a8; text-decoration: underline; }
#more { margin: 18px 0 0; }
${pad('style.css', 14)}
`;

const CRITICAL_CSS = `@font-face{font-family:"Trip Sans";src:url(/font.woff2) format("woff2");font-display:swap}html{background:#eef0f3}body{margin:0;padding:40px 16px;font-family:"Trip Sans",Georgia,serif;font-size:16px;line-height:1.5;color:#23262b}.card{max-width:520px;margin:0 auto;padding:28px 32px;background:#ffffff;border-radius:12px}h1{font-size:30px;line-height:1.2;margin:0 0 14px;color:#101215}p{margin:0 0 12px}.note{font-size:14px;color:#5b616b}a{color:#3346a8;text-decoration:underline}#more{margin:18px 0 0}`;

const APP_JS = `// app.js — deferred, so it runs after the document has been parsed.
(function () {
  'use strict';
  var started = performance.now();
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function () {
    var card = document.querySelector('.card');
    if (!card) return;
    card.setAttribute('data-ready', String(Math.round(performance.now() - started)));
  });
})();
${pad('app.js', 30).replace(/\/\*/g, '//').replace(/\*\//g, '')}
`;

function examplePage(
  title: string,
  heading: string,
  inline: boolean,
  css: string,
  extraHead = '',
  extraBody = '',
): string {
  const styleTags = inline
    ? `<style>${css}</style>\n<link rel="stylesheet" href="/style.css" media="print">`
    : `<link rel="stylesheet" href="/style.css">`;
  return `<!doctype html>
<html lang="en">
<head>
<title>${title}</title>
${styleTags}
<link rel="preload" href="/font.woff2" as="font" crossorigin>
<script src="/app.js" defer></script>${extraHead}
</head>
<body>
<div class="card">
<h1>${heading}</h1>
<p>This page exists so that packets have something to carry. It is small and plain, and every byte of it can be traced from a server to your screen.</p>
<p>It arrives one encrypted record at a time. The browser starts building the page before the last byte lands, then waits for the stylesheet before it paints anything.</p>
<p>Two more paragraphs make the document long enough to need a second record, so you can watch the page grow while it is still arriving.</p>
<p>First the name has to be turned into an address. Then a connection is opened, keys are agreed, and only then can the browser ask for this very file.</p>
<p class="note">Nothing here is real traffic: the addresses come from ranges reserved for documentation, and the server is a few hundred lines of simulation.</p>${extraBody}
<p id="more"><a href="/journey">Follow the trip</a></p>
</div>
</body>
</html>
`;
}

function siteResources(
  html: string,
  css: string,
  opts: {
    htmlCache: 'HIT' | 'MISS';
    js: string | null;
    fontSize: number | null;
    extra?: SiteResource[];
  },
): SiteResource[] {
  const out: SiteResource[] = [
    {
      path: '/',
      kind: 'document',
      contentType: 'text/html; charset=utf-8',
      text: html,
      size: 0,
      cache: opts.htmlCache,
      maxAge: 300,
    },
    {
      path: '/style.css',
      kind: 'stylesheet',
      contentType: 'text/css',
      text: css,
      size: 0,
      cache: 'HIT',
      maxAge: 86400,
    },
  ];
  if (opts.fontSize !== null) {
    out.push({
      path: '/font.woff2',
      kind: 'font',
      contentType: 'font/woff2',
      text: null,
      size: opts.fontSize,
      cache: 'HIT',
      maxAge: 31536000,
    });
  }
  if (opts.js !== null) {
    out.push({
      path: '/app.js',
      kind: 'script',
      contentType: 'text/javascript',
      text: opts.js,
      size: 0,
      cache: 'HIT',
      maxAge: 86400,
    });
  }
  return [...out, ...(opts.extra ?? [])];
}

const STATIC_CSS = `body { margin: 0; padding: 32px 16px; font-family: Georgia, serif; color: #222; line-height: 1.5; }
.card { max-width: 480px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 10px; }
p { margin: 0 0 10px; }
a { color: #3346a8; text-decoration: underline; }
`;

const STATIC_HTML = `<!doctype html>
<html lang="en">
<head>
<title>Static</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="card">
<h1>Tiny and static</h1>
<p>One small HTML file and one small stylesheet. No scripts, no web fonts.</p>
<p><a href="/">Back</a></p>
</div>
</body>
</html>
`;

const HEAVY_EXTRA_HEAD = `
<link rel="stylesheet" href="/theme.css">
<link rel="preload" href="/font-bold.woff2" as="font" crossorigin>
<script src="/vendor.js" defer></script>
<script src="/analytics.js" defer></script>`;

const HEAVY_EXTRA_BODY = Array.from(
  { length: 6 },
  (_, i) =>
    `\n<p>Section ${i + 1}. Heavy pages are mostly made of things that are not the page: frameworks, trackers, extra fonts and theme files. Each one is another request, and over HTTP/1.1 on a single connection each one waits its turn.</p>`,
).join('');

const THEME_CSS = `.card { border-radius: 14px; }
h1 { letter-spacing: 0; }
${pad('theme.css', 70)}
`;

const jsBlob = (name: string, lines: number): string =>
  `// ${name}\n${Array.from({ length: lines }, (_, i) => `function ${name.replace(/\W/g, '_')}_${i}(a, b) { return (a * ${i + 3} + b) % 9973; }`).join('\n')}\n`;

export const SITES: Readonly<Record<SiteId, (inline: boolean) => SiteDef>> = {
  'example.com': (inline) => ({
    id: 'example.com',
    host: 'example.com',
    title: 'Example Domain',
    tld: 'com',
    tldServer: 'a.gtld-servers.net',
    nsHosts: ['ns1.example.com', 'ns2.example.com'],
    cdn: true,
    originLatencyMs: 35,
    htmlThinkMs: 30,
    resources: siteResources(
      examplePage('Example Domain', 'Example Domain', inline, CRITICAL_CSS),
      EXAMPLE_CSS,
      {
        htmlCache: 'HIT',
        js: APP_JS,
        fontSize: 18_432,
      },
    ),
    criticalCss: CRITICAL_CSS,
  }),
  'static.example': () => ({
    id: 'static.example',
    host: 'static.example',
    title: 'Static',
    tld: 'example',
    tldServer: 'a.nic.example',
    nsHosts: ['ns1.static.example', 'ns2.static.example'],
    cdn: true,
    originLatencyMs: 35,
    htmlThinkMs: 2,
    resources: siteResources(STATIC_HTML, STATIC_CSS, {
      htmlCache: 'HIT',
      js: null,
      fontSize: null,
    }),
    criticalCss: STATIC_CSS,
  }),
  'far.example': (inline) => ({
    id: 'far.example',
    host: 'far.example',
    title: 'Far Away',
    tld: 'example',
    tldServer: 'a.nic.example',
    nsHosts: ['ns1.far.example', 'ns2.far.example'],
    cdn: false,
    originLatencyMs: 70,
    htmlThinkMs: 30,
    resources: siteResources(
      examplePage('Far Away', 'Far away, no CDN', inline, CRITICAL_CSS),
      EXAMPLE_CSS,
      {
        htmlCache: 'MISS',
        js: APP_JS,
        fontSize: 18_432,
      },
    ),
    criticalCss: CRITICAL_CSS,
  }),
  'heavy.example': (inline) => ({
    id: 'heavy.example',
    host: 'heavy.example',
    title: 'Heavy',
    tld: 'example',
    tldServer: 'a.nic.example',
    nsHosts: ['ns1.heavy.example', 'ns2.heavy.example'],
    cdn: true,
    originLatencyMs: 35,
    htmlThinkMs: 30,
    resources: siteResources(
      examplePage(
        'Heavy',
        'A heavy page',
        inline,
        CRITICAL_CSS,
        HEAVY_EXTRA_HEAD,
        HEAVY_EXTRA_BODY,
      ),
      EXAMPLE_CSS,
      {
        htmlCache: 'MISS',
        js: APP_JS,
        fontSize: 24_576,
        extra: [
          {
            path: '/theme.css',
            kind: 'stylesheet',
            contentType: 'text/css',
            text: THEME_CSS,
            size: 0,
            cache: 'HIT',
            maxAge: 86400,
          },
          {
            path: '/font-bold.woff2',
            kind: 'font',
            contentType: 'font/woff2',
            text: null,
            size: 26_624,
            cache: 'HIT',
            maxAge: 31536000,
          },
          {
            path: '/vendor.js',
            kind: 'script',
            contentType: 'text/javascript',
            text: jsBlob('vendor', 1400),
            size: 0,
            cache: 'HIT',
            maxAge: 86400,
          },
          {
            path: '/analytics.js',
            kind: 'script',
            contentType: 'text/javascript',
            text: jsBlob('analytics', 300),
            size: 0,
            cache: 'MISS',
            maxAge: 3600,
          },
        ],
      },
    ),
    criticalCss: CRITICAL_CSS,
  }),
};

export const SITE_IDS: readonly SiteId[] = [
  'example.com',
  'static.example',
  'far.example',
  'heavy.example',
];

export function getSite(id: SiteId, inlineCriticalCss: boolean): SiteDef {
  return SITES[id](inlineCriticalCss);
}

export function siteFromUrl(input: string): SiteId | null {
  const s = input.trim().toLowerCase();
  const m = /^(?:https?:\/\/)?([a-z0-9.-]+?)\.?(?::\d+)?(?:\/.*)?$/.exec(s);
  const host = m?.[1] ?? '';
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return (SITE_IDS as readonly string[]).includes(bare) ? (bare as SiteId) : null;
}
