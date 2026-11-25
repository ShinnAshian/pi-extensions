// Official-CLI generate_image tool for Pi, backed by one-shot `agy` runs.
//
// Mirror of src/web-tools.ts: spawns `agy --agent <temporary> --model <slug>
// [--effort <tier>] --print <prompt> --output-format stream-json
// --dangerously-skip-permissions` with a temporary restricted agent that
// exposes ONLY agy's native `generate_image` tool (confirmed in agy 1.5.17
// init.tools; bridge MCP inheritance off).
//
// 100% official `agy` CLI — zero unofficial OAuth endpoints.
// Generated media is extracted from agy's conversation brain dir
// (~/.gemini/antigravity-cli/brain/<conversationId>/.tempmediaStorage/) via
// src/artifacts.ts, with fallback to paths mentioned in tool events/response,
// then copied into the project output path (.pi/generated-images/ by default).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAgyArtifacts } from "./artifacts.js";
import { agyConversationDir } from "./agy-paths.js";
import { loadConfig } from "./config.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import { detectQuotaNotice, type QuotaNotice } from "./quota-notice.js";
import { redactText } from "./redact.js";
import { sweepStaleWebAgents, webAgentsRoot } from "./web-tools.js";

export const IMAGE_AGENT_PREFIX = "pi-bridge-img-";

const DEADLINE_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;
const MAX_REFERENCE_IMAGES = 4;
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export const ASPECT_RATIOS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface ImageRunOptions {
	prompt: string;
	aspectRatio?: AspectRatio;
	outputPath?: string;
	referenceImages?: string[];
	entries?: AgyModelEntry[];
	bin?: string;
	spawnFn?: typeof spawn;
	agentsRoot?: string;
	homeDir?: string;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onQuotaRotate?: (notice: QuotaNotice) => Promise<{ rotated: boolean; to?: string }>;
	log?: (event: string, data?: unknown, level?: "info" | "warn" | "error") => void;
}

export type ImageRunResult =
	| {
			ok: true;
			path: string;
			mimeType: string;
			bytes: number;
			base64: string;
			conversationId?: string;
			responseText?: string;
			rotatedTo?: string;
	  }
	| { ok: false; error: string };

/** Restricted one-shot agent.md allowing only agy's native `generate_image`. */
export function imageAgentMd(name: string): string {
	return `---\nname: ${name}\ndescription: Temporary Pi image generation delegate\nmainAgent: true\nsubagent: false\nmodel: inherit\nexcludeDefaultComponents: true\ninheritCustomizations: false\ninheritMcp: false\ncommandExecutionPolicy: auto\ntools:\n  - generate_image\nskills: []\nrules: []\nagents: []\nmcpServers: []\n---\n\nFulfill the user's image generation request using ONLY the generate_image tool. Do not attempt any other tool calls. After generating the image, reply concisely with the generated file path.\n`;
}

/** Pick a valid --model (+ optional --effort) from discovered catalog entries. */
export function selectImageDriverModel(entries: AgyModelEntry[] = []): { model: string; effort?: string } {
	const pick =
		entries.find((e) => e.id.includes("flash")) ??
		entries.find((e) => e.id.startsWith("gemini-")) ??
		entries[0];
	if (!pick) return { model: "gemini-3.8-flash", effort: "medium" };
	if (pick.efforts && pick.efforts.length > 0) {
		const tier = pick.efforts.includes("medium")
			? "medium"
			: pick.efforts[0];
		return { model: pick.full, effort: toAgyEffort(tier, pick.efforts) };
	}
	return { model: pick.full };
}

export function mimeTypeForPath(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".bmp":
			return "image/bmp";
		default:
			return "image/png";
	}
}

