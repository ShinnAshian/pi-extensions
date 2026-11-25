// Subscription quota view: `agy --print /usage --output-format json`.
//
// agy has no usage subcommand; the /usage slash command inside print mode
// returns the same structured payload the agy TUI panel shows and burns
// zero tokens (live-verified agy 1.2.10: status SUCCESS, usage all zeros,
// command.data.groups[] with window "weekly" | "5h" buckets carrying
// remaining_fraction and reset_time). Print mode answers in ~10s on this
// machine, so the spawn budget here is its own 30s, not the 8s discovery
// watchdog shared by models/agents.
//
// The quota is account-level: it reads the agy CLI's Google identity, so it
// is equally true for stream-json turns and ACP-server turns (same account)
// — but a pure-ACP install without the CLI cannot fetch it; the command
// layer fails closed with a pointer instead of a raw error.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	DIALOG_OPTIONS,
	dialogBlocked,
	dialogHeight,
	dialogText,
	frameDialog,
} from "@estebanforge/pi-tui-dialogs";
import { spawnAgyRaw } from "./models.js";

export const USAGE_TIMEOUT_MS = 30_000;
const USAGE_CAP_BYTES = 1024 * 1024;

export interface AgyQuotaBucket {
	id?: string;
	name: string;
	description?: string;
	/** agy's window tag: "weekly" | "5h" (tolerant of future tags). */
	window: string;
	remainingFraction: number;
	resetTime?: string;
}

export interface AgyQuotaGroup {
	name: string;
	description?: string;
	buckets: AgyQuotaBucket[];
}

export interface AgyQuotaReport {
	description?: string;
	groups: AgyQuotaGroup[];
}

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | undefined => (v !== null && typeof v === "object" ? (v as Json) : undefined);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const firstString = (o: Json, keys: string[]): string | undefined => {
	for (const k of keys) {
		const v = asString(o[k]);
		if (v !== undefined) return v;
	}
	return undefined;
};

function parseBucket(v: unknown): AgyQuotaBucket | undefined {
	const o = asObject(v);
	if (!o) return undefined;
	const remaining = asNumber(o.remaining_fraction) ?? asNumber(o.remainingFraction) ?? asNumber(o.remaining);
	const name = firstString(o, ["name", "id"]);
	if (remaining === undefined || name === undefined) return undefined;
	return {
		id: asString(o.id),
		name,
		description: asString(o.description),
		window: firstString(o, ["window"]) ?? "unknown",
		remainingFraction: Math.max(0, Math.min(1, remaining)),
		resetTime: firstString(o, ["reset_time", "resetTime"]),
	};
}

function parseGroup(v: unknown): AgyQuotaGroup | undefined {
	const o = asObject(v);
	if (!o) return undefined;
	const name = asString(o.name);
	if (name === undefined) return undefined;
	const buckets = Array.isArray(o.buckets)
		? o.buckets.map(parseBucket).filter((b): b is AgyQuotaBucket => b !== undefined)
		: [];
	return { name, description: asString(o.description), buckets };
}

/** Parse the /usage JSON payload. Tolerant: unwraps a stream-json result
 *  envelope when present (print mode does not send one), accepts snake_case
 *  and camelCase field aliases, clamps fractions. Throws a short reason on
 *  any structural mismatch — callers render it, never stack it. */
export function parseAgyUsageJson(text: string): AgyQuotaReport {
	let payload: Json | undefined;
	try {
		payload = asObject(JSON.parse(text));
	} catch {
		throw new Error("response was not JSON");
	}
	if (!payload) throw new Error("response was not an object");
	// Print mode answers at the top level; if some future agy shells the
	// command through its stream instead, the wrapper is the same event-keyed
	// NDJSON grammar the driver already parses (see fake-agy-bin frames:
	// {"event":"init",...}), so unwrap {event:"result", result:{...}}.
	const inner = payload.event !== undefined ? asObject(payload.result) : payload;
	if (!inner) throw new Error("result envelope carried no result object");
	const status = (firstString(inner, ["status"]) ?? "").toUpperCase();
	if (status !== "" && status !== "SUCCESS" && status !== "OK") {
		throw new Error(`agy reported status ${status}`);
	}
	const command = asObject(inner.command);
	if (command === undefined || command.name !== "usage") {
		throw new Error("payload is not a /usage command result");
	}
	const data = asObject(command.data) ?? asObject(inner.data);
	const rawGroups = data !== undefined && Array.isArray(data.groups) ? data.groups : undefined;
	if (rawGroups === undefined) throw new Error("no quota groups in payload");
	const groups = rawGroups.map(parseGroup).filter((g): g is AgyQuotaGroup => g !== undefined);
	if (groups.length === 0) throw new Error("no quota groups returned");
	return { description: asString(data?.description), groups };
}

