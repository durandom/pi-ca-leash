import test from "node:test";
import assert from "node:assert/strict";
import { resolveSecurityMode } from "../src/security-mode.js";

test("resolveSecurityMode — explicit securityMode wins", () => {
  assert.equal(resolveSecurityMode({ securityMode: "yolo" }), "yolo");
  assert.equal(resolveSecurityMode({ securityMode: "safe" }), "safe");
  assert.equal(
    resolveSecurityMode({ securityMode: "yolo", permissionMode: "default" }),
    "yolo",
    "explicit securityMode must override legacy permissionMode",
  );
});

test("resolveSecurityMode — bypassPermissions maps to yolo", () => {
  assert.equal(resolveSecurityMode({ permissionMode: "bypassPermissions" }), "yolo");
});

test("resolveSecurityMode — default/acceptEdits/auto map to safe", () => {
  assert.equal(resolveSecurityMode({ permissionMode: "default" }), "safe");
  assert.equal(resolveSecurityMode({ permissionMode: "acceptEdits" }), "safe");
  assert.equal(resolveSecurityMode({ permissionMode: "auto" }), "safe");
});

test("resolveSecurityMode — no input falls back to safe", () => {
  assert.equal(resolveSecurityMode({}), "safe");
});

test("resolveSecurityMode — plan and dontAsk throw", () => {
  assert.throws(() => resolveSecurityMode({ permissionMode: "plan" }), /no longer supported/);
  assert.throws(() => resolveSecurityMode({ permissionMode: "dontAsk" }), /no longer supported/);
});
