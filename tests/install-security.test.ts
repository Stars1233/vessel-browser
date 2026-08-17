import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("installer creates token-bearing configuration with private permissions", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install.sh"), "utf8");
  assert.match(script, /umask 077/);
  assert.match(script, /chmod 700 "\$CONFIG_DIR"/);
  assert.match(
    script,
    /chmod 600 "\$MCP_STDIO_SNIPPET_PATH" "\$MCP_SNIPPET_PATH" "\$HERMES_SNIPPET_PATH"/,
  );
  assert.match(script, /chmod 600 "\$MCP_AUTH_PATH"/);
});
