'use strict';

/**
 * Watch mode. The dangerous failure here is not "no refresh" — it is reading a
 * report the test runner is halfway through writing and reporting the partial
 * numbers as if they were real, so most of this is about not doing that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, makeWorkspace, cleanup, vscode, setConfig } = require('./harness');

const { waitForStableFile, CoverageWatcher } = load('coverageWatch');

test.afterEach(() => cleanup());

/** Fast timings, so the debounce and settle logic can be exercised in tests. */
const TIMING = { debounceMs: 20, stabilityTimeoutMs: 200, pollMs: 10 };

// ------------------------------------------------------ waitForStableFile ---

/** Stats that change for the first `changes` polls, then hold steady. */
function changingStat(changes) {
    let calls = 0;
    return async () => {
        calls++;
        return { size: calls <= changes ? calls * 10 : changes * 10, mtimeMs: calls <= changes ? calls : changes };
    };
}

test('a file that has stopped changing is read', async () => {
    const stable = await waitForStableFile('/report', {
        stat: changingStat(1),
        wait: async () => {},
        pollMs: 0
    });
    assert.equal(stable, true);
});

test('a file still being written is not read', async () => {
    let now = 0;
    const stable = await waitForStableFile('/report', {
        // Never settles: every poll sees a different size.
        stat: async () => ({ size: ++now, mtimeMs: now }),
        wait: async () => {
            now += 0;
        },
        pollMs: 0,
        timeoutMs: 30
    });
    assert.equal(stable, false, 'half an LCOV file is still valid LCOV — it would parse into wrong numbers');
});

test('a report that disappears mid-write is not read', async () => {
    const stable = await waitForStableFile('/report', {
        stat: async () => {
            throw new Error('ENOENT');
        },
        wait: async () => {},
        pollMs: 0
    });
    assert.equal(stable, false);
});

// ------------------------------------------------------------- watcher ---

test('nothing is watched until the feature is turned on', () => {
    const watcher = new CoverageWatcher(async () => {});
    try {
        watcher.track({ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }, 'coverage/lcov.info');
        assert.equal(watcher.isWatching, false);
        assert.equal(vscode.__harness.fileSystemWatchers.length, 0);
    } finally {
        watcher.dispose();
    }
});

test('the report a run parsed is the report that gets watched', () => {
    setConfig('sonarcloud.coverage.watchReport', true);
    const watcher = new CoverageWatcher(async () => {});
    try {
        watcher.track({ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }, 'coverage/lcov.info');
        assert.equal(watcher.isWatching, true);
        const created = vscode.__harness.fileSystemWatchers;
        assert.equal(created.length, 1);
        assert.equal(created[0].pattern, 'coverage/lcov.info');
        assert.equal(created[0].base, path.resolve('/repo'));
        assert.equal(created[0].ignoreDelete, true, 'a deleted report has nothing to read');
    } finally {
        watcher.dispose();
    }
});

test('a run against a different report moves the watch', () => {
    setConfig('sonarcloud.coverage.watchReport', true);
    const folder = { uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 };
    const watcher = new CoverageWatcher(async () => {});
    try {
        watcher.track(folder, 'coverage/lcov.info');
        watcher.track(folder, 'coverage/lcov.info');
        assert.equal(vscode.__harness.fileSystemWatchers.length, 1, 'the same report does not churn watchers');

        watcher.track(folder, 'TestResults/coverage.xml');
        const watchers = vscode.__harness.fileSystemWatchers;
        assert.equal(watchers.length, 2);
        assert.equal(watchers[0].disposed, true, 'the old report is no longer interesting');
        assert.equal(watchers[1].pattern, 'TestResults/coverage.xml');
    } finally {
        watcher.dispose();
    }
});

test('turning the setting off stops the watch immediately', () => {
    setConfig('sonarcloud.coverage.watchReport', true);
    const watcher = new CoverageWatcher(async () => {});
    try {
        watcher.track({ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }, 'coverage/lcov.info');
        setConfig('sonarcloud.coverage.watchReport', false);
        vscode.__fireConfigurationChange('sonarcloud.coverage.watchReport');
        assert.equal(watcher.isWatching, false);
        assert.equal(vscode.__harness.fileSystemWatchers[0].disposed, true);
    } finally {
        watcher.dispose();
    }
});

test('a burst of writes produces one refresh, against a settled file', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n' });
    setConfig('sonarcloud.coverage.watchReport', true);
    const refreshed = [];
    const watcher = new CoverageWatcher(async f => refreshed.push(f.name), () => {}, TIMING);
    try {
        watcher.track(folder, 'coverage/lcov.info');
        const created = vscode.__harness.fileSystemWatchers[0];
        created.fire('change');
        created.fire('change');
        created.fire('change');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.deepEqual(refreshed, [folder.name], 'a save storm is one refresh, not three');
    } finally {
        watcher.dispose();
    }
});

