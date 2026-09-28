// One short real Opus Bridge turn. Haiku may emit only an allowed status.
// No separate /usage request or OAuth endpoint call.
// Pins the CLI's currently undeclared unifiedWindows payload after SDK upgrades.
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { SubscriptionUsage } from "../src/subscription-usage.js";

it("Claude Code supplies both plan windows through the real Bridge stream", { timeout: 300_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "bridge-usage-probe-"));
	const raw = join(cwd, "sdk-stream.jsonl");
	writeFileSync(raw, "");
	const h = createRpcHarness({
		name: "subscription-usage", cwd,
		args: ["--model", `claude-bridge/${process.env.CLAUDE_BRIDGE_USAGE_TEST_MODEL ?? "claude-opus-5-5"}`, "--thinking", "off"],
		env: { CLAUDE_BRIDGE_RECORD_STREAM: raw },
		defaultTimeout: 240_000,
	});
	const segments = new Map();
	const usage = new SubscriptionUsage();
	usage.start({ events: { emit(name, value) {
		if (name === "powerbar:update") segments.set(value.id, value);
	} } }, { mode: "tui", model: { provider: "claude-bridge" } });
	const heartbeat = setInterval(() => console.log("waiting for the one Bridge probe turn"), 30_000);
	try {
		await h.startAndWait();
		await h.promptAndWait("Reply with exactly OK. Do not use tools.", 240_000);
		const messages = readFileSync(raw, "utf8").split("\n").filter(Boolean).map(JSON.parse);
		const rateEvents = messages.filter((m) => m.type === "rate_limit_event");
		assert.ok(rateEvents.length, `No rate-limit events. Inspect ${raw}`);
		for (const event of rateEvents) {
			console.log(`rate_limit_info: ${JSON.stringify(event.rate_limit_info)}`);
			usage.record(event.rate_limit_info);
		}
		for (const id of ["claude-bridge-hourly", "claude-bridge-weekly"]) {
			const segment = segments.get(id);
			assert.equal(typeof segment?.bar, "number", `Missing ${id} utilization. Inspect ${raw}`);
			assert.match(segment?.text, /\d+[dhm]/, `Missing ${id} reset. Inspect ${raw}`);
			console.log(`${id}: ${segment.text} ${segment.suffix}`);
		}
		console.log(`SDK stream evidence: ${raw}`);
	} finally {
		clearInterval(heartbeat);
		usage.stop();
		await h.stop();
	}
});