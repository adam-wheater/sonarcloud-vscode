'use strict';

/**
 * Native coverage: what VS Code's own Test Coverage view and gutter are handed
 * after a local run. The failure mode here is silent — a controller that never
 * publishes, or publishes lines shifted by one — so these assert on the exact
 * objects, not just that nothing threw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup, vscode, setConfig } = require('./harness');

const { toStatementCoverage, toFileCoverage, NativeCoverageReporter } = load('coverageTestController');

test.afterEach(() => cleanup());

const folder = () => ({ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 });

function file(overrides = {}) {
    return {
        path: 'src/a.ts',
        lines: new Map([
            [3, 0],
            [1, 2],
            [2, 0]
        ]),
        branchesCovered: 0,
        branchesTotal: 0,
        ...overrides
    };
}

test('statements are one-based in the report and zero-based in the editor', () => {
    const statements = toStatementCoverage(file());
    assert.deepEqual(
        statements.map(s => s.location.line),
        [0, 1, 2],
        'line 1 of the report is line 0 of the document, and they come out in order'
    );
    assert.deepEqual(
        statements.map(s => s.executed),
        [2, 0, 0],
        'hit counts survive, so the gutter can distinguish "once" from "never"'
    );
});

test('a line number of zero does not become a negative position', () => {
    // Defensive: a malformed report reaching this far must not throw inside VS Code.
    const statements = toStatementCoverage(file({ lines: new Map([[0, 1]]) }));
    assert.equal(statements[0].location.line, 0);
});

test('file totals count covered lines, not hits', () => {
    const coverage = toFileCoverage(folder(), file({ lines: new Map([[1, 7], [2, 0]]) }));
    assert.equal(coverage.statementCoverage.covered, 1);
    assert.equal(coverage.statementCoverage.total, 2);
    assert.match(coverage.uri.fsPath, /repo[\\/]src[\\/]a\.ts$/);
});

test('branch counts are reported only when the format measured them', () => {
    const without = toFileCoverage(folder(), file());
    assert.equal(without.branchCoverage, undefined, 'a fabricated 0/0 would show as 0% in the UI');

    const with_ = toFileCoverage(folder(), file({ branchesCovered: 3, branchesTotal: 4 }));
    assert.equal(with_.branchCoverage.covered, 3);
    assert.equal(with_.branchCoverage.total, 4);
});

// ------------------------------------------------------------- reporter ---

function reporter(measure = async () => {}) {
    return new NativeCoverageReporter(measure);
}

test('turning the feature off registers nothing at all', () => {
    setConfig('sonarcloud.coverage.nativeCoverage', false);
    const native = reporter();
    try {
        assert.equal(native.active, false);
        assert.equal(vscode.__harness.testControllers.length, 0, 'no empty entry in the Testing view');
    } finally {
        native.dispose();
    }
});

test('one runnable item per workspace folder', () => {
    vscode.__harness.workspaceFolders = [
        { uri: vscode.Uri.file('/one'), name: 'one', index: 0 },
        { uri: vscode.Uri.file('/two'), name: 'two', index: 1 }
    ];
    const native = reporter();
    try {
        const controller = vscode.__harness.testControllers[0];
        assert.equal(controller.items.size, 2);
        assert.deepEqual(
            [...controller.items].map(([, item]) => item.label),
            ['one', 'two']
        );
        assert.equal(controller.profiles.length, 1, 'coverage only — this is not a test runner');
        assert.equal(controller.profiles[0].kind, vscode.TestRunProfileKind.Coverage);
    } finally {
        native.dispose();
    }
});

test('closing a folder removes its item', () => {
    vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/one'), name: 'one', index: 0 }];
    const native = reporter();
    try {
        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/two'), name: 'two', index: 1 }];
        for (const listener of vscode.__harness.workspaceFolderListeners) {
            listener({ added: [], removed: [] });
        }
        const controller = vscode.__harness.testControllers[0];
        assert.deepEqual(
            [...controller.items].map(([, item]) => item.label),
            ['two']
        );
    } finally {
        native.dispose();
    }
});

test('a run is published as one file coverage per measured file', () => {
    vscode.__harness.workspaceFolders = [folder()];
    const native = reporter();
    try {
        native.publish(folder(), {
            files: [file(), file({ path: 'src/b.ts', lines: new Map([[1, 1]]) })],
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        });
        const controller = vscode.__harness.testControllers[0];
        assert.equal(controller.runs.length, 1);
        const run = controller.runs[0];
        assert.equal(run.coverage.length, 2);
        assert.equal(run.persist, false, 'a stale figure must not reappear after a reload');
        assert.equal(run.ended, true, 'an unended run leaves a spinner in the Testing view forever');
        assert.equal(run.request.profile, controller.profiles[0]);
    } finally {
        native.dispose();
    }
});

test('detailed coverage is served per file, and unknown files get nothing', async () => {
    vscode.__harness.workspaceFolders = [folder()];
    const native = reporter();
    try {
        native.publish(folder(), {
            files: [file()],
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        });
        const profile = vscode.__harness.testControllers[0].profiles[0];
        const published = vscode.__harness.testControllers[0].runs[0].coverage[0];
        const details = await profile.loadDetailedCoverage({}, published);
        assert.equal(details.length, 3);

        const unknown = await profile.loadDetailedCoverage({}, { uri: vscode.Uri.file('/repo/src/never.ts') });
        assert.deepEqual(unknown, [], 'better an empty gutter than another file’s lines');
    } finally {
        native.dispose();
    }
});

test('a second run replaces the first run’s details rather than accumulating them', async () => {
    vscode.__harness.workspaceFolders = [folder()];
    const native = reporter();
    try {
        const report = files => ({
            files,
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        });
        native.publish(folder(), report([file()]));
        native.publish(folder(), report([file({ path: 'src/b.ts', lines: new Map([[1, 1]]) })]));

        const profile = vscode.__harness.testControllers[0].profiles[0];
        const stale = await profile.loadDetailedCoverage({}, { uri: vscode.Uri.file('/repo/src/a.ts') });
        assert.deepEqual(stale, [], 'a file no longer in the report must not keep its old marks');
    } finally {
        native.dispose();
    }
});

test('running the item measures the folder it names', async () => {
    vscode.__harness.workspaceFolders = [
        { uri: vscode.Uri.file('/one'), name: 'one', index: 0 },
        { uri: vscode.Uri.file('/two'), name: 'two', index: 1 }
    ];
    const measured = [];
    const native = reporter(async f => measured.push(f.name));
    try {
        const controller = vscode.__harness.testControllers[0];
        const profile = controller.profiles[0];
        const item = controller.items.get(vscode.Uri.file('/two').toString());
        await profile.runHandler({ include: [item] }, { isCancellationRequested: false });
        assert.deepEqual(measured, ['two'], 'not every folder, and not the wrong one');

        await profile.runHandler({ include: undefined }, { isCancellationRequested: false });
        assert.deepEqual(measured, ['two', 'one', 'two'], 'no selection means all of them');
    } finally {
        native.dispose();
    }
});

test('a cancelled run stops before measuring anything else', async () => {
    vscode.__harness.workspaceFolders = [
        { uri: vscode.Uri.file('/one'), name: 'one', index: 0 },
        { uri: vscode.Uri.file('/two'), name: 'two', index: 1 }
    ];
    const measured = [];
    const token = { isCancellationRequested: false };
    const native = reporter(async f => {
        measured.push(f.name);
        token.isCancellationRequested = true;
    });
    try {
        await vscode.__harness.testControllers[0].profiles[0].runHandler({ include: undefined }, token);
        assert.deepEqual(measured, ['one']);
    } finally {
        native.dispose();
    }
});

test('turning the setting off mid-session tears the controller down', () => {
    vscode.__harness.workspaceFolders = [folder()];
    const native = reporter();
    try {
        assert.equal(native.active, true);
        setConfig('sonarcloud.coverage.nativeCoverage', false);
        vscode.__fireConfigurationChange('sonarcloud.coverage.nativeCoverage');
        assert.equal(native.active, false);
        assert.equal(vscode.__harness.testControllers[0].disposed, true);

        setConfig('sonarcloud.coverage.nativeCoverage', true);
        vscode.__fireConfigurationChange('sonarcloud.coverage.nativeCoverage');
        assert.equal(native.active, true, 'and back on again without a reload');
    } finally {
        native.dispose();
    }
});

test('publishing while disabled is a no-op, not a crash', () => {
    setConfig('sonarcloud.coverage.nativeCoverage', false);
    const native = reporter();
    try {
        native.publish(folder(), {
            files: [file()],
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        });
        assert.equal(vscode.__harness.testControllers.length, 0);
    } finally {
        native.dispose();
    }
});
