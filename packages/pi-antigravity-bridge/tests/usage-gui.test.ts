import assert from "node:assert/strict";
import { test } from "vitest";
import {
	buildQuotaModalBody,
	formatQuotaInlineSummary,
	formatQuotaResetDetail,
	parseAgyUsageJson,
	relativeResetLabel,
	type AgyQuotaReport,
	type QuotaModalTheme,
} from "../src/usage.js";

const mockTheme: QuotaModalTheme = {
	fg: (color, text) => `[${color}:${text}]`,
	bold: (text) => `*${text}*`,
};

const SAMPLE_PAYLOAD = JSON.stringify({
	status: "SUCCESS",
	command: {
		name: "usage",
		data: {
			description: "Within each group, models share a weekly limit and a 5-hour limit.",
			groups: [
				{
					name: "Gemini Models",
					description: "Models within this group: Gemini 4 Neon, Gemini 4 Flash",
					buckets: [
						{
							id: "gemini-weekly",
							name: "Weekly Limit Remaining",
							description: "Resets weekly",
							window: "weekly",
							remaining_fraction: 0.86,
							reset_time: "2026-12-02T13:15:00Z",
						},
						{
							id: "gemini-5h",
							name: "Five Hour Limit Remaining",
							description: "Resets every 5h",
							window: "5h",
							remaining_fraction: 0.74,
							reset_time: "2026-11-25T23:15:00Z",
						},
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{
							id: "3p-weekly",
							name: "Weekly Limit Remaining",
							window: "weekly",
							remaining_fraction: 1,
							reset_time: "2026-12-02T19:41:00Z",
						},
						{
							id: "3p-5h",
							name: "Five Hour Limit Remaining",
							window: "5h",
							remaining_fraction: 1,
							reset_time: "2026-11-26T00:41:00Z",
						},
					],
				},
			],
		},
	},
});

test("parseAgyUsageJson preserves optional report and bucket descriptions", () => {
	const report = parseAgyUsageJson(SAMPLE_PAYLOAD);
	assert.equal(report.description, "Within each group, models share a weekly limit and a 5-hour limit.");
	assert.equal(report.groups[0]?.buckets[0]?.description, "Resets weekly");

	const minimal = parseAgyUsageJson(
		JSON.stringify({
			status: "SUCCESS",
			command: {
				name: "usage",
				data: {
					groups: [{ name: "G", buckets: [{ name: "B", window: "5h", remaining_fraction: 0.5 }] }],
				},
			},
		}),
	);
	assert.equal(minimal.description, undefined);
	assert.equal(minimal.groups[0]?.buckets[0]?.description, undefined);
});

test("relativeResetLabel formats past, minutes, hours, days, and invalid inputs", () => {
	const now = new Date("2026-11-25T19:42:00Z");
	assert.equal(relativeResetLabel("2026-11-25T19:40:00Z", now), "now");
	assert.equal(relativeResetLabel("2026-11-25T20:27:00Z", now), "45m");
	assert.equal(relativeResetLabel("2026-11-25T23:15:00Z", now), "3h 33m");
	assert.equal(relativeResetLabel("2026-12-02T12:42:00Z", now), "6d 17h");
	assert.equal(relativeResetLabel("not-a-date", now), "");
});

test("formatQuotaResetDetail formats same-day, future-day, past, and invalid inputs", () => {
	const now = new Date(2026, 10, 25, 19, 42, 0);
	const sameDay = new Date(2026, 10, 25, 23, 15, 0).toISOString();
	assert.equal(formatQuotaResetDetail(sameDay, now), "resets in 3h 33m (23:15)");

	const futureDay = new Date(2026, 11, 2, 12, 42, 0).toISOString();
	assert.equal(formatQuotaResetDetail(futureDay, now), "resets in 6d 17h (12:42 on 2 Dec)");

	const past = new Date(2026, 10, 25, 19, 0, 0).toISOString();
	assert.equal(formatQuotaResetDetail(past, now), "resets now");
	assert.equal(formatQuotaResetDetail("garbage", now), "");
});

test("formatQuotaInlineSummary summarizes groups and age suffix", () => {
	const report = parseAgyUsageJson(SAMPLE_PAYLOAD);
	const now = new Date("2026-11-25T20:00:00Z");
	assert.equal(formatQuotaInlineSummary(report, now.getTime() - 20_000, now), "Gemini 74%/86% · Claude/GPT 100%");
	assert.equal(
		formatQuotaInlineSummary(report, now.getTime() - 5 * 60_000, now),
		"Gemini 74%/86% · Claude/GPT 100% (5m ago)",
	);
	assert.equal(
		formatQuotaInlineSummary(report, now.getTime() - 120 * 60_000, now),
		"Gemini 74%/86% · Claude/GPT 100% (2h ago)",
	);
	assert.equal(formatQuotaInlineSummary({ groups: [] }), "no data");
});

test("buildQuotaModalBody handles loading, cached+refreshing, full report colors, and errors", () => {
	const loadingOnly = buildQuotaModalBody(
		{ accountLabel: "1 (user@example.com)", loading: true },
		80,
		mockTheme,
	).join("\n");
	assert.match(loadingOnly, /checking…/);
	assert.match(loadingOnly, /Checking Antigravity quota/);

	const report: AgyQuotaReport = {
		description: "Shared quota note.",
		groups: [
			{
				name: "Gemini Models",
				description: "Models within this group: Gemini 4 Neon, Gemini 4 Flash, Gemini 4 Carbon",
				buckets: [
					{ name: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.35, resetTime: "2026-11-26T20:00:00Z" },
					{ name: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.1, resetTime: "2026-11-25T21:00:00Z" },
				],
			},
			{
				name: "Claude and GPT models",
				buckets: [
					{ name: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.9, resetTime: "2026-11-25T22:00:00Z" },
				],
			},
		],
	};

	const now = new Date("2026-11-25T19:42:00Z");
	const cachedRefreshing = buildQuotaModalBody(
		{
			accountLabel: "1 (user@example.com)",
			report,
			fetchedAt: now.getTime() - 120_000,
			loading: true,
		},
		80,
		mockTheme,
		now,
	).join("\n");
	assert.match(cachedRefreshing, /refreshing…/);
	assert.match(cachedRefreshing, /5h limit/);
	assert.match(cachedRefreshing, /Weekly/);

	const rendered = buildQuotaModalBody(
		{
			accountLabel: "1 (user@example.com)",
			report,
			fetchedAt: now.getTime(),
			loading: false,
		},
		60,
		mockTheme,
		now,
	).join("\n");
	const fiveIdx = rendered.indexOf("5h limit");
	const weeklyIdx = rendered.indexOf("Weekly");
	assert.ok(fiveIdx !== -1 && weeklyIdx !== -1 && fiveIdx < weeklyIdx);
	assert.match(rendered, /\[error:/);
	assert.match(rendered, /\[warning:/);
	assert.match(rendered, /\[success:/);
	assert.match(rendered, /Shared quota note\./);

	const withError = buildQuotaModalBody(
		{
			accountLabel: "1 (user@example.com)",
			report,
			loading: false,
			error: "Quota unavailable: agy did not return a /usage payload.",
		},
		80,
		mockTheme,
		now,
	).join("\n");
	assert.match(withError, /\[warning:Quota unavailable:/);
	assert.match(withError, /5h limit/);

	const errorOnly = buildQuotaModalBody(
		{
			accountLabel: "1 (user@example.com)",
			loading: false,
			error: "agy CLI is not installed.",
		},
		80,
		mockTheme,
		now,
	).join("\n");
	assert.match(errorOnly, /\[warning:agy CLI is not installed\./);
});
