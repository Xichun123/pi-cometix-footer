import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader, SessionManager, SettingsManager, Theme,
	type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
	type ExtensionEvent, type KeybindingsManager, type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import footerExtension from "./index.ts";
import { defaultLayout, readLayout, writeLayout } from "./settings.ts";

type Assistant = Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "assistant" }>;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
const ENTER = "\r", SAVE = "\x13", ESC = "\x1b", MOVE_UP = "-", MOVE_DOWN = "+";
const nav = (steps: number): string[] => Array(Math.abs(steps)).fill(steps < 0 ? "\x1b[A" : "\x1b[B");

function usage(n = 1): Assistant["usage"] {
	return {
		input: 100 * n, output: 20 * n, cacheRead: 100 * n, cacheWrite: 0, totalTokens: 220 * n,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 * n },
	};
}

function assistant(u = usage()): Assistant {
	return {
		role: "assistant", api: "openai-responses", provider: "audit", model: "audit",
		content: [], timestamp: Date.now(), stopReason: "stop", usage: u,
	};
}

function setup(t: TestContext) {
	const agentDir = mkdtempSync(join(tmpdir(), "cometix-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const settingsPath = join(agentDir, "cometix-footer.json");
	let now = 10_000;
	t.mock.method(Date, "now", () => now);
	const timers = new Map<ReturnType<typeof setInterval>, () => void>();
	t.mock.method(globalThis, "setInterval", (fn: () => void) => {
		const timer = {} as ReturnType<typeof setInterval>;
		timers.set(timer, fn);
		return timer;
	});
	t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => timers.delete(timer));
	const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const branches = new Set<() => void>();
	let branch: string | null = null;
	let level: ReturnType<ExtensionAPI["getThinkingLevel"]> = "max";
	let runGit: ExtensionAPI["exec"] = async () => ({ stdout: "## main\n", stderr: "", code: 0, killed: false });
	let footer: ReturnType<FooterFactory> | undefined;
	const requestRender = t.mock.fn();
	const fg = t.mock.fn((_color: ThemeColor, text: string) => text);
	const theme = Object.assign(Object.create(Theme.prototype), { fg }) as Theme;
	const sessionManager = SessionManager.inMemory(process.cwd());
	let inputs: (string | ((panel: Component) => void))[] = [];
	const custom: ExtensionContext["ui"]["custom"] = (factory) => new Promise((resolve, reject) => {
		let closed = false;
		Promise.resolve(factory(
			{ requestRender, terminal: { rows: 24 } } as unknown as Parameters<FooterFactory>[0],
			theme, {} as KeybindingsManager, (value) => { closed = true; resolve(value); },
		)).then((panel) => {
			const events = inputs;
			inputs = [];
			for (const input of events) {
				assert.equal(closed, false, "no input after the panel closes");
				if (typeof input === "string") panel.handleInput?.(input);
				else input(panel);
			}
			if (!closed) panel.handleInput?.(ESC);
		}).catch(reject);
	});
	const ctx = {
		mode: "tui", cwd: process.cwd(), sessionManager,
		model: { id: "audit", name: "模型 🤖", reasoning: true },
		getContextUsage: () => ({ tokens: 100, percent: 1, contextWindow: 10000 }),
		ui: {
			setFooter(factory: FooterFactory | undefined) {
				footer?.dispose?.();
				footer = factory?.({ requestRender } as unknown as Parameters<FooterFactory>[0], theme, {
					getGitBranch: () => branch,
					getAvailableProviderCount: () => 1,
					getExtensionStatuses: () => new Map([["mcp", "MCP: 1/1\nservers"]]),
					onBranchChange(callback) { branches.add(callback); return () => branches.delete(callback); },
				});
			},
			custom,
			notify: t.mock.fn(),
		},
	} as unknown as ExtensionContext;
	footerExtension({
		on: (name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, options),
		getThinkingLevel: () => level,
		exec: (...args: Parameters<ExtensionAPI["exec"]>) => runGit(...args),
	} as unknown as ExtensionAPI);
	const emit = async (event: ExtensionEvent) => { await handlers.get(event.type)?.(event, ctx); };
	t.after(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
		footer?.dispose?.();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});
	return {
		ctx, timers, branches, requestRender, fg, emit, settingsPath,
		keys(...keys: typeof inputs) { inputs = keys; },
		start: () => emit({ type: "session_start", reason: "startup" }),
		get footer() { assert.ok(footer); return footer; },
		text() { assert.ok(footer); return footer.render(500)[0].replace(/\x1b\[[0-9;]*m/g, ""); },
		command: (args = "") => commands.get("cometix-footer")!.handler(args, ctx as ExtensionCommandContext),
		advance(ms: number) { now += ms; },
		setLevel(value: typeof level) { level = value; },
		setExec(fn: ExtensionAPI["exec"]) { runGit = fn; },
		setBranch(value: string | null) { branch = value; for (const fn of branches) fn(); },
	};
}

test("counts every Pi usage source, but cache hit belongs to the latest assistant", async (t) => {
	const f = setup(t);
	const sm = f.ctx.sessionManager as SessionManager;
	const id = sm.appendMessage(assistant());
	sm.appendMessage({ role: "toolResult", toolCallId: "1", toolName: "nested", content: [], isError: false, timestamp: Date.now(), usage: usage(2) });
	sm.appendUsage("cache_warm", "audit", "audit", usage(3));
	sm.appendCompaction("summary", id, 100, undefined, false, usage(4));
	sm.branchWithSummary(id, "branch summary", undefined, false, { ...usage(5), cacheRead: 0 });
	// Older entries without optional usage remain valid.
	sm.appendCompaction("old summary", id, 100);
	sm.appendMessage({ role: "toolResult", toolCallId: "2", toolName: "bash", content: [], isError: false, timestamp: Date.now() });
	await f.start();
	assert.match(f.text(), /↑1\.5k ↓300 CH50\.0%/);
	assert.match(f.text(), /1\.500/);
	assert.match(f.text(), /MCP: 1\/1 servers/);
	// Unknown/latest-zero prompt must not leave a previous response's hit rate.
	sm.appendMessage(assistant({ ...usage(0), output: 1 }));
	assert.doesNotMatch(f.text(), /CH/);
});

test("renders all thinking levels and narrow widths; streaming settles timing and TPS", async (t) => {
	const f = setup(t);
	await f.start();
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		f.setLevel(level);
		assert.ok(f.text().includes(level));
		assert.match(f.fg.mock.calls.at(-1)!.arguments[0], /^thinking/);
	}
	f.setLevel("off");
	assert.doesNotMatch(f.text(), / • /);
	for (const width of [0, 1, 10, 20, 80, 300]) assert.ok(visibleWidth(f.footer.render(width)[0]) <= width);
	f.ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 10000 });
	assert.match(f.text(), /\? \?\/10k/);
	await f.emit({ type: "message_start", message: { role: "user", content: "test", timestamp: Date.now() } });
	assert.equal(f.timers.size, 2);
	for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const) {
		const message = assistant();
		await f.emit({ type: "message_start", message });
		f.advance(1000);
		await f.emit({ type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, delta: "chunk", partial: message } });
		f.advance(2000);
		await f.emit({ type: "message_end", message });
		assert.match(f.text(), /10\.0 tok\/s/);
	}
	const settledEvent = { type: "agent_settled" as const, aborted: false };
	await f.emit(settledEvent);
	assert.equal(f.timers.size, 1);
	assert.match(f.text(), /9s · 10\.0 tok\/s/);
	f.keys(...nav(8), ENTER, SAVE);
	await f.command();
	assert.doesNotMatch(f.text(), /tok\/s/);
	assert.equal(readLayout(f.settingsPath).showTps, false);
	f.keys(...nav(8), ENTER, SAVE);
	await f.command();
	assert.match(f.text(), /10\.0 tok\/s/);
	assert.equal(readLayout(f.settingsPath).showTps, true);
});

