const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isMiscollected } = require("../lib/junk");

test("voice effect thumbnails are junk", () => {
  assert.equal(isMiscollected({
    prompt: "华妃",
    image_url: "https://lf3-effectcdn-tos.byteeffecttos.com/obj/ies.fe.effect/abc",
  }), true);
});

test("real dreamina work is kept", () => {
  assert.equal(isMiscollected({
    prompt: "质感，肌理感，梦幻的，艺术抽象，诗意的，高级，杰作",
    author: "艾玛视觉",
    model: "图片 4.7",
    image_url: "https://p11-dreamina-sign.byteimg.com/tos-cn-i-tb4s082cfz/xxx~tplv.webp",
  }), false);
});
