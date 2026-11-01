'use strict';

/**
 * The .NET scan is the most-used path and the largest module, so its argument
 * construction, project classification and diagnostics get direct coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const dotnet = load('dotnetLocalScan');

test.afterEach(() => cleanup());

function settings(overrides = {}) {
    return {
        enabled: true,
        buildTarget: '',
        projectsToBuild: '**/*.csproj',
        projectsToBuildExplicit: false,
        buildArgs: ['--configuration', 'Release'],
        projectsToTest: '**/*[Tt]ests.csproj',
        dotnetTestArgs: ['--configuration', 'Release'],
        dotnetTestArgsExplicit: false,
        sonarExcludePattern: '',
        sonarInclusions: '',
        openCoverReportsPaths: '',
        vstestReportsPaths: '',
        openCoverReportsPathsExplicit: false,
        vstestReportsPathsExplicit: false,
        ...overrides
    };
}

// ---------------------------------------------------------- classification ---

test('test projects are recognised by folder and by name', () => {
    for (const testProject of [
        'src/MyApp.Tests/MyApp.Tests.csproj',
        'tests/Api/Api.csproj',
        'FooTests.csproj',
        'Foo.Test.csproj',
        'foo_tests.csproj',
        'test/Thing.csproj'
    ]) {
        assert.equal(dotnet.isTestProject(testProject), true, `${testProject} should be a test project`);
    }
});

test('production projects whose names merely contain "test" are not misclassified', () => {
    // Misclassifying these silently drops them from the analysed build.
    for (const production of [
        'src/ContestApi/ContestApi.csproj',
        'src/LatestOrders/LatestOrders.csproj',
        'src/ProtestService/ProtestService.csproj',
        'src/Payments/Payments.csproj',
        'src/Attestation/Attestation.csproj'
    ]) {
        assert.equal(dotnet.isTestProject(production), false, `${production} must be analysed`);
    }
});

test('solution and project files are told apart, including .slnx', () => {
    assert.equal(dotnet.isSolutionFileBuildTarget('App.sln'), true);
    assert.equal(dotnet.isSolutionFileBuildTarget('App.slnx'), true);
    assert.equal(dotnet.isSolutionFileBuildTarget('App.csproj'), false);
    assert.equal(dotnet.isProjectFileBuildTarget('App.csproj'), true);
    assert.equal(dotnet.isProjectFileBuildTarget('App.fsproj'), true);
    assert.equal(dotnet.isProjectFileBuildTarget('App.sln'), false);
});

// ------------------------------------------------------------- arguments ----

test('CLI-style scanner arguments are translated to the .NET scanner form', () => {
    assert.deepEqual(
        dotnet.convertCliScannerArgsToDotnetArgs([
            '-Dsonar.exclusions=**/x/**',
            '/d:sonar.already=1',
            '-d:sonar.lower=2',
            '--unrelated-flag'
        ]),
        ['/d:sonar.exclusions=**/x/**', '/d:sonar.already=1', '/d:sonar.lower=2']
    );
});

test('property values are normalised regardless of the prefix the user typed', () => {
    assert.equal(dotnet.normalizeDotnetPropertyArg('sonar.exclusions=a'), '/d:sonar.exclusions=a');
    assert.equal(dotnet.normalizeDotnetPropertyArg('/d:sonar.exclusions=a'), '/d:sonar.exclusions=a');
    assert.equal(dotnet.normalizeDotnetPropertyArg('-d:sonar.exclusions=a'), '/d:sonar.exclusions=a');
    assert.equal(dotnet.normalizeDotnetPropertyArg('-Dsonar.exclusions=a'), '/d:sonar.exclusions=a');
    assert.equal(dotnet.normalizeDotnetPropertyArg('   '), undefined);
});

test('the token never appears in a rendered command line', () => {
    const rendered = dotnet.renderRedactedArgs([
        'sonarscanner',
        'begin',
        '/d:sonar.token=super-secret-value',
        '/k:proj'
    ]);
    assert.ok(!rendered.includes('super-secret-value'), 'a token must never be logged');
    assert.match(rendered, /\/d:sonar\.token=\*\*\*/);
});

test('the explicit-token fallback appends the token argument', () => {
    const args = dotnet.addExplicitScannerToken(['sonarscanner', 'begin'], 'tok');
    assert.deepEqual(args, ['sonarscanner', 'begin', '/d:sonar.token=tok']);
    assert.deepEqual(dotnet.buildDotnetEndArgs('tok', false), ['sonarscanner', 'end']);
    assert.deepEqual(dotnet.buildDotnetEndArgs('tok', true), ['sonarscanner', 'end', '/d:sonar.token=tok']);
});

