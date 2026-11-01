/**
 * Getting from "17 changed lines are uncovered" to the lines themselves.
 * A percentage tells you there is work; this tells you where it is, without
 * scrolling a report and clicking file names one at a time.
 */

export interface LineGaps {
    uncovered: number[];
    /** Uncovered lines this branch changed — the ones a reviewer will ask about. */
    uncoveredChanged: number[];
}

export interface GapSummary {
    path: string;
    /** Uncovered lines this branch changed. */
    changed: number;
    /** All uncovered lines, changed or not. */
    total: number;
    /** Where to land when this file is chosen. */
    firstLine: number;
}

/**
 * The next line worth visiting after `fromLine` (1-based), wrapping back to
 * the top so repeated invocations cycle. Changed lines win when a file has
 * any: walking 400 pre-existing gaps to reach the three you just wrote is not
 * the journey anyone wants.
 */
export function nextGapLine(gaps: LineGaps | undefined, fromLine: number): number | undefined {
    const lines = gaps?.uncoveredChanged.length ? gaps.uncoveredChanged : gaps?.uncovered;
    if (!lines?.length) {
        return undefined;
    }
    const ordered = [...lines].sort((a, b) => a - b);
    return ordered.find(line => line > fromLine) ?? ordered[0];
}

/** Files with gaps, the ones this branch is answerable for first. */
export function rankGaps(byFile: Map<string, LineGaps>): GapSummary[] {
    const summaries: GapSummary[] = [];
    for (const [path, gaps] of byFile) {
        const total = gaps.uncovered.length + gaps.uncoveredChanged.length;
        if (total === 0) {
            continue;
        }
        summaries.push({
            path,
            changed: gaps.uncoveredChanged.length,
            total,
            firstLine: nextGapLine(gaps, 0) ?? 1
        });
    }
    return summaries.sort((a, b) => b.changed - a.changed || b.total - a.total || a.path.localeCompare(b.path));
}
