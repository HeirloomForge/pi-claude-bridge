import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import activate, { __test } from "../src/index.js";
import { QueryContext } from "../src/query-state.js";
import { SubscriptionUsage } from "../src/subscription-usage.js";

const fixture = readFileSync(new URL("./fixtures/sdk-streams/text.jsonl", import.meta.url), "utf8")
	.split("\n").filter(Boolean).map(JSON.parse).find((m) => m.type === "rate_limit_event");
const bridgeModel = { provider: "claude-bridge", id: "claude-haiku-4-5" };

function harness(t, mode = "tui") {
	const handlers = new Map();
	const events = new EventEmitter();
	const updates = new Map();
	events.on("powerbar:update", (segment) => updates.set(segment.id, segment));
	activate({
		events,
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerProvider() {}, registerTool() {},
	});
	const context = {
		mode, model: bridgeModel, ui: { notify() {} },
		modelRegistry: { getProvider: () => ({}) },
	};
	function emit(name, event = {}, ctx = context) {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	}
	t.after(() => emit("session_shutdown"));
	emit("session_start", { reason: "new" });
	return { updates, emit, events, context };
}

async function consume(info) {
	async function* messages() { yield { ...fixture, rate_limit_info: info }; }
	// A rate event can arrive with no active Pi stream at a tool boundary.
	await __test.consumeQuery(messages(), new Map(), bridgeModel, () => false, new QueryContext());
}

function currentInfo() {
	const info = structuredClone(fixture.rate_limit_info);
	info.unifiedWindows.five_hour.resetsAt = Math.floor(Date.now() / 1000) + 3600;
	info.unifiedWindows.seven_day.resetsAt = Math.floor(Date.now() / 1000) + 4 * 86400;
	return info;
}

describe("Bridge subscription usage integration", () => {
	it("publishes both windows from the recorded allowed SDK event through consumeQuery", async (t) => {
		const h = harness(t);
		await consume(currentInfo());
		assert.equal(h.updates.get("claude-bridge-hourly")?.suffix, "14%");
		assert.equal(h.updates.get("claude-bridge-weekly")?.suffix, "1%");
		assert.equal(h.updates.get("claude-bridge-weekly")?.bar, 1);
		assert.equal(h.updates.get("claude-bridge-weekly")?.text, "Week 4d");
	});

	it("does not compete with the HTTP usage producer's segment IDs", async (t) => {
		const h = harness(t);
		await consume(currentInfo());
		h.events.emit("powerbar:update", { id: "sub-weekly", text: undefined });
		assert.equal(h.updates.get("claude-bridge-weekly")?.suffix, "1%");
	});

	it("clears Bridge bars on model switch and republishes on return", async (t) => {
		const h = harness(t);
		await consume(currentInfo());
		h.emit("model_select", {}, { ...h.context, model: { provider: "openai-codex" } });
		assert.equal(h.updates.get("claude-bridge-weekly")?.text, undefined);
		await consume(currentInfo());
		assert.equal(h.updates.get("claude-bridge-weekly")?.text, undefined);
		h.emit("model_select");
		assert.equal(h.updates.get("claude-bridge-weekly")?.suffix, "1%");
	});

	it("keeps the TUI observer alive when a same-module headless child starts and stops", async (t) => {
		const parent = harness(t);
		const child = harness(t, "rpc");
		child.emit("session_shutdown");
		await consume(currentInfo());
		assert.equal(parent.updates.get("claude-bridge-weekly")?.suffix, "1%");
		assert.equal(child.updates.size, 0);
	});

	it("resets observations on a new session and ignores events after shutdown", async (t) => {
		const h = harness(t);
		await consume(currentInfo());
		h.emit("session_start", { reason: "new" });
		assert.equal(h.updates.get("claude-bridge-weekly")?.suffix, "?");
		h.emit("session_shutdown");
		await consume(currentInfo());
		assert.equal(h.updates.get("claude-bridge-weekly")?.text, undefined);
	});
});

function observer(t) {
	let now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	// The new path must never need a fetch, even when data is incomplete.
	t.mock.method(globalThis, "fetch", () => { throw new Error("No direct HTTP for Bridge usage"); });
	const usage = new SubscriptionUsage();
	const segments = new Map();
	const registrations = [];
	const pi = { events: { emit(name, value) {
		if (name === "powerbar:update") segments.set(value.id, value);
		else registrations.push(value);
	} } };
	usage.start(pi, { mode: "tui", model: bridgeModel });
	t.after(() => usage.stop());
	return {
		usage, registrations,
		weekly: () => segments.get("claude-bridge-weekly"),
		hourly: () => segments.get("claude-bridge-hourly"),
		advance: (ms) => { now += ms; usage.refresh(); },
		reset: () => now / 1000 + 4 * 86400,
	};
}

