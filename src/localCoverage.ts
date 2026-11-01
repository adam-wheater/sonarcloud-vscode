import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    collectTestTotals,
    CoverageData,
    CoverageGate,
    CoverageTotals,
    evaluateGate,
    FileCoverage,
    parseCoverageReport,
    percent,
    TestTotals,
    totalsFor,
    WorkspaceFileIndex
} from './coverage';
import { CoverageDecorations } from './coverageDecorations';
import {
    CoverageDelta,
    CoverageHistoryStore,
    CoverageRatchet,
    CoverageRun,
    deltaAgainstPrevious,
    describeDelta,
    describeRatchet,
    evaluateRatchet
} from './coverageHistory';
import { detectWorkspaceGitBranch } from './gitBranch';
import { ChangedLines, getChangedLines, resolveBaseRef } from './gitChanges';
import { findCoverageReport, LanguageProfile, resolveCoverageCommand, resolveLanguageProfile } from './languageProfiles';
import { CommandNotFoundError, runTool } from './processRunner';
import { SonarState } from './state';

/**
 * Local coverage report: runs the language's coverage command, parses the
 * report it produces and shows overall/line/condition coverage, unit-test
 * counts and — the pre-merge number — coverage of the lines this branch
 * changed. No SonarCloud round trip, so it can be run as often as tests are.
 */

/** What a completed run measured, for surfaces outside the report panel. */
export interface LocalCoverageRun {
    folder: vscode.WorkspaceFolder;
    files: FileCoverage[];
    totals: CoverageTotals;
    gate: CoverageGate;
    /** The parsed report, for consumers that need the raw data (native coverage). */
    coverage?: CoverageData;
    /** Verdict on "coverage did not go backwards", when that check is on. */
    ratchet?: CoverageRatchet;
}

export interface RunOptions {
    /** Skip the folder prompt — the caller already knows which folder. */
    folder?: vscode.WorkspaceFolder;
    /** False re-reads the existing report instead of re-running the tests. */
    runCommand?: boolean;
    /** False leaves the panel where it is rather than bringing it forward. */
    reveal?: boolean;
    /**
     * A background refresh: no progress notification, no popups, no output
     * channel stealing focus. A watch-triggered run must be invisible until it
     * has something to say.
     */
    quiet?: boolean;
}

/** Tolerance for clock/filesystem granularity when judging report freshness. */
const STALE_REPORT_SLACK_MS = 5000;

interface FileRow {
    path: string;
    linesCovered: number;
    linesTotal: number;
    /** Lines this branch changed that are instrumented. */
    changedTotal: number;
    changedCovered: number;
    /** First uncovered line, for jump-to-source. */
    firstUncovered?: number;
    firstUncoveredChanged?: number;
}

export class LocalCoverage implements vscode.Disposable {
    private running = false;
    private panel: vscode.WebviewPanel | undefined;
    /** Folder the visible report belongs to — the panel outlives a single run. */
    private reportedFolder: vscode.WorkspaceFolder | undefined;
    /** Markdown for the visible report, for the "copy for a PR" button. */
    private lastSummary: string | undefined;
    private readonly output = vscode.window.createOutputChannel('SonarCloud Local Coverage');
    /** Workspace file index per folder, reused between watch refreshes. */
    private readonly fileIndexes = new Map<string, WorkspaceFileIndex>();
    private readonly _onDidRun = new vscode.EventEmitter<LocalCoverageRun>();
    /** Fires when a run completes, so the status bar can show the result. */
    readonly onDidRun = this._onDidRun.event;

    constructor(
        private readonly state: SonarState,
        private readonly decorations: CoverageDecorations,
        private readonly history: CoverageHistoryStore
    ) {}

    dispose(): void {
        this.output.dispose();
        this._onDidRun.dispose();
        this.panel?.dispose();
    }

