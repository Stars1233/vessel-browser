import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { createLogger } from "../../shared/logger";
import { assertPermittedNavigationURL } from "./url-safety";

const logger = createLogger("LinkValidation");

export interface LinkValidationResult {
  status: "live" | "dead" | "unknown";
  checkedUrl: string;
  finalUrl?: string;
  statusCode?: number;
  detail?: string;
}

export interface LinkValidationResponse {
  status: number;
  url: string;
  location?: string;
}
export interface LinkValidationTransport {
  resolve(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>>;
  request(
    url: URL,
    method: "HEAD" | "GET",
    timeoutMs: number,
    resolved: { address: string; family: 4 | 6 },
  ): Promise<LinkValidationResponse>;
}
const DEAD_STATUS_CODES = new Set([404, 410, 451]);
const HEAD_FALLBACK_STATUS_CODES = new Set([400, 403, 404, 405, 406, 500, 501]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blockedAddresses.addSubnet(network, prefix, "ipv6");

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function assertPublicAddress(address: string): void {
  if (address.toLowerCase().startsWith("::ffff:")) {
    const words = address.slice(7).split(":");
    if (words.length === 2) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        assertPublicAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
      }
    }
  }
  const family = isIP(address);
  if (!family || blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error("Link validation blocked a private or non-routable destination");
  }
}

async function resolvePublicAddress(
  hostname: string,
  transport: LinkValidationTransport,
): Promise<{ address: string; family: 4 | 6 }> {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  if (isIP(normalizedHostname)) {
    assertPublicAddress(normalizedHostname);
    return {
      address: normalizedHostname,
      family: isIP(normalizedHostname) as 4 | 6,
    };
  }
  const addresses = await transport.resolve(normalizedHostname);
  if (!addresses.length) throw new Error("Link destination did not resolve");
  for (const entry of addresses) assertPublicAddress(entry.address);
  return addresses[0] as { address: string; family: 4 | 6 };
}

const defaultTransport: LinkValidationTransport = {
  async resolve(hostname) {
    return (await lookup(hostname, { all: true, verbatim: true })) as Array<{
      address: string;
      family: 4 | 6;
    }>;
  },
  async request(url, method, timeoutMs, resolved) {
    const protocol = url.protocol === "https:" ? https : http;
    return await new Promise<LinkValidationResponse>((resolve, reject) => {
      const request = protocol.request(
        url,
        {
          method,
          headers: {
            "user-agent": "Vessel/0.1.0 (+https://github.com/unmodeled-tyler/vessel-browser)",
          },
          family: resolved.family,
          autoSelectFamily: false,
          lookup: (_hostname, _options, callback) =>
            callback(null, resolved.address, resolved.family),
        },
        (response) => {
          response.resume();
          resolve({
            status: response.statusCode || 0,
            url: url.href,
            location: response.headers.location,
          });
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Link validation timed out")));
      request.on("error", reject);
      request.end();
    });
  },
};

async function requestOnce(
  urlText: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
  transport: LinkValidationTransport,
): Promise<LinkValidationResponse> {
  const url = new URL(urlText);
  assertPermittedNavigationURL(url.href);
  const resolved = await resolvePublicAddress(url.hostname, transport);
  return await transport.request(url, method, timeoutMs, resolved);
}

async function requestUrl(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
  transport: LinkValidationTransport,
): Promise<LinkValidationResponse> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestOnce(current, method, timeoutMs, transport);
    if (!REDIRECT_STATUS_CODES.has(response.status) || !response.location) return response;
    if (redirects === MAX_REDIRECTS) throw new Error("Link validation exceeded redirect limit");
    current = new URL(response.location, current).href;
  }
  throw new Error("Link validation exceeded redirect limit");
}

function classifyResponse(
  checkedUrl: string,
  response: LinkValidationResponse,
): LinkValidationResult {
  const statusCode = response.status;
  const finalUrl = response.url || checkedUrl;
  if (DEAD_STATUS_CODES.has(statusCode))
    return { status: "dead", checkedUrl, finalUrl, statusCode, detail: `HTTP ${statusCode}` };
  if (statusCode >= 200 && statusCode < 400)
    return { status: "live", checkedUrl, finalUrl, statusCode, detail: `HTTP ${statusCode}` };
  return { status: "unknown", checkedUrl, finalUrl, statusCode, detail: `HTTP ${statusCode}` };
}

export async function validateLinkDestination(
  url: string,
  timeoutMs = 3500,
  transport: LinkValidationTransport = defaultTransport,
): Promise<LinkValidationResult> {
  if (!isHttpUrl(url)) return { status: "unknown", checkedUrl: url, detail: "Non-HTTP URL" };
  try {
    assertPermittedNavigationURL(url);
  } catch (error) {
    return {
      status: "unknown",
      checkedUrl: url,
      detail: error instanceof Error ? error.message : "Navigation policy blocked URL",
    };
  }
  try {
    const headResponse = await requestUrl(url, "HEAD", timeoutMs, transport);
    if (!HEAD_FALLBACK_STATUS_CODES.has(headResponse.status))
      return classifyResponse(url, headResponse);
    return classifyResponse(url, await requestUrl(url, "GET", timeoutMs, transport));
  } catch (error) {
    logger.debug("Link validation failed:", error);
    return {
      status: "unknown",
      checkedUrl: url,
      detail: error instanceof Error ? error.message : "Link validation failed",
    };
  }
}

export function formatDeadLinkMessage(label: string, result: LinkValidationResult): string {
  const destination = result.finalUrl || result.checkedUrl;
  const status = result.statusCode ? `HTTP ${result.statusCode}` : "dead link";
  return `Skipped stale link "${label}" because ${destination} returned ${status}. Try a different link or URL instead.`;
}
