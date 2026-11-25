// Multi-account management for the official `agy` CLI keyring credential.
//
// Empirical ground truth (verified on agy 1.5.17 / Windows):
//   - `agy` ignores --gemini-dir for OAuth tokens and stores its active Google
//     OAuth credential in the OS native keyring under service "gemini", account
//     "antigravity" (Windows Credential Manager Generic target "gemini:antigravity",
//     Type=1, Persist=2, UserName="antigravity", raw UTF-8 JSON blob).
//   - Saved account slots live in <agentDir>/antigravity-bridge/accounts.json.
//     On Windows each slot's credential bytes are DPAPI-encrypted for the
//     current user (DataProtectionScope.CurrentUser) so no plaintext token ever
//     touches disk. On macOS/Linux the vault is written with 0600 permissions.
//   - Secrets are passed to OS keyring helpers via stdin (never argv).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { bridgeDir } from "./config.js";

export const KEYRING_SERVICE = "gemini";
export const KEYRING_ACCOUNT = "antigravity";
export const WIN32_TARGET = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;

const ACCOUNT_NAME_RE = /^[a-zA-Z0-9._-]{1,40}$/;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type AccountEncoding = "win32-dpapi" | "raw-base64";

export interface SavedAccount {
	name: string;
	email?: string;
	savedAt: string;
	lastUsedAt?: string;
	/** Epoch ms until which auto-rotation skips this slot after quota exhaustion. */
	cooldownUntil?: number;
	encoding: AccountEncoding;
	/** DPAPI-protected base64 on win32; raw base64 (0600 file) on POSIX. */
	payload: string;
}

export interface AccountsStoreData {
	version: 1;
	active?: string;
	accounts: SavedAccount[];
}

export interface ProtectedBlob {
	encoding: AccountEncoding;
	payload: string;
}

/** Injectable OS keyring + encryption seam for deterministic unit testing. */
export interface KeyringBackend {
	readActive(): Promise<Buffer | null> | Buffer | null;
	writeActive(raw: Buffer): Promise<void> | void;
	deleteActive(): Promise<boolean> | boolean;
	protect(raw: Buffer): Promise<ProtectedBlob> | ProtectedBlob;
	unprotect(blob: ProtectedBlob): Promise<Buffer> | Buffer;
}

export interface AccountOpOptions {
	storeFile?: string;
	backend?: KeyringBackend;
	homeDir?: string;
	now?: number;
}

export interface RotateResult {
	rotated: boolean;
	from?: string;
	to?: string;
	email?: string;
	reason?: "no-accounts" | "single-account" | "all-in-cooldown" | "error";
	error?: string;
}

export function accountsPath(agentDir?: string): string {
	return path.join(bridgeDir(agentDir), "accounts.json");
}

export function isValidAccountName(name: string): boolean {
	return ACCOUNT_NAME_RE.test(name);
}

/** Parse agy's reset interval string (e.g. "153h38m14s", "45m", "30s") into ms. */
export function parseResetDurationMs(resetsIn?: string): number {
	if (!resetsIn) return DEFAULT_COOLDOWN_MS;
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(resetsIn.trim());
	if (!m || (!m[1] && !m[2] && !m[3])) return DEFAULT_COOLDOWN_MS;
	const hours = m[1] ? Number(m[1]) : 0;
	const mins = m[2] ? Number(m[2]) : 0;
	const secs = m[3] ? Number(m[3]) : 0;
	const total = ((hours * 60 + mins) * 60 + secs) * 1000;
	if (!Number.isFinite(total) || total <= 0) return DEFAULT_COOLDOWN_MS;
	return Math.min(total, MAX_COOLDOWN_MS);
}