    /**
     * Show the last report if one is open, otherwise measure. Clicking a status
     * bar item should not silently re-run a whole test suite.
     */
    async reveal(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
            return;
        }
        await this.run();
    }

    /** Re-read the report a previous run parsed, without running any tests. */
    async refreshFromReport(folder: vscode.WorkspaceFolder): Promise<void> {
        await this.run({ folder, runCommand: false, reveal: false, quiet: true });
    }

    async run(options: RunOptions = {}): Promise<void> {
        const quiet = options.quiet === true;
        if (this.running) {
            if (!quiet) {
                void vscode.window.showInformationMessage('A local coverage run is already in progress.');
            }
            return;
        }
        // Claimed before the first await: two clicks, or a watch refresh
        // landing on a manual run, would otherwise both get past the check and
        // run the suite twice.
        this.running = true;
        try {
            await this.execute(options, quiet);
        } finally {
            this.running = false;
        }
    }

    private async execute(options: RunOptions, quiet: boolean): Promise<void> {
        const folder = options.folder ?? (await pickWorkspaceFolder());
        if (!folder) {
            return;
        }
        const profile = await resolveLanguageProfile(folder, this.state, { prompt: !quiet });
        if (!profile) {
            return;
        }
        if (!profile.coverage) {
            if (!quiet) {
                void vscode.window.showInformationMessage(
                    `No coverage format is configured for ${profile.label}. Choose a different language with ` +
                        '"SonarCloud: Select Local Scan Language", or point "sonarcloud.localScan.coverageReportPath" at a report.'
                );
            }
            return;
        }

        if (!quiet) {
            this.output.clear();
        }
        this.output.appendLine(
            `Local coverage for "${folder.name}" — language: ${profile.label}${quiet ? ' (report changed)' : ''}.`
        );
        try {
            const measure = async (
                progress: vscode.Progress<{ message?: string }>,
                cancelToken: vscode.CancellationToken
            ) => this.measure(folder, profile, progress, cancelToken, options);
            if (quiet) {
                const source = new vscode.CancellationTokenSource();
                try {
                    await measure({ report: () => {} }, source.token);
                } finally {
                    source.dispose();
                }
            } else {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Local coverage', cancellable: true },
                    measure
                );
            }
        } catch (err) {
            if (quiet) {
                this.output.appendLine(
                    `Background refresh failed: ${err instanceof Error ? err.message : String(err)}`
                );
            } else if (err instanceof CommandNotFoundError) {
                void vscode.window.showErrorMessage(
                    `${err.message} Install it and make sure it is on PATH, or turn off ` +
                        '"sonarcloud.localScan.runCoverageCommand" to read an existing report instead.'
                );
            } else {
                const message = err instanceof Error ? err.message : String(err);
                const choice = await vscode.window.showErrorMessage(`Local coverage failed: ${message}`, 'Show Output');
                if (choice === 'Show Output') {
                    this.output.show(true);
                }
            }
        }
    }

    private async measure(
        folder: vscode.WorkspaceFolder,
        profile: LanguageProfile,
        progress: vscode.Progress<{ message?: string }>,
        cancelToken: vscode.CancellationToken,
        options: RunOptions
    ): Promise<void> {
        const quiet = options.quiet === true;
        const startedAt = new Date();
        const reportPath =
            options.runCommand === false
                ? await this.locateReport(folder, profile)
                : await this.produceReport(folder, profile, progress, cancelToken);
        if (cancelToken.isCancellationRequested) {
            return;
        }
        if (!reportPath) {
            if (quiet) {
                this.output.appendLine('The watched report has gone away — nothing to re-read.');
                return;
            }
            const hint = profile.coverage?.hint ?? '';
            const choice = await vscode.window.showWarningMessage(
                `No coverage report was found for ${profile.label}. ${hint}`,
                'Show Output'
            );
            if (choice === 'Show Output') {
                this.output.show(true);
            }
            return;
        }

        progress.report({ message: 'reading coverage report…' });
        const coverage = await parseCoverageReport(folder, reportPath, this.fileIndexFor(folder, quiet));
        this.output.appendLine(
            `Parsed ${coverage.format} report "${coverage.reportPath}": ${coverage.files.length} file(s).`
        );
        if (coverage.unresolvedPaths.length > 0) {
            this.output.appendLine(
                `Note: ${coverage.unresolvedPaths.length} reported path(s) did not match a workspace file, ` +
                    `e.g. ${coverage.unresolvedPaths.slice(0, 3).join(', ')}`
            );
        }

        progress.report({ message: 'comparing against the base branch…' });
        const changes = await this.resolveChanges(folder);
        // Anchor test results to the coverage run, so stale files from previous
        // runs do not inflate the counts.
        const tests = await collectTestTotals(folder, { since: coverage.generatedAt });

        // A report older than this run means the coverage command did not
        // refresh it — reading it as current is how people act on numbers that
        // are days out of date. A watch refresh reads a report it was told had
        // just changed, so the check does not apply there.
        const stale =
            options.runCommand !== false &&
            coverage.generatedAt.getTime() < startedAt.getTime() - STALE_REPORT_SLACK_MS;
        if (stale) {
            this.output.appendLine(
                `Warning: "${coverage.reportPath}" was not refreshed by this run (last written ` +
                    `${coverage.generatedAt.toLocaleString()}). The numbers below are from that earlier run.`
            );
        }
        await this.show(folder, profile, coverage, changes, tests, stale, options);
    }

    /** Run the language's coverage command (when enabled), then locate the report. */
    private async produceReport(
        folder: vscode.WorkspaceFolder,
        profile: LanguageProfile,
        progress: vscode.Progress<{ message?: string }>,
        cancelToken: vscode.CancellationToken
    ): Promise<string | undefined> {
        const config = vscode.workspace.getConfiguration('sonarcloud');

        if (config.get<boolean>('localScan.runCoverageCommand', true)) {
            const command = await resolveCoverageCommand(folder, profile);
            if (command) {
                progress.report({ message: `running ${command.label}…` });
                this.output.appendLine(`> ${command.command} ${command.args.join(' ')}`);
                this.output.show(true);
                const result = await runTool(command.command, command.args, folder, cancelToken, this.output);
                if (cancelToken.isCancellationRequested) {
                    return undefined;
                }
                if (result.exitCode !== 0) {
                    this.output.appendLine(
                        `Warning: "${command.label}" exited with code ${result.exitCode} — reporting on whatever coverage it produced.`
                    );
                }
            } else {
                this.output.appendLine(
                    `No coverage command could be inferred for ${profile.label}. ${profile.coverage?.hint ?? ''}`
                );
            }
        }
        return this.locateReport(folder, profile);
    }

    /** Where the report is, without running anything to produce it. */
    private async locateReport(
        folder: vscode.WorkspaceFolder,
        profile: LanguageProfile
    ): Promise<string | undefined> {
        const configured = vscode.workspace
            .getConfiguration('sonarcloud')
            .get<string>('localScan.coverageReportPath', '')
            .trim();
        if (configured) {
            // A configured path that does not exist would otherwise surface as a
            // raw ENOENT; name the setting so the fix is obvious.
            try {
                await fsPromises.access(path.resolve(folder.uri.fsPath, configured));
            } catch {
                this.output.appendLine(
                    `Warning: "sonarcloud.localScan.coverageReportPath" points at "${configured}", which does not ` +
                        'exist. Falling back to the default location for this language.'
                );
                return findCoverageReport(folder, profile);
            }
            return configured;
        }
        return findCoverageReport(folder, profile);
    }

    /**
     * An explicit run always re-walks the workspace, so a file added since the
     * last one resolves; a background refresh reuses what the last run built.
     */
    private fileIndexFor(folder: vscode.WorkspaceFolder, quiet: boolean): WorkspaceFileIndex {
        const key = folder.uri.fsPath;
        let index = this.fileIndexes.get(key);
        if (!index) {
            index = new WorkspaceFileIndex(folder);
            this.fileIndexes.set(key, index);
        }
        if (!quiet) {
            index.invalidate();
        }
        return index;
    }

    private async resolveChanges(folder: vscode.WorkspaceFolder): Promise<ChangedLines | undefined> {
        const configured = vscode.workspace.getConfiguration('sonarcloud').get<string>('coverage.baseBranch', '').trim();
        const baseRef = await resolveBaseRef(folder, configured || undefined);
        if (!baseRef) {
            this.output.appendLine(
                configured
                    ? `Warning: base ref "${configured}" does not exist — skipping changed-line coverage.`
                    : 'No base branch found (looked for origin/main, origin/master, …) — skipping changed-line coverage.'
            );
            return undefined;
        }
        const changes = await getChangedLines(folder, baseRef);
        if (!changes) {
            this.output.appendLine(`Warning: could not diff against "${baseRef}" — skipping changed-line coverage.`);
            return undefined;
        }
        this.output.appendLine(
            `Compared against ${baseRef} (merge base ${changes.mergeBase.slice(0, 8)}): ` +
                `${changes.totalChangedLines} changed line(s) across ${changes.byFile.size} file(s).`
        );
        return changes;
    }

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }
        const panel = vscode.window.createWebviewPanel(
            'sonarcloudLocalCoverage',
            'Local Coverage',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel = panel;
        panel.onDidDispose(() => {
            this.panel = undefined;
        });
        panel.webview.onDidReceiveMessage(async (message: { type: string; path?: string; line?: number }) => {
            const target = this.reportedFolder;
            if (message.type === 'open' && message.path && target) {
                const uri = vscode.Uri.joinPath(target.uri, message.path);
                const line = Math.max((message.line ?? 1) - 1, 0);
                await vscode.window.showTextDocument(uri, {
                    selection: new vscode.Range(line, 0, line, 0),
                    preview: true
                });
            } else if (message.type === 'rerun') {
                void this.run();
            } else if (message.type === 'copy' && this.lastSummary) {
                await vscode.env.clipboard.writeText(this.lastSummary);
                void vscode.window.showInformationMessage('Coverage summary copied as Markdown.');
            }
        });
        return panel;
    }

    private async show(
        folder: vscode.WorkspaceFolder,
        profile: LanguageProfile,
        coverage: CoverageData,
        changes: ChangedLines | undefined,
        tests: TestTotals | undefined,
        stale = false,
        options: RunOptions = {}
    ): Promise<void> {
        const quiet = options.quiet === true;
        const rows = buildRows(coverage.files, changes);
        this.reportedFolder = folder;
        // A background refresh updates a report that is already open; it must
        // never conjure a panel over whatever the user is looking at.
        const panel = quiet ? this.panel : this.ensurePanel();
        const changedSummary = summariseChanged(rows);
        const gate = evaluateGate(
            changedSummary?.covered ?? 0,
            changedSummary?.total ?? 0,
            vscode.workspace.getConfiguration('sonarcloud').get<number>('coverage.changedLinesThreshold', 80)
        );
        const branch = await detectWorkspaceGitBranch();
        const run: CoverageRun = {
            at: new Date().toISOString(),
            branch,
            linesCovered: totalsFor(coverage.files).linesCovered,
            linesTotal: totalsFor(coverage.files).linesTotal,
            changedCovered: changedSummary?.covered ?? 0,
            changedTotal: changedSummary?.total ?? 0,
            testsTotal: tests?.total,
            testsFailed: tests?.failed
        };
        // Compare before recording, so the current run is not its own baseline.
        const delta = deltaAgainstPrevious(this.history.get(folder), run);
        const config = vscode.workspace.getConfiguration('sonarcloud');
        const ratchet = evaluateRatchet(
            delta,
            config.get<boolean>('coverage.ratchet', false),
            config.get<number>('coverage.ratchetTolerance', 0.1)
        );
        // A watch refresh is not a run: recording every file save would fill the
        // history with ticks and leave the ratchet comparing this second's
        // numbers against the last one, instead of against the last real run.
        if (!quiet) {
            await this.history.record(folder, run);
        }

        this.lastSummary = buildMarkdownSummary({
            folderName: folder.name,
            profileLabel: profile.label,
            coverage,
            changes,
            tests,
            rows,
            gate,
            delta,
            ratchet
        });
        if (panel) {
            panel.webview.html = renderReport(
                folder,
                profile,
                coverage,
                changes,
                tests,
                rows,
                gate,
                delta,
                stale,
                ratchet
            );
            if (options.reveal !== false) {
                panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
            }
        }

        if (vscode.workspace.getConfiguration('sonarcloud').get<boolean>('coverage.highlightUncovered', true)) {
            this.decorations.update(folder, coverage, changes);
        }

        const totals = totalsFor(coverage.files);
        this._onDidRun.fire({ folder, files: coverage.files, totals, gate, coverage, ratchet });
        const overall = percent(totals.linesCovered, totals.linesTotal);
        this.output.appendLine(
            `Overall line coverage: ${overall === undefined ? 'n/a' : `${overall.toFixed(1)}%`} ` +
                `(${totals.linesCovered}/${totals.linesTotal} lines).` +
                (changedSummary
                    ? ` Changed lines: ${changedSummary.covered}/${changedSummary.total} covered.`
                    : '')
        );

        const trend = describeDelta(delta);
        if (trend) {
            this.output.appendLine(`Line coverage ${trend}.`);
        }

        if (gate.applicable && !gate.passed) {
            this.output.appendLine(
                `Coverage gate FAILED: ${gate.percent?.toFixed(1)}% of changed lines covered, ` +
                    `below the ${gate.threshold}% required by "sonarcloud.coverage.changedLinesThreshold".`
            );
            if (!quiet) {
                void vscode.window.showWarningMessage(
                    `Changed-line coverage is ${gate.percent?.toFixed(1)}% — below the ${gate.threshold}% threshold.`
                );
            }
        } else if (gate.applicable) {
            this.output.appendLine(
                `Coverage gate passed: ${gate.percent?.toFixed(1)}% of changed lines covered (threshold ${gate.threshold}%).`
            );
        }

        const ratchetNote = describeRatchet(ratchet);
        if (ratchetNote) {
            this.output.appendLine(ratchetNote);
            if (!ratchet.passed && !quiet) {
                void vscode.window.showWarningMessage(ratchetNote);
            }
        }
    }
}

