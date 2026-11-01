'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeWorkspace, indexWorkspace, cleanup, vscode } = require('./harness');

const {
    parseCoverageReport,
    totalsFor,
    percent,
    collectTestTotals,
    mapWithConcurrency,
    WorkspaceFileIndex
} = load('coverage');

const APP = 'src/app.ts';
const SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n';

test.afterEach(() => cleanup());

async function parse(reportName, report, extraFiles = {}) {
    const folder = makeWorkspace({ [APP]: SOURCE, [reportName]: report, ...extraFiles });
    indexWorkspace(folder, [APP, ...Object.keys(extraFiles)]);
    return { folder, data: await parseCoverageReport(folder, reportName) };
}

test('LCOV: line hits and branch data', async () => {
    const { data } = await parse(
        'lcov.info',
        ['TN:', `SF:${APP}`, 'DA:1,5', 'DA:2,0', 'DA:3,2', 'BRDA:3,0,0,1', 'BRDA:3,0,1,-', 'end_of_record', ''].join('\n')
    );
    assert.equal(data.format, 'LCOV');
    const totals = totalsFor(data.files);
    assert.deepEqual(
        { ...totals },
        { linesCovered: 2, linesTotal: 3, branchesCovered: 1, branchesTotal: 2 }
    );
    assert.equal(data.files[0].path, APP);
});

test('LCOV: repeated DA entries keep the highest hit count', async () => {
    const { data } = await parse(
        'lcov.info',
        ['TN:', `SF:${APP}`, 'DA:1,0', 'DA:1,4', 'end_of_record', ''].join('\n')
    );
    assert.equal(data.files[0].lines.get(1), 4);
});

test('Cobertura: hits and condition-coverage fractions', async () => {
    const { data } = await parse(
        'coverage.xml',
        `<?xml version="1.0" ?>
<coverage line-rate="0.5"><sources><source>.</source></sources><packages><package name="src"><classes>
<class filename="${APP}" name="app"><lines>
  <line number="1" hits="3"/>
  <line number="2" hits="0"/>
  <line number="4" hits="1" branch="true" condition-coverage="50% (1/2)"/>
</lines></class></classes></package></packages></coverage>`
    );
    assert.equal(data.format, 'Cobertura XML');
    assert.deepEqual({ ...totalsFor(data.files) }, {
        linesCovered: 2,
        linesTotal: 3,
        branchesCovered: 1,
        branchesTotal: 2
    });
});

test('JaCoCo: covered instructions and branch counters', async () => {
    const { data } = await parse(
        'jacoco.xml',
        `<?xml version="1.0"?><report name="x"><package name="lib"><sourcefile name="Calc.java">
  <line nr="1" mi="0" ci="4" mb="1" cb="3"/>
  <line nr="2" mi="5" ci="0" mb="2" cb="0"/>
</sourcefile></package></report>`,
        { 'lib/Calc.java': 'class Calc {}\n' }
    );
    assert.equal(data.format, 'JaCoCo XML');
    assert.deepEqual({ ...totalsFor(data.files) }, {
        linesCovered: 1,
        linesTotal: 2,
        branchesCovered: 3,
        branchesTotal: 6
    });
    assert.equal(data.files[0].path, 'lib/Calc.java');
});

test('OpenCover: sequence points resolve through the file table', async () => {
    const folder = makeWorkspace({ [APP]: SOURCE });
    indexWorkspace(folder, [APP]);
    const absolute = require('path').join(folder.uri.fsPath, APP);
    require('fs').writeFileSync(
        require('path').join(folder.uri.fsPath, 'opencover.xml'),
        `<?xml version="1.0"?><CoverageSession><Modules><Module>
<Files><File uid="1" fullPath="${absolute}" /></Files>
<SequencePoints><SequencePoint vc="4" sl="1" fileid="1" /><SequencePoint vc="0" sl="2" fileid="1" /></SequencePoints>
<BranchPoints><BranchPoint vc="2" sl="1" fileid="1" /><BranchPoint vc="0" sl="1" fileid="1" /></BranchPoints>
</Module></Modules></CoverageSession>`
    );
    const data = await parseCoverageReport(folder, 'opencover.xml');
    assert.equal(data.format, 'OpenCover XML');
    assert.deepEqual({ ...totalsFor(data.files) }, {
        linesCovered: 1,
        linesTotal: 2,
        branchesCovered: 1,
        branchesTotal: 2
    });
});

