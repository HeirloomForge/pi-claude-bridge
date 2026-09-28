import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./convert.js";

const WINDOWS = [
	{ key: "five_hour", id: "claude-bridge-hourly", label: "5h", blocks: 5 },
	{ key: "seven_day", id: "claude-bridge-weekly", label: "Week", blocks: 7 },
] as const;
type WindowKey = typeof WINDOWS[number]["key"];
type Observation = { percent?: number; resetMs?: number };

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function observation(value: unknown): Observation | undefined {
	const data = object(value);
	if (!data) return undefined;
	const { utilization, resetsAt } = data;
	// SDK events use fractions and Unix seconds, unlike the OAuth usage endpoint.
	const percent = typeof utilization === "number" && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1
		? Math.round(utilization * 100) : undefined;
	const resetMs = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= 8.64e12
		? resetsAt * 1000 : undefined;
	return percent === undefined && resetMs === undefined ? undefined : { percent, resetMs };
}

function countdown(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** Passive SDK observer. No auth files, HTTP clients, SDK queries, or disk cache. */
export class SubscriptionUsage {
	private windows = new Map<WindowKey, Observation>();
	private pi: ExtensionAPI | undefined;
	private selected = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	start(pi: ExtensionAPI, ctx: ExtensionContext): void {
		this.stop();
		if (ctx.mode !== "tui") return;
		this.pi = pi;
		for (const window of WINDOWS) {
			pi.events.emit("powerbar:register-segment", {
				id: window.id, label: `Claude Bridge ${window.label} (SDK)`,
			});
		}
		this.select(ctx);
	}

	select(ctx: ExtensionContext): void {
		this.selected = ctx.mode === "tui" && ctx.model?.provider === PROVIDER_ID;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		// Only repaint the local countdown. This never polls Claude or starts a query.
		if (this.pi && this.selected) {
			this.timer = setInterval(() => this.refresh(), 60_000);
			this.timer.unref();
		}
		this.refresh();
	}

	record(value: unknown): void {
		if (!this.pi) return;
		const info = object(value);
		if (!info || !["allowed", "allowed_warning", "rejected"].includes(String(info.status))) return;
		// Current CLI streams include unifiedWindows even on ordinary allowed turns.
		// It is not declared by SDKRateLimitInfo yet; validate at this boundary.
		// Recorded SDK streams and int-subscription-usage pin the runtime contract.
		const unified = object(info.unifiedWindows);
		if (unified) {
			this.windows.clear();
			for (const { key } of WINDOWS) {
				const value = observation(unified[key]);
				if (value) this.windows.set(key, value);
			}
		} else {
			// Some CLI events only describe the limiting window. Do not mistake a
			// per-model or extra-usage limit for the aggregate weekly allowance.
			const window = WINDOWS.find(({ key }) => key === info.rateLimitType);
			if (window) {
				const value = observation(info);
				if (value) this.windows.set(window.key, value);
				else this.windows.delete(window.key);
			}
		}
		this.refresh();
	}

	refresh(): void {
		if (!this.pi) return;
		for (const window of WINDOWS) {
			if (!this.selected) {
				this.pi.events.emit("powerbar:update", { id: window.id, text: undefined });
				continue;
			}
			let value = this.windows.get(window.key);
			if (value?.resetMs !== undefined && value.resetMs <= Date.now()) {
				// A passed reset is not evidence of 0% used in the new window.
				this.windows.delete(window.key);
				value = undefined;
			}
			const percent = value?.percent;
			const reset = value?.resetMs === undefined ? "" : ` ${countdown(value.resetMs - Date.now())}`;
			this.pi.events.emit("powerbar:update", {
				id: window.id,
				text: `${window.label}${reset}`,
				suffix: percent === undefined ? "?" : `${percent}%`,
				bar: percent,
				barSegments: window.blocks,
				color: percent !== undefined && percent > 80 ? "error" : percent !== undefined && percent > 60 ? "warning" : "muted",
			});
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.selected = false;
		this.windows.clear();
		this.refresh();
		this.pi = undefined;
	}
}