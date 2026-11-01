'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const { titleCase, formatDuration, formatRating, severityRank, SEVERITIES, ISSUE_TYPES } = load('labels');
const {
    buildCoverageSummary,
    buildTestExecutionSummary,
    buildUnitTestCountSummary,
    explainMissingTestMetrics,
    sentenceCase
} = load('scanSummary');

test('titleCase turns SonarCloud enums into prose', () => {
    assert.equal(titleCase('CODE_SMELL'), 'Code Smell');
    assert.equal(titleCase('BLOCKER'), 'Blocker');
    assert.equal(titleCase(''), '');
});

test('severity ordering runs worst-first and tolerates unknown values', () => {
    const sorted = [...SEVERITIES].sort((a, b) => severityRank(a) - severityRank(b));
    assert.deepEqual(sorted, ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO']);
    assert.ok(severityRank('WHATEVER') > severityRank('INFO'));
});

test('issue types cover the SonarCloud triple', () => {
    assert.deepEqual([...ISSUE_TYPES], ['BUG', 'VULNERABILITY', 'CODE_SMELL']);
});

test('formatDuration uses SonarCloud 8-hour days', () => {
    assert.equal(formatDuration('0'), '0min');
    assert.equal(formatDuration('30'), '30min');
    assert.equal(formatDuration('60'), '1h');
    assert.equal(formatDuration('480'), '1d');
    assert.equal(formatDuration('510'), '1d 30min');
    assert.equal(formatDuration('1020'), '2d 1h');
});

test('formatDuration never renders 60 minutes instead of an hour', () => {
    // Rounding minutes independently of hours used to produce "1h 60min".
    assert.equal(formatDuration('119.5'), '2h');
    assert.equal(formatDuration('59.6'), '1h');
});

test('formatDuration passes through values it cannot parse', () => {
    assert.equal(formatDuration('unknown'), 'unknown');
});

test('formatRating maps 1-5 onto A-E', () => {
    assert.equal(formatRating('1.0'), 'A');
    assert.equal(formatRating('3'), 'C');
    assert.equal(formatRating('5.0'), 'E');
    assert.equal(formatRating('9'), '9', 'out-of-range values pass through');
});

test('coverage summary lists only the metrics SonarCloud returned', () => {
    assert.equal(
        buildCoverageSummary(new Map([['coverage', '81.3'], ['line_coverage', '84.0']])),
        'overall coverage 81.3%, line coverage 84.0%'
    );
    assert.equal(buildCoverageSummary(new Map()), undefined);
});

test('unit test counts are pluralised', () => {
    assert.equal(buildUnitTestCountSummary(new Map([['tests', '1']])), '1 unit test');
    assert.equal(buildUnitTestCountSummary(new Map([['tests', '2']])), '2 unit tests');
    assert.equal(buildUnitTestCountSummary(new Map([['tests', '1500']])), '1,500 unit tests');
});

test('test execution summary needs a test count to be meaningful', () => {
    assert.equal(buildTestExecutionSummary(new Map([['test_failures', '2']])), undefined);
    assert.equal(
        buildTestExecutionSummary(new Map([['tests', '10'], ['test_failures', '2'], ['skipped_tests', '1']])),
        '10 unit tests, 2 test failures, 1 skipped test'
    );
});

test('missing test metrics are explained differently for short-lived branches', () => {
    const shortLived = explainMissingTestMetrics({ name: 'f', isMain: false, type: 'SHORT' }, 'f');
    assert.match(shortLived, /does not publish test-execution metrics/);
    assert.match(shortLived, /short-lived/);
    assert.ok(!shortLived.startsWith('Warning'), 'expected behaviour is a note, not a warning');

    const longLived = explainMissingTestMetrics({ name: 'main', isMain: true, type: 'LONG' }, 'main');
    assert.match(longLived, /^Warning/, 'on a long-lived branch a missing measure is a real problem');
});

test('missing test metrics are explained when the branch is unknown', () => {
    assert.match(explainMissingTestMetrics(undefined, 'x'), /^Warning/);
});

test('sentenceCase capitalises without mangling the rest', () => {
    assert.equal(sentenceCase('overall coverage 12%'), 'Overall coverage 12%');
    assert.equal(sentenceCase(''), '');
});
