'use strict';

/**
 * Walking to the lines that still need tests. The ordering rules matter more
 * than they look: landing on the 400th pre-existing gap when you have three
 * uncovered lines in the diff makes the command useless.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup } = require('./harness');

const { nextGapLine, rankGaps } = load('coverageNavigation');

test.afterEach(() => cleanup());

test('the next gap is the first one after the cursor', () => {
    const gaps = { uncovered: [3, 10, 42], uncoveredChanged: [] };
    assert.equal(nextGapLine(gaps, 0), 3);
    assert.equal(nextGapLine(gaps, 3), 10);
    assert.equal(nextGapLine(gaps, 10), 42);
});

test('walking past the last gap wraps to the top', () => {
    // Otherwise the command silently stops working near the end of a file.
    assert.equal(nextGapLine({ uncovered: [3, 10], uncoveredChanged: [] }, 99), 3);
});

test('lines this branch changed come first', () => {
    const gaps = { uncovered: [1, 2, 3, 400], uncoveredChanged: [50, 51] };
    assert.equal(nextGapLine(gaps, 0), 50, 'the pre-existing gaps are not this branch’s problem');
    assert.equal(nextGapLine(gaps, 50), 51);
    assert.equal(nextGapLine(gaps, 51), 50, 'and it cycles within them');
});

test('unsorted report lines are still walked in order', () => {
    assert.equal(nextGapLine({ uncovered: [42, 3, 10], uncoveredChanged: [] }, 3), 10);
});

test('a fully covered file has nowhere to go', () => {
    assert.equal(nextGapLine({ uncovered: [], uncoveredChanged: [] }, 1), undefined);
    assert.equal(nextGapLine(undefined, 1), undefined);
});

test('files are ranked by what this branch owes, then by size of the hole', () => {
    const ranked = rankGaps(
        new Map([
            ['src/old.ts', { uncovered: [1, 2, 3, 4, 5], uncoveredChanged: [] }],
            ['src/mine.ts', { uncovered: [9], uncoveredChanged: [7] }],
            ['src/theirs.ts', { uncovered: [1, 2], uncoveredChanged: [] }],
            ['src/worst.ts', { uncovered: [], uncoveredChanged: [1, 2, 3] }]
        ])
    );
    assert.deepEqual(
        ranked.map(gap => gap.path),
        ['src/worst.ts', 'src/mine.ts', 'src/old.ts', 'src/theirs.ts']
    );
    assert.equal(ranked[0].changed, 3);
    assert.equal(ranked[0].firstLine, 1);
    assert.equal(ranked[1].firstLine, 7, 'landing on the changed line, not the older one');
});

test('files with no gaps are not offered', () => {
    const ranked = rankGaps(new Map([['src/clean.ts', { uncovered: [], uncoveredChanged: [] }]]));
    assert.deepEqual(ranked, []);
});