/** Resolve destination file path for the generated image. */
export function resolveDestinationPath(
	cwd: string,
	requestedPath: string | undefined,
	sourceExt: string,
	now = Date.now(),
): string {
	const ext = ALLOWED_IMAGE_EXTS.has(sourceExt.toLowerCase()) ? sourceExt.toLowerCase() : ".png";
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const rand = randomBytes(3).toString("hex");
	const defaultName = `agy-${stamp}-${rand}${ext}`;

	if (!requestedPath || requestedPath.trim() === "") {
		return path.resolve(cwd, ".pi", "generated-images", defaultName);
	}
	const resolved = path.resolve(cwd, requestedPath.trim());
	const hasImageExt = ALLOWED_IMAGE_EXTS.has(path.extname(resolved).toLowerCase());
	if (hasImageExt) return resolved;
	try {
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			return path.join(resolved, defaultName);
		}
	} catch {
		/* treat as directory path below */
	}
	if (requestedPath.endsWith("/") || requestedPath.endsWith("\\") || !path.extname(resolved)) {
		return path.join(resolved, defaultName);
	}
	return resolved;
}

/** Build the instruction passed to the restricted agy image agent. */
export function buildImagePrompt(opts: {
	prompt: string;
	aspectRatio?: AspectRatio;
	referenceImages?: string[];
}): string {
	const parts: string[] = [
		"Call the generate_image tool to create an image matching the following description.",
	];
	if (opts.aspectRatio) {
		parts.push(`Requested aspect ratio: ${opts.aspectRatio}.`);
	}
	if (opts.referenceImages && opts.referenceImages.length > 0) {
		parts.push("Use these local reference images:");
		for (const ref of opts.referenceImages) {
			parts.push(`- ${ref}`);
		}
	}
	parts.push("", "Prompt:", opts.prompt.trim());
	return parts.join("\n");
}