/** Fetch quota through the CLI. Undefined on any fetch failure (missing
 *  binary, non-zero exit, timeout, cap) — same degrade-to-empty contract as
 *  the model catalog; the caller renders the difference. The spawn watchdog
 *  runs 5s past agy's own --print-timeout so the CLI's clean timeout-exit
 *  always wins the race over our SIGKILL. */
export async function fetchAgyQuota(binary: string): Promise<AgyQuotaReport | undefined> {
	const raw = await spawnAgyRaw(
		binary,
		["--print", "/usage", "--output-format", "json", "--print-timeout", `${Math.ceil(USAGE_TIMEOUT_MS / 1000)}s`],
		USAGE_TIMEOUT_MS + 5_000,
		USAGE_CAP_BYTES,
	);
	if (raw === "") return undefined;
	try {
		return parseAgyUsageJson(raw);
	} catch {
		return undefined;
	}
}

// --- rendering ---------------------------------------------------------------

/** 20-segment remaining bar. */
export function quotaBar(fraction: number): string {
	const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

/** Clock-style reset label: "resets 19:53" today, else "resets 09:10 on 4 Sep". */
export function resetLabel(resetTime: string, now: Date): string {
	const at = new Date(resetTime);
	if (Number.isNaN(at.getTime())) return "";
	const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const sameDay =
		at.getFullYear() === now.getFullYear() &&
		at.getMonth() === now.getMonth() &&
		at.getDate() === now.getDate();
	if (sameDay) return `resets ${hhmm}`;
	const day = at.getDate();
	const mon = at.toLocaleString("en", { month: "short" });
	return `resets ${hhmm} on ${day} ${mon}`;
}

const WINDOW_RANK: Record<string, number> = { "5h": 0, weekly: 1 };

/** Full report text: per group, 5h bucket before weekly (the window users
 *  hit first), name labeled bar with percent and reset time. */
export function formatAgyQuotaReport(report: AgyQuotaReport, now: Date = new Date()): string {
	const lines: string[] = ["Antigravity quota (account-level, both engines)"];
	for (const group of report.groups) {
		lines.push("", group.name);
		const buckets = [...group.buckets].sort(
			(a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
		);
		for (const bucket of buckets) {
			const pct = Math.round(bucket.remainingFraction * 100);
			const reset = bucket.resetTime !== undefined ? ` · ${resetLabel(bucket.resetTime, now)}` : "";
			lines.push(`  ${bucket.name}: ${quotaBar(bucket.remainingFraction)} ${pct}%${reset}`);
		}
	}
	return lines.join("\n");
}

/** Compact relative countdown until resetTime ("3h 33m", "6d 17h", "now", or ""). */
export function relativeResetLabel(resetTime: string, now: Date = new Date()): string {
	const ts = Date.parse(resetTime);
	if (!Number.isFinite(ts)) return "";
	const delta = ts - now.getTime();
	if (delta <= 0) return "now";
	const totalMin = Math.round(delta / 60_000);
	const days = Math.floor(totalMin / (60 * 24));
	const hours = Math.floor((totalMin % (60 * 24)) / 60);
	const mins = totalMin % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

/** Combined countdown + clock reset label ("resets in 3h 33m (23:15)"). */
export function formatQuotaResetDetail(resetTime: string, now: Date = new Date()): string {
	const rel = relativeResetLabel(resetTime, now);
	if (!rel) return "";
	if (rel === "now") return "resets now";
	const clock = resetLabel(resetTime, now).replace(/^resets\s+/, "");
	return clock ? `resets in ${rel} (${clock})` : `resets in ${rel}`;
}

/** Short row label for a quota bucket inside the GUI modal. */
export function bucketShortLabel(bucket: AgyQuotaBucket): string {
	if (bucket.window === "5h") return "5h limit";
	if (bucket.window === "weekly") return "Weekly";
	return dialogText(bucket.name);
}

/** Compact inline summary for the `/agy` settings row (`Gemini 74%/86% · Claude/GPT 100%`). */
export function formatQuotaInlineSummary(
	report: AgyQuotaReport,
	fetchedAt?: number,
	now: Date = new Date(),
): string {
	if (report.groups.length === 0) return "no data";
	const parts: string[] = [];
	for (const group of report.groups) {
		const short = /gemini/i.test(group.name)
			? "Gemini"
			: /claude|gpt/i.test(group.name)
				? "Claude/GPT"
				: dialogText(group.name).slice(0, 14);
		const buckets = [...group.buckets].sort(
			(a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
		);
		const pcts = buckets.map((b) => `${Math.round(b.remainingFraction * 100)}%`);
		const pctStr =
			pcts.length === 0
				? "?"
				: pcts.every((p) => p === pcts[0])
					? pcts[0]!
					: pcts.join("/");
		parts.push(`${short} ${pctStr}`);
	}
	let summary = parts.join(" · ");
	if (fetchedAt !== undefined) {
		const ageMin = Math.floor((now.getTime() - fetchedAt) / 60_000);
		if (ageMin >= 60) summary += ` (${Math.floor(ageMin / 60)}h ago)`;
		else if (ageMin >= 1) summary += ` (${ageMin}m ago)`;
	}
	return summary;
}

// --- GUI modal ---------------------------------------------------------------

export type QuotaModalAction = "close" | "back" | "accounts";

export interface QuotaModalTheme {
	fg(color: "border" | "muted" | "dim" | "accent" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

export interface QuotaModalState {
	accountLabel: string;
	report?: AgyQuotaReport;
	fetchedAt?: number;
	loading: boolean;
	error?: string;
}

export interface QuotaModalOptions {
	accountLabel: string;
	initial?: { report: AgyQuotaReport; fetchedAt: number };
	fetchQuota?: () => Promise<AgyQuotaReport | undefined>;
	canGoBack?: boolean;
	onFetched?: (report: AgyQuotaReport, fetchedAt: number) => void;
}

function formatUpdatedClock(fetchedAt: number): string {
	const at = new Date(fetchedAt);
	if (Number.isNaN(at.getTime())) return "";
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Pure body lines for the `/agy` quota modal (unit-tested without a terminal). */
export function buildQuotaModalBody(
	state: QuotaModalState,
	width: number,
	theme: QuotaModalTheme,
	now: Date = new Date(),
): string[] {
	const inner = Math.max(20, width - 4);
	const body: string[] = [];

	let statusSuffix = "";
	if (state.loading) {
		statusSuffix = theme.fg("accent", state.report ? " · refreshing…" : " · checking…");
	} else if (state.fetchedAt !== undefined) {
		const hhmm = formatUpdatedClock(state.fetchedAt);
		if (hhmm) statusSuffix = theme.fg("dim", ` · updated ${hhmm}`);
	}

	body.push(` ${theme.fg("muted", "Account:")} ${dialogText(state.accountLabel)}${statusSuffix}`);
	body.push("");

	if (state.error) {
		for (const line of wrapTextWithAnsi(dialogText(state.error), Math.max(20, inner - 1))) {
			body.push(` ${theme.fg("warning", line)}`);
		}
		if (state.report) body.push("");
	}

	if (!state.report && state.loading) {
		body.push(` ${theme.fg("muted", "Checking Antigravity quota via agy /usage… (0 tokens)")}`);
		body.push(` ${theme.fg("dim", "Usually takes ~3-10 seconds. Press Esc to close.")}`);
	}

	if (state.report) {
		for (const group of state.report.groups) {
			body.push(` ${theme.fg("accent", theme.bold(dialogText(group.name)))}`);
			if (group.description) {
				for (const line of wrapTextWithAnsi(dialogText(group.description), Math.max(20, inner - 2))) {
					body.push(`  ${theme.fg("muted", line)}`);
				}
			}
			const buckets = [...group.buckets].sort(
				(a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
			);
			const labelWidth = Math.max(8, ...buckets.map((b) => bucketShortLabel(b).length));
			for (const bucket of buckets) {
				const pct = Math.round(bucket.remainingFraction * 100);
				const color =
					bucket.remainingFraction >= 0.5
						? "success"
						: bucket.remainingFraction >= 0.2
							? "warning"
							: "error";
				const detail = bucket.resetTime ? formatQuotaResetDetail(bucket.resetTime, now) : "";
				const resetPart = detail ? theme.fg("dim", ` · ${detail}`) : "";
				body.push(
					`  ${bucketShortLabel(bucket).padEnd(labelWidth)}  ${theme.fg(color, quotaBar(bucket.remainingFraction))}  ${theme.fg(color, `${pct}%`.padStart(4))}${resetPart}`,
				);
			}
			body.push("");
		}
		if (state.report.description) {
			for (const line of wrapTextWithAnsi(dialogText(state.report.description), Math.max(20, inner - 1))) {
				body.push(` ${theme.fg("dim", line)}`);
			}
		}
	}

	return body;
}

/** Interactive framed TUI overlay showing account-level remaining quota pools. */
export async function showQuotaModal(
	ui: ExtensionUIContext,
	opts: QuotaModalOptions,
): Promise<QuotaModalAction> {
	const footer = opts.canGoBack
		? ([
				"r refresh · a accounts · b back to /agy · esc close",
				"r refresh · a accounts · b back · esc close",
				"r refresh · esc close",
			] as const)
		: ([
				"r refresh · a accounts · esc close",
				"r refresh · esc close",
			] as const);

	return await ui.custom<QuotaModalAction>(
		(host, theme, _kb, done) => {
			const state: QuotaModalState = {
				accountLabel: opts.accountLabel,
				report: opts.initial?.report,
				fetchedAt: opts.initial?.fetchedAt,
				loading: false,
			};
			let closed = false;
			let requestSeq = 0;

			const closeWith = (action: QuotaModalAction) => {
				if (closed) return;
				closed = true;
				done(action);
			};

			const triggerFetch = () => {
				if (!opts.fetchQuota) {
					state.loading = false;
					state.error =
						"agy CLI is not installed. ACP-only setups can install agy (same Google account) to view subscription quota (/agy doctor).";
					host.requestRender();
					return;
				}
				const seq = ++requestSeq;
				state.loading = true;
				state.error = undefined;
				host.requestRender();
				void opts.fetchQuota().then(
					(res) => {
						if (closed || seq !== requestSeq) return;
						state.loading = false;
						if (res === undefined) {
							state.error =
								"Quota unavailable: agy did not return a /usage payload (see /agy doctor for binary health).";
						} else {
							const fetchedAt = Date.now();
							state.report = res;
							state.fetchedAt = fetchedAt;
							state.error = undefined;
							opts.onFetched?.(res, fetchedAt);
						}
						host.requestRender();
					},
					(err) => {
						if (closed || seq !== requestSeq) return;
						state.loading = false;
						state.error = `Quota check failed: ${err instanceof Error ? err.message : String(err)}`;
						host.requestRender();
					},
				);
			};

			if (!opts.initial || Date.now() - opts.initial.fetchedAt > 60_000) {
				triggerFetch();
			}

			return {
				render: (width: number) =>
					frameDialog(
						theme,
						width,
						dialogHeight(host),
						"Antigravity quota",
						buildQuotaModalBody(state, width, theme),
						footer,
					),
				invalidate: () => {},
				handleInput: (data: string) => {
					const lower = data.trim().toLowerCase();
					if (
						matchesKey(data, Key.escape) ||
						matchesKey(data, Key.enter) ||
						matchesKey(data, Key.ctrl("c")) ||
						matchesKey(data, "q") ||
						lower === "q"
					) {
						closeWith("close");
						return;
					}
					if (matchesKey(data, "r") || matchesKey(data, "shift+r") || lower === "r") {
						triggerFetch();
						return;
					}
					if (matchesKey(data, "a") || matchesKey(data, "shift+a") || lower === "a") {
						closeWith("accounts");
						return;
					}
					if (
						opts.canGoBack &&
						(matchesKey(data, "b") ||
							matchesKey(data, "shift+b") ||
							matchesKey(data, Key.backspace) ||
							lower === "b")
					) {
						closeWith("back");
					}
				},
			};
		},
		{ ...DIALOG_OPTIONS, blocked: dialogBlocked("Antigravity quota") },
	);
}
