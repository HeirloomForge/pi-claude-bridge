#!/usr/bin/env node

/**
 * Foreground pi-subagents children load the bridge (src/subagent-children.ts).
 *
 * pi-subagents runs a foreground child in the parent's process without ambient
 * extensions but with the parent's provider registry. Before the fix, the parent's
 * provider served the child's turns while no bridge handler ever saw the child's
 * before_agent_start, so every turn failed with "prompt-capture: no capture for
 * this N-char system prompt". These tests play pi-subagents' side of the contract:
 * read the required-extension registry for the parent session, load the listed
 * path as a fresh module instance into a child sharing the parent's registry, and
 * resolve the child's prompt from the parent's provider.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_CHILD_EXTENSIONS_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
const BRIDGE_ENTRY = realpathSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const PROVIDER_ID = "claude-bridge";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi(activateFn = activate) {
	const handlers = new Map();
	const registered = [];
	activateFn({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: (name) => registered.push(name),
		registerTool: () => {},
	});
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	return { emit, registered };
}

function sessionCtx(sessionId, modelRegistry) {
	return { sessionManager: { getSessionId: () => sessionId }, modelRegistry, mode: "print" };
}

/** pi-subagents' resolveRequiredChildExtensions(sessionId). */
function requiredChildExtensions(sessionId) {
	return globalThis[REQUIRED_CHILD_EXTENSIONS_KEY]?.bySession.get(sessionId) ?? [];
}

/** pi-subagents' registerRequiredChildExtensions, as a host such as Tidy's guards calls
 *  it from session_start: one snapshot per session, and dispose checks identity. */
function registerRequiredChildExtensions(sessionId, extensions) {
	const bySession = (globalThis[REQUIRED_CHILD_EXTENSIONS_KEY] ??= { version: 1, bySession: new Map() }).bySession;
	if (bySession.has(sessionId)) throw new Error(`Required child extensions are already registered for session '${sessionId}'; dispose them first.`);
	const frozen = Object.freeze(extensions.map((entry) => Object.freeze({ ...entry })));
	bySession.set(sessionId, frozen);
	return { frozen, dispose() { if (bySession.get(sessionId) === frozen) bySession.delete(sessionId); } };
}

const PARENT_PROMPT = "You are the orchestrator.\n\n# Project Context\nparent rules";
const CHILD_PROMPT = '<active_agent name="worker"/>\n\nYou are a worker.\n\n# Project Context\nchild rules';
const HOST_EXTENSION = { id: "tidy-guards", path: "/repo/.pi/extensions/tidy-guards.ts" };

function startParent(sessionId) {
	const parent = activateWithMockPi();
	const ctx = sessionCtx(sessionId, { getProvider: () => undefined });
	parent.emit("session_start", { reason: "startup" }, ctx);
	parent.emit("before_agent_start", { systemPrompt: PARENT_PROMPT, systemPromptOptions: {} }, ctx);
	return parent;
}

describe("foreground subagent children", () => {
	it("a child launched from a bridge session loads the bridge and its prompt resolves", async () => {
		const parent = startParent("fg-parent");

		const required = requiredChildExtensions("fg-parent");
		assert.deepEqual(required.map(({ path }) => path), [BRIDGE_ENTRY],
			"the parent session must list the bridge entry as a host-required child extension");

		// pi-subagents resets the extension cache per child, so the listed path loads fresh.
		const { default: activateChild } = await import(`${pathToFileURL(required[0].path).href}?foreground-child`);
		const child = activateWithMockPi(activateChild);
		const childCtx = sessionCtx("fg-child", { getProvider: (id) => (id === PROVIDER_ID ? {} : undefined) });
		child.emit("session_start", { reason: "startup" }, childCtx);
		assert.deepEqual(child.registered, [], "the child serves through the parent's inherited provider");
		child.emit("before_agent_start", { systemPrompt: CHILD_PROMPT, systemPromptOptions: {} }, childCtx);

		// The parent's provider resolves the child's prompt.
		assert.equal(__test.promptCaptures.resolveOrDerive(CHILD_PROMPT)?.assembledPrompt, CHILD_PROMPT);
		child.emit("session_shutdown");
		parent.emit("session_shutdown");
		assert.deepEqual(requiredChildExtensions("fg-parent"), [], "shutdown releases the registration");
	});

	it("leaves session_start to hosts registering through pi-subagents' API", () => {
		const parent = activateWithMockPi();
		const ctx = sessionCtx("host-first", {});
		parent.emit("session_start", { reason: "startup" }, ctx);
		// Throws if the bridge had taken the session's slot at session_start.
		const host = registerRequiredChildExtensions("host-first", [HOST_EXTENSION]);

		parent.emit("before_agent_start", { systemPrompt: PARENT_PROMPT, systemPromptOptions: {} }, ctx);
		parent.emit("before_agent_start", { systemPrompt: PARENT_PROMPT, systemPromptOptions: {} }, ctx);
		assert.deepEqual(requiredChildExtensions("host-first").map(({ id }) => id), ["tidy-guards", "pi-claude-bridge"],
			"the bridge appends once to the host's snapshot");

		parent.emit("session_shutdown");
		assert.equal(requiredChildExtensions("host-first"), host.frozen, "shutdown restores the host's own snapshot");
		host.dispose();
		assert.deepEqual(requiredChildExtensions("host-first"), [], "so the host's identity-checked dispose still clears it");
	});

	it("follows the session id across a switch", () => {
		const parent = startParent("switch-a");
		const ctx = sessionCtx("switch-b", {});
		parent.emit("session_start", { reason: "new" }, ctx);
		parent.emit("before_agent_start", { systemPrompt: PARENT_PROMPT, systemPromptOptions: {} }, ctx);
		assert.deepEqual(requiredChildExtensions("switch-a"), [], "the previous session's registration is released");
		assert.equal(requiredChildExtensions("switch-b").length, 1);

		parent.emit("session_shutdown");
		assert.deepEqual(requiredChildExtensions("switch-b"), []);
	});
});