function buildRows(files: FileCoverage[], changes: ChangedLines | undefined): FileRow[] {
    const rows: FileRow[] = [];
    for (const file of files) {
        const changedLines = changes?.byFile.get(file.path);
        let linesCovered = 0;
        let changedTotal = 0;
        let changedCovered = 0;
        let firstUncovered: number | undefined;
        let firstUncoveredChanged: number | undefined;
        for (const [line, hits] of file.lines) {
            const covered = hits > 0;
            if (covered) {
                linesCovered++;
            } else if (firstUncovered === undefined || line < firstUncovered) {
                firstUncovered = line;
            }
            if (changedLines?.has(line)) {
                changedTotal++;
                if (covered) {
                    changedCovered++;
                } else if (firstUncoveredChanged === undefined || line < firstUncoveredChanged) {
                    firstUncoveredChanged = line;
                }
            }
        }
        rows.push({
            path: file.path,
            linesCovered,
            linesTotal: file.lines.size,
            changedTotal,
            changedCovered,
            firstUncovered,
            firstUncoveredChanged
        });
    }
    return rows;
}

/**
 * A paste-ready summary for a pull request description. Deliberately compact:
 * the verdict, the four headline numbers, and the files a reviewer should look
 * at — not the whole repository.
 */
export function buildMarkdownSummary(input: {
    folderName: string;
    profileLabel: string;
    coverage: CoverageData;
    changes: ChangedLines | undefined;
    tests: TestTotals | undefined;
    rows: FileRow[];
    gate: CoverageGate;
    delta?: CoverageDelta;
    ratchet?: CoverageRatchet;
}): string {
    const { folderName, profileLabel, coverage, changes, tests, rows, gate, delta, ratchet } = input;
    const totals = totalsFor(coverage.files);
    const overall = percent(totals.linesCovered, totals.linesTotal);
    const condition = percent(totals.branchesCovered, totals.branchesTotal);
    const changed = summariseChanged(rows);

    const lines: string[] = [`## Local coverage — ${folderName}`, ''];
    if (gate.applicable) {
        lines.push(
            gate.passed
                ? `✅ **Changed-line coverage ${formatPercent(gate.percent)}** meets the ${gate.threshold}% threshold.`
                : `❌ **Changed-line coverage ${formatPercent(gate.percent)}** is below the ${gate.threshold}% threshold.`,
            ''
        );
    }
    if (ratchet?.applicable) {
        lines.push(`${ratchet.passed ? '✅' : '❌'} ${describeRatchet(ratchet)}`, '');
    }

    lines.push('| Metric | Value |', '| --- | --- |');
    const trend = describeDelta(delta);
    lines.push(
        `| Line coverage | ${formatPercent(overall)} (${totals.linesCovered}/${totals.linesTotal})` +
            `${trend ? ` — ${trend}` : ''} |`
    );
    if (totals.branchesTotal > 0) {
        lines.push(
            `| Condition coverage | ${formatPercent(condition)} (${totals.branchesCovered}/${totals.branchesTotal}) |`
        );
    }
    if (changed) {
        lines.push(
            `| Changed lines${changes ? ` vs \`${changes.baseRef}\`` : ''} | ` +
                `${formatPercent(percent(changed.covered, changed.total))} (${changed.covered}/${changed.total}) |`
        );
    }
    if (tests) {
        lines.push(`| Unit tests | ${tests.total} (${tests.failed} failed, ${tests.skipped} skipped) |`);
    }
    lines.push('');

    const gaps = rows
        .filter(row => row.changedTotal > row.changedCovered)
        .sort((a, b) => b.changedTotal - b.changedCovered - (a.changedTotal - a.changedCovered))
        .slice(0, 10);
    if (gaps.length > 0) {
        lines.push('<details><summary>Changed files with uncovered lines</summary>', '');
        lines.push('| File | Uncovered / changed |', '| --- | --- |');
        for (const row of gaps) {
            lines.push(`| \`${row.path}\` | ${row.changedTotal - row.changedCovered} / ${row.changedTotal} |`);
        }
        lines.push('', '</details>', '');
    }

    lines.push(
        `<sub>Measured locally from ${coverage.format} (\`${coverage.reportPath}\`) · ${profileLabel}</sub>`
    );
    return lines.join('\n');
}