test('dotnet-coverage: partial ranges count as executed lines', async () => {
    const folder = makeWorkspace({ [APP]: SOURCE });
    indexWorkspace(folder, [APP]);
    const absolute = require('path').join(folder.uri.fsPath, APP);
    require('fs').writeFileSync(
        require('path').join(folder.uri.fsPath, 'dotnetcov.xml'),
        `<?xml version="1.0"?><results><modules><module name="m">
<source_files><source_file id="0" path="${absolute}"/></source_files>
<functions><function><ranges>
  <range source_id="0" covered="yes" start_line="1" end_line="2"/>
  <range source_id="0" covered="no" start_line="3" end_line="3"/>
  <range source_id="0" covered="partial" start_line="4" end_line="4"/>
</ranges></function></functions></module></modules></results>`
    );
    const data = await parseCoverageReport(folder, 'dotnetcov.xml');
    assert.equal(data.format, 'dotnet-coverage XML');
    const totals = totalsFor(data.files);
    assert.equal(totals.linesTotal, 4);
    assert.equal(totals.linesCovered, 3, 'partial lines executed, so they count as covered');
    assert.equal(data.files[0].lines.get(3), 0);
});

test('Clover: statement counts and conditional branches', async () => {
    const { data } = await parse(
        'clover.xml',
        `<?xml version="1.0"?><coverage clover="3.2.0"><project timestamp="1"><file path="${APP}">
  <line num="1" type="stmt" count="7"/>
  <line num="2" type="stmt" count="0"/>
  <line num="3" type="cond" count="1" truecount="1" falsecount="0"/>
</file></project></coverage>`
    );
    assert.equal(data.format, 'Clover XML');
    assert.deepEqual({ ...totalsFor(data.files) }, {
        linesCovered: 2,
        linesTotal: 3,
        branchesCovered: 1,
        branchesTotal: 2
    });
});

test('Go profile: statement ranges expand to lines, import path suffix-matched', async () => {
    const { data } = await parse(
        'cover.out',
        ['mode: set', 'example.com/m/lib/util.go:1.10,2.5 2 1', 'example.com/m/lib/util.go:3.1,3.20 1 0', ''].join('\n'),
        { 'lib/util.go': 'package lib\n' }
    );
    assert.equal(data.format, 'Go coverage profile');
    assert.equal(data.files[0].path, 'lib/util.go');
    assert.deepEqual({ ...totalsFor(data.files) }, {
        linesCovered: 2,
        linesTotal: 3,
        branchesCovered: 0,
        branchesTotal: 0
    });
});

test('unknown formats are rejected with a helpful error', async () => {
    const folder = makeWorkspace({ 'weird.txt': 'not a coverage report' });
    await assert.rejects(() => parseCoverageReport(folder, 'weird.txt'), /Could not recognise the coverage format/);
});

test('paths that match no workspace file are reported, not silently dropped', async () => {
    const folder = makeWorkspace({
        [APP]: SOURCE,
        'lcov.info': ['TN:', 'SF:/elsewhere/ghost.ts', 'DA:1,1', 'end_of_record', ''].join('\n')
    });
    indexWorkspace(folder, [APP]);
    const data = await parseCoverageReport(folder, 'lcov.info');
    assert.equal(data.files.length, 0);
    assert.deepEqual(data.unresolvedPaths, ['/elsewhere/ghost.ts']);
});