/** Best-effort discovery of the active Google email from agy's recent CLI logs. */
export function detectActiveAccountEmail(homeDir: string = os.homedir()): string | undefined {
	const cliDir = path.join(homeDir, ".gemini", "antigravity-cli");
	// Newest first across cli-*, acp-login-* and acp-server-* logs: a fresh
	// `agy acp --login` only writes its email to acp-login-*.log.
	const logDir = path.join(cliDir, "log");
	let files: string[] = [];
	try {
		files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log")).map((f) => path.join(logDir, f));
	} catch {
		/* no log dir yet */
	}
	const mtime = (f: string): number => {
		try {
			return fs.statSync(f).mtimeMs;
		} catch {
			return 0;
		}
	};
	const candidates = [path.join(cliDir, "cli.log"), ...files]
		.map((f) => ({ f, t: mtime(f) }))
		.filter((c) => c.t > 0)
		.sort((a, b) => b.t - a.t)
		.slice(0, 8)
		.map((c) => c.f);

	const emailRe = /applyAuthResult:\s*email=([^,\s]+@[^,\s]+)/g;
	for (const file of candidates) {
		try {
			const text = fs.readFileSync(file, "utf8");
			let last: string | undefined;
			let match: RegExpExecArray | null;
			while ((match = emailRe.exec(text)) !== null) {
				last = match[1];
			}
			if (last) return last;
		} catch {
			/* try next */
		}
	}
	return undefined;
}

/** Try extracting an email field from the keyring JSON payload if present. */
export function emailFromCredentialBytes(raw: Buffer): string | undefined {
	try {
		const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		for (const key of ["email", "user_email", "account", "account_email"]) {
			const v = parsed[key];
			if (typeof v === "string" && v.includes("@")) return v.trim();
		}
	} catch {
		/* opaque or non-JSON blob */
	}
	return undefined;
}

// --- Windows WinCred + DPAPI backend ----------------------------------------

const WIN32_CRED_CS = `
using System;
using System.Runtime.InteropServices;

public static class PiAgyWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr cred);

    public static string ReadBase64(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return "";
            throw new InvalidOperationException("CredRead failed with Win32 error " + err);
        }
        try {
            CREDENTIAL c = Marshal.PtrToStructure<CREDENTIAL>(ptr);
            byte[] buf = new byte[(int)c.CredentialBlobSize];
            if (buf.Length > 0) Marshal.Copy(c.CredentialBlob, buf, 0, buf.Length);
            return Convert.ToBase64String(buf);
        } finally {
            CredFree(ptr);
        }
    }

    public static void WriteBase64(string target, string userName, string b64) {
        byte[] buf = Convert.FromBase64String(b64);
        IntPtr mem = Marshal.AllocCoTaskMem(buf.Length);
        try {
            if (buf.Length > 0) Marshal.Copy(buf, 0, mem, buf.Length);
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1;
            c.TargetName = target;
            c.UserName = userName;
            c.CredentialBlobSize = (uint)buf.Length;
            c.CredentialBlob = mem;
            c.Persist = 2;
            if (!CredWrite(ref c, 0)) {
                throw new InvalidOperationException("CredWrite failed with Win32 error " + Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeCoTaskMem(mem);
        }
    }

    public static bool Delete(string target) {
        if (CredDelete(target, 1, 0)) return true;
        int err = Marshal.GetLastWin32Error();
        if (err == 1168) return false;
        throw new InvalidOperationException("CredDelete failed with Win32 error " + err);
    }
}
`;

/** Async child process: keyring helpers (esp. PowerShell + Add-Type, ~3s) must not block pi's TUI event loop. */
function run(
	cmd: string,
	args: string[],
	opts: { input?: string; timeout?: number; windowsHide?: boolean; encoding?: string; maxBuffer?: number } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { windowsHide: opts.windowsHide ?? true, timeout: opts.timeout });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
		child.once("error", (error) => resolve({ status: null, stdout, stderr, error }));
		child.once("close", (status) => resolve({ status, stdout, stderr }));
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});
}