test("opening/cancelling settings keeps the footer; shutdown and non-TUI changes release resources", async (t) => {
	const f = setup(t);
	await f.start();
	const old = f.footer;
	await f.start();
	old.dispose?.();
	assert.equal(f.timers.size, 1);
	assert.equal(f.branches.size, 1);
	const current = f.footer;
	const custom = t.mock.method(f.ctx.ui, "custom");
	await f.command();
	assert.equal(custom.mock.callCount(), 1);
	assert.equal(f.footer, current);
	assert.equal(f.timers.size, 1);
	assert.equal(f.branches.size, 1);
	await f.emit({ type: "message_start", message: { role: "user", content: "test", timestamp: Date.now() } });
	assert.equal(f.timers.size, 2);
	await f.emit({ type: "session_shutdown", reason: "quit" });
	await f.emit({ type: "session_shutdown", reason: "quit" });
	assert.equal(f.timers.size, 0);
	assert.equal(f.branches.size, 0);
	await f.start();
	f.ctx.mode = "rpc";
	await f.start();
	assert.equal(f.timers.size, 0);
	assert.equal(f.branches.size, 0);
	const renders = f.requestRender.mock.callCount();
	await f.emit({ type: "message_end", message: assistant() });
	assert.equal(f.requestRender.mock.callCount(), renders);
});

