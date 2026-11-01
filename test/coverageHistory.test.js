'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup, vscode } = require('./harness');

const {
    appendRun,
    deltaAgainstPrevious,
    describeDelta,
    describeRatchet,
    evaluateRatchet,
    CoverageHistoryStore
} = load('coverageHistory');

test.afterEach(() => cleanup());

function run(overrides = {}) {
    return {
        at: new Date().toISOString(),
        branch: 'feature/x',
        linesCovered: 50,
        linesTotal: 100,
        changedCovered: 5,
        changedTotal: 10,
        ...overrides
    };
}

function memento(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => void store.set(key, value),
        store
    };
}

test('runs are stored newest first', () => {
    const history = appendRun(appendRun([], run({ at: 'first' })), run({ at: 'second' }));
    assert.deepEqual(history.map(entry => entry.at), ['second', 'first']);
});

test('history is capped so it cannot grow without bound', () => {
    let history = [];
    for (let i = 0; i < 40; i++) {
        history = appendRun(history, run({ at: `run-${i}` }), 25);
    }
    assert.equal(history.length, 25);
    assert.equal(history[0].at, 'run-39', 'the newest run survives');
});

test('the first ever run has nothing to compare against', () => {
    assert.equal(deltaAgainstPrevious([], run()), undefined);
});

test('an improvement is reported in percentage points', () => {
    const history = [run({ linesCovered: 40, linesTotal: 100 })];
    const delta = deltaAgainstPrevious(history, run({ linesCovered: 55, linesTotal: 100 }));
    assert.equal(Math.round(delta.percentagePoints), 15);
    assert.equal(delta.coveredLines, 15);
    assert.equal(delta.sameBranch, true);
});

test('a regression is reported as a negative delta', () => {
    const history = [run({ linesCovered: 80, linesTotal: 100 })];
    const delta = deltaAgainstPrevious(history, run({ linesCovered: 60, linesTotal: 100 }));
    assert.equal(Math.round(delta.percentagePoints), -20);
    assert.match(describeDelta(delta), /^−20\.0 pts/);
});

test('the same branch is preferred over a more recent run elsewhere', () => {
    // Comparing a feature branch to main mostly measures the branch, not the change.
    const history = [
        run({ branch: 'main', linesCovered: 90, linesTotal: 100, at: 'newest' }),
        run({ branch: 'feature/x', linesCovered: 50, linesTotal: 100, at: 'older' })
    ];
    const delta = deltaAgainstPrevious(history, run({ branch: 'feature/x', linesCovered: 60, linesTotal: 100 }));
    assert.equal(delta.previous.at, 'older');
    assert.equal(delta.sameBranch, true);
    assert.equal(Math.round(delta.percentagePoints), 10);
});

test('with no run on this branch, the most recent one is used and flagged', () => {
    const history = [run({ branch: 'main', linesCovered: 90, linesTotal: 100 })];
    const delta = deltaAgainstPrevious(history, run({ branch: 'feature/new', linesCovered: 80, linesTotal: 100 }));
    assert.equal(delta.sameBranch, false);
    assert.match(describeDelta(delta), /the last run \(main\)/);
});

test('a negligible change reads as unchanged rather than noise', () => {
    const history = [run({ linesCovered: 50, linesTotal: 100 })];
    const delta = deltaAgainstPrevious(history, run({ linesCovered: 50, linesTotal: 100 }));
    assert.match(describeDelta(delta), /^unchanged since/);
});

test('a run with no instrumented lines yields no percentage delta', () => {
    const history = [run({ linesCovered: 0, linesTotal: 0 })];
    const delta = deltaAgainstPrevious(history, run({ linesCovered: 0, linesTotal: 0 }));
    assert.equal(delta.percentagePoints, undefined);
    assert.equal(describeDelta(delta), undefined);
});

test('describeDelta says nothing when there is nothing to say', () => {
    assert.equal(describeDelta(undefined), undefined);
});

// ------------------------------------------------------------------ store ---

const folderA = { uri: { fsPath: '/repo/a' }, name: 'a', index: 0 };
const folderB = { uri: { fsPath: '/repo/b' }, name: 'b', index: 1 };

