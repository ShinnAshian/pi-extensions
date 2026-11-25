// Unit tests for multi-account keyring store and quota rotation (src/accounts.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	autoAccountName,
	clearActiveCredential,
	formatAccountsList,
	listSavedAccounts,
	parseResetDurationMs,
	removeSavedAccount,
	rotateAccountOnQuota,
	saveCurrentAccount,
	switchAccount,
	type KeyringBackend,
} from "../src/accounts.js";

const dirs: string[] = [];

function makeEnv(initialActive: Buffer | null = Buffer.from('{"token":"a"}')) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-accounts-test-"));
	dirs.push(dir);
	const storeFile = path.join(dir, "accounts.json");
	let active: Buffer | null = initialActive;
	const backend: KeyringBackend = {
		readActive: () => active,
		writeActive: (raw) => {
			active = Buffer.from(raw);
		},
		deleteActive: () => {
			const had = active !== null;
			active = null;
			return had;
		},
		protect: (raw) => ({ encoding: "raw-base64", payload: raw.toString("base64") }),
		unprotect: (blob) => Buffer.from(blob.payload, "base64"),
	};
	return {
		storeFile,
		backend,
		homeDir: dir,
		getActive: () => active,
		setActive: (buf: Buffer | null) => {
			active = buf;
		},
	};
}

afterEach(() => {
	while (dirs.length > 0) {
		const d = dirs.pop()!;
		fs.rmSync(d, { recursive: true, force: true });
	}
});

describe("accounts store and rotation", () => {
	it("auto-numbers slots, fills gaps, and reuses same-email slot case-insensitively", async () => {
		const env = makeEnv(Buffer.from('{"email":"userA@example.com"}'));
		const s1 = await saveCurrentAccount(undefined, { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir });
		assert.equal(s1.name, "1");
		assert.equal(s1.email, "userA@example.com");

		env.setActive(Buffer.from('{"email":"userB@example.com"}'));
		const s2 = await saveCurrentAccount(undefined, { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir });
		assert.equal(s2.name, "2");

		env.setActive(Buffer.from('{"email":"USERA@EXAMPLE.COM","token":"refreshed"}'));
		const s1Again = await saveCurrentAccount(undefined, { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir });
		assert.equal(s1Again.name, "1");

		env.setActive(Buffer.from('{"email":"work@example.com"}'));
		const named = await saveCurrentAccount("work", { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir });
		assert.equal(named.name, "work");
		assert.equal(listSavedAccounts({ storeFile: env.storeFile }).accounts.length, 3);
		assert.equal(autoAccountName([
			{ name: "1", savedAt: "", encoding: "raw-base64", payload: "" },
			{ name: "3", savedAt: "", encoding: "raw-base64", payload: "" },
		]), "2");
	});

	it("throws when saving without an active credential or with an invalid name", async () => {
		const env = makeEnv(null);
		await assert.rejects(
			saveCurrentAccount("bad/name", { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir }),
			/Invalid account name/,
		);
		await assert.rejects(
			saveCurrentAccount(undefined, { storeFile: env.storeFile, backend: env.backend, homeDir: env.homeDir }),
			/No active agy credential/,
		);
	});

	it("switches, removes, and clears active credentials", async () => {
		const env = makeEnv(Buffer.from("cred-one"));
		await saveCurrentAccount("one", { storeFile: env.storeFile, backend: env.backend, email: "one@x.com", homeDir: env.homeDir });
		env.setActive(Buffer.from("cred-two"));
		await saveCurrentAccount("two", { storeFile: env.storeFile, backend: env.backend, email: "two@x.com", homeDir: env.homeDir });

		const switched = await switchAccount("one", { storeFile: env.storeFile, backend: env.backend });
		assert.equal(switched.name, "one");
		assert.equal(env.getActive()?.toString("utf8"), "cred-one");
		assert.equal(listSavedAccounts({ storeFile: env.storeFile }).active, "one");

		assert.equal(removeSavedAccount("one", { storeFile: env.storeFile }), true);
		assert.equal(removeSavedAccount("missing", { storeFile: env.storeFile }), false);
		assert.equal(listSavedAccounts({ storeFile: env.storeFile }).active, undefined);

		assert.equal(await clearActiveCredential({ backend: env.backend }), true);
		assert.equal(env.getActive(), null);
	});

	it("rotates across non-cooling slots on quota notice and detects all-in-cooldown", async () => {
		const env = makeEnv(Buffer.from("cred-1"));
		const t0 = 1_700_000_000_000;
		await saveCurrentAccount("1", { storeFile: env.storeFile, backend: env.backend, email: "a@x.com", homeDir: env.homeDir, now: t0 });
		env.setActive(Buffer.from("cred-2"));
		await saveCurrentAccount("2", { storeFile: env.storeFile, backend: env.backend, email: "b@x.com", homeDir: env.homeDir, now: t0 });
		await switchAccount("1", { storeFile: env.storeFile, backend: env.backend, now: t0 });

		const rot1 = await rotateAccountOnQuota({ resetsIn: "1h", storeFile: env.storeFile, backend: env.backend, now: t0 + 1000 });
		assert.equal(rot1.rotated, true);
		assert.equal(rot1.from, "1");
		assert.equal(rot1.to, "2");
		assert.equal(env.getActive()?.toString("utf8"), "cred-2");

		const rot2 = await rotateAccountOnQuota({ resetsIn: "30m", storeFile: env.storeFile, backend: env.backend, now: t0 + 2000 });
		assert.equal(rot2.rotated, false);
		assert.equal(rot2.reason, "all-in-cooldown");

		const listed = listSavedAccounts({ storeFile: env.storeFile });
		const rendered = formatAccountsList(listed, true, t0 + 2000);
		assert.match(rendered, /\* 2 \(b@x\.com\)/);
		assert.match(rendered, /cooldown ~/);
	});

	it("parses reset duration strings with bounds", () => {
		assert.equal(parseResetDurationMs("1h30m10s"), ((90 * 60) + 10) * 1000);
		assert.equal(parseResetDurationMs("invalid"), 30 * 60 * 1000);
		assert.equal(parseResetDurationMs("9999h"), 7 * 24 * 60 * 60 * 1000);
	});
});
