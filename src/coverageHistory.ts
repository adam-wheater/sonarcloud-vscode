import * as vscode from 'vscode';

/**
 * Remembers what previous local coverage runs measured, so a run can answer
 * "did this change help or hurt?" — the question a percentage on its own
 * cannot. Kept in workspace state; it is a convenience, never a source of
 * truth, so a corrupt or missing history simply means no comparison.
 */

export interface CoverageRun {
    /** ISO timestamp of the run. */
    at: string;
    /** Git branch at the time, when it could be detected. */
    branch?: string;
    linesCovered: number;
    linesTotal: number;
    changedCovered: number;
    changedTotal: number;
    testsTotal?: number;
    testsFailed?: number;
}

export interface CoverageDelta {
    previous: CoverageRun;
    /** Change in line-coverage percentage, in percentage points. */
    percentagePoints: number | undefined;
    coveredLines: number;
    totalLines: number;
    /** False when the comparison crosses branches, which is worth saying. */
    sameBranch: boolean;
}

const MAX_RUNS = 25;

function linePercent(run: CoverageRun): number | undefined {
    return run.linesTotal > 0 ? (run.linesCovered / run.linesTotal) * 100 : undefined;
}

/** Newest first, capped — old runs are not interesting and would grow forever. */
export function appendRun(history: CoverageRun[], run: CoverageRun, max: number = MAX_RUNS): CoverageRun[] {
    return [run, ...history].slice(0, max);
}

/**
 * Compare against the most recent earlier run, preferring one on the same
 * branch: comparing a feature branch against main's last run mostly measures
 * the branch difference, not the change just made.
 */
export function deltaAgainstPrevious(history: CoverageRun[], current: CoverageRun): CoverageDelta | undefined {
    if (history.length === 0) {
        return undefined;
    }
    const sameBranch = current.branch
        ? history.find(run => run.branch === current.branch)
        : undefined;
    const previous = sameBranch ?? history[0];
    const before = linePercent(previous);
    const after = linePercent(current);
    return {
        previous,
        percentagePoints: before === undefined || after === undefined ? undefined : after - before,
        coveredLines: current.linesCovered - previous.linesCovered,
        totalLines: current.linesTotal - previous.linesTotal,
        sameBranch: previous === sameBranch
    };
}

/**
 * Verdict for "coverage must not go backwards". The changed-line gate answers
 * "is the new code tested?"; this answers the other question a reviewer asks —
 * "did this branch drag the project down?" — which a branch can do while still
 * covering every line it touched, by deleting tests or adding untested code
 * that the diff does not attribute to it.
 */
export interface CoverageRatchet {
    /** False when disabled, or when there is no comparable earlier run. */
    applicable: boolean;
    passed: boolean;
    /** Percentage points lost since the baseline; negative when coverage rose. */
    dropped: number | undefined;
    /** Drops smaller than this are rounding, not regressions. */
    tolerance: number;
    baseline: CoverageRun | undefined;
    /** False when the only baseline available is from another branch. */
    sameBranch: boolean;
}

export function evaluateRatchet(
    delta: CoverageDelta | undefined,
    enabled: boolean,
    tolerance: number
): CoverageRatchet {
    const points = delta?.percentagePoints;
    const applicable = enabled && points !== undefined;
    return {
        applicable,
        // A drop is a negative delta, so losing ground is a positive "dropped".
        passed: !applicable || -(points as number) <= tolerance,
        dropped: points === undefined ? undefined : -points,
        tolerance,
        baseline: delta?.previous,
        sameBranch: delta?.sameBranch ?? false
    };
}

/** One sentence for the report, the summary and the output channel. */
export function describeRatchet(ratchet: CoverageRatchet): string | undefined {
    if (!ratchet.applicable || ratchet.dropped === undefined) {
        return undefined;
    }
    const scope = ratchet.sameBranch
        ? 'the last run on this branch'
        : `the last run (${ratchet.baseline?.branch ?? 'unknown branch'})`;
    if (!ratchet.passed) {
        return `Line coverage dropped ${ratchet.dropped.toFixed(1)} pts since ${scope}.`;
    }
    return ratchet.dropped > 0
        ? `Line coverage is ${ratchet.dropped.toFixed(1)} pts below ${scope} — within the ${ratchet.tolerance} pt tolerance.`
        : `Line coverage held since ${scope}.`;
}

/** "+1.2 pts since the last run on this branch" — or undefined when unchanged. */
export function describeDelta(delta: CoverageDelta | undefined): string | undefined {
    if (!delta || delta.percentagePoints === undefined) {
        return undefined;
    }
    const points = delta.percentagePoints;
    const scope = delta.sameBranch ? 'the last run on this branch' : `the last run (${delta.previous.branch ?? 'unknown branch'})`;
    if (Math.abs(points) < 0.05) {
        return `unchanged since ${scope}`;
    }
    return `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pts since ${scope}`;
}

/** Per-workspace-folder history, so a multi-root workspace does not mix repos. */
export class CoverageHistoryStore {
    private static readonly KEY = 'sonarcloud.coverageHistory';

    constructor(private readonly memento: vscode.Memento) {}

    get(folder: vscode.WorkspaceFolder): CoverageRun[] {
        const all = this.memento.get<Record<string, CoverageRun[]>>(CoverageHistoryStore.KEY, {});
        const runs = all[folder.uri.fsPath];
        return Array.isArray(runs) ? runs.filter(isCoverageRun) : [];
    }

    async record(folder: vscode.WorkspaceFolder, run: CoverageRun): Promise<void> {
        const all = this.memento.get<Record<string, CoverageRun[]>>(CoverageHistoryStore.KEY, {});
        const next = { ...all, [folder.uri.fsPath]: appendRun(this.get(folder), run) };
        await this.memento.update(CoverageHistoryStore.KEY, next);
    }

    async clear(folder: vscode.WorkspaceFolder): Promise<void> {
        const all = this.memento.get<Record<string, CoverageRun[]>>(CoverageHistoryStore.KEY, {});
        const next = { ...all };
        delete next[folder.uri.fsPath];
        await this.memento.update(CoverageHistoryStore.KEY, next);
    }
}

/** Stored state can predate a schema change, so validate before trusting it. */
function isCoverageRun(value: unknown): value is CoverageRun {
    const run = value as CoverageRun | undefined;
    return (
        !!run &&
        typeof run.at === 'string' &&
        typeof run.linesCovered === 'number' &&
        typeof run.linesTotal === 'number'
    );
}
