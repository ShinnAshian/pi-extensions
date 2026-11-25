// Unit tests for Pi 1.6 codemode catalog descriptions, priority notes, and compression rotation.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { codemodeCatalog, codemodeNestedTools, type BridgeToolInfo } from "../src/bridge-catalog.js";
import { buildCodemodeBridgeDescription } from "../src/codemode-description.js";
import { buildCodemodePriorityNote, buildContextDigest, shouldRotateOnTranscriptShrink } from "../src/provider.js";
import type { AgySession } from "../src/sessions.js";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("buildCodemodeBridgeDescription", () => {
	it("renders Nested tools TS declarations, excludes direct tools, and is idempotent", () => {
		const tools: BridgeToolInfo[] = [
			{
				name: "codemode",
				description: "Run JS.",
				parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
			},
			{
				name: "ask_user_question",
				description: "Ask user.",
				parameters: { type: "object", properties: { questions: { type: "array" } }, required: ["questions"] },
			},
			{
				name: "read",
				description: "Read a file from disk.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "File path" }, offset: { type: "number" } },
					required: ["path"],
				},
				promptGuidelines: ["Use read instead of cat."],
			},
			{
				name: "my-custom-tool",
				description: "Hyphenated tool.",
				parameters: { type: "object", properties: { mode: { enum: ["fast", "deep"] } }, required: ["mode"] },
				namespace: { name: "ext", description: "Extra tools" },
			},
		];

		const out = buildCodemodeBridgeDescription("Base codemode docs.", tools, {
			inlineBudget: 4000,
			excludeNames: new Set(["codemode", "ask_user_question"]),
		});
		assert.match(out, /Nested tools:/);
		assert.match(out, /### `read`/);
		assert.ok(out.includes("declare const tools: { read(args: {"));
		assert.match(out, /path: string;/);
		assert.ok(out.includes("offset?: number;"));
		assert.match(out, /Use read instead of cat\./);
		assert.ok(out.includes("### `my_custom_tool` (`my-custom-tool`)"));
		assert.doesNotMatch(out, /### `codemode`/);
		assert.doesNotMatch(out, /### `ask_user_question`/);

		assert.equal(buildCodemodeBridgeDescription(out, tools, { inlineBudget: 4000 }), out);
	});

	it("truncates within tight inlineBudget and appends unlisted summary", () => {
		const many: BridgeToolInfo[] = Array.from({ length: 30 }, (_, i) => ({
			name: `tool_${i}`,
			description: "Description ".repeat(25) + `#${i}`,
			parameters: { type: "object", properties: { arg: { type: "string" } }, required: ["arg"] },
			namespace: i % 2 === 0 ? { name: "ns_a" } : { name: "ns_b" },
		}));
		const tight = buildCodemodeBridgeDescription("Base.", many, { inlineBudget: 250 });
		assert.match(tight, /Nested tools:/);
		assert.match(tight, /Unlisted nested tools \(/);
		assert.ok(tight.length < 3000);
	});
});

describe("codemodeNestedTools and codemodeCatalog", () => {
	it("filters nested tools by exposure and emits pure catalog with direct tools", () => {
		const pool: BridgeToolInfo[] = [
			{ name: "codemode", description: "Base", parameters: { type: "object" }, exposure: "direct" },
			{ name: "ask_user_question", description: "Ask", parameters: { type: "object" }, exposure: "direct" },
			{ name: "read", description: "Read", parameters: { type: "object" }, exposure: "codemode" },
			{ name: "bash", description: "Bash", parameters: { type: "object" }, exposure: "direct" },
			{ name: "secret_tool", description: "Hidden", parameters: { type: "object" }, exposure: "hidden" },
			{ name: "lazy_tool", description: "Deferred", parameters: { type: "object" }, exposure: "deferred" },
			{ name: "ui_only", description: "Model only", parameters: { type: "object" }, exposure: "model-only" },
		];

		const nested = codemodeNestedTools(pool, ["codemode", "ask_user_question"], new Set(["ui_only"]));
		assert.deepEqual(nested.map((t) => t.name), ["ask_user_question", "read"]);

		const authorized = pool.filter((t) => t.name === "codemode" || t.name === "ask_user_question");
		const cat = codemodeCatalog(authorized, {
			directTools: ["ask_user_question"],
			pure: true,
			inlineBudget: 4000,
			nestedTools: nested,
		});
		assert.deepEqual(cat.direct.map((d) => d.name), ["codemode", "ask_user_question"]);
		assert.deepEqual(cat.proxied, []);
		assert.match(cat.direct[0]!.description, /Nested tools:/);
		assert.match(cat.direct[0]!.description, /### `read`/);
		assert.doesNotMatch(cat.direct[0]!.description, /### `ask_user_question`/);
	});

	it("formats buildCodemodePriorityNote for pure and non-pure modes", () => {
		const pure = buildCodemodePriorityNote({ pure: true, directTools: ["ask_user_question"] });
		assert.match(pure, /Direct MCP tools available alongside codemode: ask_user_question/);
		assert.match(pure, /ALL_TOOLS, await searchTools\(query\), and await describeTool\(name\)/);
		assert.doesNotMatch(pure, /bridge_tool_info/);

		const nonPure = buildCodemodePriorityNote({ pure: false, directTools: [] });
		assert.match(nonPure, /bridge_tool_info \/ bridge_call_tool/);
	});
});

describe("external context compression rotation and digest preservation", () => {
	it("rotates bound conversations on shrink or boundary rewrite with compress anchor", () => {
		const rec: AgySession = {
			conversationId: "conv-1",
			lastStepIdx: 0,
			lastMessageCount: 3,
			digestBoundary: "user:300",
		};
		const m1: Message = { role: "user", content: "a", timestamp: 100 };
		const m2: Message = { role: "user", content: "b", timestamp: 200 };
		const m3: Message = { role: "user", content: "c", timestamp: 300 };
		const compressResult: Message = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "codemode",
			content: [{ type: "text", text: "▣ ACP | compressed 30k -> 3k" }],
			isError: false,
			timestamp: 350,
		};

		assert.equal(shouldRotateOnTranscriptShrink(rec, [m1, m2, m3]), false);
		assert.equal(shouldRotateOnTranscriptShrink(rec, [m1, m2]), true);
		assert.equal(shouldRotateOnTranscriptShrink(rec, [m1, m2, compressResult, m3]), true);
		assert.equal(shouldRotateOnTranscriptShrink({ conversationId: "conv-1", lastStepIdx: 0, lastMessageCount: 2 }, [m1, m2, m3]), false);
	});

	it("preserves long compress summaries beyond TOOL_CALL_ARGS_CAP in digests", () => {
		const longSummary = "DECISION: keep changes minimal. ".repeat(15) + "UNIQUE_SENTINEL_991";
		const messages: Message[] = [
			{ role: "user", content: "Start task", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "compress",
						arguments: { content: [{ topic: "Phase 1", startId: "m00001", endId: "m00020", summary: longSummary }] },
					},
					{
						type: "toolCall",
						id: "tc2",
						name: "codemode",
						arguments: { code: `await tools.compress({ content: [{ startId: "m00021", endId: "m00040", summary: "CODEMODE_SENTINEL_777 ${"x".repeat(350)}" }] });` },
					},
				],
				api: "agy-bridge",
				provider: "antigravity",
				model: "gemini",
				usage: zeroUsage(),
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "tc1", toolName: "compress", content: [{ type: "text", text: "▣ ACP | compressed" }], isError: false, timestamp: 3 },
			{ role: "user", content: "Continue", timestamp: 4 },
		];
		const digest = buildContextDigest(messages, 0, { bound: false });
		assert.ok(digest.includes("UNIQUE_SENTINEL_991"));
		assert.ok(digest.includes("CODEMODE_SENTINEL_777"));
	});
});
