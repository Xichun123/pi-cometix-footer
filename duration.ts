export function formatDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "?";

	const totalSeconds = Math.round(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}