async function runPowerShell(script: string, stdin?: string): Promise<string> {
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const res = await run(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		{
			input: stdin ?? "",
			encoding: "utf8",
			windowsHide: true,
			timeout: 20_000,
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	if (res.error) throw res.error;
	if (res.status !== 0) {
		const detail = (res.stderr || res.stdout || "").trim().slice(0, 400);
		throw new Error(`Windows credential helper failed (exit ${res.status}): ${detail}`);
	}
	return (res.stdout ?? "").trim();
}

function createWin32KeyringBackend(): KeyringBackend {
	return {
		async readActive(): Promise<Buffer | null> {
			const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN32_CRED_CS}
'@
$b64 = [PiAgyWinCred]::ReadBase64('${WIN32_TARGET}')
[Console]::Out.Write($b64)
`;
			const b64 = await runPowerShell(script);
			if (!b64) return null;
			return Buffer.from(b64, "base64");
		},
		async writeActive(raw: Buffer): Promise<void> {
			const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN32_CRED_CS}
'@
$b64 = [Console]::In.ReadToEnd().Trim()
[PiAgyWinCred]::WriteBase64('${WIN32_TARGET}', '${KEYRING_ACCOUNT}', $b64)
`;
			await runPowerShell(script, raw.toString("base64"));
		},
		async deleteActive(): Promise<boolean> {
			const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN32_CRED_CS}
'@
$deleted = [PiAgyWinCred]::Delete('${WIN32_TARGET}')
[Console]::Out.Write($deleted)
`;
			return (await runPowerShell(script)).toLowerCase() === "true";
		},
		async protect(raw: Buffer): Promise<ProtectedBlob> {
			const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$enc = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;
			const payload = await runPowerShell(script, raw.toString("base64"));
			return { encoding: "win32-dpapi", payload };
		},
		async unprotect(blob: ProtectedBlob): Promise<Buffer> {
			if (blob.encoding === "raw-base64") return Buffer.from(blob.payload, "base64");
			const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$raw = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($raw))
`;
			const b64 = await runPowerShell(script, blob.payload);
			return Buffer.from(b64, "base64");
		},
	};
}

function createDarwinKeyringBackend(): KeyringBackend {
	return {
		async readActive(): Promise<Buffer | null> {
			const res = await run(
				"security",
				["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
				{ encoding: "utf8", timeout: 10_000 },
			);
			if (res.status !== 0) return null;
			const val = res.stdout.replace(/\r?\n$/, "");
			return val ? Buffer.from(val, "utf8") : null;
		},
		async writeActive(raw: Buffer): Promise<void> {
			// macOS security CLI has no stdin secret flag; -i reads commands from stdin.
			const escaped = raw.toString("utf8").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const cmd = `add-generic-password -U -s "${KEYRING_SERVICE}" -a "${KEYRING_ACCOUNT}" -w "${escaped}"\n`;
			const res = await run("security", ["-i"], { input: cmd, encoding: "utf8", timeout: 10_000 });
			if (res.status !== 0) {
				throw new Error(`macOS Keychain write failed: ${(res.stderr || "").trim()}`);
			}
		},
		async deleteActive(): Promise<boolean> {
			const res = await run(
				"security",
				["delete-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT],
				{ encoding: "utf8", timeout: 10_000 },
			);
			return res.status === 0;
		},
		async protect(raw: Buffer): Promise<ProtectedBlob> {
			return { encoding: "raw-base64", payload: raw.toString("base64") };
		},
		async unprotect(blob: ProtectedBlob): Promise<Buffer> {
			return Buffer.from(blob.payload, "base64");
		},
	};
}

function createLinuxKeyringBackend(): KeyringBackend {
	return {
		async readActive(): Promise<Buffer | null> {
			const res = await run(
				"secret-tool",
				["lookup", "service", KEYRING_SERVICE, "account", KEYRING_ACCOUNT],
				{ encoding: "utf8", timeout: 10_000 },
			);
			if (res.status !== 0 || !res.stdout) return null;
			return Buffer.from(res.stdout, "utf8");
		},
		async writeActive(raw: Buffer): Promise<void> {
			const res = await run(
				"secret-tool",
				["store", "--label=Antigravity CLI", "service", KEYRING_SERVICE, "account", KEYRING_ACCOUNT],
				{ input: raw.toString("utf8"), encoding: "utf8", timeout: 10_000 },
			);
			if (res.status !== 0) {
				throw new Error(`Linux secret-tool write failed: ${(res.stderr || "").trim()}`);
			}
		},
		async deleteActive(): Promise<boolean> {
			const res = await run(
				"secret-tool",
				["clear", "service", KEYRING_SERVICE, "account", KEYRING_ACCOUNT],
				{ encoding: "utf8", timeout: 10_000 },
			);
			return res.status === 0;
		},
		async protect(raw: Buffer): Promise<ProtectedBlob> {
			return { encoding: "raw-base64", payload: raw.toString("base64") };
		},
		async unprotect(blob: ProtectedBlob): Promise<Buffer> {
			return Buffer.from(blob.payload, "base64");
		},
	};
}

let cachedDefaultBackend: KeyringBackend | undefined;
export function defaultKeyringBackend(): KeyringBackend {
	if (cachedDefaultBackend) return cachedDefaultBackend;
	if (process.platform === "win32") cachedDefaultBackend = createWin32KeyringBackend();
	else if (process.platform === "darwin") cachedDefaultBackend = createDarwinKeyringBackend();
	else cachedDefaultBackend = createLinuxKeyringBackend();
	return cachedDefaultBackend;
}

// --- Vault persistence ------------------------------------------------------

export function loadAccountsStore(storeFile: string = accountsPath()): AccountsStoreData {
	try {
		const raw = fs.readFileSync(storeFile, "utf8");
		const parsed = JSON.parse(raw) as Partial<AccountsStoreData>;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.accounts)) {
			return {
				version: 1,
				active: typeof parsed.active === "string" ? parsed.active : undefined,
				accounts: parsed.accounts.filter(
					(a): a is SavedAccount =>
						!!a &&
						typeof a.name === "string" &&
						typeof a.payload === "string" &&
						(a.encoding === "win32-dpapi" || a.encoding === "raw-base64"),
				),
			};
		}
	} catch {
		/* missing or corrupt -> empty vault */
	}
	return { version: 1, accounts: [] };
}

