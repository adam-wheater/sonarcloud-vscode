'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const { evaluateGate, classifyLines } = load('coverage');

test('a branch above the threshold passes', () => {
    const gate = evaluateGate(9, 10, 80);
    assert.equal(gate.applicable, true);
    assert.equal(gate.passed, true);
    assert.equal(gate.percent, 90);
});

test('a branch below the threshold fails', () => {
    const gate = evaluateGate(5, 10, 80);
    assert.equal(gate.passed, false);
    assert.equal(gate.percent, 50);
});

test('exactly meeting the threshold passes', () => {
    assert.equal(evaluateGate(8, 10, 80).passed, true);
});

test('a branch that changes no instrumented lines passes trivially', () => {
    // Failing here would train people to ignore the gate.
    const gate = evaluateGate(0, 0, 80);
    assert.equal(gate.applicable, false);
    assert.equal(gate.passed, true);
});

test('a zero threshold disables the gate', () => {
    const gate = evaluateGate(0, 100, 0);
    assert.equal(gate.applicable, false);
    assert.equal(gate.passed, true);
});

test('the gate reports the numbers it judged', () => {
    const gate = evaluateGate(3, 4, 50);
    assert.equal(gate.covered, 3);
    assert.equal(gate.total, 4);
    assert.equal(gate.threshold, 50);
});

function fileWith(lines) {
    return { path: 'a.ts', lines: new Map(lines), branchesCovered: 0, branchesTotal: 0 };
}

test('classifyLines separates uncovered changed lines from the rest', () => {
    const file = fileWith([
        [1, 1],
        [2, 0],
        [3, 0],
        [4, 5]
    ]);
    const classified = classifyLines(file, new Set([3, 4]));
    assert.deepEqual(classified.uncovered, [2], 'uncovered but untouched by this branch');
    assert.deepEqual(classified.uncoveredChanged, [3], 'uncovered and changed here');
});

test('classifyLines with no diff treats everything as ordinary uncovered', () => {
    const classified = classifyLines(fileWith([[1, 0], [2, 0]]), undefined);
    assert.deepEqual(classified.uncovered, [1, 2]);
    assert.deepEqual(classified.uncoveredChanged, []);
});

test('classifyLines returns lines in ascending order', () => {
    const classified = classifyLines(fileWith([[9, 0], [2, 0], [5, 0]]), undefined);
    assert.deepEqual(classified.uncovered, [2, 5, 9]);
});

test('a fully covered file produces nothing to mark', () => {
    const classified = classifyLines(fileWith([[1, 3], [2, 1]]), new Set([1, 2]));
    assert.deepEqual(classified.uncovered, []);
    assert.deepEqual(classified.uncoveredChanged, []);
});

// --- Markdown summary (the paste-into-a-PR path) ---

const { buildMarkdownSummary } = load('localCoverage');

function summaryInput(overrides = {}) {
    return {
        folderName: 'my-service',
        profileLabel: 'Go',
        coverage: {
            files: [{ path: 'a.go', lines: new Map([[1, 1], [2, 0]]), branchesCovered: 1, branchesTotal: 2 }],
            format: 'Go coverage profile',
            reportPath: 'coverage.out',
            generatedAt: new Date(),
            unresolvedPaths: []
        },
        changes: { byFile: new Map([['a.go', new Set([2])]]), baseRef: 'origin/main', mergeBase: 'abc', totalChangedLines: 1 },
        tests: { total: 12, passed: 11, failed: 1, skipped: 0, sources: 1 },
        rows: [{ path: 'a.go', linesCovered: 1, linesTotal: 2, changedTotal: 1, changedCovered: 0 }],
        gate: evaluateGate(0, 1, 80),
        ...overrides
    };
}

test('markdown summary leads with the gate verdict', () => {
    const failing = buildMarkdownSummary(summaryInput());
    assert.match(failing, /❌ \*\*Changed-line coverage 0\.0%\*\* is below the 80% threshold/);

    const passing = buildMarkdownSummary(summaryInput({ gate: evaluateGate(1, 1, 80) }));
    assert.match(passing, /✅ \*\*Changed-line coverage 100\.0%\*\* meets the 80% threshold/);
});

test('markdown summary reports the headline metrics as a table', () => {
    const markdown = buildMarkdownSummary(summaryInput());
    assert.match(markdown, /\| Line coverage \| 50\.0% \(1\/2\) \|/);
    assert.match(markdown, /\| Condition coverage \| 50\.0% \(1\/2\) \|/);
    assert.match(markdown, /\| Changed lines vs `origin\/main` \| 0\.0% \(0\/1\) \|/);
    assert.match(markdown, /\| Unit tests \| 12 \(1 failed, 0 skipped\) \|/);
});

test('markdown summary lists files with uncovered changed lines', () => {
    const markdown = buildMarkdownSummary(summaryInput());
    assert.match(markdown, /Changed files with uncovered lines/);
    assert.match(markdown, /\| `a\.go` \| 1 \/ 1 \|/);
});

test('markdown summary omits sections it has no data for', () => {
    const markdown = buildMarkdownSummary(
        summaryInput({
            tests: undefined,
            changes: undefined,
            rows: [{ path: 'a.go', linesCovered: 2, linesTotal: 2, changedTotal: 0, changedCovered: 0 }],
            gate: evaluateGate(0, 0, 80),
            coverage: {
                files: [{ path: 'a.go', lines: new Map([[1, 1], [2, 1]]), branchesCovered: 0, branchesTotal: 0 }],
                format: 'Go coverage profile',
                reportPath: 'coverage.out',
                generatedAt: new Date(),
                unresolvedPaths: []
            }
        })
    );
    assert.ok(!markdown.includes('Unit tests'), 'no test results, no test row');
    assert.ok(!markdown.includes('Condition coverage'), 'format carried no branch data');
    assert.ok(!markdown.includes('Changed files with uncovered lines'), 'nothing to flag');
    assert.ok(!markdown.includes('threshold'), 'an inapplicable gate is not mentioned');
});

test('markdown summary records where the numbers came from', () => {
    const markdown = buildMarkdownSummary(summaryInput());
    assert.match(markdown, /Measured locally from Go coverage profile \(`coverage\.out`\) · Go/);
});

test('markdown summary caps the file list so a PR comment stays readable', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
        path: `file${i}.go`,
        linesCovered: 0,
        linesTotal: 5,
        changedTotal: 5,
        changedCovered: 0
    }));
    const markdown = buildMarkdownSummary(summaryInput({ rows, gate: evaluateGate(0, 125, 80) }));
    const listed = [...markdown.matchAll(/\| `file\d+\.go` \|/g)].length;
    assert.equal(listed, 10);
});