function summariseChanged(rows: FileRow[]): { covered: number; total: number } | undefined {
    let covered = 0;
    let total = 0;
    for (const row of rows) {
        covered += row.changedCovered;
        total += row.changedTotal;
    }
    return total > 0 ? { covered, total } : undefined;
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showErrorMessage('Open the folder you want coverage for first.');
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to measure' });
}

// ------------------------------------------------------------------- view ---

export function renderReport(
    folder: vscode.WorkspaceFolder,
    profile: LanguageProfile,
    coverage: CoverageData,
    changes: ChangedLines | undefined,
    tests: TestTotals | undefined,
    rows: FileRow[],
    gate: CoverageGate,
    delta?: CoverageDelta,
    stale = false,
    ratchet?: CoverageRatchet
): string {
    const totals = totalsFor(coverage.files);
    const overall = percent(totals.linesCovered, totals.linesTotal);
    const condition = percent(totals.branchesCovered, totals.branchesTotal);
    const changed = summariseChanged(rows);
    const changedPercent = changed ? percent(changed.covered, changed.total) : undefined;

    const changedRows = rows
        .filter(row => row.changedTotal > 0)
        .sort(
            (a, b) =>
                b.changedTotal - b.changedCovered - (a.changedTotal - a.changedCovered) ||
                b.changedTotal - a.changedTotal
        );
    const worstRows = [...rows]
        .filter(row => row.linesTotal > 0)
        .sort((a, b) => {
            const aPct = a.linesCovered / a.linesTotal;
            const bPct = b.linesCovered / b.linesTotal;
            return aPct - bPct || b.linesTotal - a.linesTotal;
        })
        .slice(0, 40);

    const changedFilesWithoutCoverage = changes
        ? [...changes.byFile.keys()].filter(file => isSourceFile(file) && !rows.some(row => row.path === file))
        : [];

    const nonce = String(Math.random()).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1.5em 3em; line-height: 1.5; }
    h1 { font-size: 1.35em; margin-bottom: 0.2em; }
    h2 { font-size: 1.05em; margin-top: 2em; }
    .sub { opacity: 0.75; font-size: 0.9em; margin-top: 0; }
    .tiles { display: flex; flex-wrap: wrap; gap: 0.8em; margin: 1.4em 0 0.4em; }
    .tile { flex: 1 1 11em; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 0.8em 1em; }
    .tile .label { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
    .tile .value { font-size: 1.7em; font-weight: 600; line-height: 1.2; }
    .tile .detail { font-size: 0.85em; opacity: 0.8; }
    .good { color: var(--vscode-charts-green); }
    .warn { color: var(--vscode-charts-yellow); }
    .bad { color: var(--vscode-charts-red); }
    table { border-collapse: collapse; width: 100%; margin-top: 0.6em; }
    th, td { text-align: left; padding: 0.35em 0.6em; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); }
    th { font-weight: 600; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    a.file { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
    a.file:hover { text-decoration: underline; }
    .bar { display: inline-block; width: 5em; height: 0.55em; border-radius: 3px; background: var(--vscode-editorWidget-border, rgba(128,128,128,0.35)); vertical-align: middle; margin-right: 0.5em; overflow: hidden; }
    .bar > span { display: block; height: 100%; }
    .empty { opacity: 0.75; font-style: italic; }
    .gate { display: flex; align-items: baseline; gap: 0.6em; margin: 1.4em 0 0; padding: 0.7em 1em; border-radius: 6px; border-left: 4px solid; }
    .gate.pass { border-color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 8%, transparent); }
    .gate.fail { border-color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 8%, transparent); }
    .gate .verdict { font-weight: 600; }
    button { font-family: inherit; font-size: 0.9em; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 3px; padding: 0.45em 1em; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>Local coverage — ${escapeHtml(folder.name)}</h1>
<p class="sub">
    ${escapeHtml(profile.label)} · ${escapeHtml(coverage.format)} · <code>${escapeHtml(coverage.reportPath)}</code>
    · produced ${escapeHtml(relativeTime(coverage.generatedAt))}
</p>

${
    stale
        ? `<div class="gate fail">
        <span class="verdict">⚠ This report was not refreshed by the last run</span>
        <span class="detail">The coverage command did not rewrite it, so these numbers are from ${escapeHtml(relativeTime(coverage.generatedAt))}.</span>
    </div>`
        : ''
}
${
    gate.applicable
        ? `<div class="gate ${gate.passed ? 'pass' : 'fail'}">
        <span class="verdict">${gate.passed ? '✓ Changed-line coverage meets the threshold' : '✕ Changed-line coverage is below the threshold'}</span>
        <span class="detail">${formatPercent(gate.percent)} of ${gate.total.toLocaleString()} changed lines covered · threshold ${gate.threshold}%</span>
    </div>`
        : ''
}
${
    ratchet?.applicable
        ? `<div class="gate ${ratchet.passed ? 'pass' : 'fail'}">
        <span class="verdict">${ratchet.passed ? '✓ Coverage did not go backwards' : '✕ Coverage went backwards'}</span>
        <span class="detail">${escapeHtml(describeRatchet(ratchet) ?? '')}</span>
    </div>`
        : ''
}

<div class="tiles">
    ${tile(
        'Line coverage',
        formatPercent(overall),
        [`${totals.linesCovered.toLocaleString()} / ${totals.linesTotal.toLocaleString()} lines`, escapeHtml(describeDelta(delta) ?? '')]
            .filter(Boolean)
            .join(' · '),
        overall
    )}
    ${tile('Condition coverage', formatPercent(condition), totals.branchesTotal > 0 ? `${totals.branchesCovered.toLocaleString()} / ${totals.branchesTotal.toLocaleString()} branches` : 'not reported by this format', condition)}
    ${tile(
        changes ? `Changed lines vs ${escapeHtml(changes.baseRef)}` : 'Changed lines',
        changedPercent === undefined ? '—' : formatPercent(changedPercent),
        changed
            ? `${changed.covered.toLocaleString()} / ${changed.total.toLocaleString()} changed lines covered`
            : changes
              ? 'no instrumented lines changed on this branch'
              : 'no base branch found',
        changedPercent
    )}
    ${tile(
        'Unit tests',
        tests ? tests.total.toLocaleString() : '—',
        tests
            ? `${tests.passed.toLocaleString()} passed · ${tests.failed.toLocaleString()} failed · ${tests.skipped.toLocaleString()} skipped`
            : 'no TRX/JUnit results found',
        tests ? (tests.failed > 0 ? 0 : 100) : undefined
    )}
</div>

<p>
    <button id="rerun" type="button">Re-run coverage</button>
    <button id="copy" type="button">Copy summary for a PR</button>
</p>

<h2>Changed files${changes ? ` (vs ${escapeHtml(changes.baseRef)})` : ''}</h2>
${
    !changes
        ? '<p class="empty">No base branch was found to compare against. Set "sonarcloud.coverage.baseBranch" to choose one.</p>'
        : changedRows.length === 0
          ? '<p class="empty">This branch changes no instrumented lines.</p>'
          : table(
                ['File', 'Changed', 'Covered', 'Uncovered', 'Coverage'],
                changedRows.map(row => {
                    const pct = percent(row.changedCovered, row.changedTotal);
                    return [
                        fileLink(row.path, row.firstUncoveredChanged ?? row.firstUncovered),
                        num(row.changedTotal),
                        num(row.changedCovered),
                        num(row.changedTotal - row.changedCovered),
                        `<td>${bar(pct)}${formatPercent(pct)}</td>`
                    ].join('');
                })
            )
}
${
    changedFilesWithoutCoverage.length > 0
        ? `<p class="empty">${changedFilesWithoutCoverage.length} changed source file(s) have no coverage data at all — ` +
          `e.g. <code>${changedFilesWithoutCoverage.slice(0, 3).map(escapeHtml).join('</code>, <code>')}</code>. ` +
          'They may be excluded from instrumentation, or contain no executable statements.</p>'
        : ''
}

<h2>Lowest coverage files</h2>
${
    worstRows.length === 0
        ? '<p class="empty">No files with instrumented lines were found in the report.</p>'
        : table(
              ['File', 'Lines', 'Covered', 'Uncovered', 'Coverage'],
              worstRows.map(row => {
                  const pct = percent(row.linesCovered, row.linesTotal);
                  return [
                      fileLink(row.path, row.firstUncovered),
                      num(row.linesTotal),
                      num(row.linesCovered),
                      num(row.linesTotal - row.linesCovered),
                      `<td>${bar(pct)}${formatPercent(pct)}</td>`
                  ].join('');
              })
          )
}

<script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element)) {
            return;
        }
        const link = event.target.closest('a.file');
        if (link) {
            event.preventDefault();
            vscodeApi.postMessage({ type: 'open', path: link.dataset.path, line: Number(link.dataset.line) || 1 });
            return;
        }
        if (event.target.id === 'rerun') {
            vscodeApi.postMessage({ type: 'rerun' });
        } else if (event.target.id === 'copy') {
            vscodeApi.postMessage({ type: 'copy' });
        }
    });
