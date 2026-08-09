import { ipcRenderer } from "electron";

const MAX_DIFF_HEADINGS = 8;
const PAGE_DIFF_ACTIVITY_THROTTLE_MS = 350;
const PAGE_DIFF_MUTATION_DEBOUNCE_MS = 1200;

let pageDiffMutationTimer: ReturnType<typeof setTimeout> | null = null;
let pageDiffActivityThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastPageDiffSignature = "";

function normalizeSignatureText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function collectBoundedVisibleText(root: Element | null, maxLength: number): string {
  if (!root) return "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let length = 0;

  while (length < maxLength) {
    const node = walker.nextNode();
    if (!node) break;
    const parent = node.parentElement;
    if (!parent || parent.closest("script, style, noscript, [hidden], [aria-hidden='true']")) {
      continue;
    }
    const text = normalizeSignatureText(node.textContent);
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
  }

  return parts.join(" ").slice(0, maxLength);
}

function getPageDiffSignature(): string {
  const title = normalizeSignatureText(document.title);
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .slice(0, MAX_DIFF_HEADINGS)
    .map((el) => normalizeSignatureText(el.textContent))
    .filter(Boolean)
    .join(" | ");
  const mainRoot = document.querySelector("main, article, [role='main']") || document.body;
  const visibleText = collectBoundedVisibleText(mainRoot, 1200);
  return [window.location.href, title, headings, visibleText].join("\n");
}

function asElement(node: Node | null): Element | null {
  if (node instanceof Element) return node;
  return node?.parentElement || null;
}

function isVesselOwnedNode(node: Node | null): boolean {
  const el = asElement(node);
  return !!el?.closest?.("[data-vessel-highlight], .__vessel-highlight-label");
}

function shouldIgnorePageDiffMutation(mutation: MutationRecord): boolean {
  if (mutation.type === "attributes") {
    return isVesselOwnedNode(mutation.target);
  }
  if (mutation.type === "characterData") {
    return isVesselOwnedNode(mutation.target);
  }
  if (mutation.type === "childList") {
    const added = Array.from(mutation.addedNodes);
    const removed = Array.from(mutation.removedNodes);
    return [...added, ...removed].every((node) => isVesselOwnedNode(node));
  }
  return false;
}

function emitPageDiffDirty(): void {
  const nextSignature = getPageDiffSignature();
  if (!nextSignature || nextSignature === lastPageDiffSignature) return;
  lastPageDiffSignature = nextSignature;
  ipcRenderer.send("page:diff-dirty");
}

function notifyPageDiffActivity(): void {
  if (pageDiffActivityThrottleTimer) return;
  ipcRenderer.send("page:diff-activity");
  pageDiffActivityThrottleTimer = setTimeout(() => {
    pageDiffActivityThrottleTimer = null;
  }, PAGE_DIFF_ACTIVITY_THROTTLE_MS);
}

function isDocumentViewerPage(): boolean {
  const contentType = document.contentType?.toLowerCase() || "";
  if (contentType.includes("application/pdf")) return true;

  try {
    const url = new URL(window.location.href);
    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    if (/\.(pdf|epub|mobi|cbz|cbr)$/.test(pathname)) return true;

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "archive.org" && /^\/(details|stream|download)\//.test(pathname)) {
      return true;
    }
  } catch {
    // Ignore unparsable URLs and keep normal observer behavior.
  }

  return !!document.querySelector(
    "#BookReader, ia-bookreader, bookreader, embed[type='application/pdf'], object[type='application/pdf']",
  );
}

export function startPageDiffObserver(): void {
  if (typeof MutationObserver === "undefined") return;
  if (!document.documentElement) return;
  if (isDocumentViewerPage()) return;

  lastPageDiffSignature = getPageDiffSignature();

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => shouldIgnorePageDiffMutation(mutation))) {
      return;
    }

    notifyPageDiffActivity();
    if (pageDiffMutationTimer) {
      clearTimeout(pageDiffMutationTimer);
    }
    pageDiffMutationTimer = setTimeout(() => {
      pageDiffMutationTimer = null;
      emitPageDiffDirty();
    }, PAGE_DIFF_MUTATION_DEBOUNCE_MS);
  });

  const resetSignature = () => {
    lastPageDiffSignature = "";
  };
  window.addEventListener("popstate", resetSignature);
  window.addEventListener("hashchange", resetSignature);

  const observerOptions: MutationObserverInit = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "aria-expanded",
      "aria-selected",
      "aria-checked",
      "aria-label",
      "title",
      "open",
    ],
  };
  const observeVisibleDocument = () => {
    if (document.hidden) return;
    lastPageDiffSignature = getPageDiffSignature();
    observer.observe(document.documentElement, observerOptions);
  };
  const handleVisibilityChange = () => {
    if (document.hidden) {
      observer.disconnect();
      if (pageDiffMutationTimer) {
        clearTimeout(pageDiffMutationTimer);
        pageDiffMutationTimer = null;
      }
      return;
    }
    observeVisibleDocument();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  observeVisibleDocument();

  window.addEventListener("beforeunload", () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (pageDiffActivityThrottleTimer) {
      clearTimeout(pageDiffActivityThrottleTimer);
      pageDiffActivityThrottleTimer = null;
    }
    if (pageDiffMutationTimer) {
      clearTimeout(pageDiffMutationTimer);
      pageDiffMutationTimer = null;
    }
  });
}
