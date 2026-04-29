#!/usr/bin/env node
import { ClaudeRuntimeIntercomBridge } from "./bridge.js";

const bridge = new ClaudeRuntimeIntercomBridge();
const prompt = process.argv.slice(2).join(" ") || "You are demo worker. Reply briefly.";

const peer = await bridge.launchPeer({
  name: "demo-worker",
  prompt,
  permissionMode: "bypassPermissions",
});

console.log("launched", JSON.stringify(peer, null, 2));

const ask = await bridge.ask("demo-worker", {
  from: "demo-client",
  text: "Reply with exactly: intercom-ok",
});

console.log("ask", JSON.stringify(ask, null, 2));

const stopped = await bridge.stop("demo-worker");
console.log("stopped", JSON.stringify(stopped, null, 2));