test('auth failures trigger the explicit-token retry, other failures do not', () => {
    assert.equal(
        dotnet.shouldRetryWithExplicitScannerToken('Response status code does not indicate success: 401.'),
        true
    );
    assert.equal(
        dotnet.shouldRetryWithExplicitScannerToken('Response status code does not indicate success: 403.'),
        true
    );
    assert.equal(dotnet.shouldRetryWithExplicitScannerToken('error MSB4025: project file could not be loaded'), false);
    assert.equal(dotnet.shouldRetryWithExplicitScannerToken(''), false);
});

test('scanner failures are explained by their cause, not just their exit code', () => {
    const project = { key: 'proj', name: 'Proj' };
    const unauthorized = dotnet.buildScannerStepFailureMessage(
        'begin',
        1,
        'Response status code does not indicate success: 401.',
        project,
        'org'
    );
    assert.match(unauthorized, /401/);
    assert.match(unauthorized, /token/i);

    const forbidden = dotnet.buildScannerStepFailureMessage(
        'begin',
        1,
        'Response status code does not indicate success: 403.',
        project,
        'org'
    );
    assert.match(forbidden, /Execute Analysis/, 'a 403 is a permission problem, not a bad token');
    assert.match(forbidden, /proj/);

    const timeout = dotnet.buildScannerStepFailureMessage('end', 1, 'Response status code does not indicate success: 504.', project, 'org');
    assert.match(timeout, /transient/);

    const generic = dotnet.buildScannerStepFailureMessage('end', 7, 'something else', project, 'org');
    assert.match(generic, /exited with code 7/);
});

// -------------------------------------------------------------- coverage ----

test('managed coverage assigns one results directory and report per test project', () => {
    const projects = [{ fsPath: '/r/A.Tests.csproj' }, { fsPath: '/r/B.Tests.csproj' }];
    const plan = dotnet.planManagedCoverage(settings(), projects, '/r/coverage', 'xplat');
    assert.equal(plan.managed, true);
    assert.equal(plan.coverageReports.length, 2);
    assert.notEqual(plan.coverageReports[0], plan.coverageReports[1], 'reports must not collide');
    assert.match(plan.coverageReports[0], /coverage-1\.opencover\.xml$/);
    assert.match(plan.trxReports[0], /results-1[\\/]test_results\.trx$/);
});

test('dotnet-coverage uses its own report extension', () => {
    const plan = dotnet.planManagedCoverage(settings(), [{ fsPath: '/r/A.Tests.csproj' }], '/r/coverage', 'dotnet-coverage');
    assert.match(plan.coverageReports[0], /coverage-1\.xml$/);
    assert.ok(!plan.coverageReports[0].endsWith('.opencover.xml'));
});

test('a user-supplied results directory disables the managed layout', () => {
    const plan = dotnet.planManagedCoverage(
        settings({ dotnetTestArgs: ['--results-directory', '/custom'] }),
        [{ fsPath: '/r/A.Tests.csproj' }],
        '/r/coverage',
        'xplat'
    );
    assert.equal(plan.managed, false, 'the user is managing report paths themselves');
});

test('tests with no projects are never "managed"', () => {
    assert.equal(dotnet.planManagedCoverage(settings(), [], '/r/coverage', 'xplat').managed, false);
    assert.equal(
        dotnet.planManagedCoverage(settings({ enabled: false }), [{ fsPath: '/r/A.csproj' }], '/r/c', 'xplat').managed,
        false
    );
});

test('exact report paths are passed to the scanner instead of wildcards', () => {
    const projects = [{ fsPath: '/r/A.Tests.csproj' }];
    const plan = dotnet.planManagedCoverage(settings(), projects, '/r/coverage', 'xplat');
    const args = dotnet.buildDotnetPropertyArgs(settings(), plan, 'xplat');
    const coverageArg = args.find(arg => arg.includes('opencover.reportsPaths'));
    assert.ok(coverageArg, 'the OpenCover property must be set');
    assert.ok(!coverageArg.includes('**'), 'no wildcard — the scanner resolves those inconsistently');
    assert.ok(coverageArg.includes(plan.coverageReports[0]));
});

