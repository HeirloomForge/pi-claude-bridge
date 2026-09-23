// Bounded live SDK probe: retry after compaction with no new user message.
// Unlike the manual compact tests, the retained tail is a tool result.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession } from "cc-session-io";
import activate, { __test } from "../src/index.js";

const cwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "bridge-compact-retry-"));
process.chdir(scratch);
const handlers = new Map();
let provider;
activate({ on: (name, fn) => handlers.set(name, fn), registerProvider: (_, p) => { provider = p; }, registerTool() {} });
const model = { ...provider.models.find(m => m.id === "claude-opus-5-5"), provider: "claude-bridge", baseUrl: "claude-bridge", api: "anthropic-messages" };
assert.equal(model.id, "claude-opus-5-5");
const systemPrompt = "You are a test assistant. Return the checkpoint from the completed read tool, verbatim. Do not call any tools.";
handlers.get("before_agent_start")({ systemPrompt, systemPromptOptions: {} });
handlers.get("session_compact")({ reason: "overflow", willRetry: true });
const context = { systemPrompt, tools: [], messages: [
  { role: "user", content: "Read checkpoint.txt and respond with its exact content, nothing else.", timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "toolu_checkpoint", name: "read", arguments: { path: "checkpoint.txt" } }], timestamp: 2 },
  { role: "toolResult", toolCallId: "toolu_checkpoint", toolName: "read", content: [{ type: "text", text: "RECOVERED-CHECKPOINT-7391" }], timestamp: 3 },
] };
const heartbeat = setInterval(() => console.log("Waiting for live Claude continuation..."), 30000);
try {
  const response = await provider.streamSimple(model, context, { maxTokens: 128, reasoning: "off" }).result();
  assert.notEqual(response.stopReason, "error", response.errorMessage);
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  assert.equal(text, "RECOVERED-CHECKPOINT-7391");
  console.log("PASS: live Claude resumed the retained tool history after compaction", response.usage);
} finally {
  clearInterval(heartbeat);
  const session = __test.getSharedSession();
  await handlers.get("session_shutdown")?.();
  if (session) deleteSession(session.sessionId, scratch, process.env.CLAUDE_CONFIG_DIR);
  process.chdir(cwd);
  rmSync(scratch, { recursive: true, force: true });
}