/** Extract candidate image file paths from arbitrary text (tool output or response). */
export function extractImagePathsFromText(text: string): string[] {
	if (!text) return [];
	const results: string[] = [];
	// Match Windows (C:\... or C:/...) and POSIX (/...) paths ending in an image extension.
	const re = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|`\r\n]+?\.(?:png|jpe?g|webp|gif|bmp)\b/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const candidate = m[0].replace(/[),.;:]+$/, "");
		if (!results.includes(candidate)) results.push(candidate);
	}
	return results;
}

async function runSingleImageAttempt(opts: ImageRunOptions): Promise<
	| { ok: true; sourcePath: string; conversationId?: string; responseText: string }
	| { ok: false; error: string; quota?: QuotaNotice }
> {
	const cwd = opts.cwd ?? process.cwd();
	const homeDir = opts.homeDir ?? os.homedir();
	const root = opts.agentsRoot ?? webAgentsRoot();
	fs.mkdirSync(root, { recursive: true });

	const validatedRefs: string[] = [];
	if (opts.referenceImages && opts.referenceImages.length > 0) {
		for (const ref of opts.referenceImages.slice(0, MAX_REFERENCE_IMAGES)) {
			const abs = path.resolve(cwd, ref);
			if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
				return { ok: false, error: `Reference image not found: ${ref}` };
			}
			validatedRefs.push(abs);
		}
	}

	const agentName = `${IMAGE_AGENT_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const agentDir = path.join(root, agentName);
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "agent.md"), imageAgentMd(agentName), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, ".pid"), `${process.pid}\n`, { mode: 0o600 });

	const bin = opts.bin ?? process.env.AGY_BIN ?? "agy";
	const { model, effort } = selectImageDriverModel(opts.entries);
	const prompt = buildImagePrompt({
		prompt: opts.prompt,
		aspectRatio: opts.aspectRatio,
		referenceImages: validatedRefs,
	});
	const args = [
		"--agent", agentName,
		"--model", model,
		...(effort ? ["--effort", effort] : []),
		"--output-format", "stream-json",
		"--dangerously-skip-permissions",
		`--print=${prompt}`,
	];

	const doSpawn = opts.spawnFn ?? spawn;
	const child = doSpawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const stop = () => {
		if (!child.killed) child.kill();
	};
	const onAbort = () => stop();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(stop, opts.timeoutMs ?? DEADLINE_MS);

	let buffer = "";
	let bytes = 0;
	let stderrTail = "";
	let failed = "";
	let conversationId: string | undefined;
	let imageToolUsed = false;
	let response = "";
	const discoveredPaths: string[] = [];

	const collectPaths = (val: unknown): void => {
		if (typeof val === "string") {
			for (const p of extractImagePathsFromText(val)) {
				if (!discoveredPaths.includes(p)) discoveredPaths.push(p);
			}
		} else if (val && typeof val === "object") {
			try {
				for (const p of extractImagePathsFromText(JSON.stringify(val))) {
					if (!discoveredPaths.includes(p)) discoveredPaths.push(p);
				}
			} catch {
				/* ignore */
			}
		}
	};

	const handleFrame = (line: string): void => {
		if (failed || !line.startsWith("{")) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		const record = frame as Record<string, unknown>;
		if (typeof record.conversation_id === "string" && record.conversation_id) {
			conversationId = record.conversation_id;
		}
		if (record.event === "step_update") {
			const step = record.step_update as Record<string, unknown> | undefined;
			if (typeof step?.conversation_id === "string" && step.conversation_id) {
				conversationId = step.conversation_id;
			}
			const toolName = String(step?.tool_name ?? step?.step_type ?? "");
			if (toolName === "generate_image") {
				imageToolUsed = true;
				collectPaths(step);
			}
		} else if (record.event === "result") {
			const result = record.result as Record<string, unknown> | undefined;
			if (typeof result?.conversation_id === "string" && result.conversation_id) {
				conversationId = result.conversation_id;
			}
			const status = result?.status;
			if (status !== "OK" && status !== "SUCCESS") {
				const errText = typeof result?.error === "string" ? result.error : "";
				failed = errText ? redactText(errText) : `agy image run ended with status ${String(status ?? "unknown")}`;
				return;
			}
			response = typeof result?.response === "string" ? result.response.trim() : "";
			collectPaths(response);
		}
	};

	try {
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES && !failed) {
				failed = "Antigravity image run output exceeded the 4 MiB limit";
				stop();
				return;
			}
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl !== -1 && !failed) {
				handleFrame(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
		});

		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		if (buffer.trim()) handleFrame(buffer.trim());

		if (!failed && opts.signal?.aborted) failed = "image generation aborted";
		if (!failed && response) {
			const quota = detectQuotaNotice(response);
			if (quota) {
				return { ok: false, error: `Antigravity quota reached${quota.resetsIn ? ` (resets in ${quota.resetsIn})` : ""}`, quota };
			}
		}
		if (!failed && code !== 0) {
			const quota = detectQuotaNotice(stderrTail);
			if (quota) {
				return { ok: false, error: `Antigravity quota reached${quota.resetsIn ? ` (resets in ${quota.resetsIn})` : ""}`, quota };
			}
			failed = `agy exited with code ${code}${stderrTail ? `: ${redactText(stderrTail.trim()).slice(-300)}` : ""}`;
		}
		if (failed) {
			opts.log?.("image-run-failed", { agent: agentName, error: failed }, "warn");
			return { ok: false, error: failed };
		}

		// Locate generated image: prefer agy's .tempmediaStorage artifact scan, then explicit paths.
		let sourcePath: string | undefined;
		if (conversationId) {
			const convDir = agyConversationDir("stream-json", conversationId, homeDir);
			const artifacts = await listAgyArtifacts(convDir);
			const generated = artifacts
				.filter((a) => a.mediaType === "image" && a.kind === "generated")
				.sort((a, b) => b.modifiedMs - a.modifiedMs);
			const anyImg = artifacts
				.filter((a) => a.mediaType === "image" && a.kind !== "uploaded")
				.sort((a, b) => b.modifiedMs - a.modifiedMs);
			sourcePath = generated[0]?.absolutePath ?? anyImg[0]?.absolutePath;
		}
		if (!sourcePath) {
			for (const candidate of discoveredPaths) {
				try {
					if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
						sourcePath = candidate;
						break;
					}
				} catch {
					/* try next */
				}
			}
		}
		if (!sourcePath) {
			const detail = imageToolUsed
				? "generate_image ran but no image file was found in agy's media storage or response."
				: "Antigravity did not invoke generate_image or produce an image file.";
			return { ok: false, error: response ? `${detail} Response: ${response.slice(0, 300)}` : detail };
		}

		opts.log?.("image-run-ok", { agent: agentName, conversationId, sourcePath });
		return { ok: true, sourcePath, conversationId, responseText: response };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		opts.log?.("image-run-failed", { agent: agentName, error: message }, "warn");
		return { ok: false, error: message };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		stop();
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

