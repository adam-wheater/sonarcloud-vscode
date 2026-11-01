'use strict';

/**
 * Scanner provisioning and CLI argument construction. A wrong platform
 * artefact means a 404 download; a wrong PATH means "installed but not found";
 * an unquoted argument means a broken command on Windows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { load, makeWorkspace, cleanup } = require('./harness');

const installer = load('scannerInstall');
const localScan = load('localScan');

test.afterEach(() => cleanup());

/** Run a body with process.platform/arch temporarily reported as something else. */
function onPlatform(platform, arch, body) {
    const original = { platform: process.platform, arch: process.arch };
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    try {
        return body();
    } finally {
        Object.defineProperty(process, 'platform', { value: original.platform, configurable: true });
        Object.defineProperty(process, 'arch', { value: original.arch, configurable: true });
    }
}

test('platform artefacts match the names SonarSource publishes', () => {
    assert.equal(onPlatform('linux', 'x64', installer.platformArtifact), 'linux-x64');
    assert.equal(onPlatform('linux', 'arm64', installer.platformArtifact), 'linux-aarch64');
    assert.equal(onPlatform('darwin', 'x64', installer.platformArtifact), 'macosx-x64');
    assert.equal(onPlatform('darwin', 'arm64', installer.platformArtifact), 'macosx-aarch64');
    assert.equal(onPlatform('win32', 'x64', installer.platformArtifact), 'windows-x64');
});

test('Windows on ARM falls back to the x64 build, which runs under emulation', () => {
    // No windows-aarch64 archive is published; requesting one would 404.
    assert.equal(onPlatform('win32', 'arm64', installer.platformArtifact), 'windows-x64');
});

test('unsupported platforms report no artefact rather than a bad URL', () => {
    assert.equal(onPlatform('aix', 'ppc64', installer.platformArtifact), undefined);
    assert.equal(onPlatform('linux', 'ia32', installer.platformArtifact), undefined);
});

test('the dotnet tools directory is prepended to PATH exactly once', () => {
    const toolsDir = path.join(os.homedir(), '.dotnet', 'tools');
    const patched = installer.withDotnetToolPath({ PATH: '/usr/bin:/bin' });
    assert.equal(patched.PATH.split(path.delimiter)[0], toolsDir, 'global tools must win over stale copies');

    const already = installer.withDotnetToolPath({ PATH: `${toolsDir}${path.delimiter}/usr/bin` });
    assert.equal(
        already.PATH.split(path.delimiter).filter(segment => segment === toolsDir).length,
        1,
        'no duplicate entries on repeated calls'
    );
});

test('an empty or missing PATH still yields a usable one', () => {
    assert.ok(installer.withDotnetToolPath({}).PATH.includes('.dotnet'));
    assert.ok(installer.withDotnetToolPath({ PATH: '' }).PATH.includes('.dotnet'));
});

test('other environment variables survive the PATH patch', () => {
    const patched = installer.withDotnetToolPath({ PATH: '/usr/bin', SONAR_TOKEN: 'secret', HOME: '/root' });
    assert.equal(patched.SONAR_TOKEN, 'secret');
    assert.equal(patched.HOME, '/root');
});

// ------------------------------------------------------ CLI scan settings ---

test('pipeline-style placeholders expand to the scanned folder', () => {
    const folder = { uri: { fsPath: '/repo' }, name: 'repo', index: 0 };
    assert.equal(localScan.expandSettingValue('$(Build.SourcesDirectory)/coverage', folder), '/repo/coverage');
    assert.equal(localScan.expandSettingValue('$(System.DefaultWorkingDirectory)/x', folder), '/repo/x');
    assert.equal(localScan.expandSettingValue('${workspaceFolder}/y', folder), '/repo/y');
    assert.equal(localScan.expandSettingValue('$(Agent.TempDirectory)/t', folder), `${os.tmpdir()}/t`);
    assert.equal(localScan.expandSettingValue('${temp}/t', folder), `${os.tmpdir()}/t`);
});

test('every occurrence of a placeholder is expanded, not just the first', () => {
    const folder = { uri: { fsPath: '/repo' }, name: 'repo', index: 0 };
    assert.equal(
        localScan.expandSettingValue('$(Build.SourcesDirectory)/a,$(Build.SourcesDirectory)/b', folder),
        '/repo/a,/repo/b'
    );
});

