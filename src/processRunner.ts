import { spawn } from 'child_process';
import * as vscode from 'vscode';

/** Raised when the executable itself is missing, so callers can name it. */
export class CommandNotFoundError extends Error {
    constructor(public readonly command: string) {
        super(`Could not find "${command}".`);
    }
}

export interface ToolRunResult {
    exitCode: number;
    /** Tail of the combined output, capped so long builds stay in memory. */
    output: string;
}

const OUTPUT_TAIL_LIMIT = 512 * 1024;

/** How long a process tree gets to exit politely before it is killed outright. */
const TERMINATION_GRACE_MS = 5000;

/**
 * Spawn options that make a child killable as a group.
 *
 * Everything the extension runs is a launcher: `sonar-scanner` is a shell
 * script that execs java, `npm test` forks a runner, `dotnet test` starts a
 * test host. Killing only the process we spawned leaves the real work running
 * — a java scanner still burning CPU, or a test suite still rewriting the very
 * report watch mode is reading — while the UI reports the run as cancelled.
 */
export function processGroupOptions(): { detached: boolean } {
    // On POSIX this makes the child a process-group leader, so the whole group
    // can be signalled. Windows has no process groups; taskkill /T walks the
    // tree instead, and detached there would spawn a console window.
    return { detached: process.platform !== 'win32' };
}

/**
 * Terminate a child and everything it started. Best effort by nature: a
 * process that ignores SIGTERM is killed after a grace period, and a tree that
 * has already exited is simply nothing to signal.
 */
export function killProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
    const pid = child.pid;
    if (pid === undefined) {
        child.kill();
        return;
    }
    if (process.platform === 'win32') {
        // /T takes the children with it, /F because a test host asked politely
        // will often decline.
        spawn('taskkill', ['/pid', String(pid), '/T', '/F']).on('error', () => child.kill());
        return;
    }
    const signalGroup = (signal: NodeJS.Signals): boolean => {
        try {
            process.kill(-pid, signal);
            return true;
        } catch {
            // No group (the child never started, or already reaped): fall back
            // to the child itself so a lone process is still stopped.
            try {
                child.kill(signal);
            } catch {
                // already gone
            }
            return false;
        }
    };
    if (!signalGroup('SIGTERM')) {
        return;
    }
    const timer = setTimeout(() => signalGroup('SIGKILL'), TERMINATION_GRACE_MS);
    // Do not hold the host open just to deliver a follow-up kill.
    timer.unref?.();
}

/**
 * Runs an ecosystem tool (npm, flutter, gradle, pytest, …). These are shell
 * shims on Windows, so a shell is required there — and with shell:true Node
 * joins the arguments unquoted, hence the explicit quoting.
 */
export function runTool(
    command: string,
    args: string[],
    folder: vscode.WorkspaceFolder,
    cancelToken: vscode.CancellationToken,
    output: vscode.OutputChannel
): Promise<ToolRunResult> {
    return new Promise<ToolRunResult>((resolve, reject) => {
        const useShell = process.platform === 'win32';
        let tail = '';
        const child = spawn(useShell ? quote(command) : command, useShell ? args.map(quote) : args, {
            cwd: folder.uri.fsPath,
            env: { ...process.env },
            shell: useShell,
            ...processGroupOptions()
        });
        const cancellation = cancelToken.onCancellationRequested(() => killProcessTree(child));
        const append = (chunk: Buffer) => {
            const text = chunk.toString();
            tail = (tail + text).slice(-OUTPUT_TAIL_LIMIT);
            output.append(text);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.on('error', err => {
            cancellation.dispose();
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new CommandNotFoundError(command));
            } else {
                reject(err);
            }
        });
        child.on('close', code => {
            cancellation.dispose();
            resolve({ exitCode: code ?? 1, output: tail });
        });
    });
}

/**
 * Quoting for cmd.exe: double quotes keep spaces together and stop `&`, `|`,
 * `<`, `>` and `^` from being interpreted.
 */
function quote(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}
