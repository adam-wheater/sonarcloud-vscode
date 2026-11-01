'use strict';

/**
 * The local coverage run, end to end over a real fixture workspace: which
 * report it reads, what it publishes, and — the part that is easy to get
 * wrong — how much of that a *background* refresh is allowed to do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, makeWorkspace, cleanup, vscode, setConfig } = require('./harness');

const { LocalCoverage } = load('localCoverage');
const { CoverageHistoryStore } = load('coverageHistory');
const { CoverageDecorations } = load('coverageDecorations');

test.afterEach(() => cleanup());

const LCOV = ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:3,1', 'end_of_record', ''].join('\n');

function memento(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            store.set(key, value);
        },
        store
    };
}

/** A workspace with a coverage report, and a coverage runner pointed at it. */
function setup(files = { 'coverage/lcov.info': LCOV, 'src/a.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' }) {
    const folder = makeWorkspace(files);
    // Remember the language, so nothing prompts; never run a command.
    const state = { scanLanguage: 'js', setScanLanguage: async () => {} };
    setConfig('sonarcloud.localScan.runCoverageCommand', false);
    const decorations = new CoverageDecorations();
    const history = new CoverageHistoryStore(memento());
    const coverage = new LocalCoverage(state, decorations, history);
    return { folder, coverage, decorations, history };
}

function lastRun(coverage) {
    let seen;
    coverage.onDidRun(run => (seen = run));
    return () => seen;
}

test('a run reads the report and reports what it measured', async () => {
    const { folder, coverage } = setup();
    const runs = lastRun(coverage);
    try {
        await coverage.run({ folder });
        const run = runs();
        assert.ok(run, 'a completed run must be announced, or the status bar never updates');
        assert.equal(run.totals.linesCovered, 2);
        assert.equal(run.totals.linesTotal, 3);
        assert.equal(run.coverage.reportPath, path.join('coverage', 'lcov.info').replace(/\\/g, '/'));
        assert.equal(vscode.__harness.webviewPanels.length, 1, 'an explicit run opens the report');
        assert.ok(vscode.__harness.webviewPanels[0].webview.html.includes('Local coverage'));
    } finally {
        coverage.dispose();
    }
});

test('a background refresh does not open a report over what you are doing', async () => {
    // The whole point of watch mode is that it is invisible until you look.
    const { folder, coverage } = setup();
    const runs = lastRun(coverage);
    try {
        await coverage.refreshFromReport(folder);
        assert.equal(vscode.__harness.webviewPanels.length, 0, 'no panel conjured out of nowhere');
        assert.equal(vscode.__harness.progressRuns.length, 0, 'and no progress notification either');
        assert.ok(runs(), 'but the figures still reach the status bar and gutter');
        assert.deepEqual(vscode.__harness.shownMessages, [], 'and nothing pops up');
    } finally {
        coverage.dispose();
    }
});

test('a background refresh updates a report that is already open', async () => {
    const { folder, coverage } = setup();
    try {
        await coverage.run({ folder });
        const panel = vscode.__harness.webviewPanels[0];
        const revealsAfterRun = panel.reveals;

        fs.writeFileSync(
            path.join(folder.uri.fsPath, 'coverage/lcov.info'),
            ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'end_of_record', ''].join('\n')
        );
        await coverage.refreshFromReport(folder);

        assert.equal(vscode.__harness.webviewPanels.length, 1, 'the same panel, not a second one');
        assert.match(panel.webview.html, /100\.0%/, 'showing the new numbers');
        assert.equal(panel.reveals, revealsAfterRun, 'without stealing focus back');
    } finally {
        coverage.dispose();
    }
});

test('a background refresh does not record a history entry', async () => {
    // Otherwise every file save becomes a "run", and the trend compares this
    // second's numbers against the last one instead of the last real run.
    const { folder, coverage, history } = setup();
    try {
        await coverage.run({ folder });
        assert.equal(history.get(folder).length, 1);
        await coverage.refreshFromReport(folder);
        await coverage.refreshFromReport(folder);
        assert.equal(history.get(folder).length, 1);
    } finally {
        coverage.dispose();
    }
});

test('a background refresh with no remembered language stays silent', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': LCOV });
    setConfig('sonarcloud.localScan.runCoverageCommand', false);
    const coverage = new LocalCoverage(
        { scanLanguage: undefined, setScanLanguage: async () => {} },
        new CoverageDecorations(),
        new CoverageHistoryStore(memento())
    );
    try {
        await coverage.refreshFromReport(folder);
        assert.deepEqual(vscode.__harness.shownMessages, [], 'a file save must not throw a language picker at you');
    } finally {
        coverage.dispose();
    }
});

test('a missing report is reported once, and not as a crash', async () => {
    const { folder, coverage } = setup({ 'src/a.ts': 'export const a = 1;\n' });
    try {
        await coverage.run({ folder });
        assert.equal(vscode.__harness.webviewPanels.length, 0);
        assert.equal(vscode.__harness.shownMessages.length, 1);
        assert.match(vscode.__harness.shownMessages[0].message, /No coverage report was found/);
    } finally {
        coverage.dispose();
    }
});

test('a missing report during a background refresh says so in the log only', async () => {
    const { folder, coverage } = setup({ 'src/a.ts': 'export const a = 1;\n' });
    try {
        await coverage.refreshFromReport(folder);
        assert.deepEqual(vscode.__harness.shownMessages, []);
        const log = vscode.__harness.outputChannels.map(channel => channel.lines.join('')).join('');
        assert.match(log, /watched report has gone away/);
    } finally {
        coverage.dispose();
    }
});

test('a report older than the run is called out as stale, but not on a refresh', async () => {
    const { folder, coverage } = setup();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(folder.uri.fsPath, 'coverage/lcov.info'), old, old);
    try {
        await coverage.run({ folder });
        assert.match(vscode.__harness.webviewPanels[0].webview.html, /was not refreshed by the last run/);

        // A watch refresh reads a report it was told had just changed; the
        // check would fire on every single refresh and mean nothing.
        await coverage.refreshFromReport(folder);
        assert.ok(!vscode.__harness.webviewPanels[0].webview.html.includes('was not refreshed by the last run'));
    } finally {
        coverage.dispose();
    }
});

test('a run already in progress is not started twice', async () => {
    const { folder, coverage } = setup();
    try {
        const first = coverage.run({ folder });
        const second = coverage.run({ folder });
        await Promise.all([first, second]);
        assert.equal(vscode.__harness.webviewPanels.length, 1);
        assert.ok(
            vscode.__harness.shownMessages.some(m => /already in progress/.test(m.message)),
            'the second attempt says why nothing happened'
        );
    } finally {
        coverage.dispose();
    }
});

test('a configured report path that does not exist names the setting', async () => {
    const { folder, coverage } = setup();
    setConfig('sonarcloud.localScan.coverageReportPath', 'nowhere/coverage.xml');
    try {
        await coverage.run({ folder });
        const log = vscode.__harness.outputChannels.map(channel => channel.lines.join('')).join('');
        assert.match(log, /sonarcloud\.localScan\.coverageReportPath/);
        assert.match(log, /Falling back/);
        assert.equal(vscode.__harness.webviewPanels.length, 1, 'and the fallback report is still shown');
    } finally {
        coverage.dispose();
    }
});
