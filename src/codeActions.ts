import * as vscode from 'vscode';
import { SonarDiagnostics } from './diagnostics';
import { IssueNode } from './issuesProvider';
import { titleCase } from './labels';

/**
 * Quick fixes on the SonarCloud squiggles themselves. The issues are already in
 * the Problems panel; without this the only way to act on one is to find it
 * again in the sidebar, which is the long way round from the line you are
 * looking at.
 */
export class SonarCodeActions implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

    constructor(private readonly diagnostics: SonarDiagnostics) {}

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== 'sonarcloud') {
                continue; // someone else's squiggle
            }
            const found = this.diagnostics.issueFor(document.uri, diagnostic);
            if (!found) {
                continue;
            }
            const node: IssueNode = { kind: 'issue', issue: found.issue, path: found.path };
            const severity = titleCase(found.issue.severity);

            actions.push(
                action(`Fix this ${severity.toLowerCase()} issue with Copilot`, 'sonarcloud.fixWithCopilot', node, diagnostic, true),
                action('Explain this SonarCloud rule', 'sonarcloud.showIssueDetails', node, diagnostic),
                action('Resolve on SonarCloud (false positive / won\'t fix)…', 'sonarcloud.resolveIssue', node, diagnostic)
            );
        }
        return actions;
    }
}

function action(
    title: string,
    command: string,
    node: IssueNode,
    diagnostic: vscode.Diagnostic,
    preferred = false
): vscode.CodeAction {
    const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    codeAction.command = { command, title, arguments: [node] };
    // Attaching the diagnostic lets VS Code offer it from the Problems panel too.
    codeAction.diagnostics = [diagnostic];
    codeAction.isPreferred = preferred;
    return codeAction;
}
