import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "./duration.ts";

test("formats task durations compactly", () => {
	assert.equal(formatDuration(12_400), "12s");
	assert.equal(formatDuration(83_000), "1m 23s");
	assert.equal(formatDuration(3_723_000), "1h 2m");
});

test("handles short and invalid durations", () => {
	assert.equal(formatDuration(499), "0s");
	assert.equal(formatDuration(500), "1s");
	assert.equal(formatDuration(-1), "?");
	assert.equal(formatDuration(Number.NaN), "?");
});