describe("passive SDK usage observations", () => {
	it("starts unknown, without manufacturing zero or requesting usage", (t) => {
		const h = observer(t);
		assert.equal(h.weekly().suffix, "?");
		assert.equal(h.weekly().bar, undefined);
		assert.equal(h.registrations.length, 2);
	});

	it("handles allowed, warning, and rejected events with the same unit conversion", (t) => {
		const h = observer(t);
		for (const status of ["allowed", "allowed_warning", "rejected"]) {
			h.usage.record({ status, rateLimitType: "seven_day", utilization: 0.96, resetsAt: h.reset() });
			assert.equal(h.weekly().suffix, "96%");
			assert.equal(h.weekly().bar, 96);
			assert.equal(h.weekly().text, "Week 4d");
			assert.equal(h.weekly().color, "error");
		}
	});

	it("renders zero, warning and full usage without treating zero as missing", (t) => {
		const h = observer(t);
		for (const [utilization, percent, color] of [[0, 0, "muted"], [0.7, 70, "warning"], [1, 100, "error"]]) {
			h.usage.record({ status: "allowed", unifiedWindows: { seven_day: { utilization, resetsAt: h.reset() } } });
			assert.equal(h.weekly().suffix, `${percent}%`);
			assert.equal(h.weekly().bar, percent);
			assert.equal(h.weekly().color, color);
		}
	});

	it("repaints countdown locally and expires the bar instead of inventing a reset to zero", (t) => {
		const h = observer(t);
		h.usage.record({ status: "allowed", rateLimitType: "seven_day", utilization: 0.96, resetsAt: h.reset() });
		h.advance(86400_000);
		assert.equal(h.weekly().text, "Week 3d");
		assert.equal(h.weekly().suffix, "96%");
		h.advance(3 * 86400_000);
		assert.equal(h.weekly().text, "Week");
		assert.equal(h.weekly().suffix, "?");
		assert.equal(h.weekly().bar, undefined);
	});

	it("retains a reset without utilization, but never substitutes a threshold or rejection as a percentage", (t) => {
		const h = observer(t);
		h.usage.record({ status: "rejected", rateLimitType: "seven_day", surpassedThreshold: 0.95, resetsAt: h.reset() });
		assert.equal(h.weekly().suffix, "?");
		assert.equal(h.weekly().bar, undefined);
		assert.equal(h.weekly().text, "Week 4d");
	});

	it("does not overwrite aggregate weekly data with model-specific or overage limits", (t) => {
		const h = observer(t);
		h.usage.record({ status: "allowed", rateLimitType: "seven_day", utilization: 0.12 });
		for (const rateLimitType of ["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage"]) {
			h.usage.record({ status: "rejected", rateLimitType, utilization: 1 });
			assert.equal(h.weekly().bar, 12);
		}
	});

	it("clears windows absent from a new unified snapshot, without shifting the five-hour slot", (t) => {
		const h = observer(t);
		h.usage.record({ status: "allowed", unifiedWindows: {
			five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.2 },
		} });
		h.usage.record({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3 } } });
		assert.equal(h.hourly().bar, undefined);
		assert.equal(h.weekly().bar, 30);
		h.usage.record({ status: "allowed", unifiedWindows: {} });
		assert.equal(h.weekly().bar, undefined);
	});

	it("rejects invalid data and keeps partial observations honest", (t) => {
		const h = observer(t);
		for (const value of [undefined, null, [], "oops", { status: "unexpected" }]) h.usage.record(value);
		for (const utilization of [undefined, null, "0.5", -1, 96, NaN, Infinity]) {
			h.usage.record({ status: "allowed", unifiedWindows: { seven_day: { utilization, resetsAt: h.reset() } } });
			assert.equal(h.weekly().suffix, "?");
			assert.equal(h.weekly().bar, undefined);
		}
		for (const resetsAt of [undefined, null, "1800000000", -1, Infinity, NaN, 9e20]) {
			h.usage.record({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.1, resetsAt } } });
			assert.equal(h.weekly().text, "Week");
			assert.equal(h.weekly().bar, 10);
		}
	});

	it("stays inert in RPC, print and JSON sessions", (t) => {
		const usage = new SubscriptionUsage();
		t.after(() => usage.stop());
		for (const mode of ["rpc", "print", "json"]) {
			usage.start({ events: { emit() { assert.fail("headless usage must not publish UI events"); } } }, { mode, model: bridgeModel });
			usage.record(currentInfo());
			usage.refresh();
			usage.stop();
		}
	});
});