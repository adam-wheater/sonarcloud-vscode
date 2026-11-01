import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Best-effort detection of the branch currently checked out in the workspace,
 * so the branch picker can highlight it. Reads .git/HEAD directly to avoid
 * depending on the built-in git extension being active.
 */
export async function detectWorkspaceGitBranch(): Promise<string | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') {
            continue;
        }
        try {
            let gitPath = path.join(folder.uri.fsPath, '.git');
            const stat = await fs.stat(gitPath);
            if (stat.isFile()) {
                // Worktree/submodule: .git is a file containing "gitdir: <path>"
                const content = await fs.readFile(gitPath, 'utf8');
                const match = /^gitdir:\s*(.+)$/m.exec(content);
                if (!match) {
                    continue;
                }
                gitPath = path.resolve(folder.uri.fsPath, match[1].trim());
            }
            const head = await fs.readFile(path.join(gitPath, 'HEAD'), 'utf8');
            const refMatch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
            if (refMatch) {
                return refMatch[1].trim();
            }
        } catch {
            // Not a git checkout, or unreadable — try the next folder.
        }
    }
    return undefined;
}