test('values without placeholders pass through untouched', () => {
    const folder = { uri: { fsPath: '/repo' }, name: 'repo', index: 0 };
    assert.equal(localScan.expandSettingValue('--no-build', folder), '--no-build');
    assert.equal(localScan.expandSettingValue('', folder), '');
});

test('CLI properties are normalised to the -D form and expanded', () => {
    const folder = { uri: { fsPath: '/repo' }, name: 'repo', index: 0 };
    assert.equal(localScan.normalizeSonarPropertyArg('sonar.inclusions=**/*.cs', folder), '-Dsonar.inclusions=**/*.cs');
    assert.equal(localScan.normalizeSonarPropertyArg('-Dsonar.inclusions=x', folder), '-Dsonar.inclusions=x');
    assert.equal(localScan.normalizeSonarPropertyArg('  ', folder), undefined);
    assert.equal(
        localScan.buildSonarPropertyArg('sonar.cs.opencover.reportsPaths', '$(Build.SourcesDirectory)/c.xml', folder),
        '-Dsonar.cs.opencover.reportsPaths=/repo/c.xml'
    );
    assert.equal(localScan.buildSonarPropertyArg('sonar.x', '   ', folder), undefined);
});

test('cmd.exe quoting keeps arguments intact and metacharacters inert', () => {
    assert.equal(localScan.windowsQuote('C:\\Program Files\\sonar-scanner.bat'), '"C:\\Program Files\\sonar-scanner.bat"');
    assert.equal(localScan.windowsQuote('-Dsonar.branch.name=feature/x'), '"-Dsonar.branch.name=feature/x"');
    assert.equal(localScan.windowsQuote('a"b'), '"a""b"', 'embedded quotes are doubled, not dropped');
    // & and | inside quotes are literal to cmd.exe.
    assert.equal(localScan.windowsQuote('x & calc'), '"x & calc"');
});

test('the JRE provisioning retry triggers only on the extraction failure it targets', () => {
    assert.equal(
        localScan.shouldRetryWithoutJreProvisioning(
            'ERROR: Failed to extract archive ... java.nio.file.AccessDeniedException: /home/u/.sonar/cache'
        ),
        true
    );
    assert.equal(localScan.shouldRetryWithoutJreProvisioning('Failed to extract archive: corrupt zip'), false);
    assert.equal(localScan.shouldRetryWithoutJreProvisioning('AccessDeniedException on a source file'), false);
    assert.equal(localScan.shouldRetryWithoutJreProvisioning(''), false);
});

test('the bundled Java is found next to an absolute scanner path', async () => {
    const folder = makeWorkspace({
        'scanner/bin/sonar-scanner': '#!/bin/sh\n',
        'scanner/jre/bin/java': '#!/bin/sh\n'
    });
    const bin = path.join(folder.uri.fsPath, 'scanner', 'bin', 'sonar-scanner');
    const java = await localScan.resolveBundledScannerJava(bin);
    assert.equal(java, path.join(folder.uri.fsPath, 'scanner', 'jre', 'bin', 'java'));
});

test('a scanner on PATH has no bundled Java to point at', async () => {
    assert.equal(await localScan.resolveBundledScannerJava('sonar-scanner'), undefined);
});

test('a scanner without a bundled runtime reports none', async () => {
    const folder = makeWorkspace({ 'scanner/bin/sonar-scanner': '#!/bin/sh\n' });
    const bin = path.join(folder.uri.fsPath, 'scanner', 'bin', 'sonar-scanner');
    assert.equal(await localScan.resolveBundledScannerJava(bin), undefined);
});

test('captured output is capped so a long build cannot exhaust memory', () => {
    const big = 'x'.repeat(600 * 1024);
    const capped = localScan.appendOutputTail('', big);
    assert.ok(capped.length <= 512 * 1024, 'the tail is bounded');
    assert.ok(capped.length > 0);
    // The end of the log is what diagnostics need, so the tail must be kept.
    assert.equal(localScan.appendOutputTail('a'.repeat(512 * 1024), 'TAIL').endsWith('TAIL'), true);
});
