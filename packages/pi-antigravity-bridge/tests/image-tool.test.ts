// Unit tests for pure helpers in src/image-tool.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	buildImagePrompt,
	extractImagePathsFromText,
	imageAgentMd,
	mimeTypeForPath,
	resolveDestinationPath,
	selectImageDriverModel,
} from "../src/image-tool.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	}
});

describe("image-tool helpers", () => {
	it("builds restricted agent.md exposing only generate_image", () => {
		const md = imageAgentMd("pi-bridge-img-test");
		assert.match(md, /name: pi-bridge-img-test/);
		assert.match(md, /inheritMcp: false/);
		assert.match(md, /tools:\n  - generate_image/);
	});

	it("selects flash model with full agy slug and clamped effort", () => {
		assert.deepEqual(selectImageDriverModel([]), { model: "gemini-3.8-flash", effort: "medium" });
		assert.deepEqual(
			selectImageDriverModel([
				{ id: "gemini-3-1-pro", full: "gemini-3.1-pro", efforts: ["low", "high"] },
				{ id: "gemini-3-8-flash", full: "gemini-3.8-flash", efforts: ["low", "medium", "high"] },
			]),
			{ model: "gemini-3.8-flash", effort: "medium" },
		);
		assert.deepEqual(
			selectImageDriverModel([{ id: "custom-img", full: "custom-img" }]),
			{ model: "custom-img" },
		);
	});

	it("maps image MIME types and resolves destination paths", () => {
		assert.equal(mimeTypeForPath("a.jpg"), "image/jpeg");
		assert.equal(mimeTypeForPath("a.webp"), "image/webp");
		assert.equal(mimeTypeForPath("a.unknown"), "image/png");

		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-img-dest-"));
		tmpDirs.push(cwd);
		const now = Date.UTC(2026, 10, 25, 12, 0, 0);

		const defPath = resolveDestinationPath(cwd, undefined, ".webp", now);
		assert.ok(defPath.startsWith(path.join(cwd, ".pi", "generated-images")));
		assert.ok(defPath.endsWith(".webp"));

		const explicit = resolveDestinationPath(cwd, "assets/banner.jpg", ".png", now);
		assert.equal(explicit, path.resolve(cwd, "assets/banner.jpg"));

		const dirOut = resolveDestinationPath(cwd, "assets/out-dir", ".png", now);
		assert.equal(path.dirname(dirOut), path.resolve(cwd, "assets/out-dir"));
		assert.ok(dirOut.endsWith(".png"));
	});

	it("formats buildImagePrompt and extracts paths from text", () => {
		const prompt = buildImagePrompt({
			prompt: "A minimal logo",
			aspectRatio: "16:9",
			referenceImages: ["/tmp/ref1.png"],
		});
		assert.match(prompt, /Requested aspect ratio: 16:9\./);
		assert.match(prompt, /- \/tmp\/ref1\.png/);
		assert.match(prompt, /Prompt:\nA minimal logo/);

		const extracted = extractImagePathsFromText("Saved at /var/tmp/out.png and C:\\work\\img.webp.");
		assert.deepEqual(extracted, ["/var/tmp/out.png", "C:\\work\\img.webp"]);
	});
});
