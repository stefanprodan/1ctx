// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page an emailed link opens, drawn by the server: GET and HEAD
// never act, since mail scanners open links, and its one button posts a
// plain form through the router. It loads nothing (no script, font or
// stylesheet) and sends no referrer, so the token in its address never
// leaves. Its look is the sign-in's, its values copied from
// client/style/tokens.css, light or dark as the system is
// (test/server/web/link-page.test.ts holds them equal).

export const LINK_PAGE = "/link/";

// the colours, fonts, sizes and radii, named as in tokens.css
const STYLE = `:root{color-scheme:dark;--page:#131314;--card:#1e1f20;--inset:#0f1216;--line:#2a2b2d;--line-strong:#35363a;--hover:#2a2b2d;--fg:#e7e7e9;--faint:#8b8b91;--sparkle:#f2c14e;--sans:"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;--text-small:12px;--text-ui:13px;--text-input:14px;--radius:6px;--radius-card:10px;--space-4:16px;--space-5:24px;--space-6:32px}
@media (prefers-color-scheme:light){:root{color-scheme:light;--page:#f4f2ec;--card:#fbfaf7;--inset:#eeece5;--line:#dfdcd3;--line-strong:#cfccc2;--hover:#e6e3da;--fg:#1a1a1c;--faint:#6f6e75;--sparkle:#d9a53a}}
html,body{height:100%}
body{margin:0;background:var(--page);color:var(--fg);font:var(--text-ui)/1.5 var(--sans);-webkit-font-smoothing:antialiased}
main{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-6);min-height:100%;padding:var(--space-4)}
.card{box-sizing:border-box;width:340px;max-width:100%;padding:var(--space-5);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--card)}
.card p{margin:0 0 var(--space-4)}
.card p:last-child{margin-bottom:0}
form{display:flex;flex-direction:column;gap:var(--space-4);margin:0}
label{display:flex;flex-direction:column;gap:6px;color:var(--faint);font-size:var(--text-small)}
input{box-sizing:border-box;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--inset);color:var(--fg);font:inherit;font-size:var(--text-input)}
button{width:100%;height:36px;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--hover);color:var(--fg);font:inherit;font-weight:500;cursor:pointer}
a{color:var(--fg)}`;

// the logo (client/lib/icons.tsx), 80 high as on the sign-in page
const LOGO = `<svg width="151" height="80" viewBox="0 0 170.19 90" role="img" aria-label="1ctx"><g transform="translate(3 15)" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path stroke="currentColor" d="M126.19 0H18.72A18.72 18.72 0 0 0 0 18.72V53.28A18.72 18.72 0 0 0 18.72 72H133.47A18.72 18.72 0 0 0 152.19 53.28V26"/><path fill="var(--sparkle)" stroke="none" transform="translate(74.19 -18) scale(4)" d="M19.5 1.0C19.5 2.925 21.075 4.5 23.0 4.5C21.075 4.5 19.5 6.075 19.5 8.0C19.5 6.075 17.925 4.5 16.0 4.5C17.925 4.5 19.5 2.925 19.5 1.0Z"/></g><path fill="currentColor" transform="translate(23 68.5)" d="M4.03 0V-5.42H13.14V-29.2L3.98 -22.49V-29.2L12.03 -35H19.13V-5.42H26.47V0Z M42.62 0.48Q39.22 0.48 36.7 -0.79Q34.18 -2.06 32.79 -4.39Q31.4 -6.71 31.4 -9.88V-16.49Q31.4 -19.66 32.79 -21.98Q34.18 -24.31 36.7 -25.58Q39.22 -26.85 42.62 -26.85Q47.56 -26.85 50.56 -24.28Q53.55 -21.72 53.7 -17.31H47.8Q47.66 -19.37 46.24 -20.5Q44.83 -21.62 42.62 -21.62Q40.18 -21.62 38.79 -20.3Q37.4 -18.99 37.4 -16.54V-9.88Q37.4 -7.43 38.79 -6.09Q40.18 -4.75 42.62 -4.75Q44.88 -4.75 46.27 -5.87Q47.66 -7 47.8 -9.06H53.7Q53.55 -4.65 50.56 -2.09Q47.56 0.48 42.62 0.48Z M72.64 0Q68.95 0 66.76 -2.13Q64.58 -4.27 64.58 -7.91V-20.95H57.29V-26.37H64.58V-33.8H70.62V-26.37H81.12V-20.95H70.62V-8.05Q70.62 -6.9 71.27 -6.16Q71.92 -5.42 73.07 -5.42H80.88V0Z M85.15 0 94.36 -13.62 85.77 -26.37H92.53L96.61 -19.9Q96.99 -19.32 97.33 -18.6Q97.66 -17.88 97.81 -17.45Q98 -17.88 98.31 -18.6Q98.62 -19.32 99.01 -19.9L103.08 -26.37H109.89L101.31 -13.62L110.47 0H103.66L99.1 -7.24Q98.72 -7.82 98.36 -8.56Q98 -9.3 97.81 -9.73Q97.62 -9.3 97.28 -8.56Q96.95 -7.82 96.56 -7.24L91.96 0Z"/></svg>`;

// what every page of it sends: no store, no referrer, and nothing loaded
// or framed; a form posts only here
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function page(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in · 1ctx</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${LOGO}
<div class="card">
${body}
</div>
</main>
</body>
</html>
`,
    { status, headers: { ...PAGE_HEADERS, ...headers } },
  );
}

// a live link: the one button that uses it. The token is a checked
// base64url shape, so it needs no escaping
export const livePage = (token: string): Response =>
  page(
    200,
    `<form method="post" action="/api/links/${token}">
<button type="submit">Sign in</button>
</form>`,
  );

// a dead link reads as an unknown one; with email on, a form asks again
export const deadPage = (askAgain: boolean): Response =>
  page(
    404,
    askAgain
      ? `<p>This link no longer works.</p>
<form method="post" action="/api/login/link">
<label>Email<input type="email" name="email" autocomplete="email" required></label>
<button type="submit">Email me a new link</button>
</form>`
      : "<p>This link no longer works.</p>",
  );

// the answer to that form's ask, the same whoever it named
export const sentPage = (headers: Record<string, string>): Response =>
  page(
    202,
    `<p>Check your email.</p>
<p><a href="/">Enter the code</a></p>`,
    headers,
  );

export type LinkPagePort = {
  // whether the token opens a live link: unused, unexpired, its user
  // enabled
  live(token: string): boolean;
  emailOn(): boolean;
};

// GET and HEAD of /link/<token>; nothing they do changes a row
export function linkPage(port: LinkPagePort): (req: Request) => Response {
  return (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    const token = new URL(req.url).pathname.slice(LINK_PAGE.length);
    const res = port.live(token) ? livePage(token) : deadPage(port.emailOn());
    return req.method === "HEAD"
      ? new Response(null, { status: res.status, headers: res.headers })
      : res;
  };
}
