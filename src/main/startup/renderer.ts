import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, type BrowserView, type WebContents } from "electron";
import { loadTrustedAppURL } from "../network/url-safety";

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const target = new URL(value);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      const trusted = new URL(devUrl);
      return target.origin === trusted.origin && target.pathname === trusted.pathname;
    }
    return (
      target.protocol === "file:" &&
      path.resolve(fileURLToPath(target)) === path.resolve(resolveRendererFile())
    );
  } catch {
    return false;
  }
}

export function installTrustedRendererNavigationPolicy(
  webContents: WebContents,
  openInBrowserTab?: (url: string) => void,
): void {
  const rerouteWebUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        openInBrowserTab?.(parsed.toString());
      }
    } catch {
      // Invalid and non-web URLs remain denied.
    }
  };

  webContents.setWindowOpenHandler(({ url }) => {
    rerouteWebUrl(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    rerouteWebUrl(url);
  });
  webContents.on("will-redirect", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
  });
}

/**
 * Returns the dev-mode renderer URL for a given view name, or null if
 * ELECTRON_RENDERER_URL is not set (production).
 */
function rendererUrlFor(view: "chrome" | "sidebar" | "devtools"): string | null {
  if (!process.env.ELECTRON_RENDERER_URL) return null;
  const url = new URL(process.env.ELECTRON_RENDERER_URL);
  url.searchParams.set("view", view);
  return url.toString();
}

export function resolveRendererFile(): string {
  const candidates = [
    path.join(__dirname, "../renderer/index.html"),
    path.join(__dirname, "../../out/renderer/index.html"),
    path.join(app.getAppPath(), "out/renderer/index.html"),
    path.join(app.getAppPath(), "renderer/index.html"),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Could not locate renderer/index.html. Tried: ${candidates.join(", ")}`);
  }
  return match;
}

/**
 * Loads the SolidJS renderer views (chrome, sidebar, devtools panel).
 * Uses ELECTRON_RENDERER_URL when in dev mode, otherwise loads from the
 * bundled renderer file.
 */
export function loadRenderers(
  chromeView: BrowserView,
  sidebarView: BrowserView,
  devtoolsPanelView: BrowserView,
): void {
  const chromeUrl = rendererUrlFor("chrome");
  const sidebarUrl = rendererUrlFor("sidebar");
  const devtoolsUrl = rendererUrlFor("devtools");

  if (chromeUrl && sidebarUrl && devtoolsUrl) {
    void loadTrustedAppURL(chromeView.webContents, chromeUrl);
    void loadTrustedAppURL(sidebarView.webContents, sidebarUrl);
    void loadTrustedAppURL(devtoolsPanelView.webContents, devtoolsUrl);
  } else {
    const rendererFile = resolveRendererFile();
    chromeView.webContents.loadFile(rendererFile, {
      query: { view: "chrome" },
    });
    sidebarView.webContents.loadFile(rendererFile, {
      query: { view: "sidebar" },
    });
    devtoolsPanelView.webContents.loadFile(rendererFile, {
      query: { view: "devtools" },
    });
  }
}
