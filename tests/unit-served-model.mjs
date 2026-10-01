/**
 * Claude Code takes its API endpoint from its own settings, so a user-level
 * ANTHROPIC_BASE_URL (a local model router, a gateway) can answer a bridge request
 * with a different model while `system/init` still names the requested one. A
 * router sending every "sonnet" id to a local GLM made claude-bridge/claude-sonnet-5-5
 * end turns with tool calls written as text, which read as Sonnet misbehaving.
 * message_start carries the model that actually answered; a mismatch must be said
 * out loud, once per pair, naming both.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The warning also lands in the diag log in pi's agent dir; keep it out of the real one.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-served-model-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const { QueryContext } = await import("../src/query-state.js");
const { __test } = await import("../src/index.js");
const diagLog = join(agentDir, "claude-bridge-diag.log");

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const modelFor = (id) => ({ api: "claude-bridge", provider: "claude-bridge", id, cost: zeroCost });

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

async function answer(requestedId, servedModel) {
	const model = modelFor(requestedId);
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(model);
	async function* gen() {
		yield { type: "stream_event", event: { type: "message_start", message: { id: `msg_${servedModel}`, model: servedModel, usage: { input_tokens: 1, output_tokens: 0 } } } };
	}
	await __test.consumeQuery(gen(), new Map(), model, () => false, c);
}

let notices;
beforeEach(() => {
	notices = [];
	__test.setPiUI({ notify: (message, level) => notices.push({ message, level }) });
});

describe("served model differs from the requested one", () => {
	it("warns once, naming both models", async () => {
		await answer("claude-sonnet-5-5", "glm-5.3-flash-exl3");
		await answer("claude-sonnet-5-5", "glm-5.3-flash-exl3");

		assert.equal(notices.length, 1, "one notice per requested/served pair");
		assert.equal(notices[0].level, "warning");
		assert.match(notices[0].message, /claude-sonnet-5-5/);
		assert.match(notices[0].message, /glm-5\.3-flash-exl3/);
		const diag = readFileSync(diagLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(diag.map(({ label, requested, served }) => ({ label, requested, served })),
			[{ label: "served_model_mismatch", requested: "claude-sonnet-5-5", served: "glm-5.3-flash-exl3" }]);
	});

	it("warns again for a different pair", async () => {
		await answer("claude-opus-5-5", "qwen3.8-27b");
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /claude-opus-5-5/);
	});

	it("stays quiet when the requested model, or a dated snapshot of it, answers", async () => {
		const diagLines = () => (existsSync(diagLog) ? readFileSync(diagLog, "utf8").trim().split("\n").length : 0);
		const before = diagLines();
		await answer("claude-sonnet-5-5", "claude-sonnet-5-5");
		await answer("claude-haiku-4-5", "claude-haiku-4-5-20251001");
		await answer("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001");
		await answer("claude-sonnet-5-5", undefined);
		assert.deepEqual(notices, []);
		assert.equal(diagLines(), before);
	});
});