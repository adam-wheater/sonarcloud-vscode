import { spawn } from 'child_process';
import * as vscode from 'vscode';

/**
 * Which lines this branch adds or modifies relative to its base, so coverage
 * can be reported for "the code I am about to merge" rather than the whole
 * repository. Uses git directly — the built-in git extension may be disabled.
 */

export interface ChangedLines {
    /** Workspace-relative POSIX path → line numbers added or modified. */
    byFile: Map<string, Set<number>>;
    /** The ref the diff was taken against, e.g. "origin/main". */
    baseRef: string;
    /** Merge-base commit the comparison actually used. */
    mergeBase: string;
    totalChangedLines: number;
}

const BASE_REF_CANDIDATES = ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'];

export async function resolveBaseRef(
    folder: vscode.WorkspaceFolder,
    configured: string | undefined
): Promise<string | undefined> {
    if (configured) {
        return (await refExists(folder, configured)) ? configured : undefined;
    }
    // The branch's own upstream is the most accurate base when it is set.
    const upstream = (await git(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
    if (upstream && (await refExists(folder, upstream))) {
        const head = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        // An upstream pointing at this same branch is not a useful base.
        if (!upstream.endsWith(`/${head}`)) {
            return upstream;
        }
    }
    for (const candidate of BASE_REF_CANDIDATES) {
        if (await refExists(folder, candidate)) {
            return candidate;
        }
    }
    return undefined;
}

export async function getChangedLines(
    folder: vscode.WorkspaceFolder,
    baseRef: string
): Promise<ChangedLines | undefined> {
    const mergeBase = (await git(folder, ['merge-base', 'HEAD', baseRef])).stdout.trim();
    if (!mergeBase) {
        return undefined;
    }
    // Diffing the working tree (not HEAD) against the merge base covers
    // committed and uncommitted work — everything the merge would bring.
    const diff = await git(folder, ['diff', '-U0', '--no-color', '--diff-filter=d', mergeBase]);
    if (diff.code !== 0) {
        return undefined;
    }

    const byFile = new Map<string, Set<number>>();
    let totalChangedLines = 0;
    let current: Set<number> | undefined;
    let previousWasOldFileHeader = false;
    for (const line of diff.stdout.split(/\r?\n/)) {
        // In a unified diff the new-file header always follows the old-file
        // one. Without that check, *adding* a line whose text begins with
        // "++ " produces a "+++ " line that reads exactly like a header, and
        // every line after it gets attributed to a file that does not exist.
        const isFileHeader = line.startsWith('+++ ') && previousWasOldFileHeader;
        previousWasOldFileHeader = line.startsWith('--- ');
        if (isFileHeader) {
            const target = line.slice(4).trim();
            if (target === '/dev/null') {
                current = undefined;
                continue;
            }
            // Strip git's "b/" prefix and surrounding quotes on unusual paths.
            const filePath = unquote(target.replace(/^b\//, ''));
            current = new Set<number>();
            byFile.set(filePath, current);
        } else if (current && line.startsWith('@@')) {
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!hunk) {
                continue;
            }
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let n = start; n < start + count; n++) {
                current.add(n);
            }
            totalChangedLines += count;
        }
    }
    for (const [file, lines] of byFile) {
        if (lines.size === 0) {
            byFile.delete(file);
        }
    }
    return { byFile, baseRef, mergeBase, totalChangedLines };
}

async function refExists(folder: vscode.WorkspaceFolder, ref: string): Promise<boolean> {
    const result = await git(folder, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.code === 0 && result.stdout.trim().length > 0;
}

function unquote(value: string): string {
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value.slice(1, -1);
        }
    }
    return value;
}

function git(folder: vscode.WorkspaceFolder, args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise(resolve => {
        let stdout = '';
        const child = spawn('git', args, { cwd: folder.uri.fsPath, shell: false });
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', () => {
            // git chatter is not useful here; the exit code carries the verdict
        });
        child.on('error', () => resolve({ code: 1, stdout: '' }));
        child.on('close', code => resolve({ code: code ?? 1, stdout }));
    });
}
