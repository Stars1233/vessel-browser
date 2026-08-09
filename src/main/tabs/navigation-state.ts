import { INTERNAL_HTML_DATA_URL_PREFIX } from "../network/url-safety";

export interface NavigationFailure {
  url: string;
  dataUrl: string;
}

export type TabNavigationMode =
  | { kind: "normal" }
  | { kind: "deferred"; url: string }
  | { kind: "failure"; failure: NavigationFailure };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createNavigationFailure(url: string, errorDescription: string): NavigationFailure {
  const safeUrl = escapeHtml(url);
  const safeError = escapeHtml(errorDescription || "The connection failed");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page unavailable</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #141418; color: #f2f1f4; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 15%, #292633 0, #141418 42%); }
    main { width: min(560px, calc(100vw - 48px)); }
    .mark { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid #5d566a; border-radius: 12px; color: #c8b8dc; font-size: 22px; }
    h1 { margin: 24px 0 10px; font-size: clamp(28px, 5vw, 42px); letter-spacing: -0.04em; }
    p { margin: 0; color: #aaa5b0; line-height: 1.6; }
    code { display: block; margin-top: 14px; overflow-wrap: anywhere; color: #77717f; font-size: 12px; }
    a { display: inline-block; margin-top: 28px; padding: 10px 17px; border-radius: 9px; background: #eee9f5; color: #1d1922; font-weight: 650; text-decoration: none; }
    a:focus-visible { outline: 3px solid #9c7bc3; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">!</div>
    <h1>This page could not be reached</h1>
    <p>Check your connection and the address, then try again.</p>
    <code>${safeError}</code>
    <a href="${safeUrl}">Retry ${safeUrl}</a>
  </main>
</body>
</html>`;
  return {
    url,
    dataUrl: `${INTERNAL_HTML_DATA_URL_PREFIX}${encodeURIComponent(html)}`,
  };
}

export function isFailurePageUrl(mode: TabNavigationMode, url: string): boolean {
  return mode.kind === "failure" && url === mode.failure.dataUrl;
}
