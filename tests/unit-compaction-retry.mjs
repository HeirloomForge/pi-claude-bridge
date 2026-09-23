import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bridge-recovery-"));
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({
  provider: { plan: "max" }, askClaude: { enabled: false },
}));
const calls = [];
globalThis.__bridgeRecoveryQuery = ({ prompt, options }) => {
  const c = { options }; calls.push(c);
  const gen = (async function* () {
    c.prompt = (await prompt.next()).value;
    
    yield { type: "result", subtype: "success", is_error: false, result: "continued" };
  })();
  return Object.assign(gen, { close() {}, interrupt: async () => {} });
};
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") return {
    url: "data:text/javascript,export const query = (...args) => globalThis.__bridgeRecoveryQuery(...args)", shortCircuit: true,
  };
  return next(specifier, context);
} });
const { default: activate, __test } = await import("../src/index.js");
const { openSession } = await import("cc-session-io");
const handlers = new Map();
let provider;
activate({ on: (name, fn) => handlers.set(name, fn), registerProvider: (_, p) => { provider = p; }, registerTool() {} });
const model = { id: "claude-opus-5-5", provider: "claude-bridge", api: "anthropic-messages", baseUrl: "claude-bridge", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const prompt = "You are a test assistant.";
const context = {
  systemPrompt: prompt, tools: [], messages: [
    { role: "user", content: "Preserve the checkpoint and continue the task.", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "retained-call", name: "read", arguments: { path: "checkpoint.txt" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "retained-call", toolName: "read", content: [{ type: "text", text: "CHECKPOINT-7391" }], timestamp: 3 },
  ],
};
beforeEach(() => {
  calls.length = 0;
  __test.resetSharedSession();
  handlers.get("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: {} });
});
after(() => { hook.deregister(); delete globalThis.__bridgeRecoveryQuery; rmSync(root, { recursive: true, force: true }); });

test("overflow compaction retries through Claude with the retained tool result", async () => {
  handlers.get("session_compact")({ reason: "overflow", willRetry: true });
  const answer = await provider.streamSimple(model, context).result();
  assert.equal(answer.content.map(b => b.text ?? "").join(""), "continued");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.resume, "rebuild retained history before continuing");
  const session = openSession({ sessionId: calls[0].options.resume, projectPath: process.cwd(), claudeDir: process.env.CLAUDE_CONFIG_DIR });
  assert.match(JSON.stringify(session.messages), /CHECKPOINT-7391/);
  assert.match(JSON.stringify(session.messages), /retained-call/);
});

test("an ordinary orphaned result still ends without launching Claude", async () => {
  handlers.get("session_compact")({ reason: "manual", willRetry: false });
  const answer = await provider.streamSimple(model, context).result();
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, []);
  assert.equal(calls.length, 0);
});

test("the recovery permission is consumed by the next user request", async () => {
  handlers.get("session_compact")({ reason: "overflow", willRetry: true });
  const newUser = { ...context, messages: [{ role: "user", content: "New request", timestamp: 4 }] };
  const answer = await provider.streamSimple(model, newUser).result();
  assert.equal(answer.stopReason, "stop");
  await new Promise(resolve => setImmediate(resolve));
  const orphan = await provider.streamSimple(model, context).result();
  assert.deepEqual(orphan.content, []);
  assert.equal(calls.length, 1);
});

test("external compaction is the default and neither invokes Claude nor overwrites another handler", async () => {
  const result = await handlers.get("session_before_compact")({ preparation: { messagesToSummarize: [context.messages[0]], turnPrefixMessages: [], settings: { reserveTokens: 16384 }, fileOps: { read: new Set(), edited: new Set(), written: new Set() } }, branchEntries: [] }, { model });
  assert.equal(result, undefined);
  assert.equal(calls.length, 0);
});