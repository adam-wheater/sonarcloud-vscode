'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const { runTool, killProcessTree, processGroupOptions, CommandNotFoundError } = load('processRunner');
const { spawn, execFileSync } = require('child_process');

function channel() {
    return vscode.window.createOutputChannel('test');
}

function neverCancelled() {
    return new vscode.CancellationTokenSource().token;
}

test.afterEach(() => cleanup());

test('captures stdout and the exit code', async () => {
    const folder = makeWorkspace({});
    const output = channel();
    const result = await runTool(
        process.execPath,
        ['-e', 'process.stdout.write("hello from the tool")'],
        folder,
        neverCancelled(),
        output
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /hello from the tool/);
    assert.match(output.lines.join(''), /hello from the tool/);
});

test('captures stderr and a non-zero exit code', async () => {
    const folder = makeWorkspace({});
    const result = await runTool(
        process.execPath,
        ['-e', 'process.stderr.write("boom"); process.exit(3)'],
        folder,
        neverCancelled(),
        channel()
    );
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /boom/);
});

test('runs in the workspace folder', async () => {
    const folder = makeWorkspace({});
    const result = await runTool(
        process.execPath,
        ['-e', 'process.stdout.write(process.cwd())'],
        folder,
        neverCancelled(),
        channel()
    );
    // macOS reports /private/var for /var, so compare the resolved tail.
    assert.ok(result.output.endsWith(require('path').basename(folder.uri.fsPath)));
});

test('a missing executable raises CommandNotFoundError naming the command', async () => {
    const folder = makeWorkspace({});
    await assert.rejects(
        () => runTool('definitely-not-a-real-binary-xyz', [], folder, neverCancelled(), channel()),
        error => {
            assert.ok(error instanceof CommandNotFoundError, 'must be the shared error class');
            assert.equal(error.command, 'definitely-not-a-real-binary-xyz');
            assert.match(error.message, /Could not find/);
            return true;
        }
    );
});

test('the scan and the coverage report share one CommandNotFoundError class', () => {
    // A module-local redeclaration would make `instanceof` checks silently fail,
    // so the "install it / turn the setting off" guidance would never appear.
    const localScan = load('localScan');
    const localCoverage = load('localCoverage');
    assert.ok(localScan.LocalScanner, 'localScan still exports its entry point');
    assert.ok(localCoverage.LocalCoverage, 'localCoverage still exports its entry point');
    assert.equal(load('processRunner').CommandNotFoundError, CommandNotFoundError);
});

test('cancellation terminates a long-running tool', async () => {
    const folder = makeWorkspace({});
    const source = new vscode.CancellationTokenSource();
    const started = Date.now();
    const pending = runTool(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)'],
        folder,
        source.token,
        channel()
    );
    setTimeout(() => source.cancel(), 50);
    const result = await pending;
    assert.notEqual(result.exitCode, 0, 'a killed process does not exit cleanly');
    assert.ok(Date.now() - started < 10000, 'must not wait for the full sleep');
});

test('arguments containing spaces survive intact', async () => {
    const folder = makeWorkspace({});
    const result = await runTool(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', 'a value with spaces'],
        folder,
        neverCancelled(),
        channel()
    );
    assert.equal(result.output.trim(), 'a value with spaces');
});


// ------------------------------------------------------ cancelling a run ---

/**
 * True while a process is still running. A killed orphan can linger as an
 * unreaped zombie when nothing is reaping (containers, CI), and `kill(pid, 0)`
 * succeeds for those — so ask for the state, not just for existence.
 */
function alive(pid) {
    try {
        const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return state.length > 0 && !state.startsWith('Z');
    } catch {
        return false; // ps exits non-zero when the pid is gone
    }
}

const posix = process.platform !== 'win32';

test('cancelling kills the work, not just the launcher', { skip: !posix && 'POSIX process groups' }, async () => {
    // Everything this extension runs is a launcher: sonar-scanner starts java,
    // npm test forks a runner, dotnet test starts a test host — and the
    // launcher often exits long before the work does. Signalling only the
    // process we spawned leaves that work running while the UI reports the run
    // as cancelled. The fixture mirrors it: the shell exits immediately and
    // leaves its background job behind, still in the same process group.
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; exit 0'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        ...processGroupOptions()
    });
    const grandchildPid = await new Promise(resolve => {
        child.stdout.on('data', chunk => resolve(Number(String(chunk).trim())));
    });
    await new Promise(resolve => child.on('exit', resolve));
    assert.ok(alive(grandchildPid), 'the work should outlive its launcher, or this proves nothing');

    killProcessTree(child);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(alive(grandchildPid), false, 'the work outlived a cancelled run');
});

test('killing something already gone is not an error', () => {
    const child = spawn('sh', ['-c', 'exit 0'], processGroupOptions());
    return new Promise(resolve => {
        child.on('close', () => {
            killProcessTree(child); // must not throw
            killProcessTree({ pid: undefined, kill: () => true });
            resolve();
        });
    });
});

test('a cancelled tool run resolves rather than hanging', async () => {
    const folder = makeWorkspace({});
    const source = new vscode.CancellationTokenSource();
    const run = runTool(posix ? 'sh' : 'cmd', posix ? ['-c', 'sleep 30'] : ['/c', 'timeout', '30'], folder, source.token, channel());
    await new Promise(resolve => setTimeout(resolve, 150));
    source.cancel();
    const result = await run;
    assert.notEqual(result.exitCode, 0, 'a killed process did not succeed');
});
