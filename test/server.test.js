const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { normalizeUrl, isStatusExpected, createServer } = require("../src/server");

test("normalizeUrl adds https scheme and rejects invalid inputs", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("http://127.0.0.1:3000/health"), "http://127.0.0.1:3000/health");
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("ftp://example.com"), null);
});

test("isStatusExpected evaluates rules accurately", () => {
  assert.equal(isStatusExpected(200, "2xx"), true);
  assert.equal(isStatusExpected(404, "2xx"), false);
  assert.equal(isStatusExpected(200, "200"), true);
  assert.equal(isStatusExpected(201, "200"), false);
  assert.equal(isStatusExpected(302, "3xx"), true);
});

test("POST and DELETE /api/targets persist in temp store", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scp-test-"));
  const storePath = path.join(tmpDir, "targets.json");
  const server = createServer(storePath);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const createRes = await fetch(`${baseUrl}/api/targets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Local Test",
        url: "https://example.com",
        expectedStatus: "200",
        note: "Test kaydı"
      })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.ok(created.id);

    const delRes = await fetch(`${baseUrl}/api/targets/${encodeURIComponent(created.id)}`, {
      method: "DELETE"
    });
    assert.equal(delRes.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
