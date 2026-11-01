import * as path from 'path';
import * as vscode from 'vscode';
import { percent } from './coverage';
import { LocalCoverageRun } from './localCoverage';

/**
 * Keeps the last local coverage result in the status bar. Two reasons this
 * earns its place: the report itself is reachable only from an icon inside a
 * sidebar view, which is easy to miss entirely; and "how well covered is the
 * file I am looking at" is the question you have while editing, not after
 * opening a report.
 *
 * The result survives a restart, but a restored figure describes the code as
 * it was, not as it is — so it is always labelled as such rather than being
 * presented as a current measurement.
 */

/** Per-file totals only: enough for the status bar, small enough to persist. */
export interface FileSummary {
    path: string;
    covered: number;
    total: number;
}

export interface CoverageSnapshot {
    folderPath: string;
    folderName: string;
    linesCovered: number;
    linesTotal: number;
    gate: { applicable: boolean; passed: boolean; threshold: number; percent?: number };
    files: FileSummary[];
    /** ISO timestamp of the run. */
    at: string;
    /** True when restored from storage rather than measured this session. */
    fromPreviousSession?: boolean;
}

export interface CoverageStatus {
    text: string;
    tooltip: string;
    /** True when the changed-line gate failed, so the item should stand out. */
    alarming: boolean;
}

/** What the status bar needs to know beyond the numbers themselves. */
export interface CoverageStatusContext {
    /** True while the report is being watched for changes. */
    watching?: boolean;
}

/** Persisting every file of a very large repo is not worth the workspace state. */
const MAX_PERSISTED_FILES = 5000;

export function toSnapshot(run: LocalCoverageRun): CoverageSnapshot {
    return {
        folderPath: run.folder.uri.fsPath,
        folderName: run.folder.name,
        linesCovered: run.totals.linesCovered,
        linesTotal: run.totals.linesTotal,
        gate: {
            applicable: run.gate.applicable,
            passed: run.gate.passed,
            threshold: run.gate.threshold,
            // Omitted rather than set to undefined: JSON.stringify drops
            // undefined keys, so the stored shape would not match what we
            // wrote and a round trip would not be an identity.
            ...(run.gate.percent === undefined ? {} : { percent: run.gate.percent })
        },
        files: run.files.slice(0, MAX_PERSISTED_FILES).map(file => ({
            path: file.path,
            covered: [...file.lines.values()].filter(hits => hits > 0).length,
            total: file.lines.size
        })),
        at: new Date().toISOString()
    };
}

/**
 * Pure rendering, so the wording is testable: the active file's coverage when
 * the snapshot knows about it, plus the project total.
 */
export function renderCoverageStatus(
    snapshot: CoverageSnapshot | undefined,
    activeRelativePath: string | undefined,
    context: CoverageStatusContext = {}
): CoverageStatus | undefined {
    if (!snapshot) {
        return undefined;
    }
    const overall = percent(snapshot.linesCovered, snapshot.linesTotal);
    if (overall === undefined) {
        return undefined;
    }

    const failing = snapshot.gate.applicable && !snapshot.gate.passed;
    // A restored figure gets its own icon: it is history, not a measurement.
    // A watched figure gets one too — it says the number keeps itself current,
    // which changes how much you should trust it.
    const icon = snapshot.fromPreviousSession
        ? '$(history)'
        : failing
          ? '$(warning)'
          : context.watching
            ? '$(eye)'
            : '$(beaker)';

    const activeFile = activeRelativePath
        ? snapshot.files.find(file => file.path === activeRelativePath)
        : undefined;

    const tooltip: string[] = [];
    let text: string;
    if (activeFile && activeFile.total > 0) {
        text = `${icon} ${format(percent(activeFile.covered, activeFile.total))} file · ${format(overall)} all`;
        tooltip.push(
            `${path.posix.basename(activeFile.path)}: ${format(percent(activeFile.covered, activeFile.total))} ` +
                `(${activeFile.covered}/${activeFile.total} lines)`
        );
    } else {
        text = `${icon} ${format(overall)} coverage`;
    }

    tooltip.push(`${snapshot.folderName}: ${format(overall)} (${snapshot.linesCovered}/${snapshot.linesTotal} lines)`);
    if (snapshot.gate.applicable) {
        tooltip.push(
            snapshot.gate.passed
                ? `Changed lines ${format(snapshot.gate.percent)} — meets the ${snapshot.gate.threshold}% threshold.`
                : `Changed lines ${format(snapshot.gate.percent)} — below the ${snapshot.gate.threshold}% threshold.`
        );
    }
    if (snapshot.fromPreviousSession) {
        tooltip.push(
            `Measured ${relativeTime(snapshot.at)}, before this session — the code may have changed since.`,
            'Click to re-measure.'
        );
    } else if (context.watching) {
        tooltip.push('Watching the coverage report — this updates when your tests rewrite it.');
        tooltip.push('Click to open the local coverage report.');
    } else {
        tooltip.push('Click to open the local coverage report.');
    }

    return { text, tooltip: tooltip.join('\n'), alarming: failing && !snapshot.fromPreviousSession };
}