test('two report entries for one file merge instead of double counting', async () => {
    const { data } = await parse(
        'lcov.info',
        [
            'TN:',
            `SF:${APP}`,
            'DA:1,0',
            'DA:2,1',
            'end_of_record',
            `SF:${APP}`,
            'DA:1,3',
            'DA:3,0',
            'end_of_record',
            ''
        ].join('\n')
    );
    assert.equal(data.files.length, 1, 'the same file must appear once');
    const totals = totalsFor(data.files);
    assert.equal(totals.linesTotal, 3);
    assert.equal(totals.linesCovered, 2, 'line 1 is covered by the second run');
});

test('percent guards against an empty denominator', () => {
    assert.equal(percent(0, 0), undefined);
    assert.equal(percent(1, 4), 25);
});

test('test totals: TRX counters', async () => {
    const folder = makeWorkspace({
        'r.trx': '<TestRun><ResultSummary><Counters total="42" passed="38" failed="2" error="0" notExecuted="2"/></ResultSummary></TestRun>'
    });
    indexWorkspace(folder, ['r.trx']);
    assert.deepEqual(await collectTestTotals(folder), {
        total: 42,
        passed: 38,
        failed: 2,
        skipped: 2,
        sources: 1
    });
});

test('test totals: JUnit with a bare <testsuites> wrapper sums the suites', async () => {
    const folder = makeWorkspace({
        'junit.xml': '<testsuites><testsuite name="a" tests="10" failures="1" errors="1" skipped="2"/></testsuites>'
    });
    indexWorkspace(folder, ['junit.xml']);
    assert.deepEqual(await collectTestTotals(folder), {
        total: 10,
        passed: 6,
        failed: 2,
        skipped: 2,
        sources: 1
    });
});

test('test totals: aggregate <testsuites> attributes are not double counted', async () => {
    const folder = makeWorkspace({
        'junit.xml':
            '<testsuites tests="10" failures="2" skipped="1">' +
            '<testsuite name="a" tests="6" failures="1" skipped="1"/>' +
            '<testsuite name="b" tests="4" failures="1"/>' +
            '</testsuites>'
    });
    indexWorkspace(folder, ['junit.xml']);
    const totals = await collectTestTotals(folder);
    assert.equal(totals.total, 10, 'the aggregate element wins over its children');
    assert.equal(totals.failed, 2);
});

test('test totals: no result files at all', async () => {
    const folder = makeWorkspace({});
    indexWorkspace(folder, []);
    assert.equal(await collectTestTotals(folder), undefined);
});

test('test totals: TRX wins when a suite writes both TRX and JUnit', async () => {
    // A run reported in two formats must not be counted twice.
    const folder = makeWorkspace({
        'r.trx': '<TestRun><ResultSummary><Counters total="8" passed="8" failed="0" notExecuted="0"/></ResultSummary></TestRun>',
        'junit.xml': '<testsuites><testsuite name="a" tests="8" failures="0"/></testsuites>'
    });
    indexWorkspace(folder, ['r.trx', 'junit.xml']);
    const totals = await collectTestTotals(folder);
    assert.equal(totals.total, 8, 'the same 8 tests must be counted once');
    assert.equal(totals.sources, 1);
});

test('test totals: leftover result files from an old run are ignored', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const folder = makeWorkspace({
        'fresh/r.trx': '<TestRun><ResultSummary><Counters total="5" passed="5" failed="0" notExecuted="0"/></ResultSummary></TestRun>',
        'old/r.trx': '<TestRun><ResultSummary><Counters total="99" passed="99" failed="0" notExecuted="0"/></ResultSummary></TestRun>'
    });
    // Age the leftover well beyond the grace period.
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(folder.uri.fsPath, 'old/r.trx'), stale, stale);
    indexWorkspace(folder, ['fresh/r.trx', 'old/r.trx']);

    const totals = await collectTestTotals(folder, { since: new Date() });
    assert.equal(totals.total, 5, 'only the current run counts');
    assert.equal(totals.sources, 1);
});