export function saveAccountsStore(data: AccountsStoreData, storeFile: string = accountsPath()): void {
	writeJsonAtomic(storeFile, data, { mode: 0o600 });
}

// --- Public account operations ----------------------------------------------

export function listSavedAccounts(opts: AccountOpOptions = {}): { active?: string; accounts: SavedAccount[] } {
	const data = loadAccountsStore(opts.storeFile);
	return { active: data.active, accounts: data.accounts };
}

/** Auto slot name: reuse the slot already holding this email, else the lowest unused number. */
export function autoAccountName(accounts: readonly SavedAccount[], email?: string): string {
	const lower = email?.toLowerCase();
	const same = lower ? accounts.find((a) => a.email?.toLowerCase() === lower) : undefined;
	if (same) return same.name;
	const taken = new Set(accounts.map((a) => a.name));
	let n = 1;
	while (taken.has(String(n))) n++;
	return String(n);
}

/** Snapshot the currently signed-in `agy` OS keyring credential into a slot.
 *  Omit name to auto-number (see autoAccountName). */
export async function saveCurrentAccount(
	name?: string,
	opts: AccountOpOptions & { email?: string } = {},
): Promise<SavedAccount> {
	if (name !== undefined && !isValidAccountName(name.trim())) {
		throw new Error(`Invalid account name "${name}". Use 1-40 chars: letters, digits, ., _, -.`);
	}
	const backend = opts.backend ?? defaultKeyringBackend();
	const raw = await backend.readActive();
	if (!raw || raw.length === 0) {
		throw new Error("No active agy credential found in the OS keyring. Sign in first with `agy acp --login` (or `/agy accounts login`).");
	}
	const protectedBlob = await backend.protect(raw);
	const nowIso = new Date(opts.now ?? Date.now()).toISOString();
	const email = opts.email ?? emailFromCredentialBytes(raw) ?? detectActiveAccountEmail(opts.homeDir);

	const store = loadAccountsStore(opts.storeFile);
	const trimmed = name?.trim() || autoAccountName(store.accounts, email);
	const existingIdx = store.accounts.findIndex((a) => a.name === trimmed);
	const entry: SavedAccount = {
		name: trimmed,
		email: email ?? (existingIdx >= 0 ? store.accounts[existingIdx].email : undefined),
		savedAt: nowIso,
		lastUsedAt: nowIso,
		encoding: protectedBlob.encoding,
		payload: protectedBlob.payload,
	};
	if (existingIdx >= 0) store.accounts[existingIdx] = entry;
	else store.accounts.push(entry);
	store.active = trimmed;
	saveAccountsStore(store, opts.storeFile);
	return entry;
}

/** Write a saved slot's credential into the OS keyring and mark it active. */
export async function switchAccount(name: string, opts: AccountOpOptions = {}): Promise<SavedAccount> {
	const trimmed = name.trim();
	const store = loadAccountsStore(opts.storeFile);
	const entry = store.accounts.find((a) => a.name === trimmed);
	if (!entry) {
		const avail = store.accounts.map((a) => a.name).join(", ") || "(none)";
		throw new Error(`Unknown account "${trimmed}". Saved accounts: ${avail}`);
	}
	const backend = opts.backend ?? defaultKeyringBackend();
	const raw = await backend.unprotect({ encoding: entry.encoding, payload: entry.payload });
	await backend.writeActive(raw);
	entry.lastUsedAt = new Date(opts.now ?? Date.now()).toISOString();
	store.active = entry.name;
	saveAccountsStore(store, opts.storeFile);
	return entry;
}