test("aborts obsolete Git queries and ignores late results after branch changes or disposal", async (t) => {
	const f = setup(t);
	const pending: { signal: AbortSignal; finish: (stdout: string) => void }[] = [];
	f.setExec(async (_cmd, _args, options) => new Promise((resolve) => {
		assert.ok(options?.signal);
		pending.push({ signal: options.signal, finish: (stdout) => resolve({ stdout, stderr: "", code: 0, killed: false }) });
	}));
	await f.start();
	f.setBranch("main");
	assert.equal(pending.length, 1);
	const whilePending = f.requestRender.mock.callCount();
	f.text();
	f.text();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pending.length, 1);
	assert.equal(f.requestRender.mock.callCount(), whilePending);
	f.setBranch("next");
	assert.equal(pending[0].signal.aborted, true);
	assert.equal(pending.length, 2);
	pending[1].finish("## next...origin/next [ahead 2, behind 3]\nUU conflict\n");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(f.text(), /next ⚠ ↑2 ↓3/);
	pending[0].finish("## main\n");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.match(f.text(), /next ⚠ ↑2 ↓3/);
	f.setBranch("last");
	await f.emit({ type: "session_shutdown", reason: "quit" });
	assert.equal(pending[2].signal.aborted, true);
	const renders = f.requestRender.mock.callCount();
	pending[2].finish("## last\n?? file\n");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.requestRender.mock.callCount(), renders);
	assert.equal(f.timers.size, 0);
	assert.equal(f.branches.size, 0);
});

test("Pi's real resource loader loads the published extension entry point", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "cometix-loader-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd, agentDir: join(cwd, "agent"), settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, []);
	assert.equal(result.extensions.length, 1);
	assert.ok(result.extensions[0].commands.has("cometix-footer"));
	assert.ok(result.extensions[0].handlers.has("agent_settled"));
	assert.ok(result.extensions[0].handlers.has("session_shutdown"));
});

test("settings toggle segments, reorder, persist, and stop hidden Git/activity work", async (t) => {
	const f = setup(t);
	await f.start();
	let queries = 0;
	f.setExec(async () => { queries++; return { stdout: "## main\n", stderr: "", code: 0, killed: false }; });
	f.keys(...nav(2), ENTER, ...nav(3), ENTER, ...nav(2), ...Array(7).fill(MOVE_UP), SAVE);
	await f.command();
	const saved = readLayout(f.settingsPath);
	assert.deepEqual(saved.hidden, ["git", "activity"]);
	assert.equal(saved.order[0], "statuses");
	assert.match(f.text(), /^MCP: 1\/1 servers \| /);
	assert.equal(f.timers.size, 0);
	assert.equal(f.branches.size, 0);
	f.setBranch("main");
	await f.emit({ type: "message_start", message: { role: "user", content: "test", timestamp: Date.now() } });
	assert.doesNotMatch(f.text(), /main|tok\/s/);
	assert.equal(queries, 0);
	assert.equal(f.timers.size, 0);
	await f.start();
	assert.match(f.text(), /^MCP: 1\/1 servers \| /);
	assert.equal(f.timers.size, 0);
	// Re-enabling a hidden item preserves its configured place.
	f.keys(...nav(3), ENTER, SAVE);
	await f.command();
	assert.equal(readLayout(f.settingsPath).order[3], "git");
	assert.deepEqual(readLayout(f.settingsPath).hidden, ["activity"]);
	assert.equal(f.timers.size, 1);
});

test("settings support cancel, reset and hiding all segments without stray separators", async (t) => {
	const f = setup(t);
	await f.start();
	f.keys(ENTER, ESC);
	await f.command();
	assert.match(f.text(), /模型/);
	assert.equal(existsSync(f.settingsPath), false);
	f.keys(MOVE_DOWN, ESC);
	await f.command();
	assert.equal(existsSync(f.settingsPath), false);
	f.keys(ENTER, ...Array(7).fill(["\x1b[B", ENTER]).flat(), SAVE);
	await f.command();
	assert.equal(f.text(), "");
	assert.equal(f.timers.size, 0);
	f.keys(...nav(9), ENTER, SAVE);
	await f.command();
	assert.deepEqual(readLayout(f.settingsPath), defaultLayout());
	assert.match(f.text(), /模型/);
	assert.equal(f.timers.size, 1);
});

