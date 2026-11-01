import * as vscode from 'vscode';
import { SonarCloudClient, SonarIssue } from './client';
import { LoadedIssue } from './issuesProvider';
import { SonarState } from './state';

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
    BLOCKER: vscode.DiagnosticSeverity.Error,
    CRITICAL: vscode.DiagnosticSeverity.Error,
    MAJOR: vscode.DiagnosticSeverity.Warning,
    MINOR: vscode.DiagnosticSeverity.Information,
    INFO: vscode.DiagnosticSeverity.Hint
};

/**
 * Publishes the issues loaded by the Issues view as VS Code diagnostics, so
 * files in the workspace get squiggles at the reported location and issues
 * appear in the Problems panel (where Copilot's agent mode also reads them).
 */
export class SonarDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('sonarcloud');
    private generation = 0;
    /**
     * The issue behind each published diagnostic, so code actions can offer to
     * act on it. Keyed by file, since a diagnostic carries no identity of its own.
     */
    private issuesByFile = new Map<string, { diagnostic: vscode.Diagnostic; issue: SonarIssue; path: string }[]>();

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {}

    static get enabled(): boolean {
        return vscode.workspace.getConfiguration('sonarcloud').get<boolean>('showDiagnostics', true);
    }

    dispose(): void {
        this.collection.dispose();
    }

    clear(): void {
        this.generation++;
        this.issuesByFile = new Map();
        this.collection.clear();
    }

    /** The SonarCloud issue a published diagnostic came from, if it is one of ours. */
    issueFor(uri: vscode.Uri, diagnostic: vscode.Diagnostic): { issue: SonarIssue; path: string } | undefined {
        const candidates = this.issuesByFile.get(uri.fsPath);
        if (!candidates) {
            return undefined;
        }
        // Match on position and message: a diagnostic has no stable identity,
        // and two rules can flag the same line.
        return candidates.find(
            entry =>
                entry.diagnostic.message === diagnostic.message &&
                entry.diagnostic.range.start.line === diagnostic.range.start.line
        );
    }

    async publish(items: LoadedIssue[]): Promise<void> {
        const generation = ++this.generation;
        if (!SonarDiagnostics.enabled) {
            this.collection.clear();
            return;
        }
        const byFile = new Map<string, SonarIssue[]>();
        for (const item of items) {
            if (!item.path) {
                continue;
            }
            const list = byFile.get(item.path);
            if (list) {
                list.push(item.issue);
            } else {
                byFile.set(item.path, [item.issue]);
            }
        }
        // Resolved together: a project with issues in hundreds of files would
        // otherwise pay one round trip to the file system per file, in series,
        // before a single squiggle appears.
        const resolved = await Promise.all(
            [...byFile.keys()].map(async filePath => ({ filePath, uri: await resolveWorkspaceFile(filePath) }))
        );
        const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
        const lookup = new Map<string, { diagnostic: vscode.Diagnostic; issue: SonarIssue; path: string }[]>();
        for (const { filePath, uri } of resolved) {
            const issues = byFile.get(filePath) ?? [];
            if (uri) {
                const diagnostics = issues.map(issue => this.toDiagnostic(issue));
                entries.push([uri, diagnostics]);
                lookup.set(
                    uri.fsPath,
                    diagnostics.map((diagnostic, index) => ({ diagnostic, issue: issues[index], path: filePath }))
                );
            }
        }
        if (generation !== this.generation) {
            return; // a newer publish (or clear) superseded this one
        }
        this.collection.clear();
        this.issuesByFile = lookup;
        for (const [uri, diagnostics] of entries) {
            this.collection.set(uri, diagnostics);
        }
    }

    private toDiagnostic(issue: SonarIssue): vscode.Diagnostic {
        const range = issue.textRange
            ? new vscode.Range(
                  Math.max(issue.textRange.startLine - 1, 0),
                  issue.textRange.startOffset,
                  Math.max(issue.textRange.endLine - 1, 0),
                  issue.textRange.endOffset
              )
            : issue.line !== undefined
              ? new vscode.Range(Math.max(issue.line - 1, 0), 0, Math.max(issue.line - 1, 0), Number.MAX_SAFE_INTEGER)
              : new vscode.Range(0, 0, 0, 0);
        const diagnostic = new vscode.Diagnostic(
            range,
            issue.message,
            SEVERITY_MAP[issue.severity] ?? vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'sonarcloud';
        diagnostic.code = {
            value: issue.rule,
            target: vscode.Uri.parse(this.client.issueUrl(issue, this.state.branch))
        };
        return diagnostic;
    }
}

/** Direct per-folder lookup only — no glob fallback, this runs for every file with issues. */
async function resolveWorkspaceFile(relativePath: string): Promise<vscode.Uri | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const candidate = vscode.Uri.joinPath(folder.uri, relativePath);
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // try the next folder
        }
    }
    return undefined;
}
