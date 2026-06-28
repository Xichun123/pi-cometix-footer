/**
 * Cometix-style footer for pi.
 *
 * Borrows the "cometix" theme look from CCometixLine (MIT, Haleclipse):
 *   https://github.com/Haleclipse/CCometixLine
 *
 * Single line, " | " separators, Nerd Font icons, bold colored segments:
 *   Model | Directory | Git(branch + ✓/●/⚠ + ↑n/↓n) | Context% | Tokens | Cost
 *
 * Toggle with /cometix-footer (on by default). /reload to pick up edits.
 */

import type { ExtensionAPI, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// --- icon set ---------------------------------------------------------------
// Set to "emoji" if your terminal has no Nerd Font (icons become 🤖 📁 🌿 ⚡ 📊 💰).
const ICON_MODE: "nerd" | "emoji" = "nerd";

const cp = (n: number) => String.fromCodePoint(n);
const ICONS = {
	nerd: {
		model: "\ue22c", // nf-fae-pi
		dir: "\ue285", // nf-fae-bigger
		git: cp(0xf02a2), // nf-md-git
		ctx: "\uf49b", // nf-md-counter
		usage: cp(0xf0a9e), // nf-md-chart_bar
		cost: "\ueec1", // nf-md-cash
	},
	emoji: {
		model: "🤖",
		dir: "📁",
		git: "🌿",
		ctx: "⚡️",
		usage: "📊",
		cost: "💰",
	},
}[ICON_MODE];

// --- ANSI helpers (truecolor terminal) --------------------------------------
const RESET = "\x1b[0m";
// bold + color, then reset
const paint = (code: number, s: string) => `\x1b[1;${code}m${s}${RESET}`;
const SEG = `\x1b[2m | ${RESET}`; // dim separator

// 16-color bright codes used by the cometix theme
const C = {
	cyan: 96, // model, usage
	yellow: 93, // dir icon
	green: 92, // dir text
	blue: 94, // git
	magenta: 95, // context
	cost: 33, // cost (yellow, normal)
	red: 91,
	warn: 93,
};

// --- formatters -------------------------------------------------------------
function fmtCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const r = relative(resolve(home), resolve(cwd));
	if (r === "") return "~";
	if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return cwd;
	return `~${sep}${r}`;
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

interface GitStatus {
	dirty: boolean;
	conflicts: boolean;
	ahead: number;
	behind: number;
}

function parseGitPorcelain(out: string): GitStatus {
	const s: GitStatus = { dirty: false, conflicts: false, ahead: 0, behind: 0 };
	for (const line of out.split("\n")) {
		if (line.startsWith("## ")) {
			const m = line.match(/\[(?:ahead (\d+)(?:,? behind (\d+))?|behind (\d+)(?:,? ahead (\d+))?)\]/);
			if (m) {
				s.ahead = Number(m[1] ?? m[4] ?? 0);
				s.behind = Number(m[2] ?? m[3] ?? 0);
			}
		} else if (line.length >= 2) {
			const xy = line.slice(0, 2);
			if (xy === "!!" || xy === "??") {
				s.dirty = true;
			} else if (/^(UU|AA|DD|AU|UA|DU|UD)$/.test(xy)) {
				s.conflicts = true;
				s.dirty = true;
			} else {
				s.dirty = true;
			}
		}
	}
	return s;
}

// --- extension --------------------------------------------------------------
export default function (pi: ExtensionAPI) {
	// user preference: on by default. Toggle with /cometix-footer.
	let userEnabled = true;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubBranch: (() => void) | undefined;

	// git status cache, refreshed async; render reads it sync
	let gitCache: { ts: number; data: GitStatus } = {
		ts: 0,
		data: { dirty: false, conflicts: false, ahead: 0, behind: 0 },
	};
	let gitInFlight = false;
	const GIT_TTL = 3000;

	async function refreshGit(cwd: string, branch: string | null) {
		if (gitInFlight) return;
		if (!branch) {
			gitCache = { ts: Date.now(), data: { dirty: false, conflicts: false, ahead: 0, behind: 0 } };
			return;
		}
		gitInFlight = true;
		try {
			const r = await pi.exec("git", ["status", "-b", "--porcelain=v1"], { cwd, timeout: 3000 });
			const data = r.code === 0 ? parseGitPorcelain(r.stdout) : gitCache.data;
			gitCache = { ts: Date.now(), data };
		} catch {
			// keep previous cache
		} finally {
			gitInFlight = false;
		}
	}

	function installFooter(ctx: any): void {
		// clean up any previous instance first
		if (timer) clearInterval(timer);
		timer = undefined;
		unsubBranch?.();
		unsubBranch = undefined;

		ctx.ui.setFooter((tui: TUI, theme: any, footerData: ReadonlyFooterDataProvider) => {
			// refresh on git branch / HEAD change
			unsubBranch = footerData.onBranchChange(() => {
				void refreshGit(ctx.cwd, footerData.getGitBranch());
				tui.requestRender();
			});
			// periodic refresh for dirty / ahead / behind
			timer = setInterval(() => {
				void refreshGit(ctx.cwd, footerData.getGitBranch()).then(() => tui.requestRender());
			}, GIT_TTL);

			return {
				invalidate() {},
				dispose() {
					if (timer) clearInterval(timer);
					timer = undefined;
					unsubBranch?.();
					unsubBranch = undefined;
				},
				render(width: number): string[] {
					// trigger async refresh if stale (non-blocking)
					const now = Date.now();
					if (now - gitCache.ts > GIT_TTL) {
						void refreshGit(ctx.cwd, footerData.getGitBranch()).then(() => tui.requestRender());
					}

					const home = process.env.HOME || process.env.USERPROFILE;

					// model (+ thinking level, like pi's native "gpt-5.5 • xhigh")
					const modelId = ctx.model?.name || ctx.model?.id || "no-model";
					const lvl = pi.getThinkingLevel();
					const showLvl = !!ctx.model?.reasoning && !!lvl && lvl !== "off";
					let modelSeg: string;
					if (showLvl) {
						// color the level with pi's thinking palette (matches editor border)
						const lvlToken = `thinking${lvl.charAt(0).toUpperCase()}${lvl.slice(1)}`;
						const lvlStr = theme.fg(lvlToken, lvl);
						modelSeg = `\x1b[1;${C.cyan}m${ICONS.model}  ${modelId}${RESET}\x1b[2m • ${RESET}${lvlStr}${RESET}`;
					} else {
						modelSeg = paint(C.cyan, `${ICONS.model}  ${modelId}`);
					}

					// directory
					const dirText = fmtCwd(ctx.sessionManager.getCwd(), home);
					const dirSeg = `\x1b[1;${C.yellow}m${ICONS.dir} \x1b[${C.green}m${dirText}${RESET}`;

					// git
					const branch = footerData.getGitBranch();
					let gitSeg = "";
					if (branch) {
						const g = gitCache.data;
						let st = " ✓";
						if (g.conflicts) st = " ⚠";
						else if (g.dirty) st = " ●";
						let remote = "";
						if (g.ahead > 0) remote += ` ↑${g.ahead}`;
						if (g.behind > 0) remote += ` ↓${g.behind}`;
						gitSeg = paint(C.blue, `${ICONS.git} ${branch}${st}${remote}`);
					}

					// context window: e.g. "4% 13k/272k"
					const cu = ctx.getContextUsage();
					const pct = cu?.percent;
					const pctStr = pct != null ? `${Math.round(pct)}%` : "?";
					const tokStr = cu?.tokens != null ? fmtTok(cu.tokens) : "?";
					const winStr = cu?.contextWindow ? fmtTok(cu.contextWindow) : "?";
					const ctxColor = pct == null ? C.magenta : pct > 90 ? C.red : pct > 70 ? C.warn : C.magenta;
					const ctxSeg = paint(ctxColor, `${ICONS.ctx} ${pctStr} ${tokStr}/${winStr}`);

					// tokens (cumulative across the session file) + latest cache hit rate
					let tin = 0;
					let tout = 0;
					let totalCR = 0;
					let totalCW = 0;
					let lastHit: number | undefined;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e?.type === "message" && e.message?.role === "assistant") {
							const u = (e.message as any).usage;
							if (u) {
								tin += u.input ?? 0;
								tout += u.output ?? 0;
								const cr = u.cacheRead ?? 0;
								const cw = u.cacheWrite ?? 0;
								totalCR += cr;
								totalCW += cw;
								const prompt = (u.input ?? 0) + cr + cw;
								if (prompt > 0) lastHit = (cr / prompt) * 100;
							}
						}
					}
					let tokText = `${ICONS.usage} ↑${fmtTok(tin)} ↓${fmtTok(tout)}`;
					if ((totalCR > 0 || totalCW > 0) && lastHit != null) {
						tokText += ` CH${lastHit.toFixed(1)}%`;
					}
					const tokSeg = paint(C.cyan, tokText);

					const segs = [modelSeg, dirSeg];
					if (gitSeg) segs.push(gitSeg);
					segs.push(ctxSeg, tokSeg);

					// extension/package statuses (e.g. MCP servers) — appended as a final segment on the same line
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => (t ?? "").replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						if (statusLine) {
							segs.push(statusLine);
						}
					}

					let line = segs.join(SEG);
					if (visibleWidth(line) > width) {
						line = truncateToWidth(line, width, "");
					}
					return [line];
				},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		// Re-install each session with a fresh ctx so model/sessionManager stay current.
		if (ctx.mode !== "tui" || !userEnabled) return;
		installFooter(ctx);
	});

	pi.registerCommand("cometix-footer", {
		description: "Toggle cometix-style footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			userEnabled = !userEnabled;
			if (userEnabled) {
				installFooter(ctx);
				ctx.ui.notify("Cometix footer on", "info");
			} else {
				ctx.ui.setFooter(undefined);
				if (timer) clearInterval(timer);
				timer = undefined;
				unsubBranch?.();
				unsubBranch = undefined;
				ctx.ui.notify("Cometix footer off (default restored)", "info");
			}
		},
	});
}