test('test totals: without a reference time every result file counts', async () => {
    const folder = makeWorkspace({
        'a/r.trx': '<TestRun><ResultSummary><Counters total="2" passed="2" failed="0" notExecuted="0"/></ResultSummary></TestRun>',
        'b/r.trx': '<TestRun><ResultSummary><Counters total="3" passed="3" failed="0" notExecuted="0"/></ResultSummary></TestRun>'
    });
    indexWorkspace(folder, ['a/r.trx', 'b/r.trx']);
    const totals = await collectTestTotals(folder);
    assert.equal(totals.total, 5, 'multiple test projects still aggregate');
    assert.equal(totals.sources, 2);
});

// ------------------------------------------------- malformed report input ---

test('implausible line numbers are ignored rather than skewing the totals', async () => {
    // Malformed reports do contain these; counting them adds phantom rows and
    // moves the percentage.
    const { data } = await parse(
        'lcov.info',
        ['TN:', `SF:${APP}`, 'DA:-5,0', 'DA:0,1', 'DA:2.5,1', 'DA:99999999999,0', 'DA:1,1', 'end_of_record', ''].join('\n')
    );
    assert.deepEqual([...data.files[0].lines.keys()], [1], 'only the plausible line survives');
});

test('non-numeric hit counts read as uncovered rather than NaN', async () => {
    const { data } = await parse(
        'lcov.info',
        ['TN:', `SF:${APP}`, 'DA:1,abc', 'DA:2,-3', 'end_of_record', ''].join('\n')
    );
    assert.equal(data.files[0].lines.get(1), 0);
    assert.equal(data.files[0].lines.get(2), 0, 'a negative hit count is not coverage');
    assert.equal(totalsFor(data.files).linesCovered, 0);
});

test('a Go range that runs backwards is skipped', async () => {
    const { data } = await parse(
        'cover.out',
        ['mode: set', 'example.com/m/lib/util.go:9.1,2.1 1 1', 'example.com/m/lib/util.go:1.1,2.1 1 1', ''].join('\n'),
        { 'lib/util.go': 'package lib\n' }
    );
    assert.deepEqual([...data.files[0].lines.keys()].sort((a, b) => a - b), [1, 2]);
});

test('a truncated report parses to nothing instead of throwing', async () => {
    const folder = makeWorkspace({ 'lcov.info': 'SF:src/app.ts\nDA:1,' });
    const data = await parseCoverageReport(folder, 'lcov.info');
    assert.equal(data.format, 'LCOV');
    assert.equal(totalsFor(data.files).linesTotal, 0);
});

test('XML with unclosed tags parses to nothing instead of throwing', async () => {
    const folder = makeWorkspace({
        'c.xml': '<coverage line-rate="1"><packages><package><classes><class filename="a.ts"><lines><line number="1" hits="1"'
    });
    const data = await parseCoverageReport(folder, 'c.xml');
    assert.equal(data.format, 'Cobertura XML');
    assert.equal(data.files.length, 0);
});

test('XML entities in a file path are decoded', async () => {
    const folder = makeWorkspace({
        'a&b.ts': 'x\n',
        'c.xml':
            '<coverage line-rate="1"><sources><source>.</source></sources><packages><package><classes>' +
            '<class filename="a&amp;b.ts"><lines><line number="1" hits="1"/></lines></class>' +
            '</classes></package></packages></coverage>'
    });
    indexWorkspace(folder, ['a&b.ts']);
    const data = await parseCoverageReport(folder, 'c.xml');
    assert.equal(data.files[0].path, 'a&b.ts');
});

test('a deeply nested document does not blow up the parser', async () => {
    const folder = makeWorkspace({
        'deep.xml': '<coverage line-rate="1">' + '<packages>'.repeat(500) + '</packages>'.repeat(500) + '</coverage>'
    });
    const started = Date.now();
    await parseCoverageReport(folder, 'deep.xml');
    assert.ok(Date.now() - started < 5000, 'parsing must not degrade badly on odd input');
});


