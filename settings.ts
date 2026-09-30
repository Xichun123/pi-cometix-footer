import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, parseKey, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export const SEGMENTS = {
	model: "模型 / 思考级别",
	directory: "工作目录",
	git: "Git 状态",
	context: "上下文占用",
	tokens: "Token / 缓存命中率",
	activity: "任务耗时 / TPS",
	cost: "累计费用",
	statuses: "扩展状态信息",
};
export type SegmentId = keyof typeof SEGMENTS;
export interface FooterLayout {
	order: SegmentId[];
	hidden: SegmentId[];
	showTps: boolean;
}

export function defaultLayout(): FooterLayout {
	return { order: Object.keys(SEGMENTS) as SegmentId[], hidden: [], showTps: true };
}

function isSegmentList(value: unknown): value is SegmentId[] {
	return Array.isArray(value)
		&& value.every((id: unknown) => typeof id === "string" && Object.hasOwn(SEGMENTS, id))
		&& new Set(value).size === value.length;
}

export function readLayout(path: string): FooterLayout {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaultLayout();
		throw error;
	}
	if (!value || typeof value !== "object") throw new Error("Invalid footer layout");
	const { order, hidden, showTps } = value as Record<string, unknown>;
	if (!isSegmentList(order) || !isSegmentList(hidden)) throw new Error("Invalid footer segment IDs or duplicates");
	if (showTps !== undefined && typeof showTps !== "boolean") throw new Error("Invalid TPS setting");
	// Older files default TPS to on; new segments appear after the saved order.
	return {
		order: [...order, ...defaultLayout().order.filter((id) => !order.includes(id))],
		hidden,
		showTps: showTps ?? true,
	};
}

export function writeLayout(path: string, layout: FooterLayout): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o600 });
		// ponytail: atomic last-writer-wins across Pi sessions; add locking if concurrent editing matters.
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** One persistent panel: Ctrl+S saves, Esc discards, focus follows the edited item. */
export function editLayout(ctx: ExtensionContext, layout: FooterLayout): Promise<FooterLayout | undefined> {
	return ctx.ui.custom<FooterLayout | undefined>((tui, theme, _kb, done) => {
		let draft: FooterLayout = { ...layout, order: [...layout.order], hidden: [...layout.hidden] };

		function makeList(focus?: string): SelectList {
			const items = [
				...draft.order.map((id, i) => ({
					value: id,
					label: `${i + 1}. ${draft.hidden.includes(id) ? "○" : "✓"} ${SEGMENTS[id]}`,
				})),
				{ value: "tps", label: `${draft.order.length + 1}. ${draft.showTps ? "✓" : "○"} 生成速度（TPS）` },
				{ value: "reset", label: "恢复默认" },
			];
			const next = new SelectList(items, Math.max(1, Math.min(10, tui.terminal.rows - 5)), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			next.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === focus)));
			next.onSelect = ({ value }) => {
				if (value === "reset") draft = defaultLayout();
				else if (value === "tps") draft.showTps = !draft.showTps;
				else {
					const id = draft.order.find((item) => item === value);
					if (!id) return;
					draft.hidden = draft.hidden.includes(id) ? draft.hidden.filter((item) => item !== id) : [...draft.hidden, id];
				}
				list = makeList(value);
			};
			next.onCancel = () => done(undefined);
			return next;
		}
		let list = makeList();
		let rows = tui.terminal.rows;

		return {
			invalidate() { list.invalidate(); },
			render(width: number): string[] {
				if (rows !== tui.terminal.rows) {
					rows = tui.terminal.rows;
					list = makeList(list.getSelectedItem()?.value);
				}
				return [
					theme.fg("accent", "Cometix 页脚设置"),
					...list.render(Math.max(4, width)),
					theme.fg("dim", "↑/↓ 选择 · Enter/Space 开关"),
					theme.fg("dim", "-/+ 上移/下移 · Ctrl+S 保存 · Esc 取消"),
				].map((line) => truncateToWidth(line, width, ""));
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("s"))) {
					done(draft);
					return;
				}
				const selected = list.getSelectedItem();
				const key = decodeKittyPrintable(data) ?? parseKey(data);
				if (key === "-" || key === "+" || key === "shift++") {
					const from = draft.order.findIndex((id) => id === selected?.value);
					const to = from + (key === "-" ? -1 : 1);
					if (from >= 0 && to >= 0 && to < draft.order.length) {
						[draft.order[from], draft.order[to]] = [draft.order[to], draft.order[from]];
						list = makeList(selected?.value);
					}
				} else if (matchesKey(data, Key.space) && selected) list.onSelect?.(selected);
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