test('history is kept per workspace folder', async () => {
    const store = new CoverageHistoryStore(memento());
    await store.record(folderA, run({ at: 'a1', linesCovered: 10 }));
    await store.record(folderB, run({ at: 'b1', linesCovered: 90 }));

    assert.deepEqual(store.get(folderA).map(entry => entry.at), ['a1']);
    assert.deepEqual(store.get(folderB).map(entry => entry.at), ['b1'], 'repos must not share history');
});

test('an empty history reads as empty, not as a crash', () => {
    assert.deepEqual(new CoverageHistoryStore(memento()).get(folderA), []);
});

test('corrupt stored state is ignored rather than throwing', () => {
    const store = new CoverageHistoryStore(
        memento({
            'sonarcloud.coverageHistory': {
                '/repo/a': [{ nonsense: true }, { at: 'ok', linesCovered: 1, linesTotal: 2 }, null]
            }
        })
    );
    assert.deepEqual(store.get(folderA).map(entry => entry.at), ['ok'], 'only valid entries survive');
});

test('stored state of the wrong shape entirely is ignored', () => {
    const store = new CoverageHistoryStore(memento({ 'sonarcloud.coverageHistory': { '/repo/a': 'not-an-array' } }));
    assert.deepEqual(store.get(folderA), []);
});

test('clearing one folder leaves the others alone', async () => {
    const store = new CoverageHistoryStore(memento());
    await store.record(folderA, run());
    await store.record(folderB, run());
    await store.clear(folderA);
    assert.deepEqual(store.get(folderA), []);
    assert.equal(store.get(folderB).length, 1);
});

test('recording accumulates rather than replacing', async () => {
    const store = new CoverageHistoryStore(memento());
    await store.record(folderA, run({ at: 'one' }));
    await store.record(folderA, run({ at: 'two' }));
    assert.deepEqual(store.get(folderA).map(entry => entry.at), ['two', 'one']);
});

// -------------------------------------------------------------- ratchet ---

/** A delta of `points` percentage points, positive when coverage rose. */
function delta(points, sameBranch = true) {
    return {
        previous: run({ branch: sameBranch ? 'feature/x' : 'main' }),
        percentagePoints: points,
        coveredLines: 0,
        totalLines: 0,
        sameBranch
    };
}

test('the ratchet is silent until it is turned on', () => {
    const off = evaluateRatchet(delta(-5), false, 0.1);
    assert.equal(off.applicable, false);
    assert.equal(off.passed, true, 'a check nobody asked for cannot fail a run');
    assert.equal(describeRatchet(off), undefined);
});

test('the first ever run has nothing to go backwards from', () => {
    const first = evaluateRatchet(undefined, true, 0.1);
    assert.equal(first.applicable, false);
    assert.equal(first.passed, true);
});

test('a project with no instrumented lines cannot be judged', () => {
    const unmeasurable = evaluateRatchet(delta(undefined), true, 0.1);
    assert.equal(unmeasurable.applicable, false);
    assert.equal(unmeasurable.passed, true);
});

test('coverage going backwards fails the run', () => {
    const dropped = evaluateRatchet(delta(-2.5), true, 0.1);
    assert.equal(dropped.applicable, true);
    assert.equal(dropped.passed, false);
    assert.equal(dropped.dropped, 2.5);
    assert.match(describeRatchet(dropped), /dropped 2\.5 pts since the last run on this branch/);
});

test('a rounding-sized loss is not a regression', () => {
    // Adding two lines of code to a large file moves the percentage without
    // anyone doing anything wrong; failing on that trains people to ignore it.
    const noise = evaluateRatchet(delta(-0.05), true, 0.1);
    assert.equal(noise.passed, true);
    assert.match(describeRatchet(noise), /within the 0\.1 pt tolerance/);
});

test('coverage that improved is reported as held, not as a drop', () => {
    const better = evaluateRatchet(delta(3), true, 0.1);
    assert.equal(better.passed, true);
    assert.equal(better.dropped, -3);
    assert.match(describeRatchet(better), /held since the last run on this branch/);
});

test('a comparison across branches says so', () => {
    // Otherwise "coverage dropped" reads as an accusation about this branch
    // when it is really the difference between two branches.
    const crossed = evaluateRatchet(delta(-4, false), true, 0.1);
    assert.match(describeRatchet(crossed), /the last run \(main\)/);
});

test('the stub is left clean for the next test', () => {
    assert.deepEqual(vscode.__harness.shownMessages, []);
});
