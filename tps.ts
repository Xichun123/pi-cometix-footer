export interface TpsSample {
	outputTokens: number;
	elapsedMs: number;
	tokensPerSecond: number;
}

/**
 * Tracks output generation time from the first streamed output delta, excluding
 * time to first token. A sample is unavailable when a provider does not stream
 * output deltas or report final output-token usage.
 */
export class TpsTracker {
	private firstOutputAt: number | undefined;

	start(): void {
		this.firstOutputAt = undefined;
	}

	noteOutput(delta: string, now = Date.now()): void {
		if (delta.length > 0 && this.firstOutputAt === undefined) {
			this.firstOutputAt = now;
		}
	}

	finish(outputTokens: number, now = Date.now()): TpsSample | undefined {
		const firstOutputAt = this.firstOutputAt;
		this.firstOutputAt = undefined;
		const elapsedMs = firstOutputAt === undefined ? 0 : now - firstOutputAt;
		if (!Number.isFinite(outputTokens) || outputTokens <= 0 || elapsedMs <= 0) return undefined;

		return {
			outputTokens,
			elapsedMs,
			tokensPerSecond: outputTokens / (elapsedMs / 1000),
		};
	}
}

export function formatTps(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "?";
	return tokensPerSecond < 100 ? tokensPerSecond.toFixed(1) : String(Math.round(tokensPerSecond));
}