test('a refresh that throws is logged, not surfaced as a dialog', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\n' });
    setConfig('sonarcloud.coverage.watchReport', true);
    const logged = [];
    const watcher = new CoverageWatcher(
        async () => {
            throw new Error('report is nonsense');
        },
        message => logged.push(message),
        TIMING
    );
    try {
        watcher.track(folder, 'coverage/lcov.info');
        vscode.__harness.fileSystemWatchers[0].fire('change');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(
            logged.some(message => message.includes('report is nonsense')),
            'a background refresh must never interrupt what the user is doing'
        );
        assert.deepEqual(vscode.__harness.shownMessages, []);
    } finally {
        watcher.dispose();
    }
});

test('a report that never settles is skipped rather than half-read', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\n' });
    setConfig('sonarcloud.coverage.watchReport', true);
    const target = path.join(folder.uri.fsPath, 'coverage/lcov.info');
    const rewrite = setInterval(() => fs.appendFileSync(target, 'DA:1,1\n'), 10);
    const refreshed = [];
    const logged = [];
    const watcher = new CoverageWatcher(
        async () => refreshed.push('refreshed'),
        message => logged.push(message),
        TIMING
    );
    try {
        watcher.track(folder, 'coverage/lcov.info');
        vscode.__harness.fileSystemWatchers[0].fire('change');
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.deepEqual(refreshed, []);
        assert.ok(logged.some(message => message.includes('still being written')));
    } finally {
        clearInterval(rewrite);
        watcher.dispose();
    }
});

test('a write that lands during a refresh is not lost', async () => {
    // The tests that finished mid-refresh are exactly the ones you are waiting
    // for; dropping that write leaves the UI a run behind until the next save.
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\n' });
    setConfig('sonarcloud.coverage.watchReport', true);
    let release;
    const blocked = new Promise(resolve => (release = resolve));
    const refreshed = [];
    const watcher = new CoverageWatcher(
        async () => {
            refreshed.push('refresh');
            if (refreshed.length === 1) {
                await blocked;
            }
        },
        () => {},
        TIMING
    );
    try {
        watcher.track(folder, 'coverage/lcov.info');
        const created = vscode.__harness.fileSystemWatchers[0];
        created.fire('change');
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(refreshed.length, 1, 'the first refresh is under way');

        created.fire('change'); // arrives while the first is still running
        await new Promise(resolve => setTimeout(resolve, 120));
        release();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(refreshed.length, 2, 'the write during the refresh is read afterwards');
    } finally {
        release();
        watcher.dispose();
    }
});

test('turning the watch off mid-refresh cancels the queued one', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\n' });
    setConfig('sonarcloud.coverage.watchReport', true);
    let release;
    const blocked = new Promise(resolve => (release = resolve));
    const refreshed = [];
    const watcher = new CoverageWatcher(
        async () => {
            refreshed.push('refresh');
            if (refreshed.length === 1) {
                await blocked;
            }
        },
        () => {},
        TIMING
    );
    try {
        watcher.track(folder, 'coverage/lcov.info');
        const created = vscode.__harness.fileSystemWatchers[0];
        created.fire('change');
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(refreshed.length, 1, 'the first refresh is under way');

        created.fire('change');
        // Long enough for the debounce to elapse, so this write is genuinely
        // queued behind the running refresh rather than still on a timer.
        await new Promise(resolve => setTimeout(resolve, 60));

        setConfig('sonarcloud.coverage.watchReport', false);
        vscode.__fireConfigurationChange('sonarcloud.coverage.watchReport');
        release();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(refreshed.length, 1, 'the queued refresh must not outlive the watch');
    } finally {
        release();
        watcher.dispose();
    }
});

test('the toggle writes where the setting will actually take effect', async () => {
    // Updating Global while a Workspace value exists is silently shadowed by
    // it, and updating Workspace with no folder open throws outright.
    const watcher = new CoverageWatcher(async () => {});
    try {
        vscode.__harness.workspaceFolders = [];
        await watcher.toggle();
        assert.equal(
            vscode.__harness.configurationUpdates.at(-1).target,
            vscode.ConfigurationTarget.Global,
            'a window with no folder has no workspace settings file'
        );

        vscode.__harness.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
        await watcher.toggle();
        assert.equal(vscode.__harness.configurationUpdates.at(-1).target, vscode.ConfigurationTarget.Workspace);
    } finally {
        watcher.dispose();
    }
});

test('the toggle reports the state it moved to', async () => {
    const watcher = new CoverageWatcher(async () => {});
    try {
        assert.equal(await watcher.toggle(), true);
        assert.equal(await watcher.toggle(), false);
    } finally {
        watcher.dispose();
    }
});
