const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extFrom, isAllowedImageUrl } = require("../lib/image-store");

test("keeps original format from content-type", () => {
  assert.equal(extFrom("image/png", "https://x/a.webp"), "png");
  assert.equal(extFrom("image/jpeg", ""), "jpg");
  assert.equal(extFrom("image/webp", ""), "webp");
});

test("allows dreamina cdn and rejects random hosts", () => {
  assert.equal(isAllowedImageUrl("https://p11-dreamina-sign.byteimg.com/tos/x.webp"), true);
  assert.equal(isAllowedImageUrl("https://example.com/a.png"), false);
});
