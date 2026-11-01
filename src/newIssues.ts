import * as vscode from 'vscode';

/**
 * Which issues appeared since you last looked. SonarCloud's own "new code"
 * filter answers a different question — it is scoped to the project's new-code
 * period, which can be weeks wide and includes everything you have already
 * seen and triaged. This is the narrower, more useful one before a merge:
 * what turned up since the last time this workspace saw the list.
 *
 * The baseline lives in workspace state and is never a source of truth: if it
 * is missing, capped or corrupt, nothing is marked new. A false "new" badge is
 * worse than no badge, because it makes the badge unusable.
 */

export interface IssueBaseline {
    /** ISO timestamp the baseline was taken. */
    at: string;
    keys: string[];
    /** True when the project had more issues than we are willing to store. */
    truncated?: boolean;
}

/**
 * issues/search refuses to page past the 10,000th result, so a complete load
 * can never exceed this — anything larger is a defensive limit, not a real
 * one, and truncation switches the badge off rather than lying.
 */
export const MAX_BASELINE_KEYS = 10000;

/**
 * Baselines to keep. Every project/branch pair the workspace visits stores
 * one, so without a cap a long-lived workspace accumulates them forever —
 * megabytes of workspace state for branches deleted months ago.
 */
export const MAX_BASELINE_SCOPES = 8;

export function toBaseline(issueKeys: string[], at: Date = new Date()): IssueBaseline {
    const truncated = issueKeys.length > MAX_BASELINE_KEYS;
    return {
        at: at.toISOString(),
        keys: issueKeys.slice(0, MAX_BASELINE_KEYS),
        // Only stored when true, so a JSON round trip is an identity.
        ...(truncated ? { truncated: true } : {})
    };
}

/**
 * Keys present now but not in the baseline. A truncated baseline would report
 * every dropped key as new, so it reports nothing instead.
 */
export function newIssueKeys(baseline: IssueBaseline | undefined, issueKeys: string[]): Set<string> {
    if (!baseline || baseline.truncated) {
        return new Set();
    }
    const known = new Set(baseline.keys);
    return new Set(issueKeys.filter(key => !known.has(key)));
}

/** "3 new since 2 hours ago" for the view header; nothing when there is nothing new. */
export function describeNewIssues(count: number, since: string | undefined): string | undefined {
    if (count <= 0 || !since) {
        return undefined;
    }
    return `${count} new since ${since}`;
}

export function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) {
        return 'your last check';
    }
    const minutes = Math.max((Date.now() - then) / 60000, 0);
    if (minutes < 2) {
        return 'a moment ago';
    }
    if (minutes < 90) {
        return `${Math.round(minutes)} minutes ago`;
    }
    const hours = minutes / 60;
    return hours < 36 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
}

export function isIssueBaseline(value: unknown): value is IssueBaseline {
    const baseline = value as IssueBaseline | undefined;
    return !!baseline && typeof baseline.at === 'string' && Array.isArray(baseline.keys);
}

/** Keep the most recently taken baselines; drop the rest, and anything corrupt. */
function prune(all: Record<string, unknown>): Record<string, IssueBaseline> {
    const valid = Object.entries(all).filter((entry): entry is [string, IssueBaseline] => isIssueBaseline(entry[1]));
    valid.sort((a, b) => (Date.parse(b[1].at) || 0) - (Date.parse(a[1].at) || 0));
    return Object.fromEntries(valid.slice(0, MAX_BASELINE_SCOPES));
}

/** Per project and branch, so switching either does not mix two issue lists. */
export class IssueBaselineStore {
    private static readonly KEY = 'sonarcloud.issueBaseline';

    constructor(private readonly memento: vscode.Memento) {}

    static scope(projectKey: string, branch: string | undefined): string {
        return `${projectKey}@@${branch ?? ''}`;
    }

    get(projectKey: string, branch: string | undefined): IssueBaseline | undefined {
        const all = this.memento.get<Record<string, unknown>>(IssueBaselineStore.KEY, {});
        const stored = all[IssueBaselineStore.scope(projectKey, branch)];
        return isIssueBaseline(stored) ? stored : undefined;
    }

    async set(projectKey: string, branch: string | undefined, baseline: IssueBaseline): Promise<void> {
        const all = this.memento.get<Record<string, unknown>>(IssueBaselineStore.KEY, {});
        const next = { ...all, [IssueBaselineStore.scope(projectKey, branch)]: baseline };
        await this.memento.update(IssueBaselineStore.KEY, prune(next));
    }
}
