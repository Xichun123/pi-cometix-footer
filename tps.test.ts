import assert from "node:assert/strict";
import test from "node:test";
import { formatTps, TpsTracker } from "./tps.ts";

test("measures from the first output delta and excludes TTFT", () => {
	const tracker = new TpsTracker();
	tracker.start();
	tracker.noteOutput("first chunk", 5_000);
	tracker.noteOutput("second chunk", 6_000);

	assert.deepEqual(tracker.finish(100, 7_000), {
		outputTokens: 100,
		elapsedMs: 2_000,
		tokensPerSecond: 50,
	});
});

test("does not produce a sample without streamed output", () => {
	const tracker = new TpsTracker();
	tracker.start();
	tracker.noteOutput("", 1_000);

	assert.equal(tracker.finish(20, 2_000), undefined);
});

test("requires positive output usage and duration", () => {
	const tracker = new TpsTracker();
	tracker.start();
	tracker.noteOutput("chunk", 1_000);
	assert.equal(tracker.finish(0, 2_000), undefined);

	tracker.start();
	tracker.noteOutput("chunk", 3_000);
	assert.equal(tracker.finish(10, 3_000), undefined);
});

test("resets timing between responses", () => {
	const tracker = new TpsTracker();
	tracker.start();
	tracker.noteOutput("old", 1_000);
	tracker.start();
	tracker.noteOutput("new", 5_000);

	assert.equal(tracker.finish(10, 6_000)?.tokensPerSecond, 10);
	assert.equal(tracker.finish(10, 7_000), undefined);
});

test("formats TPS compactly", () => {
	assert.equal(formatTps(42.34), "42.3");
	assert.equal(formatTps(123.6), "124");
	assert.equal(formatTps(Number.NaN), "?");
});