/** Run one-shot image generation via official `agy`, with optional single retry on account rotation. */
export async function runImageAgent(opts: ImageRunOptions): Promise<ImageRunResult> {
	const trimmed = opts.prompt.trim();
	if (!trimmed) return { ok: false, error: "prompt must not be empty" };
	if (trimmed.length > MAX_PROMPT_CHARS) {
		return { ok: false, error: `prompt exceeds ${MAX_PROMPT_CHARS} character limit` };
	}

	let rotatedTo: string | undefined;
	let attempt = await runSingleImageAttempt({ ...opts, prompt: trimmed });
	if (!attempt.ok && attempt.quota && opts.onQuotaRotate) {
		const rot = await opts.onQuotaRotate(attempt.quota);
		if (rot.rotated) {
			rotatedTo = rot.to;
			attempt = await runSingleImageAttempt({ ...opts, prompt: trimmed });
		}
	}
	if (!attempt.ok) return { ok: false, error: attempt.error };

	const cwd = opts.cwd ?? process.cwd();
	const destPath = resolveDestinationPath(cwd, opts.outputPath, path.extname(attempt.sourcePath));
	fs.mkdirSync(path.dirname(destPath), { recursive: true });
	fs.copyFileSync(attempt.sourcePath, destPath);
	const buf = fs.readFileSync(destPath);
	const mimeType = mimeTypeForPath(destPath);

	return {
		ok: true,
		path: destPath,
		mimeType,
		bytes: buf.length,
		base64: buf.toString("base64"),
		conversationId: attempt.conversationId,
		responseText: attempt.responseText,
		rotatedTo,
	};
}

export interface RegisterImageToolOptions {
	bin?: string;
	entries?: AgyModelEntry[];
	onQuotaRotate?: (notice: QuotaNotice) => Promise<{ rotated: boolean; to?: string }>;
	log?: (event: string, data?: unknown, level?: "info" | "warn" | "error") => void;
}

/** Register the `generate_image` tool in Pi, backed by official `agy` CLI. */
export function registerImageTool(pi: ExtensionAPI, opts: RegisterImageToolOptions = {}): void {
	sweepStaleWebAgents(webAgentsRoot(), Date.now(), IMAGE_AGENT_PREFIX);

	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image via the official Antigravity CLI (agy), optionally guided by local reference images. Saves under .pi/generated-images/ unless path is set.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Image description." }),
			aspectRatio: Type.Optional(
				Type.Union(ASPECT_RATIOS.map((r) => Type.Literal(r)), {
					description: "Optional aspect ratio (e.g. 1:1, 16:9, 9:16).",
				}),
			),
			path: Type.Optional(
				Type.String({ description: "Project-relative file or directory to save the image." }),
			),
			referenceImages: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional local reference image paths to guide generation (up to 4).",
				}),
			),
		}),
		async execute(_id, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as {
				prompt: string;
				aspectRatio?: AspectRatio;
				path?: string;
				referenceImages?: string[];
			};
			const result = await runImageAgent({
				prompt: params.prompt,
				aspectRatio: params.aspectRatio,
				outputPath: params.path,
				referenceImages: params.referenceImages,
				entries: opts.entries,
				bin: opts.bin,
				cwd: ctx?.cwd ?? process.cwd(),
				signal,
				onQuotaRotate: loadConfig().autoRotateAccounts ? opts.onQuotaRotate : undefined,
				log: opts.log,
			});
			if (!result.ok) {
				throw new Error(result.error);
			}
			const relPath = path.relative(ctx?.cwd ?? process.cwd(), result.path) || result.path;
			const rotNote = result.rotatedTo ? ` (rotated account -> ${result.rotatedTo})` : "";
			return {
				content: [
					{
						type: "text",
						text: `Generated image saved to ${relPath} (${result.mimeType}, ${result.bytes} bytes)${rotNote}.`,
					},
					{
						type: "image",
						data: result.base64,
						mimeType: result.mimeType,
					},
				],
				details: {
					path: result.path,
					relativePath: relPath,
					mimeType: result.mimeType,
					bytes: result.bytes,
					conversationId: result.conversationId,
					rotatedTo: result.rotatedTo,
				},
			};
		},
	});
}