function format(value: number | undefined): string {
    return value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) {
        return 'previously';
    }
    const minutes = Math.max((Date.now() - then) / 60000, 0);
    if (minutes < 90) {
        return `${Math.round(minutes)} minutes ago`;
    }
    const hours = minutes / 60;
    return hours < 36 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/** Stored state can predate a schema change, so validate before trusting it. */
export function isCoverageSnapshot(value: unknown): value is CoverageSnapshot {
    const snapshot = value as CoverageSnapshot | undefined;
    return (
        !!snapshot &&
        typeof snapshot.folderPath === 'string' &&
        typeof snapshot.linesCovered === 'number' &&
        typeof snapshot.linesTotal === 'number' &&
        Array.isArray(snapshot.files) &&
        !!snapshot.gate &&
        typeof snapshot.gate.applicable === 'boolean'
    );
}

export class CoverageStatusBar implements vscode.Disposable {
    private static readonly KEY = 'sonarcloud.lastCoverageSnapshot';

    private readonly item = vscode.window.createStatusBarItem(
        'sonarcloud.localCoverage',
        vscode.StatusBarAlignment.Left,
        49
    );
    private snapshot: CoverageSnapshot | undefined;
    private context: CoverageStatusContext = {};
    private readonly listeners: vscode.Disposable[] = [];

    constructor(private readonly memento: vscode.Memento) {
        this.item.name = 'Local Coverage';
        this.item.command = 'sonarcloud.openCoverageReport';
        this.listeners.push(vscode.window.onDidChangeActiveTextEditor(() => this.render()));
        this.restore();
    }

    dispose(): void {
        for (const listener of this.listeners) {
            listener.dispose();
        }
        this.item.dispose();
    }

    /** Tell the item whether the report is being watched, and repaint. */
    setWatching(watching: boolean): void {
        this.context = { ...this.context, watching };
        this.render();
    }

    update(run: LocalCoverageRun): void {
        this.snapshot = toSnapshot(run);
        void this.memento.update(CoverageStatusBar.KEY, this.snapshot);
        this.render();
    }

    async clear(): Promise<void> {
        this.snapshot = undefined;
        await this.memento.update(CoverageStatusBar.KEY, undefined);
        this.render();
    }

    private restore(): void {
        const stored = this.memento.get<unknown>(CoverageStatusBar.KEY);
        if (!isCoverageSnapshot(stored)) {
            return;
        }
        // Only restore for a folder still open, or the figure belongs to
        // somewhere the user is no longer working.
        const open = (vscode.workspace.workspaceFolders ?? []).some(
            folder => folder.uri.fsPath === stored.folderPath
        );
        if (!open) {
            return;
        }
        this.snapshot = { ...stored, fromPreviousSession: true };
        this.render();
    }

    private render(): void {
        const status = renderCoverageStatus(this.snapshot, this.activeRelativePath(), this.context);
        if (!status) {
            this.item.hide();
            return;
        }
        this.item.text = status.text;
        this.item.tooltip = status.tooltip;
        this.item.backgroundColor = status.alarming
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        this.item.show();
    }

    private activeRelativePath(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.snapshot || editor.document.uri.scheme !== 'file') {
            return undefined;
        }
        const relative = path.relative(this.snapshot.folderPath, editor.document.uri.fsPath).replace(/\\/g, '/');
        return relative.startsWith('..') ? undefined : relative;
    }
}