</script>
</body>
</html>`;
}

function tile(label: string, value: string, detail: string, pct: number | undefined): string {
    return `<div class="tile">
        <div class="label">${label}</div>
        <div class="value ${qualityClass(pct)}">${value}</div>
        <div class="detail">${detail}</div>
    </div>`;
}

function table(headers: string[], rows: string[]): string {
    const head = headers
        .map((header, index) => `<th${index === 0 ? '' : ' class="num"'}>${escapeHtml(header)}</th>`)
        .join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows.map(row => `<tr>${row}</tr>`).join('')}</tbody></table>`;
}

function fileLink(filePath: string, line: number | undefined): string {
    const name = path.posix.basename(filePath);
    const dir = path.posix.dirname(filePath);
    return `<td><a class="file" data-path="${escapeHtml(filePath)}" data-line="${line ?? 1}" title="${escapeHtml(filePath)}">${escapeHtml(name)}</a>${
        dir && dir !== '.' ? ` <span class="detail" style="opacity:0.6">${escapeHtml(dir)}</span>` : ''
    }</td>`;
}

function num(value: number): string {
    return `<td class="num">${value.toLocaleString()}</td>`;
}

function bar(pct: number | undefined): string {
    if (pct === undefined) {
        return '';
    }
    const color =
        pct >= 80 ? 'var(--vscode-charts-green)' : pct >= 50 ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-red)';
    return `<span class="bar"><span style="width:${pct.toFixed(0)}%;background:${color}"></span></span>`;
}

function qualityClass(pct: number | undefined): string {
    if (pct === undefined) {
        return '';
    }
    return pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'bad';
}

function formatPercent(pct: number | undefined): string {
    return pct === undefined ? '—' : `${pct.toFixed(1)}%`;
}

function relativeTime(date: Date): string {
    const seconds = Math.max((Date.now() - date.getTime()) / 1000, 0);
    if (seconds < 90) {
        return 'just now';
    }
    const minutes = seconds / 60;
    if (minutes < 90) {
        return `${Math.round(minutes)} minutes ago`;
    }
    const hours = minutes / 60;
    return hours < 36 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;
}

function isSourceFile(filePath: string): boolean {
    return /\.(cs|vb|fs|ts|tsx|js|jsx|mjs|cjs|dart|java|kt|py|go|php|rb|scala|swift)$/i.test(filePath);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