test('dotnet-coverage reports map to the Visual Studio coverage property', () => {
    const projects = [{ fsPath: '/r/A.Tests.csproj' }];
    const plan = dotnet.planManagedCoverage(settings(), projects, '/r/coverage', 'dotnet-coverage');
    const args = dotnet.buildDotnetPropertyArgs(settings(), plan, 'dotnet-coverage');
    assert.ok(
        args.some(arg => arg.startsWith('/d:sonar.cs.vscoveragexml.reportsPaths=')),
        'dotnet-coverage XML is not OpenCover'
    );
});

test('an explicitly configured report path wins over the managed one', () => {
    const custom = settings({ openCoverReportsPaths: 'my/report.xml', openCoverReportsPathsExplicit: true });
    const plan = dotnet.planManagedCoverage(custom, [{ fsPath: '/r/A.Tests.csproj' }], '/r/coverage', 'xplat');
    const args = dotnet.buildDotnetPropertyArgs(custom, plan, 'xplat');
    assert.ok(args.some(arg => arg === '/d:sonar.cs.opencover.reportsPaths=my/report.xml'));
});

test('test arguments gain the runsettings and results directory under the managed layout', () => {
    const plan = dotnet.planManagedCoverage(settings(), [{ fsPath: '/r/A.Tests.csproj' }], '/r/coverage', 'xplat');
    const args = dotnet.buildDotnetTestArgs('/r/A.Tests.csproj', ['--configuration', 'Release'], plan, 'xplat', 0, '/r/cov.runsettings', false);
    assert.equal(args[0], 'test');
    assert.equal(args[1], '/r/A.Tests.csproj');
    assert.ok(args.includes('--settings'));
    assert.ok(args.includes('/r/cov.runsettings'));
    assert.ok(args.includes('--results-directory'));
    assert.ok(!args.includes('--no-build'), 'test projects are not part of the scanner build by default');
});

test('reusing a solution build adds --no-build so projects are not imported twice', () => {
    const plan = dotnet.planManagedCoverage(settings(), [{ fsPath: '/r/A.Tests.csproj' }], '/r/coverage', 'xplat');
    const args = dotnet.buildDotnetTestArgs('/r/A.Tests.csproj', [], plan, 'xplat', 0, '/r/cov.runsettings', true);
    assert.ok(args.includes('--no-build'));
});

test('a user-supplied --settings is not duplicated', () => {
    const plan = dotnet.planManagedCoverage(settings(), [{ fsPath: '/r/A.Tests.csproj' }], '/r/coverage', 'xplat');
    const args = dotnet.buildDotnetTestArgs('/r/A.Tests.csproj', ['--settings', 'mine.runsettings'], plan, 'xplat', 0, '/r/cov.runsettings', false);
    assert.equal(args.filter(arg => arg === '--settings').length, 1);
    assert.ok(args.includes('mine.runsettings'));
});

test('collector arguments are stripped when dotnet-coverage drives the run', () => {
    // Running both collectors at once produces empty or conflicting reports.
    assert.deepEqual(
        dotnet.stripCoverageCollectorArgs(['--configuration', 'Release', '--collect', 'XPlat Code Coverage', '--logger', 'trx']),
        ['--configuration', 'Release', '--logger', 'trx']
    );
    assert.deepEqual(dotnet.stripCoverageCollectorArgs(['--collect:XPlat Code Coverage', '-v', 'n']), ['-v', 'n']);
    assert.deepEqual(dotnet.stripCoverageCollectorArgs(['--collect=Code Coverage']), []);
});

test('dotnet-coverage wraps the test command as a single quoted argument', () => {
    const args = dotnet.buildDotnetCoverageCollectArgs(['test', '/r/My Tests.csproj', '--no-build'], '/r/coverage-1.xml');
    assert.equal(args[0], 'collect');
    assert.match(args[1], /^dotnet test "\/r\/My Tests\.csproj" --no-build$/, 'paths with spaces must stay one argument');
    assert.deepEqual(args.slice(2), ['-f', 'xml', '-o', '/r/coverage-1.xml']);
});

test('build arguments follow the target', () => {
    assert.deepEqual(dotnet.buildDotnetBuildArgs('/r/App.sln', settings()), [
        'build',
        '/r/App.sln',
        '--configuration',
        'Release'
    ]);
    assert.deepEqual(dotnet.buildDotnetBuildArgs(undefined, settings()), ['build', '--configuration', 'Release']);
});

