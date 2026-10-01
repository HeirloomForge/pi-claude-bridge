import { realpathSync } from "fs";

/**
 * pi-subagents runs a foreground child in the parent's process without the
 * parent's ambient extensions, yet hands it the parent's provider registry. The
 * child's turns then reach this bridge's provider while no bridge handler sees the
 * child's `before_agent_start`, so its prompt is never captured and every turn
 * fails closed in resolveOrDerive. Listing the bridge as a host-required child
 * extension makes pi-subagents load it into each child it launches from this
 * session. A loaded child instance finds the provider already registered, skips
 * registration, and only records its prompts into the process-wide captures.
 *
 * pi-subagents is not a dependency, so this writes its process-global registry
 * directly, with the shape and version check of its `registerRequiredChildExtensions`
 * (`pi-subagents/required-child-extensions`). That API holds one snapshot per
 * session and refuses a second registration, which other hosts use from
 * `session_start` (Tidy's guards do, and give up silently when refused). So the
 * bridge appends to the session's snapshot instead of registering its own, and
 * the caller should do it after session_start has settled.
 */
const REQUIRED_CHILD_EXTENSIONS_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
const BRIDGE_CHILD_EXTENSION_ID = "pi-claude-bridge";

type RequiredChildExtension = Readonly<{ id: string; path: string }>;
type RequiredChildExtensionSnapshot = ReadonlyArray<RequiredChildExtension>;
type RequiredChildExtensionRegistry = { version: 1; bySession: Map<string, RequiredChildExtensionSnapshot> };

function requiredChildExtensionRegistry(): RequiredChildExtensionRegistry | undefined {
	const root = globalThis as Record<symbol, unknown>;
	const existing = root[REQUIRED_CHILD_EXTENSIONS_KEY] as Partial<RequiredChildExtensionRegistry> | undefined;
	if (existing === undefined) {
		const created: RequiredChildExtensionRegistry = { version: 1, bySession: new Map() };
		root[REQUIRED_CHILD_EXTENSIONS_KEY] = created;
		return created;
	}
	// A future registry version may change the entry contract; leave it alone.
	if (existing?.version !== 1 || !(existing.bySession instanceof Map)) return undefined;
	return existing as RequiredChildExtensionRegistry;
}

/** One bridge instance's entry in pi-subagents' required child extensions. */
export class SubagentChildRequirement {
	private registered?: { sessionId: string; snapshot: RequiredChildExtensionSnapshot; previous?: RequiredChildExtensionSnapshot };

	constructor(private readonly extensionPath: string) {}

	/** Append the bridge to `sessionId`'s snapshot unless it is already listed.
	 *  Moving to another session releases the previous one first. */
	require(sessionId: string | undefined): void {
		if (this.registered && this.registered.sessionId !== sessionId) this.release();
		const registry = requiredChildExtensionRegistry();
		if (!registry || !sessionId) return;
		const path = realpathSync(this.extensionPath);
		const previous = registry.bySession.get(sessionId);
		if (previous?.some((entry) => entry.path === path || entry.id === BRIDGE_CHILD_EXTENSION_ID)) return;
		const snapshot = Object.freeze([...(previous ?? []), Object.freeze({ id: BRIDGE_CHILD_EXTENSION_ID, path })]);
		registry.bySession.set(sessionId, snapshot);
		this.registered = { sessionId, snapshot, previous };
	}

	/** Put back the snapshot the bridge appended to, so its owner's own
	 *  identity-checked dispose still matches. */
	release(): void {
		const registered = this.registered;
		this.registered = undefined;
		const registry = requiredChildExtensionRegistry();
		if (!registered || registry?.bySession.get(registered.sessionId) !== registered.snapshot) return;
		if (registered.previous) registry.bySession.set(registered.sessionId, registered.previous);
		else registry.bySession.delete(registered.sessionId);
	}
}