test("layout files validate input, retain invalid files, and fail saves without changing active layout", async (t) => {
	const f = setup(t);
	assert.deepEqual(readLayout(f.settingsPath), defaultLayout());
	writeLayout(f.settingsPath, { ...defaultLayout(), order: ["statuses"], hidden: ["git"] });
	assert.equal(readLayout(f.settingsPath).order.length, 8);
	assert.equal(readLayout(f.settingsPath).order[0], "statuses");
	assert.deepEqual(readdirSync(join(f.settingsPath, "..")), ["cometix-footer.json"]);
	writeFileSync(f.settingsPath, JSON.stringify({ order: ["statuses"], hidden: [] }));
	assert.equal(readLayout(f.settingsPath).showTps, true);
	for (const value of [null, [], {}, { order: ["model", "model"], hidden: [] }, { order: [], hidden: ["unknown"] }, { order: [], hidden: [], showTps: "on" }]) {
		writeFileSync(f.settingsPath, JSON.stringify(value));
		assert.throws(() => readLayout(f.settingsPath));
	}
	writeFileSync(f.settingsPath, "broken JSON");
	await f.start();
	assert.match(f.text(), /模型/);
	assert.equal(readFileSync(f.settingsPath, "utf8"), "broken JSON");
	const notifications: [string, string?][] = [];
	f.ctx.ui.notify = (message, level) => { notifications.push([message, level]); };
	rmSync(f.settingsPath);
	mkdirSync(f.settingsPath);
	f.keys(ENTER, SAVE);
	await f.command();
	assert.match(f.text(), /模型/);
	assert.ok(notifications.some(([message, level]) => level === "error" && message.includes("Cannot save")));
	assert.deepEqual(readdirSync(join(f.settingsPath, "..")), ["cometix-footer.json"]);
});

test("TPS preference survives restart; cancelled edits and removed subcommands leave the footer unchanged", async (t) => {
	const f = setup(t);
	await f.start();
	f.keys(...nav(8), ENTER, SAVE);
	await f.command();
	await f.start();
	const message = assistant();
	await f.emit({ type: "message_start", message });
	await f.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "chunk", partial: message } });
	f.advance(2000);
	await f.emit({ type: "message_end", message });
	assert.doesNotMatch(f.text(), /tok\/s/);
	f.keys(...nav(8), ENTER, ESC);
	await f.command();
	assert.equal(readLayout(f.settingsPath).showTps, false);
	assert.doesNotMatch(f.text(), /tok\/s/);
	const custom = t.mock.method(f.ctx.ui, "custom");
	const current = f.footer;
	for (const args of ["settings", "tps", "tps on", "tps off", "off"]) await f.command(args);
	assert.equal(custom.mock.callCount(), 0);
	assert.equal(f.footer, current);
	assert.equal(f.timers.size, 1);
	f.keys(...nav(9), ENTER, SAVE);
	await f.command();
	assert.equal(readLayout(f.settingsPath).showTps, true);
	assert.match(f.text(), /10\.0 tok\/s/);
});

test("settings keep focus after toggles, reordering and reset, and Ctrl+S saves without a save row", async (t) => {
	const f = setup(t);
	await f.start();
	const selected = (panel: Component) => panel.render(200).find((line) => line.startsWith("→ "));
	f.keys(
		MOVE_UP,
		(panel) => assert.match(selected(panel)!, /^→ 1\. ✓ 模型/),
		...nav(5), ENTER,
		(panel) => assert.match(selected(panel)!, /^→ 6\. ○ 任务耗时/),
		" ",
		(panel) => assert.match(selected(panel)!, /^→ 6\. ✓ 任务耗时/),
		MOVE_UP,
		(panel) => assert.match(selected(panel)!, /^→ 5\. ✓ 任务耗时/),
		MOVE_DOWN,
		(panel) => assert.match(selected(panel)!, /^→ 6\. ✓ 任务耗时/),
		"\x1b[45u", // Kitty: plain minus
		(panel) => assert.match(selected(panel)!, /^→ 5\. ✓ 任务耗时/),
		"\x1b[61:43;2u", // Kitty: Shift+= produces plus
		(panel) => assert.match(selected(panel)!, /^→ 6\. ✓ 任务耗时/),
		"\x1b[27;1;45~", // xterm modifyOtherKeys: minus
		(panel) => assert.match(selected(panel)!, /^→ 5\. ✓ 任务耗时/),
		"\x1b[27;2;43~", // xterm modifyOtherKeys: shifted plus
		(panel) => assert.match(selected(panel)!, /^→ 6\. ✓ 任务耗时/),
		"\x1b[45;5u", "\x1b[61:43;6u", // Ctrl+-/+ must not reorder
		(panel) => assert.match(selected(panel)!, /^→ 6\. ✓ 任务耗时/),
		...nav(2), MOVE_DOWN,
		(panel) => assert.match(selected(panel)!, /^→ 8\. ✓ 扩展/),
		...nav(1), ENTER, MOVE_UP,
		(panel) => assert.equal(selected(panel), "→ 9. ○ 生成速度（TPS）"),
		" ",
		(panel) => assert.equal(selected(panel), "→ 9. ✓ 生成速度（TPS）"),
		...nav(1), ENTER,
		(panel) => {
			assert.equal(selected(panel), "→ 恢复默认");
			assert.doesNotMatch(panel.render(200).join("\n"), /保存并退出/);
			for (const width of [0, 1, 10, 20, 80]) {
				assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
			}
		}, SAVE,
	);
	await f.command();
	assert.deepEqual(readLayout(f.settingsPath), defaultLayout());
});
