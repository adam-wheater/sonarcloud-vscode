'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup, vscode } = require('./harness');

const { renderCoverageStatus, toSnapshot, isCoverageSnapshot, CoverageStatusBar } = load('coverageStatusBar');
const { evaluateGate } = load('coverage');

test.afterEach(() => cleanup());

function snapshot(overrides = {}) {
    return {
        folderPath: '/repo',
        folderName: 'repo',
        linesCovered: 81,
        linesTotal: 100,
        gate: { applicable: true, passed: true, threshold: 80, percent: 90 },
        files: [{ path: 'src/a.ts', covered: 2, total: 4 }],
        at: new Date().toISOString(),
        ...overrides
    };
}

test('nothing is shown before the first run', () => {
    assert.equal(renderCoverageStatus(undefined, undefined), undefined);
});

test('a project with no instrumented lines shows nothing rather than 0%', () => {
    assert.equal(
        renderCoverageStatus(snapshot({ linesCovered: 0, linesTotal: 0 }), undefined),
        undefined,
        'a meaningless 0% would be worse than silence'
    );
});

test('with no active file it shows the project total', () => {
    const status = renderCoverageStatus(snapshot(), undefined);
    assert.equal(status.text, '$(beaker) 81.0% coverage');
    assert.match(status.tooltip, /repo: 81\.0% \(81\/100 lines\)/);
    assert.match(status.tooltip, /Click to open/);
});

test('with a covered file open it shows that file alongside the total', () => {
    const status = renderCoverageStatus(snapshot(), 'src/a.ts');
    assert.equal(status.text, '$(beaker) 50.0% file · 81.0% all');
    assert.match(status.tooltip, /a\.ts: 50\.0% \(2\/4 lines\)/);
});

test('a file the report does not know about falls back to the total', () => {
    const status = renderCoverageStatus(snapshot(), 'src/unknown.ts');
    assert.equal(status.text, '$(beaker) 81.0% coverage');
});

test('a failed changed-line gate makes the item stand out', () => {
    const status = renderCoverageStatus(
        snapshot({ gate: { applicable: true, passed: false, threshold: 80, percent: 10 } }),
        undefined
    );
    assert.equal(status.alarming, true);
    assert.match(status.text, /\$\(warning\)/);
    assert.match(status.tooltip, /below the 80% threshold/);
});

test('a branch that changed nothing does not mention the gate at all', () => {
    const status = renderCoverageStatus(
        snapshot({ gate: { applicable: false, passed: true, threshold: 80 } }),
        undefined
    );
    assert.equal(status.alarming, false);
    assert.ok(!status.tooltip.includes('threshold'), 'an inapplicable gate is noise');
});

test('a watched figure says so, so you know it keeps itself current', () => {
    const status = renderCoverageStatus(snapshot(), undefined, { watching: true });
    assert.match(status.text, /\$\(eye\)/);
    assert.match(status.tooltip, /Watching the coverage report/);
});

test('a failing gate outranks the watch icon — the problem matters more', () => {
    const status = renderCoverageStatus(
        snapshot({ gate: { applicable: true, passed: false, threshold: 80, percent: 10 } }),
        undefined,
        { watching: true }
    );
    assert.match(status.text, /\$\(warning\)/);
});

// ------------------------------------------------------------ persistence ---

