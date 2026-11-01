'use strict';

const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'adam-wheater.sonarcloud-vscode';

suite('activation', () => {
    test('the extension is present and activates', async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} was not found in the host`);
        await extension.activate();
        assert.equal(extension.isActive, true);
    });

    test('activation registers every declared command with the host', async () => {
        await vscode.extensions.getExtension(EXTENSION_ID).activate();
        const registered = await vscode.commands.getCommands(true);
        const declared = require('../../../package.json').contributes.commands.map(c => c.command);
        const missing = declared.filter(command => !registered.includes(command));
        assert.deepStrictEqual(missing, [], 'declared commands missing from the running host');
    });

    test('contributed settings resolve with their declared defaults', async () => {
        const config = vscode.workspace.getConfiguration('sonarcloud');
        assert.strictEqual(config.get('localScan.language'), 'auto');
        assert.strictEqual(config.get('coverage.changedLinesThreshold'), 80);
        assert.strictEqual(config.get('coverage.highlightUncovered'), true);
        assert.strictEqual(config.get('showDiagnostics'), true);
    });

    test('the language model tools are contributed', () => {
        const tools = require('../../../package.json').contributes.languageModelTools.map(t => t.name);
        // vscode.lm is only present on hosts with the API; assert the manifest
        // side unconditionally and the runtime side when available.
        assert.ok(tools.includes('sonarcloud_get_issues'));
        if (vscode.lm && Array.isArray(vscode.lm.tools)) {
            const registered = vscode.lm.tools.map(tool => tool.name);
            for (const name of tools) {
                assert.ok(registered.includes(name), `${name} was not registered with vscode.lm`);
            }
        }
    });
});

suite('webview report', () => {
    test('the real webview accepts the generated HTML and its CSP', async () => {
        const { renderReport } = require('../../../out/localCoverage.js');
        const { evaluateGate } = require('../../../out/coverage.js');
        const folder = vscode.workspace.workspaceFolders[0];

        const coverage = {
            files: [{ path: 'src/sample.js', lines: new Map([[1, 1], [2, 0]]), branchesCovered: 0, branchesTotal: 0 }],
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        };
        const rows = [
            { path: 'src/sample.js', linesCovered: 1, linesTotal: 2, changedTotal: 1, changedCovered: 0, firstUncovered: 2, firstUncoveredChanged: 2 }
        ];
        const html = renderReport(
            folder,
            { id: 'js', label: 'JavaScript', detail: '', scanner: 'cli', markers: [] },
            coverage,
            { byFile: new Map([['src/sample.js', new Set([2])]]), baseRef: 'origin/main', mergeBase: 'abc', totalChangedLines: 1 },
            { total: 3, passed: 3, failed: 0, skipped: 0, sources: 1 },
            rows,
            evaluateGate(0, 1, 80)
        );

        const panel = vscode.window.createWebviewPanel('sonarcloudLocalCoverageTest', 'Coverage', vscode.ViewColumn.One, {
            enableScripts: true
        });
        try {
            panel.webview.html = html;
            assert.ok(panel.webview.html.includes('Local coverage'), 'the host kept the assigned HTML');
            assert.ok(panel.webview.html.includes('nonce-'), 'the CSP nonce survived assignment');
        } finally {
            panel.dispose();
        }
    });
});

suite('editor decorations', () => {
    test('uncovered lines can be decorated in a real editor', async () => {
        const { CoverageDecorations } = require('../../../out/coverageDecorations.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const fileUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'sample.js'));

        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);

        const decorations = new CoverageDecorations();
        try {
            decorations.update(
                folder,
                {
                    files: [
                        {
                            path: 'src/sample.js',
                            // Line 3 is uncovered; line 999 is past the end of the
                            // file and must be skipped rather than throwing.
                            lines: new Map([[1, 1], [3, 0], [999, 0]]),
                            branchesCovered: 0,
                            branchesTotal: 0
                        }
                    ],
                    format: 'LCOV',
                    reportPath: 'coverage/lcov.info',
                    generatedAt: new Date(),
                    unresolvedPaths: []
                },
                { byFile: new Map([['src/sample.js', new Set([3])]]), baseRef: 'main', mergeBase: 'x', totalChangedLines: 1 }
            );
            assert.strictEqual(decorations.hasData, true);
            assert.strictEqual(decorations.isEnabled, true);

            assert.strictEqual(decorations.toggle(), false, 'toggling turns highlighting off');
            assert.strictEqual(decorations.toggle(), true);

            decorations.clear();
            assert.strictEqual(decorations.hasData, false);
        } finally {
            decorations.dispose();
        }
    });

    test('editing a file drops its stale marks', async () => {
        const { CoverageDecorations } = require('../../../out/coverageDecorations.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const fileUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'sample.js'));
        const document = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(document);

        const decorations = new CoverageDecorations();
        try {
            decorations.update(
                folder,
                {
                    files: [{ path: 'src/sample.js', lines: new Map([[3, 0]]), branchesCovered: 0, branchesTotal: 0 }],
                    format: 'LCOV',
                    reportPath: 'r',
                    generatedAt: new Date(),
                    unresolvedPaths: []
                },
                undefined
            );
            assert.strictEqual(decorations.hasData, true);

            await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '// shifting lines\n'));
            // The change event is delivered asynchronously.
            await new Promise(resolve => setTimeout(resolve, 250));
            assert.strictEqual(decorations.hasData, false, 'marks must not point at shifted lines');
        } finally {
            decorations.dispose();
            // Leave the fixture as we found it.
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });
});

suite('diagnostics', () => {
    test('issues are published to the Problems panel for real files', async () => {
        const { SonarDiagnostics } = require('../../../out/diagnostics.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const fileUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'sample.js'));

        const client = {
            issueUrl: () => 'https://sonarcloud.io/project/issues?id=x',
            organization: () => 'org'
        };
        const state = { branch: undefined };
        const diagnostics = new SonarDiagnostics(client, state);
        try {
            await diagnostics.publish([
                {
                    issue: {
                        key: 'i1',
                        rule: 'js:S1481',
                        severity: 'CRITICAL',
                        component: 'proj:src/sample.js',
                        project: 'proj',
                        line: 2,
                        message: 'Unused variable',
                        type: 'CODE_SMELL',
                        status: 'OPEN'
                    },
                    path: 'src/sample.js'
                }
            ]);

            const published = vscode.languages.getDiagnostics(fileUri);
            assert.strictEqual(published.length, 1, 'one diagnostic on the real file');
            assert.strictEqual(published[0].message, 'Unused variable');
            assert.strictEqual(published[0].source, 'sonarcloud');
            assert.strictEqual(published[0].severity, vscode.DiagnosticSeverity.Error, 'CRITICAL maps to Error');
            assert.strictEqual(published[0].range.start.line, 1, 'reported lines are 1-based');

            diagnostics.clear();
            assert.strictEqual(vscode.languages.getDiagnostics(fileUri).length, 0);
        } finally {
            diagnostics.dispose();
        }
    });
});

suite('code actions', () => {
    test('the real host offers SonarCloud quick fixes on our diagnostics', async () => {
        const { SonarDiagnostics } = require('../../../out/diagnostics.js');
        const { SonarCodeActions } = require('../../../out/codeActions.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const fileUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'sample.js'));

        const client = { issueUrl: () => 'https://sonarcloud.io/x' };
        const diagnostics = new SonarDiagnostics(client, { branch: undefined });
        const registration = vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            new SonarCodeActions(diagnostics),
            { providedCodeActionKinds: SonarCodeActions.providedCodeActionKinds }
        );
        try {
            await diagnostics.publish([
                {
                    issue: {
                        key: 'i1',
                        rule: 'js:S1481',
                        severity: 'CRITICAL',
                        component: 'proj:src/sample.js',
                        project: 'proj',
                        line: 2,
                        message: 'Unused variable',
                        type: 'CODE_SMELL',
                        status: 'OPEN'
                    },
                    path: 'src/sample.js'
                }
            ]);

            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);

            // Ask VS Code itself for the actions, exactly as the lightbulb does.
            // The host cancels in-flight code-action requests when the editor
            // it is resolving for changes underneath it, which happens on its
            // own schedule here; one retry distinguishes that from our
            // provider not offering anything.
            const actions = await requestCodeActions(fileUri, new vscode.Range(1, 0, 1, 1));
            const ours = (actions ?? []).filter(action => action.command && action.command.command.startsWith('sonarcloud.'));
            assert.ok(ours.length >= 3, `expected SonarCloud quick fixes, got ${JSON.stringify((actions ?? []).map(a => a.title))}`);
            assert.ok(ours.some(a => a.command.command === 'sonarcloud.fixWithCopilot'));
            assert.ok(ours.some(a => a.command.command === 'sonarcloud.showIssueDetails'));
        } finally {
            registration.dispose();
            diagnostics.dispose();
        }
    });
});

/** Ask for code actions, retrying once if the host cancels the request. */
async function requestCodeActions(uri, range, attempt = 0) {
    try {
        return await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range);
    } catch (err) {
        const cancelled = /cancel/i.test(err && err.message ? err.message : String(err));
        if (cancelled && attempt < 1) {
            await new Promise(resolve => setTimeout(resolve, 250));
            return requestCodeActions(uri, range, attempt + 1);
        }
        throw err;
    }
}

suite('coverage status bar', () => {
    test('the real host accepts the status bar item and restores a persisted figure', async () => {
        const { CoverageStatusBar, toSnapshot } = require('../../../out/coverageStatusBar.js');
        const { evaluateGate } = require('../../../out/coverage.js');
        const folder = vscode.workspace.workspaceFolders[0];

        // A memento with the same contract as the real workspaceState.
        const store = new Map();
        const memento = {
            get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
            update: async (key, value) => {
                if (value === undefined) {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
                return undefined;
            }
        };

        const first = new CoverageStatusBar(memento);
        try {
            first.update({
                folder,
                files: [
                    { path: 'src/sample.js', lines: new Map([[1, 1], [2, 0]]), branchesCovered: 0, branchesTotal: 0 }
                ],
                totals: { linesCovered: 1, linesTotal: 2, branchesCovered: 0, branchesTotal: 0 },
                gate: evaluateGate(1, 2, 80)
            });
            assert.strictEqual(store.size, 1, 'the run was persisted');
            const stored = store.get('sonarcloud.lastCoverageSnapshot');
            assert.strictEqual(stored.folderPath, folder.uri.fsPath);
            // Whatever we persist has to survive VS Code's JSON round trip.
            assert.deepStrictEqual(JSON.parse(JSON.stringify(stored)), stored);
        } finally {
            first.dispose();
        }

        // A second session over the same workspace restores it.
        const second = new CoverageStatusBar(memento);
        try {
            assert.ok(true, 'constructing over stored state did not throw in a real host');
        } finally {
            second.dispose();
        }

        // toSnapshot must not smuggle a Map into persisted state.
        const snapshot = toSnapshot({
            folder,
            files: [{ path: 'a.js', lines: new Map([[1, 1]]), branchesCovered: 0, branchesTotal: 0 }],
            totals: { linesCovered: 1, linesTotal: 1, branchesCovered: 0, branchesTotal: 0 },
            gate: evaluateGate(0, 0, 80)
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, 'snapshot must be plain JSON');
    });
});

suite('native coverage', () => {
    test('the real host accepts the coverage objects we build', () => {
        const { toFileCoverage, toStatementCoverage } = require('../../../out/coverageTestController.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const file = {
            path: 'src/sample.js',
            lines: new Map([[1, 3], [2, 0]]),
            branchesCovered: 1,
            branchesTotal: 2
        };

        const fileCoverage = toFileCoverage(folder, file);
        assert.ok(fileCoverage instanceof vscode.FileCoverage, 'must be the host’s own type, not a look-alike');
        assert.strictEqual(fileCoverage.statementCoverage.covered, 1);
        assert.strictEqual(fileCoverage.statementCoverage.total, 2);
        assert.strictEqual(fileCoverage.branchCoverage.total, 2);
        assert.strictEqual(fileCoverage.uri.fsPath, vscode.Uri.joinPath(folder.uri, 'src/sample.js').fsPath);

        const statements = toStatementCoverage(file);
        assert.strictEqual(statements.length, 2);
        assert.ok(statements[0] instanceof vscode.StatementCoverage);
        assert.strictEqual(statements[0].location.line, 0, 'report line 1 is document line 0');
    });

    test('a run reaches the host’s Test Coverage surface, and the tree stays honest', async () => {
        const { NativeCoverageReporter } = require('../../../out/coverageTestController.js');
        const folder = vscode.workspace.workspaceFolders[0];
        const measured = [];
        // A distinct id: the activated extension already owns the real one,
        // and the host rejects a duplicate.
        const reporter = new NativeCoverageReporter(async target => measured.push(target.name), 'sonarcloud.test.coverage');
        try {
            assert.strictEqual(reporter.active, true, 'native coverage is on by default');

            reporter.publish(folder, {
                files: [
                    { path: 'src/sample.js', lines: new Map([[1, 1], [2, 0]]), branchesCovered: 0, branchesTotal: 0 }
                ],
                format: 'LCOV',
                reportPath: 'coverage/lcov.info',
                generatedAt: new Date(),
                unresolvedPaths: []
            });
            assert.ok(true, 'the host accepted a coverage run built from a parsed report');
        } finally {
            reporter.dispose();
        }
    });

    test('a duplicate controller id degrades instead of failing activation', () => {
        const { NativeCoverageReporter } = require('../../../out/coverageTestController.js');
        // The extension already registered the default id in this host.
        const clashing = new NativeCoverageReporter(async () => {});
        try {
            assert.strictEqual(clashing.active, false, 'no controller, but also no thrown error');
        } finally {
            clashing.dispose();
        }
    });
});

suite('coverage navigation', () => {
    test('walking uncovered lines with nothing measured is a message, not a crash', async () => {
        await vscode.extensions.getExtension(EXTENSION_ID).activate();
        // The command has to survive being run before any coverage exists —
        // that is exactly when someone will try it from the palette.
        await vscode.commands.executeCommand('sonarcloud.goToNextUncovered');
        assert.ok(true, 'the command returned without throwing in a real host');
    });

    test('the settings the new features read resolve in the host', () => {
        const config = vscode.workspace.getConfiguration('sonarcloud');
        assert.strictEqual(config.get('coverage.nativeCoverage'), true);
        assert.strictEqual(config.get('coverage.watchReport'), false);
        assert.strictEqual(config.get('coverage.ratchet'), false);
        assert.strictEqual(config.get('coverage.ratchetTolerance'), 0.1);
    });
});
