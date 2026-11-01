'use strict';

/**
 * The report is assembled by string concatenation, so the things that break
 * silently are escaping and structure. These assertions pin both without
 * needing a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup, vscode } = require('./harness');

const { renderReport, buildMarkdownSummary } = load('localCoverage');
const { evaluateGate } = load('coverage');
const { evaluateRatchet } = load('coverageHistory');

test.afterEach(() => cleanup());

function fixture(overrides = {}) {
    const coverage = {
        files: [
            { path: 'src/a.ts', lines: new Map([[1, 1], [2, 0], [3, 0]]), branchesCovered: 1, branchesTotal: 2 },
            { path: 'src/b.ts', lines: new Map([[1, 1], [2, 1]]), branchesCovered: 0, branchesTotal: 0 }
        ],
        format: 'LCOV',
        reportPath: 'coverage/lcov.info',
        generatedAt: new Date(),
        unresolvedPaths: []
    };
    return {
        folder: { uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 },
        profile: { id: 'js', label: 'JavaScript / TypeScript (incl. React)', detail: '', scanner: 'cli', markers: [] },
        coverage,
        changes: {
            byFile: new Map([['src/a.ts', new Set([2])]]),
            baseRef: 'origin/main',
            mergeBase: 'abc1234',
            totalChangedLines: 1
        },
        tests: { total: 12, passed: 11, failed: 1, skipped: 0, sources: 1 },
        rows: [
            { path: 'src/a.ts', linesCovered: 1, linesTotal: 3, changedTotal: 1, changedCovered: 0, firstUncovered: 2, firstUncoveredChanged: 2 },
            { path: 'src/b.ts', linesCovered: 2, linesTotal: 2, changedTotal: 0, changedCovered: 0 }
        ],
        gate: evaluateGate(0, 1, 80),
        ...overrides
    };
}

function render(overrides, delta, stale) {
    const f = fixture(overrides);
    return renderReport(f.folder, f.profile, f.coverage, f.changes, f.tests, f.rows, f.gate, delta, stale, f.ratchet);
}

test('the page carries a restrictive CSP with a per-render script nonce', () => {
    const html = render();
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
    assert.ok(csp, 'a CSP must be present — the panel enables scripts');
    assert.match(csp[1], /default-src 'none'/);
    assert.match(csp[1], /script-src 'nonce-[^']+'/);

    const nonce = /script-src 'nonce-([^']+)'/.exec(html)[1];
    assert.match(html, new RegExp(`<script nonce="${nonce}">`), 'the script tag must carry the same nonce');
    assert.ok(!/<script(?![^>]*nonce)/.test(html), 'no unnonced script may exist');

    // A fixed nonce would defeat the point.
    const second = /script-src 'nonce-([^']+)'/.exec(render())[1];
    assert.notEqual(nonce, second);
});

test('file paths are HTML-escaped everywhere they appear', () => {
    const nasty = 'src/<img src=x onerror="alert(1)">.ts';
    const html = render({
        rows: [
            {
                path: nasty,
                linesCovered: 0,
                linesTotal: 2,
                changedTotal: 2,
                changedCovered: 0,
                firstUncovered: 1,
                firstUncoveredChanged: 1
            }
        ]
    });
    assert.ok(!html.includes('<img src=x'), 'raw markup from a path must never reach the page');
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('the base branch name is escaped in the tile label', () => {
    const html = render({
        changes: {
            byFile: new Map(),
            baseRef: 'origin/<script>bad</script>',
            mergeBase: 'abc',
            totalChangedLines: 0
        }
    });
    assert.ok(!html.includes('<script>bad'), 'a branch name is user data');
    assert.match(html, /&lt;script&gt;bad/);
});

test('the gate banner reflects the verdict', () => {
    assert.match(render().match(/<div class="gate ([^"]+)"/)[1], /fail/);
    assert.match(render({ gate: evaluateGate(1, 1, 80) }).match(/<div class="gate ([^"]+)"/)[1], /pass/);
    assert.ok(!render({ gate: evaluateGate(0, 0, 80) }).includes('class="gate'), 'no banner when nothing changed');
});

test('headline numbers appear in the tiles', () => {
    const html = render();
    assert.match(html, /33\.3%/, 'line coverage: 1 of 3 lines');
    assert.match(html, /1 \/ 2 branches/, 'condition coverage detail');
    assert.match(html, /11 passed · 1 failed · 0 skipped/);
});

test('changed files are linked with the line to jump to', () => {
    const html = render();
    assert.match(html, /data-path="src\/a\.ts" data-line="2"/);
});

test('a file with no changed lines is absent from the changed table but present in the ranking', () => {
    const html = render();
    const changedSection = html.slice(html.indexOf('<h2>Changed files'), html.indexOf('<h2>Lowest coverage'));
    assert.ok(changedSection.includes('a.ts'));
    assert.ok(!changedSection.includes('b.ts'), 'b.ts changed nothing');
    assert.ok(html.slice(html.indexOf('<h2>Lowest coverage')).includes('b.ts'));
});

test('without a base branch the report explains why changed-line coverage is missing', () => {
    const html = render({ changes: undefined });
    assert.match(html, /No base branch was found/);
    assert.match(html, /sonarcloud\.coverage\.baseBranch/);
});

test('a repo with no coverage data renders without throwing', () => {
    const html = render({
        coverage: {
            files: [],
            format: 'LCOV',
            reportPath: 'coverage/lcov.info',
            generatedAt: new Date(),
            unresolvedPaths: []
        },
        rows: [],
        changes: undefined,
        tests: undefined,
        gate: evaluateGate(0, 0, 80)
    });
    assert.match(html, /No files with instrumented lines/);
    assert.match(html, /no TRX\/JUnit results found/);
});

test('changed files with no coverage data at all are called out', () => {
    const html = render({
        changes: {
            byFile: new Map([['src/untested.ts', new Set([1, 2])]]),
            baseRef: 'origin/main',
            mergeBase: 'abc',
            totalChangedLines: 2
        }
    });
    assert.match(html, /changed source file\(s\) have no coverage data at all/);
    assert.match(html, /src\/untested\.ts/);
});

test('a changed non-source file is not reported as missing coverage', () => {
    const html = render({
        changes: {
            byFile: new Map([['README.md', new Set([1])]]),
            baseRef: 'origin/main',
            mergeBase: 'abc',
            totalChangedLines: 1
        }
    });
    assert.ok(!html.includes('have no coverage data at all'), 'docs are not expected to be covered');
});

test('the markdown summary escapes nothing it should not, and stays paste-safe', () => {
    const f = fixture();
    const markdown = buildMarkdownSummary({
        folderName: f.folder.name,
        profileLabel: f.profile.label,
        coverage: f.coverage,
        changes: f.changes,
        tests: f.tests,
        rows: f.rows,
        gate: f.gate
    });
    assert.ok(!markdown.includes('<script'), 'no raw HTML beyond the details wrapper');
    assert.match(markdown, /^## Local coverage — repo$/m);
    // Table rows must be well formed or GitHub renders them as text.
    for (const line of markdown.split('\n').filter(l => l.startsWith('|'))) {
        assert.match(line, /^\|.*\|$/, `malformed table row: ${line}`);
    }
});

test('the line-coverage tile carries the trend when there is history', () => {
    const delta = {
        previous: { at: 'x', branch: 'feature/x', linesCovered: 1, linesTotal: 4, changedCovered: 0, changedTotal: 0 },
        percentagePoints: 8.3,
        coveredLines: 1,
        totalLines: 0,
        sameBranch: true
    };
    const html = render(undefined, delta);
    assert.match(html, /\+8\.3 pts since the last run on this branch/);
});

test('the first ever run shows no trend rather than a meaningless zero', () => {
    const html = render(undefined, undefined);
    assert.ok(!html.includes('pts since'), 'nothing to compare against yet');
});

test('a report the run did not refresh is called out before any numbers', () => {
    // Otherwise days-old coverage reads as current, which is how people ship
    // on numbers that no longer describe the code.
    const html = render(undefined, undefined, true);
    assert.match(html, /was not refreshed by the last run/);
    assert.ok(
        html.indexOf('not refreshed') < html.indexOf('class="tiles"'),
        'the warning must come before the figures it qualifies'
    );
});

test('a freshly produced report carries no staleness warning', () => {
    assert.ok(!render(undefined, undefined, false).includes('not refreshed'));
    assert.ok(!render().includes('not refreshed'), 'defaults to fresh');
});


// -------------------------------------------------------------- ratchet ---

/** A delta of `points` percentage points, positive when coverage rose. */
function deltaOf(points) {
    return {
        previous: { at: new Date().toISOString(), branch: 'feature/x', linesCovered: 5, linesTotal: 10, changedCovered: 0, changedTotal: 0 },
        percentagePoints: points,
        coveredLines: 0,
        totalLines: 0,
        sameBranch: true
    };
}

test('a coverage regression gets its own banner in the report', () => {
    const html = render({ ratchet: evaluateRatchet(deltaOf(-3), true, 0.1) });
    assert.match(html, /Coverage went backwards/);
    assert.match(html, /dropped 3\.0 pts/);
    assert.match(html, /class="gate fail"/);
});

test('the ratchet says nothing when it is switched off', () => {
    const html = render({ ratchet: evaluateRatchet(deltaOf(-3), false, 0.1) });
    assert.ok(!html.includes('went backwards'));
    assert.ok(!html.includes('did not go backwards'), 'a check nobody enabled should be invisible');
});

test('the PR summary states the ratchet verdict', () => {
    const f = fixture();
    const markdown = buildMarkdownSummary({
        folderName: f.folder.name,
        profileLabel: f.profile.label,
        coverage: f.coverage,
        changes: f.changes,
        tests: f.tests,
        rows: f.rows,
        gate: f.gate,
        ratchet: evaluateRatchet(deltaOf(-3), true, 0.1)
    });
    assert.match(markdown, /❌ Line coverage dropped 3\.0 pts/);
});