test('a restored figure is labelled as history, not presented as current', () => {
    const restored = renderCoverageStatus(
        snapshot({ fromPreviousSession: true, at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
        undefined
    );
    assert.match(restored.text, /\$\(history\)/, 'a different icon, so it does not read as a fresh measurement');
    assert.match(restored.tooltip, /before this session — the code may have changed since/);
    assert.match(restored.tooltip, /3 hours ago/);
    assert.match(restored.tooltip, /Click to re-measure/);
});

test('a restored failing gate does not raise a fresh alarm', () => {
    // The code may already have been fixed; shouting about it on startup is wrong.
    const restored = renderCoverageStatus(
        snapshot({ fromPreviousSession: true, gate: { applicable: true, passed: false, threshold: 80, percent: 10 } }),
        undefined
    );
    assert.equal(restored.alarming, false);
    assert.match(restored.text, /\$\(history\)/);
});

test('a snapshot keeps only per-file totals, not line maps', () => {
    const run = {
        folder: { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
        files: [
            { path: 'src/a.ts', lines: new Map([[1, 1], [2, 0], [3, 2]]), branchesCovered: 0, branchesTotal: 0 }
        ],
        totals: { linesCovered: 2, linesTotal: 3, branchesCovered: 0, branchesTotal: 0 },
        gate: evaluateGate(1, 2, 80)
    };
    const stored = toSnapshot(run);
    assert.deepEqual(stored.files, [{ path: 'src/a.ts', covered: 2, total: 3 }]);
    assert.equal(stored.folderPath, '/repo');
    assert.ok(Date.parse(stored.at) > 0);
    assert.ok(JSON.stringify(stored).length < 1000, 'the persisted form stays small');
});

test('a very large repo does not persist an unbounded snapshot', () => {
    const files = Array.from({ length: 9000 }, (_, i) => ({
        path: `src/f${i}.ts`,
        lines: new Map([[1, 1]]),
        branchesCovered: 0,
        branchesTotal: 0
    }));
    const stored = toSnapshot({
        folder: { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
        files,
        totals: { linesCovered: 9000, linesTotal: 9000, branchesCovered: 0, branchesTotal: 0 },
        gate: evaluateGate(0, 0, 80)
    });
    assert.equal(stored.files.length, 5000);
    assert.equal(stored.linesTotal, 9000, 'the project total still reflects every file');
});

test('corrupt stored state is rejected rather than rendered', () => {
    assert.equal(isCoverageSnapshot(undefined), false);
    assert.equal(isCoverageSnapshot({}), false);
    assert.equal(isCoverageSnapshot({ folderPath: '/x', linesCovered: 1, linesTotal: 2 }), false);
    assert.equal(isCoverageSnapshot(snapshot()), true);
});

/** Memento backed by a Map, matching the slice the status bar uses. */
function memento(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        store
    };
}

/** Capture status bar items the class creates. */
function captureItems() {
    const items = [];
    const original = vscode.window.createStatusBarItem;
    vscode.window.createStatusBarItem = (id, alignment, priority) => {
        const item = {
            id,
            alignment,
            priority,
            text: '',
            show() {
                this.visible = true;
            },
            hide() {
                this.visible = false;
            },
            dispose() {}
        };
        items.push(item);
        return item;
    };
    return { items, restore: () => (vscode.window.createStatusBarItem = original) };
}

const KEY = 'sonarcloud.lastCoverageSnapshot';

test('a run is persisted and restored on the next session', () => {
    const store = memento();
    const captured = captureItems();
    try {
        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
        const first = new CoverageStatusBar(store);
        first.update({
            folder: { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
            files: [{ path: 'src/a.ts', lines: new Map([[1, 1], [2, 0]]), branchesCovered: 0, branchesTotal: 0 }],
            totals: { linesCovered: 81, linesTotal: 100, branchesCovered: 0, branchesTotal: 0 },
            gate: evaluateGate(9, 10, 80)
        });
        assert.match(captured.items[0].text, /81\.0%/);
        first.dispose();

        // A new session over the same workspace.
        const second = new CoverageStatusBar(store);
        assert.match(captured.items[1].text, /\$\(history\)/, 'restored, and labelled as such');
        assert.match(captured.items[1].text, /81\.0%/);
        assert.equal(captured.items[1].visible, true);
        second.dispose();
    } finally {
        captured.restore();
    }
});

test('a figure for a folder no longer open is not restored', () => {
    const stored = memento({ [KEY]: snapshot({ folderPath: '/some/other/repo' }) });
    const captured = captureItems();
    try {
        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
        const bar = new CoverageStatusBar(stored);
        assert.notEqual(captured.items[0].visible, true, 'it describes somewhere the user is not working');
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('corrupt stored state leaves the status bar hidden', () => {
    const captured = captureItems();
    try {
        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
        const bar = new CoverageStatusBar(memento({ [KEY]: { nonsense: true } }));
        assert.notEqual(captured.items[0].visible, true);
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('clearing removes the persisted figure as well as the item', async () => {
    const store = memento({ [KEY]: snapshot() });
    const captured = captureItems();
    try {
        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
        const bar = new CoverageStatusBar(store);
        assert.equal(captured.items[0].visible, true);
        await bar.clear();
        assert.equal(captured.items[0].visible, false);
        assert.equal(store.store.has(KEY), false, 'it must not come back on the next restart');
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('a snapshot survives a JSON round trip unchanged', () => {
    // Workspace state is persisted as JSON: a Map, a Date or an undefined-valued
    // key would come back different from what was stored.
    const stored = toSnapshot({
        folder: { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
        files: [{ path: 'a.ts', lines: new Map([[1, 1]]), branchesCovered: 0, branchesTotal: 0 }],
        totals: { linesCovered: 1, linesTotal: 1, branchesCovered: 0, branchesTotal: 0 },
        gate: evaluateGate(0, 0, 80)
    });
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored);
    assert.ok(!('percent' in stored.gate), 'an unknown percentage is omitted, not stored as undefined');

    const withPercent = toSnapshot({
        folder: { uri: { fsPath: '/repo' }, name: 'repo', index: 0 },
        files: [],
        totals: { linesCovered: 1, linesTotal: 2, branchesCovered: 0, branchesTotal: 0 },
        gate: evaluateGate(1, 2, 80)
    });
    assert.equal(withPercent.gate.percent, 50);
    assert.deepEqual(JSON.parse(JSON.stringify(withPercent)), withPercent);
});
