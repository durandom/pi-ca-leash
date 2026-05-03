import test from "node:test";
import assert from "node:assert/strict";
import { derivePeerName, parsePeerStartInput } from "./peer-naming.js";

test("parsePeerStartInput supports prompt-only auto-naming", () => {
  assert.deepEqual(parsePeerStartInput("Investigate flaky tests"), {
    prompt: "Investigate flaky tests",
    autoNamed: true,
  });
});

test("parsePeerStartInput preserves explicit name override", () => {
  assert.deepEqual(parsePeerStartInput("reviewer | Review auth flow"), {
    name: "reviewer",
    prompt: "Review auth flow",
    autoNamed: false,
  });
});

test("derivePeerName uses readable role heuristics and deconflicts", () => {
  assert.equal(derivePeerName("Please review the auth flow", []), "reviewer");
  assert.equal(derivePeerName("Investigate flaky tests", ["researcher"]), "researcher-2");
  assert.equal(derivePeerName("You are a brief worker. Reply briefly.", []), "worker");
  assert.equal(derivePeerName("Help with this", ["peer"]), "peer-2");
});
