/** Synthesize Pi 1.6.0-style "Nested tools:" TypeScript declarations for the
 *  bridged `codemode` MCP tool.
 *
 *  `pi.getAllTools()` returns `codemode`'s base description (~1.4 KB) without
 *  the runtime-generated `Nested tools:` catalog that Pi's own model loop
 *  attaches. Without it, Antigravity models see an opaque `codemode({ code })`
 *  tool and have to waste turns probing `ALL_TOOLS` / `describeTool()`.
 *
 *  Self-contained (no private subpath imports from pi-coding-agent) so Pi
 *  upgrades cannot break it. */

import type { BridgeToolInfo } from "./bridge-catalog.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_INLINE_BUDGET = 4000;
const MAX_SCHEMA_DEPTH = 4;
const MAX_PROPS_PER_OBJECT = 18;

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Convert a tool name to a valid JS identifier under `tools.<id>`. */
export function toCodemodeIdentifier(name: string): string {
	if (JS_IDENT_RE.test(name)) return name;
	const cleaned = name.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^([0-9])/, "_$1");
	return cleaned || "_tool";
}

function renderSchemaComment(desc: unknown, pad: string): string {
	if (typeof desc !== "string") return "";
	const line = desc.replace(/\s+/g, " ").trim();
	if (!line) return "";
	const clipped = line.length > 140 ? `${line.slice(0, 137)}...` : line;
	return `${pad}// ${clipped}\n`;
}

/** Render a JSON Schema / TypeBox parameter schema into compact TypeScript. */
export function renderJsonSchemaTs(schema: unknown, depth = 0): string {
	if (!schema || typeof schema !== "object") return "unknown";
	const s = schema as Record<string, unknown>;

	if (s.const !== undefined) return JSON.stringify(s.const);
	if (Array.isArray(s.enum) && s.enum.length > 0) {
		return s.enum.map((v) => JSON.stringify(v)).join(" | ");
	}
	if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
		return s.anyOf.map((sub) => renderJsonSchemaTs(sub, depth + 1)).join(" | ");
	}
	if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
		return s.oneOf.map((sub) => renderJsonSchemaTs(sub, depth + 1)).join(" | ");
	}

	const type = s.type;
	if (Array.isArray(type)) {
		return type.map((t) => renderJsonSchemaTs({ ...s, type: t }, depth + 1)).join(" | ");
	}
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	if (type === "array") {
		if (depth >= MAX_SCHEMA_DEPTH) return "Array<unknown>";
		return `Array<${renderJsonSchemaTs(s.items, depth + 1)}>`;
	}

	const props = s.properties && typeof s.properties === "object"
		? (s.properties as Record<string, unknown>)
		: null;
	if (type === "object" || props) {
		if (!props) return "Record<string, unknown>";
		const keys = Object.keys(props);
		if (keys.length === 0) return "{}";
		if (depth >= MAX_SCHEMA_DEPTH) return "Record<string, unknown>";
		const required = new Set(Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === "string") : []);
		const pad = "  ".repeat(depth + 1);
		const closePad = "  ".repeat(depth);
		const shownKeys = keys.slice(0, MAX_PROPS_PER_OBJECT);
		const lines: string[] = ["{"];
		for (const key of shownKeys) {
			const propSchema = props[key];
			const comment = propSchema && typeof propSchema === "object"
				? renderSchemaComment((propSchema as Record<string, unknown>).description, pad)
				: "";
			const propKey = JS_IDENT_RE.test(key) ? key : JSON.stringify(key);
			const opt = required.has(key) ? "" : "?";
			const propType = renderJsonSchemaTs(propSchema, depth + 1);
			lines.push(`${comment}${pad}${propKey}${opt}: ${propType};`);
		}
		if (keys.length > shownKeys.length) {
			lines.push(`${pad}// ... ${keys.length - shownKeys.length} more properties`);
		}
		lines.push(`${closePad}}`);
		return lines.join("\n");
	}

	return "unknown";
}