test('prebuild arguments suppress inherited SonarScanner imports', () => {
    assert.deepEqual(dotnet.buildDotnetBuildArgs('/r/App.Tests.csproj', settings(), false, true), [
        'build',
        '/r/App.Tests.csproj',
        '--configuration',
        'Release',
        '-p:SonarQubeTargetsImported=true'
    ]);
});

// ------------------------------------------------------------- gitignore ----

test('gitignore entries are appended with the file\'s own line ending', () => {
    assert.equal(dotnet.appendGitignoreEntry('bin/\r\nobj/\r\n', '.sonarqube/'), 'bin/\r\nobj/\r\n.sonarqube/\r\n');
    assert.equal(dotnet.appendGitignoreEntry('bin/\nobj/\n', '.sonarqube/'), 'bin/\nobj/\n.sonarqube/\n');
    assert.equal(dotnet.appendGitignoreEntry('', '.sonarqube/'), '.sonarqube/\n');
    assert.equal(dotnet.appendGitignoreEntry('bin/', '.sonarqube/'), 'bin/\n.sonarqube/\n', 'a missing trailing newline is added');
});

test('an existing gitignore entry is detected, and comments do not count', () => {
    assert.equal(dotnet.hasGitignoreEntry('bin/\n.sonarqube/\n', '.sonarqube'), true);
    assert.equal(dotnet.hasGitignoreEntry('bin/\n# .sonarqube/\n', '.sonarqube'), false, 'a comment is not an entry');
    assert.equal(dotnet.hasGitignoreEntry('bin/\n', '.sonarqube'), false);
});

// ------------------------------------------------------- report inspection ---

test('a coverage report with no modules is recognised as empty', async () => {
    const folder = makeWorkspace({
        'empty.xml': '<?xml version="1.0"?><results><modules></modules></results>',
        'full.xml': '<?xml version="1.0"?><results><modules><module name="m"/></modules></results>',
        'opencover.xml': '<CoverageSession><Modules><Module><Files/></Module></Modules></CoverageSession>'
    });
    const at = name => path.join(folder.uri.fsPath, name);
    assert.equal(await dotnet.coverageReportLooksEmpty(at('empty.xml')), true);
    assert.equal(await dotnet.coverageReportLooksEmpty(at('full.xml')), false);
    assert.equal(await dotnet.coverageReportLooksEmpty(at('opencover.xml')), false, 'OpenCover capitalises Module');
    assert.equal(await dotnet.coverageReportLooksEmpty(at('missing.xml')), false, 'unreadable is not "empty"');
});

test('the coverage import summary reports what the scanner actually parsed', () => {
    const channel = vscode.window.createOutputChannel('t');
    const plan = { coverageReports: ['/r/coverage-1.xml'], resultsDirs: [], trxReports: [], managed: true };

    dotnet.summarizeCoverageImport(
        'INFO: Parsing the Visual Studio coverage XML report /r/coverage-1.xml\nINFO: Coverage Report Statistics: 5 files',
        channel,
        plan
    );
    assert.match(channel.lines.join(''), /imported 1 coverage report/);
    assert.match(channel.lines.join(''), /Coverage Report Statistics/);

    const silent = vscode.window.createOutputChannel('t2');
    dotnet.summarizeCoverageImport('INFO: Analysis complete', silent, plan);
    assert.match(silent.lines.join(''), /did not log parsing ANY coverage report/);
});

// --------------------------------------------------------- build targets ----

test('a solution is preferred over individual projects', async () => {
    const folder = makeWorkspace({
        'App.sln': '',
        'src/Api/Api.csproj': '',
        'src/Api.Tests/Api.Tests.csproj': ''
    });
    const targets = await dotnet.resolveBuildTargets(folder, settings());
    assert.deepEqual(targets.map(t => path.basename(t)), ['App.sln']);
});

test('without a solution, only non-test projects are built', async () => {
    const folder = makeWorkspace({
        'src/Api/Api.csproj': '',
        'src/Worker/Worker.csproj': '',
        'src/Api.Tests/Api.Tests.csproj': ''
    });
    const targets = await dotnet.resolveBuildTargets(folder, settings());
    const names = targets.map(t => path.basename(t)).sort();
    assert.deepEqual(names, ['Api.csproj', 'Worker.csproj'], 'test projects would mark the whole graph as test code');
});