/** Remove a saved slot from accounts.json (leaves active OS keyring untouched). */
export function removeSavedAccount(name: string, opts: AccountOpOptions = {}): boolean {
	const trimmed = name.trim();
	const store = loadAccountsStore(opts.storeFile);
	const before = store.accounts.length;
	store.accounts = store.accounts.filter((a) => a.name !== trimmed);
	if (store.accounts.length === before) return false;
	if (store.active === trimmed) store.active = undefined;
	saveAccountsStore(store, opts.storeFile);
	return true;
}

/** Clear active OS keyring credential so a fresh `agy acp --login` writes a new account cleanly. */
export async function clearActiveCredential(opts: AccountOpOptions = {}): Promise<boolean> {
	const backend = opts.backend ?? defaultKeyringBackend();
	return await backend.deleteActive();
}

/** Rotate to the next non-cooled saved account after a quota-exhaustion notice. */
export async function rotateAccountOnQuota(
	params: { resetsIn?: string } & AccountOpOptions = {},
): Promise<RotateResult> {
	const now = params.now ?? Date.now();
	const store = loadAccountsStore(params.storeFile);
	if (store.accounts.length === 0) return { rotated: false, reason: "no-accounts" };
	if (store.accounts.length === 1) return { rotated: false, reason: "single-account" };

	const currentIdx = store.active ? store.accounts.findIndex((a) => a.name === store.active) : -1;
	const fromName = currentIdx >= 0 ? store.accounts[currentIdx].name : undefined;

	if (currentIdx >= 0) {
		store.accounts[currentIdx].cooldownUntil = now + parseResetDurationMs(params.resetsIn);
	}

	// Round-robin search starting right after the active account.
	const start = currentIdx >= 0 ? (currentIdx + 1) % store.accounts.length : 0;
	let candidate: SavedAccount | undefined;
	for (let i = 0; i < store.accounts.length; i++) {
		const idx = (start + i) % store.accounts.length;
		if (idx === currentIdx) continue;
		const acc = store.accounts[idx];
		if (acc.cooldownUntil !== undefined && acc.cooldownUntil > now) continue;
		candidate = acc;
		break;
	}

	if (!candidate) {
		saveAccountsStore(store, params.storeFile);
		return { rotated: false, from: fromName, reason: "all-in-cooldown" };
	}

	try {
		const backend = params.backend ?? defaultKeyringBackend();
		const raw = await backend.unprotect({ encoding: candidate.encoding, payload: candidate.payload });
		await backend.writeActive(raw);
		candidate.lastUsedAt = new Date(now).toISOString();
		candidate.cooldownUntil = undefined;
		store.active = candidate.name;
		saveAccountsStore(store, params.storeFile);
		return {
			rotated: true,
			from: fromName,
			to: candidate.name,
			email: candidate.email,
		};
	} catch (err) {
		return {
			rotated: false,
			from: fromName,
			reason: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function formatAccountsList(
	data: { active?: string; accounts: SavedAccount[] },
	autoRotate: boolean,
	now: number = Date.now(),
): string {
	if (data.accounts.length === 0) {
		return [
			"Antigravity accounts: (none saved)",
			`  auto-rotate on quota: ${autoRotate ? "on" : "off"}`,
			"",
			"Save your current agy login:",
			"  /agy accounts save",
			"Sign into an additional account and save it:",
			"  /agy accounts login",
		].join("\n");
	}
	const lines = [
		`Antigravity accounts (${data.accounts.length} saved, auto-rotate: ${autoRotate ? "on" : "off"}):`,
	];
	for (const acc of data.accounts) {
		const mark = acc.name === data.active ? "*" : " ";
		const email = acc.email ? ` (${acc.email})` : "";
		let cooldown = "";
		if (acc.cooldownUntil && acc.cooldownUntil > now) {
			const mins = Math.ceil((acc.cooldownUntil - now) / 60_000);
			cooldown = ` [cooldown ~${mins}m]`;
		}
		lines.push(` ${mark} ${acc.name}${email}${cooldown}`);
	}
	lines.push("", "Commands: /agy accounts save [name] | use <name> | login [name] | remove <name> | auto on|off");
	return lines.join("\n");
}
