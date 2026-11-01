'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeWorkspace, cleanup, setConfig } = require('./harness');

const {
    detectProfiles,
    findProfile,
    resolveCoverageCommand,
    findCoverageReport,
    coverageScannerArgs,
    resolveLanguageProfile,
    LANGUAGE_PROFILES
} = load('languageProfiles');

test.afterEach(() => cleanup());

const ids = detected => detected.map(entry => entry.profile.id);

test('a .NET solution is detected', async () => {
    const folder = makeWorkspace({ 'App.sln': '', 'src/App/App.csproj': '' });
    assert.ok(ids(await detectProfiles(folder)).includes('dotnet'));
});

test('a Flutter app is detected from pubspec.yaml', async () => {
    const folder = makeWorkspace({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' });
    assert.deepEqual(ids(await detectProfiles(folder)), ['dart']);
});

test('a React app is detected from package.json', async () => {
    const folder = makeWorkspace({ 'package.json': '{"dependencies":{"react":"^18.0.0"}}' });
    assert.deepEqual(ids(await detectProfiles(folder)), ['js']);
});

test('markers one level down are detected (monorepo layouts)', async () => {
    const folder = makeWorkspace({ 'client/package.json': '{}' });
    assert.deepEqual(ids(await detectProfiles(folder)), ['js']);
});

test('node_modules is not mistaken for the project', async () => {
    const folder = makeWorkspace({ 'node_modules/left-pad/package.json': '{}', 'go.mod': 'module m\n' });
    assert.deepEqual(ids(await detectProfiles(folder)), ['go']);
});

test('a polyglot repo reports every language it finds, in priority order', async () => {
    const folder = makeWorkspace({
        'api/Api.csproj': '',
        'web/package.json': '{}',
        'scripts/requirements.txt': 'requests\n'
    });
    const detected = ids(await detectProfiles(folder));
    assert.deepEqual(detected, ['dotnet', 'js', 'python']);
});

test('an empty folder detects nothing and never offers the "other" profile as detected', async () => {
    const folder = makeWorkspace({ 'notes.md': '# hi' });
    assert.deepEqual(ids(await detectProfiles(folder)), []);
});

test('detection reports the marker file as evidence', async () => {
    const folder = makeWorkspace({ 'go.mod': 'module m\n' });
    const [detected] = await detectProfiles(folder);
    assert.match(detected.evidence, /go\.mod$/);
});

test('Dart coverage command: Flutter vs a pure Dart package', async () => {
    const flutter = makeWorkspace({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' });
    assert.equal((await resolveCoverageCommand(flutter, findProfile('dart'))).command, 'flutter');
    cleanup();

    const dart = makeWorkspace({ 'pubspec.yaml': 'name: lib\nenvironment:\n  sdk: ">=3.0.0"\n' });
    const command = await resolveCoverageCommand(dart, findProfile('dart'));
    assert.equal(command.command, 'dart');
    assert.deepEqual(command.args, ['run', 'coverage:test_with_coverage']);
});

test('Node: a project coverage script is preferred over the generic form', async () => {
    const folder = makeWorkspace({
        'package.json': JSON.stringify({ scripts: { test: 'jest', 'test:coverage': 'jest --coverage' } })
    });
    const command = await resolveCoverageCommand(folder, findProfile('js'));
    assert.deepEqual([command.command, ...command.args], ['npm', 'run', 'test:coverage']);
});

test('Node: npm needs "--" to forward the coverage flag', async () => {
    const folder = makeWorkspace({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    const command = await resolveCoverageCommand(folder, findProfile('js'));
    assert.deepEqual([command.command, ...command.args], ['npm', 'test', '--', '--coverage']);
});

test('Node: the lockfile selects the package manager, and yarn/pnpm skip the "--"', async () => {
    const folder = makeWorkspace({
        'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
        'pnpm-lock.yaml': ''
    });
    const command = await resolveCoverageCommand(folder, findProfile('js'));
    assert.deepEqual([command.command, ...command.args], ['pnpm', 'test', '--coverage']);
});

test('Node: no test script means no inferred command', async () => {
    const folder = makeWorkspace({ 'package.json': JSON.stringify({ name: 'x' }) });
    assert.equal(await resolveCoverageCommand(folder, findProfile('js')), undefined);
});

test('Node: malformed package.json does not throw', async () => {
    const folder = makeWorkspace({ 'package.json': '{ this is not json' });
    assert.equal(await resolveCoverageCommand(folder, findProfile('js')), undefined);
});

test('findCoverageReport picks the first existing non-empty report', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': 'TN:\n' });
    assert.equal(await findCoverageReport(folder, findProfile('js')), 'coverage/lcov.info');
});

test('findCoverageReport ignores an empty report file', async () => {
    const folder = makeWorkspace({ 'coverage/lcov.info': '' });
    assert.equal(await findCoverageReport(folder, findProfile('js')), undefined);
});

test('findCoverageReport falls through to a secondary location', async () => {
    const folder = makeWorkspace({ 'build/logs/clover.xml': '<coverage/>' });
    assert.equal(await findCoverageReport(folder, findProfile('php')), 'build/logs/clover.xml');
});

test('coverageScannerArgs emits the property only when a report exists', () => {
    const python = findProfile('python');
    assert.deepEqual(coverageScannerArgs(python, 'coverage.xml'), [
        '-Dsonar.exclusions=**/.venv/**,**/venv/**,**/__pycache__/**',
        '-Dsonar.python.coverage.reportPaths=coverage.xml'
    ]);
    assert.deepEqual(coverageScannerArgs(python, undefined), [
        '-Dsonar.exclusions=**/.venv/**,**/venv/**,**/__pycache__/**'
    ]);
});

test('every profile is internally consistent', () => {
    const seen = new Set();
    for (const profile of LANGUAGE_PROFILES) {
        assert.ok(profile.id && !seen.has(profile.id), `duplicate or missing id: ${profile.id}`);
        seen.add(profile.id);
        assert.ok(profile.label && profile.detail, `${profile.id} needs a label and detail`);
        assert.ok(['cli', 'dotnet'].includes(profile.scanner), `${profile.id} has an unknown scanner`);
        if (profile.coverage) {
            assert.ok(profile.coverage.property.startsWith('sonar.'), `${profile.id} property looks wrong`);
            assert.ok(profile.coverage.reportPaths.length > 0, `${profile.id} needs a report path`);
            assert.ok(profile.coverage.hint, `${profile.id} needs a hint for manual setup`);
        }
    }
});

test('every profile id is offered by the settings enum', () => {
    const packageJson = require('../package.json');
    const enumValues = packageJson.contributes.configuration.properties['sonarcloud.localScan.language'].enum;
    for (const profile of LANGUAGE_PROFILES) {
        assert.ok(enumValues.includes(profile.id), `${profile.id} is missing from the setting enum`);
    }
    // "auto" plus one entry per profile, and descriptions must line up.
    assert.equal(enumValues.length, LANGUAGE_PROFILES.length + 1);
    assert.equal(
        packageJson.contributes.configuration.properties['sonarcloud.localScan.language'].enumDescriptions.length,
        enumValues.length
    );
});

test('the setting overrides a remembered choice', async () => {
    const folder = makeWorkspace({ 'go.mod': 'module m\n' });
    setConfig('sonarcloud.localScan.language', 'python');
    const preference = { scanLanguage: 'go', setScanLanguage: async () => {} };
    const profile = await resolveLanguageProfile(folder, preference);
    assert.equal(profile.id, 'python');
});

test('a remembered choice is used without prompting', async () => {
    const folder = makeWorkspace({ 'go.mod': 'module m\n' });
    let asked = false;
    const preference = {
        scanLanguage: 'go',
        setScanLanguage: async () => {
            asked = true;
        }
    };
    const profile = await resolveLanguageProfile(folder, preference);
    assert.equal(profile.id, 'go');
    assert.equal(asked, false, 'a remembered language must not be re-saved or re-prompted');
});

test('an unknown setting value falls back to asking rather than failing', async () => {
    const folder = makeWorkspace({ 'go.mod': 'module m\n' });
    setConfig('sonarcloud.localScan.language', 'cobol');
    const { vscode } = require('./harness');
    vscode.__harness.quickPickResponder = items => items.find(item => item.profile && item.profile.id === 'go');
    let saved;
    const profile = await resolveLanguageProfile(folder, {
        scanLanguage: undefined,
        setScanLanguage: async id => {
            saved = id;
        }
    });
    assert.equal(profile.id, 'go');
    assert.equal(saved, 'go', 'the answer is remembered');
    assert.ok(vscode.__harness.shownMessages.some(m => m.level === 'warning'));
});

test('dismissing the picker cancels rather than defaulting to a language', async () => {
    const folder = makeWorkspace({ 'go.mod': 'module m\n' });
    const { vscode } = require('./harness');
    vscode.__harness.quickPickResponder = () => undefined;
    const profile = await resolveLanguageProfile(folder, { scanLanguage: undefined, setScanLanguage: async () => {} });
    assert.equal(profile, undefined);
});