function renderToolSection(tool: BridgeToolInfo): string {
	const id = toCodemodeIdentifier(tool.name);
	const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
	const rawDesc = (tool.description ?? tool.name).trim();
	const desc = rawDesc.length > 500 ? `${rawDesc.slice(0, 497)}...` : rawDesc;
	const guidelines = (tool.promptGuidelines ?? [])
		.map((g) => g.trim())
		.filter(Boolean)
		.map((g) => `- ${g}`);
	const argsTs = renderJsonSchemaTs(tool.parameters, 0);
	const retTs = tool.outputSchema ? renderJsonSchemaTs(tool.outputSchema, 0) : "string";
	const parts = [heading, desc];
	if (guidelines.length > 0) parts.push(guidelines.join("\n"));
	parts.push(`\`\`\`ts\ndeclare const tools: { ${id}(args: ${argsTs}): Promise<${retTs}>; };\n\`\`\``);
	return parts.join("\n\n");
}

interface CatalogGroup {
	namespace?: { name: string; description?: string };
	entries: Array<{ name: string; section: string; cost: number }>;
}

/** Round-robin budget picker mirroring Pi 1.6.0's selectCatalog(): every group
 *  places its cheapest remaining tool each round so namespaces stay balanced. */
function selectWithinBudget(groups: CatalogGroup[], budget: number): Set<string> {
	const queues = groups.map((g) => [...g.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = Math.max(0, budget);
	let active = queues.filter((q) => q.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

export interface CodemodeDescriptionOptions {
	/** Estimated token budget for inline nested tool sections. Default 4000. */
	inlineBudget?: number;
	/** Tool names to exclude from nested listing (e.g. codemode itself, direct tools). */
	excludeNames?: ReadonlySet<string>;
}

/** Enrich codemode's base description with inline TypeScript declarations for
 *  callable nested tools. Idempotent if Nested tools are already present. */
export function buildCodemodeBridgeDescription(
	baseDescription: string,
	nestedTools: readonly BridgeToolInfo[],
	opts: CodemodeDescriptionOptions = {},
): string {
	if (baseDescription.includes("\nNested tools:\n")) return baseDescription;
	const exclude = opts.excludeNames ?? new Set<string>();
	const callable = nestedTools.filter(
		(t) =>
			t.name !== "codemode" &&
			!exclude.has(t.name) &&
			t.exposure !== "deferred" &&
			t.exposure !== "model-only" &&
			t.exposure !== "hidden",
	);
	if (callable.length === 0) return baseDescription;

	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const tool of callable) {
		const ns = tool.namespace;
		const key = ns ? `ns:${ns.name}` : "";
		const group = groups.get(key) ?? { namespace: ns, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(tool);
		group.entries.push({
			name: tool.name,
			section,
			cost: Math.ceil(section.length / CHARS_PER_TOKEN),
		});
	}

	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const budget = opts.inlineBudget ?? DEFAULT_INLINE_BUDGET;
	const shown = selectWithinBudget(ordered, budget);

	const blocks: string[] = ["Nested tools:"];
	const unlisted: string[] = [];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((e) => shown.has(e.name));
		for (const e of entries) {
			if (!shown.has(e.name)) unlisted.push(e.name);
		}
		if (namespace) {
			const suffix = visible.length === entries.length
				? ""
				: visible.length === 0
					? " (tools not listed)"
					: " (some tools not listed)";
			const nsDesc = namespace.description?.trim();
			blocks.push(`## ${namespace.name}${suffix}${nsDesc ? `\n${nsDesc}` : ""}`);
		}
		for (const e of visible) blocks.push(e.section);
	}

	if (unlisted.length > 0) {
		blocks.push(`Unlisted nested tools (${unlisted.length}): ${unlisted.join(", ")}. Call \`describeTool(name)\` or \`searchTools(query)\` inside codemode to inspect them.`);
	}

	return `${baseDescription.trimEnd()}\n\n${blocks.join("\n\n")}`;
}