// ----------------------------------------------------- workspace indexing ---

test('the workspace is only walked when a reported path needs matching', async () => {
    // A well-formed report naming files that exist resolves directly; walking
    // 20,000 files to confirm that would be pure waste on every refresh.
    const folder = makeWorkspace({ [APP]: SOURCE, 'lcov.info': ['TN:', `SF:${APP}`, 'DA:1,1', 'end_of_record', ''].join('\n') });
    indexWorkspace(folder, [APP]);
    const before = vscode.__harness.findFilesCalls.length;
    await parseCoverageReport(folder, 'lcov.info');
    assert.equal(vscode.__harness.findFilesCalls.length, before);
});

test('an index is reused across refreshes, and rebuilt on demand', async () => {
    // Absolute build paths (most .NET formats) need the index; watch mode
    // re-reads the report every few seconds, and each walk is a full scan.
    const absolute = '/build/agent/work/src/app.ts';
    const folder = makeWorkspace({
        [APP]: SOURCE,
        'lcov.info': ['TN:', `SF:${absolute}`, 'DA:1,1', 'end_of_record', ''].join('\n')
    });
    indexWorkspace(folder, [APP]);
    const index = new WorkspaceFileIndex(folder);

    const first = await parseCoverageReport(folder, 'lcov.info', index);
    assert.deepEqual(first.files.map(file => file.path), [APP], 'matched by trailing segments');
    const afterFirst = vscode.__harness.findFilesCalls.length;

    await parseCoverageReport(folder, 'lcov.info', index);
    assert.equal(vscode.__harness.findFilesCalls.length, afterFirst, 'the second read reuses the walk');

    index.invalidate();
    await parseCoverageReport(folder, 'lcov.info', index);
    assert.equal(vscode.__harness.findFilesCalls.length, afterFirst + 1, 'an explicit run sees files added since');
});

test('a stale index expires on its own', async () => {
    const folder = makeWorkspace({ [APP]: SOURCE });
    indexWorkspace(folder, [APP]);
    const index = new WorkspaceFileIndex(folder, 0);
    await index.get();
    const after = vscode.__harness.findFilesCalls.length;
    await index.get();
    assert.equal(vscode.__harness.findFilesCalls.length, after + 1);
});

test('resolution order does not depend on which lookup finishes first', async () => {
    // The files are resolved concurrently; the merge must still follow the
    // report, or two entries for one file could merge in either direction.
    const report = [
        'TN:',
        `SF:${APP}`,
        'DA:1,1',
        'DA:2,0',
        'end_of_record',
        `SF:${APP}`,
        'DA:2,7',
        'end_of_record',
        ''
    ].join('\n');
    const folder = makeWorkspace({ [APP]: SOURCE, 'lcov.info': report });
    indexWorkspace(folder, [APP]);
    const data = await parseCoverageReport(folder, 'lcov.info');
    assert.equal(data.files.length, 1, 'two entries for one file merge into one');
    assert.equal(data.files[0].lines.get(2), 7, 'the higher hit count wins, whichever arrived first');
});

test('concurrent work is bounded, and results stay in input order', async () => {
    // Unbounded, a large report queues thousands of file-system calls at once
    // and starves the rest of the extension host.
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 200 }, (_, i) => i);
    const results = await mapWithConcurrency(
        items,
        async i => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 1));
            inFlight--;
            return i * 2;
        },
        8
    );
    assert.equal(peak, 8);
    assert.deepEqual(results.slice(0, 4), [0, 2, 4, 6], 'index i holds the result for item i');
    assert.equal(results.length, 200);
});

test('mapping nothing does not hang', async () => {
    assert.deepEqual(await mapWithConcurrency([], async x => x, 8), []);
});
