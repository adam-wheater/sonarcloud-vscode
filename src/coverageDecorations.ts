import * as path from 'path';
import * as vscode from 'vscode';
import { classifyLines, CoverageData } from './coverage';
import { LineGaps } from './coverageNavigation';
import { ChangedLines } from './gitChanges';

/**
 * Marks uncovered lines in open editors after a local coverage run, so the
 * gaps are visible where the code is being written rather than only in a
 * report. Lines this branch changed get a stronger treatment — those are the
 * ones a reviewer will ask about.
 */
export class CoverageDecorations implements vscode.Disposable {
    private readonly uncovered = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        overviewRulerColor: new vscode.ThemeColor('charts.red'),
        light: { backgroundColor: 'rgba(255, 0, 0, 0.06)' },
        dark: { backgroundColor: 'rgba(255, 0, 0, 0.09)' }
    });

    private readonly uncoveredChanged = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        overviewRulerColor: new vscode.ThemeColor('charts.red'),
        light: { backgroundColor: 'rgba(255, 0, 0, 0.13)' },
        dark: { backgroundColor: 'rgba(255, 0, 0, 0.18)' },
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('charts.red')
    });

    /** Workspace-relative path → lines, for the folder the run covered. */
    private byFile = new Map<string, LineGaps>();
    private folder: vscode.WorkspaceFolder | undefined;
    private enabled = true;
    private readonly listeners: vscode.Disposable[] = [];

    constructor() {
        this.listeners.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this.applyToVisibleEditors()),
            vscode.workspace.onDidChangeTextDocument(event => {
                // Line numbers no longer line up once the file is edited; drop
                // that file's marks rather than pointing at the wrong lines.
                const relative = this.relativePath(event.document.uri);
                if (relative && this.byFile.delete(relative)) {
                    this.applyToVisibleEditors();
                }
            })
        );
    }

    dispose(): void {
        for (const listener of this.listeners) {
            listener.dispose();
        }
        this.uncovered.dispose();
        this.uncoveredChanged.dispose();
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    get hasData(): boolean {
        return this.byFile.size > 0;
    }

    /** The folder the current marks describe, for navigation. */
    get coveredFolder(): vscode.WorkspaceFolder | undefined {
        return this.folder;
    }

    /** Every file with gaps, keyed by workspace-relative path. */
    get gaps(): Map<string, LineGaps> {
        return this.byFile;
    }

    /** Gaps for an open document, or undefined when it is not in the run. */
    gapsFor(uri: vscode.Uri): LineGaps | undefined {
        const relative = this.relativePath(uri);
        return relative ? this.byFile.get(relative) : undefined;
    }

    /** Replace the marks with those from a fresh coverage run. */
    update(folder: vscode.WorkspaceFolder, coverage: CoverageData, changes: ChangedLines | undefined): void {
        this.folder = folder;
        this.byFile = new Map();
        for (const file of coverage.files) {
            const classified = classifyLines(file, changes?.byFile.get(file.path));
            if (classified.uncovered.length > 0 || classified.uncoveredChanged.length > 0) {
                this.byFile.set(file.path, classified);
            }
        }
        this.applyToVisibleEditors();
    }

    clear(): void {
        this.byFile = new Map();
        this.applyToVisibleEditors();
    }

    /** Returns the new state, so callers can report it. */
    toggle(): boolean {
        this.enabled = !this.enabled;
        this.applyToVisibleEditors();
        return this.enabled;
    }

    private applyToVisibleEditors(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const relative = this.relativePath(editor.document.uri);
            const classified = this.enabled && relative ? this.byFile.get(relative) : undefined;
            editor.setDecorations(this.uncovered, toRanges(classified?.uncovered, editor.document, 'Not covered by tests'));
            editor.setDecorations(
                this.uncoveredChanged,
                toRanges(classified?.uncoveredChanged, editor.document, 'Changed on this branch and not covered by tests')
            );
        }
    }

    private relativePath(uri: vscode.Uri): string | undefined {
        if (!this.folder || uri.scheme !== 'file') {
            return undefined;
        }
        const relative = path.relative(this.folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        return relative.startsWith('..') ? undefined : relative;
    }
}

function toRanges(
    lines: number[] | undefined,
    document: vscode.TextDocument,
    hoverMessage: string
): vscode.DecorationOptions[] {
    if (!lines?.length) {
        return [];
    }
    const options: vscode.DecorationOptions[] = [];
    for (const line of lines) {
        const zeroBased = line - 1;
        // Reports can name lines past the end of an edited file.
        if (zeroBased < 0 || zeroBased >= document.lineCount) {
            continue;
        }
        options.push({ range: document.lineAt(zeroBased).range, hoverMessage });
    }
    return options;
}
