import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { targetForSetting } from './settings';

/**
 * Watches the coverage report a run parsed and re-reads it when the tests
 * rewrite it, so an external watcher (`dotnet watch test`, `jest --watch`,
 * `flutter test --watch`) keeps the status bar, gutter and report panel
 * current without anyone running anything from the extension.
 *
 * Only the report is re-read — the coverage command is never re-run, so this
 * cannot start a test suite behind your back.
 */

/** Long enough that a burst of writes collapses into one refresh. */
const DEBOUNCE_MS = 600;

export interface WatchTiming {
    /** How long a burst of writes is allowed to collapse into one refresh. */
    debounceMs?: number;
    /** How long to wait for the report to stop changing before giving up. */
    stabilityTimeoutMs?: number;
    pollMs?: number;
}

export interface FileStat {
    size: number;
    mtimeMs: number;
}

export interface StableFileOptions {
    stat: (fsPath: string) => Promise<FileStat>;
    wait: (ms: number) => Promise<void>;
    /** Give up and read anyway rather than watching a file that is rewritten continuously. */
    timeoutMs?: number;
    pollMs?: number;
}

/**
 * Wait until a file stops changing. A report read while the test runner is
 * still writing it parses "successfully" into wrong numbers — a half-written
 * LCOV file is still valid LCOV — so this is the difference between a live
 * figure and a figure that flickers to nonsense.
 *
 * Returns false when the file never settled (or vanished), so the caller can
 * skip this round instead of reporting a partial file.
 */
export async function waitForStableFile(fsPath: string, options: StableFileOptions): Promise<boolean> {
    const pollMs = options.pollMs ?? 150;
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    let previous: FileStat | undefined;
    while (Date.now() < deadline) {
        let current: FileStat;
        try {
            current = await options.stat(fsPath);
        } catch {
            return false; // being replaced, or gone entirely
        }
        if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
            return true;
        }
        previous = current;
        await options.wait(pollMs);
    }
    return false;
}

export class CoverageWatcher implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private watched: { folder: vscode.WorkspaceFolder; reportPath: string } | undefined;
    private refreshing = false;
    /** A write that arrived while a refresh was running, still to be read. */
    private pending = false;
    private readonly listeners: vscode.Disposable[] = [];

    constructor(
        private readonly refresh: (folder: vscode.WorkspaceFolder) => Promise<void>,
        private readonly log: (message: string) => void = () => {},
        private readonly timing: WatchTiming = {}
    ) {
        this.listeners.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('sonarcloud.coverage.watchReport')) {
                    this.apply();
                }
            })
        );
    }

    dispose(): void {
        for (const listener of this.listeners) {
            listener.dispose();
        }
        this.stop();
    }

    get isWatching(): boolean {
        return !!this.watcher;
    }

    /** The report currently being watched, for the status bar tooltip. */
    get target(): { folder: vscode.WorkspaceFolder; reportPath: string } | undefined {
        return this.watched;
    }

    /** Remember what a completed run parsed, and start watching if enabled. */
    track(folder: vscode.WorkspaceFolder, reportPath: string): void {
        const unchanged = this.watched?.folder.uri.fsPath === folder.uri.fsPath && this.watched.reportPath === reportPath;
        this.watched = { folder, reportPath };
        if (!unchanged || !this.watcher) {
            this.apply();
        }
    }

    /** Returns the new state, so the caller can report it. */
    async toggle(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('sonarcloud');
        const next = !config.get<boolean>('coverage.watchReport', false);
        await config.update('coverage.watchReport', next, targetForSetting(config, 'coverage.watchReport'));
        // onDidChangeConfiguration also calls apply(); doing it here keeps the
        // state correct even in hosts that deliver that event asynchronously.
        this.apply();
        return next;
    }

    private apply(): void {
        const enabled = vscode.workspace.getConfiguration('sonarcloud').get<boolean>('coverage.watchReport', false);
        this.stop();
        if (!enabled || !this.watched) {
            return;
        }
        const { folder, reportPath } = this.watched;
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, reportPath),
            false,
            false,
            true // a deleted report has nothing to read; wait for it to come back
        );
        this.watcher.onDidChange(() => this.schedule());
        this.watcher.onDidCreate(() => this.schedule());
        this.log(`Watching "${reportPath}" for changes.`);
    }

    private stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pending = false;
        this.watcher?.dispose();
        this.watcher = undefined;
    }

    private schedule(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.run();
        }, this.timing.debounceMs ?? DEBOUNCE_MS);
    }

    private async run(): Promise<void> {
        const target = this.watched;
        // Not watching any more: a refresh queued before the watch was turned
        // off must not still fire after it.
        if (!target || !this.watcher) {
            return;
        }
        if (this.refreshing) {
            // Dropping this write would leave the last one unread: the tests
            // that finished during the refresh would never reach the UI.
            this.pending = true;
            return;
        }
        this.refreshing = true;
        try {
            const absolute = path.resolve(target.folder.uri.fsPath, target.reportPath);
            const stable = await waitForStableFile(absolute, {
                stat: async fsPath => {
                    const stats = await fsPromises.stat(fsPath);
                    return { size: stats.size, mtimeMs: stats.mtimeMs };
                },
                wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
                timeoutMs: this.timing.stabilityTimeoutMs,
                pollMs: this.timing.pollMs
            });
            if (!stable) {
                this.log(`"${target.reportPath}" is still being written — skipping this refresh.`);
                return;
            }
            await this.refresh(target.folder);
        } catch (err) {
            // A background refresh must never pop an error dialog.
            this.log(`Watch refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.refreshing = false;
            if (this.pending) {
                this.pending = false;
                this.schedule();
            }
        }
    }
}
