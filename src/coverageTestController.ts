import * as vscode from 'vscode';
import { CoverageData, FileCoverage } from './coverage';

/**
 * Publishes a local coverage run through VS Code's own coverage API, so the
 * numbers land in the Test Coverage view and the editor's coverage gutter —
 * the same places every other coverage-producing extension puts them — rather
 * than only in our report panel.
 *
 * A controller needs something runnable to hang a coverage profile off, so we
 * register one item per workspace folder. That is honest: "measure this folder"
 * is exactly what running it does. Only a coverage profile is registered, so
 * the item never pretends to be a test suite you can run without coverage.
 */

const CONTROLLER_ID = 'sonarcloud.localCoverage';

/** Absolute line hit counts as VS Code's per-line statement coverage. */
export function toStatementCoverage(file: FileCoverage): vscode.StatementCoverage[] {
    const statements: vscode.StatementCoverage[] = [];
    for (const [line, hits] of [...file.lines].sort((a, b) => a[0] - b[0])) {
        statements.push(new vscode.StatementCoverage(hits, new vscode.Position(Math.max(line - 1, 0), 0)));
    }
    return statements;
}

/**
 * File-level summary. Branch counts come from the report's own per-file totals
 * rather than being derived from the statements: the formats we parse report
 * branches per file, not per line, and inventing per-line branches would put
 * numbers in the UI that the report never measured.
 */
export function toFileCoverage(folder: vscode.WorkspaceFolder, file: FileCoverage): vscode.FileCoverage {
    let covered = 0;
    for (const hits of file.lines.values()) {
        if (hits > 0) {
            covered++;
        }
    }
    return new vscode.FileCoverage(
        vscode.Uri.joinPath(folder.uri, file.path),
        new vscode.TestCoverageCount(covered, file.lines.size),
        file.branchesTotal > 0 ? new vscode.TestCoverageCount(file.branchesCovered, file.branchesTotal) : undefined
    );
}

/** The API landed in 1.88; guard anyway so an older host degrades instead of failing to activate. */
export function nativeCoverageAvailable(): boolean {
    return typeof vscode.tests?.createTestController === 'function' && typeof vscode.FileCoverage === 'function';
}

export class NativeCoverageReporter implements vscode.Disposable {
    private controller: vscode.TestController | undefined;
    private profile: vscode.TestRunProfile | undefined;
    /** File URI → per-line detail, resolved lazily when the gutter asks for it. */
    private details = new Map<string, vscode.StatementCoverage[]>();
    private readonly listeners: vscode.Disposable[] = [];

    constructor(
        private readonly measure: (folder: vscode.WorkspaceFolder) => Promise<void>,
        /** Overridable so a second instance can coexist with the extension's own. */
        private readonly controllerId: string = CONTROLLER_ID
    ) {
        this.listeners.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('sonarcloud.coverage.nativeCoverage')) {
                    this.syncEnabled();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncItems())
        );
        this.syncEnabled();
    }

    dispose(): void {
        for (const listener of this.listeners) {
            listener.dispose();
        }
        this.teardown();
    }

    /** True when a controller is registered — the tests assert on this rather than on VS Code internals. */
    get active(): boolean {
        return !!this.controller;
    }

    /** Hand a completed run to VS Code. A no-op when native coverage is off. */
    publish(folder: vscode.WorkspaceFolder, coverage: CoverageData): void {
        if (!this.controller || !this.profile) {
            return;
        }
        const item = this.itemFor(folder);
        const request = new vscode.TestRunRequest(item ? [item] : undefined, undefined, this.profile);
        const run = this.controller.createTestRun(request, 'Local coverage', false);
        this.details = new Map();
        try {
            for (const file of coverage.files) {
                const fileCoverage = toFileCoverage(folder, file);
                this.details.set(fileCoverage.uri.toString(), toStatementCoverage(file));
                run.addCoverage(fileCoverage);
            }
        } finally {
            run.end();
        }
    }

    private syncEnabled(): void {
        const enabled =
            vscode.workspace.getConfiguration('sonarcloud').get<boolean>('coverage.nativeCoverage', true) &&
            nativeCoverageAvailable();
        if (enabled && !this.controller) {
            this.setup();
        } else if (!enabled && this.controller) {
            this.teardown();
        }
    }

    private setup(): void {
        let controller: vscode.TestController;
        try {
            controller = vscode.tests.createTestController(this.controllerId, 'SonarCloud Local Coverage');
        } catch (err) {
            // The host refuses a duplicate controller id. Losing the native
            // view is a shame; failing activation over it would be worse.
            console.warn(`SonarCloud: native coverage unavailable — ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        this.controller = controller;
        this.profile = controller.createRunProfile(
            'Local Coverage',
            vscode.TestRunProfileKind.Coverage,
            (request, token) => this.handleRun(request, token),
            true
        );
        this.profile.loadDetailedCoverage = async (_run, fileCoverage) =>
            this.details.get(fileCoverage.uri.toString()) ?? [];
        this.syncItems();
    }

    private teardown(): void {
        this.profile?.dispose();
        this.controller?.dispose();
        this.profile = undefined;
        this.controller = undefined;
        this.details = new Map();
    }

    /** One item per folder, so a multi-root workspace can measure each separately. */
    private syncItems(): void {
        const controller = this.controller;
        if (!controller) {
            return;
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const wanted = new Set(folders.map(folder => folder.uri.toString()));
        for (const [id] of [...controller.items].filter(([id]) => !wanted.has(id))) {
            controller.items.delete(id);
        }
        for (const folder of folders) {
            const id = folder.uri.toString();
            if (!controller.items.get(id)) {
                controller.items.add(controller.createTestItem(id, folder.name, folder.uri));
            }
        }
    }

    private itemFor(folder: vscode.WorkspaceFolder): vscode.TestItem | undefined {
        return this.controller?.items.get(folder.uri.toString());
    }

    private async handleRun(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const requested = request.include?.length
            ? folders.filter(folder => request.include!.some(item => item.id === folder.uri.toString()))
            : folders;
        for (const folder of requested) {
            if (token.isCancellationRequested) {
                return;
            }
            // measure() publishes back through publish(), which opens its own
            // run — the coverage is the result, so there is nothing to report
            // on a run of our own.
            await this.measure(folder);
        }
    }
}
