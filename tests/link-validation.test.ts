import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";

import {
  validateLinkDestination,
  type LinkValidationTransport,
} from "../src/main/network/link-validation";

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/gone") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (req.url === "/head-405-get-404") {
      if (req.method === "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (req.url === "/redirect-private") {
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end();
      return;
    }

    res.writeHead(500, { "content-type": "text/plain" });
    res.end("unexpected");
  });

  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

let serverInfo: { server: http.Server; baseUrl: string };
const testTransport: LinkValidationTransport = {
  async resolve() {
    return [{ address: "93.184.216.34", family: 4 }];
  },
  async request(url, method) {
    const response = await fetch(`${serverInfo.baseUrl}${url.pathname}`, {
      method,
      redirect: "manual",
    });
    await response.body?.cancel();
    return {
      status: response.status,
      url: url.href,
      location: response.headers.get("location") || undefined,
    };
  },
};

before(async () => {
  serverInfo = await createServer();
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    serverInfo.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test("validateLinkDestination marks HTTP 200 destinations as live", async () => {
  const result = await validateLinkDestination("https://example.test/ok", 3500, testTransport);

  assert.equal(result.status, "live");
  assert.equal(result.statusCode, 200);
});

test("validateLinkDestination marks HTTP 404 destinations as dead", async () => {
  const result = await validateLinkDestination("https://example.test/gone", 3500, testTransport);

  assert.equal(result.status, "dead");
  assert.equal(result.statusCode, 404);
});

test("validateLinkDestination falls back to GET when HEAD is unsupported", async () => {
  const result = await validateLinkDestination(
    "https://example.test/head-405-get-404",
    3500,
    testTransport,
  );

  assert.equal(result.status, "dead");
  assert.equal(result.statusCode, 404);
});

test("validateLinkDestination blocks private IP literals without requesting them", async () => {
  let requested = false;
  const transport: LinkValidationTransport = {
    async resolve() {
      return [];
    },
    async request() {
      requested = true;
      throw new Error("unexpected");
    },
  };
  const result = await validateLinkDestination("http://127.0.0.1/admin", 3500, transport);
  assert.equal(result.status, "unknown");
  assert.match(result.detail || "", /private or non-routable/);
  assert.equal(requested, false);

  for (const url of ["http://[::1]/admin", "http://[::ffff:127.0.0.1]/admin"]) {
    const ipv6Result = await validateLinkDestination(url, 3500, transport);
    assert.equal(ipv6Result.status, "unknown");
    assert.match(ipv6Result.detail || "", /private or non-routable/);
  }
});

test("validateLinkDestination revalidates every redirect target", async () => {
  const result = await validateLinkDestination(
    "https://example.test/redirect-private",
    3500,
    testTransport,
  );
  assert.equal(result.status, "unknown");
  assert.match(result.detail || "", /private or non-routable/);
});

test("validateLinkDestination does not fetch URLs blocked by navigation policy", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  const originalAirGapped = process.env.VESSEL_AIR_GAPPED;
  process.env.VESSEL_AIR_GAPPED = "1";
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("", { status: 200 });
  };

  try {
    const result = await validateLinkDestination("javascript:alert(1)");
    assert.equal(result.status, "unknown");

    const blocked = await validateLinkDestination("https://not-real.invalid");
    assert.equal(blocked.status, "unknown");
    assert.match(blocked.detail || "", /Air-gapped mode blocked/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAirGapped === undefined) {
      delete process.env.VESSEL_AIR_GAPPED;
    } else {
      process.env.VESSEL_AIR_GAPPED = originalAirGapped;
    }
  }
});