test('a configured build target is honoured verbatim', async () => {
    const folder = makeWorkspace({ 'App.sln': '', 'src/Api/Api.csproj': '' });
    const targets = await dotnet.resolveBuildTargets(folder, settings({ buildTarget: '/abs/Custom.sln' }));
    assert.deepEqual(targets, ['/abs/Custom.sln']);
});

test('a build target pointing at a test project falls back with a warning', async () => {
    const folder = makeWorkspace({ 'src/Api/Api.csproj': '', 'src/Api.Tests/Api.Tests.csproj': '' });
    const targets = await dotnet.resolveBuildTargets(
        folder,
        settings({ buildTarget: path.join(folder.uri.fsPath, 'src/Api.Tests/Api.Tests.csproj') })
    );
    assert.deepEqual(targets.map(t => path.basename(t)), ['Api.csproj']);
    assert.ok(vscode.__harness.shownMessages.some(m => m.level === 'warning'));
});

test('test projects are discovered by the configured glob', async () => {
    const folder = makeWorkspace({
        'src/Api/Api.csproj': '',
        'src/Api.Tests/Api.Tests.csproj': '',
        'src/Worker.Tests/Worker.Tests.csproj': ''
    });
    const found = await dotnet.findTestProjects(folder, settings());
    assert.deepEqual(found.map(uri => path.basename(uri.fsPath)).sort(), ['Api.Tests.csproj', 'Worker.Tests.csproj']);
});

test('build artefact directories are never scanned for projects', async () => {
    const folder = makeWorkspace({
        'src/Api/Api.csproj': '',
        'src/Api/bin/Debug/Leftover.csproj': '',
        'src/Api/obj/Temp.csproj': ''
    });
    const targets = await dotnet.resolveBuildTargets(folder, settings());
    assert.deepEqual(targets.map(t => path.basename(t)), ['Api.csproj']);
});

// ------------------------------------------------- multi-solution handling ---

test('one solution is used as-is', () => {
    const folder = makeWorkspace({ 'App.sln': '' });
    const chosen = dotnet.pickSolutionTargets(folder, [{ fsPath: path.join(folder.uri.fsPath, 'App.sln') }]);
    assert.equal(chosen.length, 1);
    assert.equal(vscode.__harness.shownMessages.length, 0, 'no warning when there is no ambiguity');
});

test('with several solutions the root one wins, and the choice is announced', () => {
    // Building them all compiles shared projects twice and double-imports them.
    const folder = makeWorkspace({ 'App.sln': '', 'tools/Tools.sln': '', 'src/deep/Deep.sln': '' });
    const at = name => ({ fsPath: path.join(folder.uri.fsPath, name) });
    const chosen = dotnet.pickSolutionTargets(folder, [at('src/deep/Deep.sln'), at('App.sln'), at('tools/Tools.sln')]);
    assert.deepEqual(chosen.map(p => path.basename(p)), ['App.sln']);
    assert.ok(vscode.__harness.shownMessages.some(m => /3 solutions found/.test(m.message)));
});

test('equally shallow solutions are broken by a stable rule', () => {
    const folder = makeWorkspace({ 'a/A.sln': '', 'b/B.sln': '' });
    const at = name => ({ fsPath: path.join(folder.uri.fsPath, name) });
    const first = dotnet.pickSolutionTargets(folder, [at('b/B.sln'), at('a/A.sln')]);
    const second = dotnet.pickSolutionTargets(folder, [at('a/A.sln'), at('b/B.sln')]);
    assert.deepEqual(first, second, 'repeated scans must analyse the same solution');
});

test('build artefacts cannot crowd real projects out of the search budget', async () => {
    // findFiles applies its cap before the caller can filter, so leftovers in
    // bin/ or obj/ could consume the whole budget and hide real projects. The
    // exclusion therefore has to reach the API, not just post-filter results.
    const folder = makeWorkspace({ 'src/Api/Api.csproj': '', 'src/Api/obj/Debug/Leftover.csproj': '' });
    await dotnet.resolveBuildTargets(folder, settings());

    const projectSearches = vscode.__harness.findFilesCalls.filter(call => call.pattern.includes('csproj'));
    assert.ok(projectSearches.length > 0, 'projects were searched for');
    for (const call of projectSearches) {
        assert.ok(call.exclude, `no exclusion passed for "${call.pattern}"`);
        assert.match(call.exclude, /\bobj\b/);
        assert.match(call.exclude, /\bbin\b/);
        assert.match(call.exclude, /node_modules/);
    }
});
