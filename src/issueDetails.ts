import * as vscode from 'vscode';
import { SonarCloudClient, SonarIssue, SonarRuleDetails } from './client';
import { titleCase } from './labels';

let currentPanel: vscode.WebviewPanel | undefined;

export async function showIssueDetails(
    client: SonarCloudClient,
    issue: SonarIssue,
    filePath: string | undefined,
    branch: string | undefined
): Promise<void> {
    let rule: SonarRuleDetails | undefined;
    try {
        rule = await client.getRule(issue.rule);
    } catch {
        // Details still render without the rule description.
    }

    // Reuse a single panel — clicking through issues shouldn't stack editors.
    if (!currentPanel) {
        currentPanel = vscode.window.createWebviewPanel(
            'sonarcloudIssue',
            'SonarCloud Issue',
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        });
    } else {
        currentPanel.reveal(currentPanel.viewColumn ?? vscode.ViewColumn.Beside, true);
    }
    currentPanel.webview.html = renderHtml(client, issue, rule, filePath, branch);
}

function renderHtml(
    client: SonarCloudClient,
    issue: SonarIssue,
    rule: SonarRuleDetails | undefined,
    filePath: string | undefined,
    branch: string | undefined
): string {
    const location = filePath
        ? `${filePath}${issue.line !== undefined ? `:${issue.line}` : ''}`
        : issue.component;
    const ruleDescription = rule
        ? rule.htmlDesc ?? (rule.descriptionSections ?? []).map(s => s.content).join('\n')
        : '';

    const badges = [
        badge(titleCase(issue.severity)),
        badge(titleCase(issue.type)),
        issue.effort ? badge(`Effort: ${issue.effort}`) : '',
        issue.status ? badge(titleCase(issue.status)) : ''
    ]
        .filter(Boolean)
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:;">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 0 1.5em 2em;
        line-height: 1.5;
        max-width: 60em;
    }
    h1 { font-size: 1.3em; }
    code, pre {
        font-family: var(--vscode-editor-font-family);
        background: var(--vscode-textCodeBlock-background);
        border-radius: 3px;
    }
    pre { padding: 0.7em; overflow-x: auto; }
    a { color: var(--vscode-textLink-foreground); }
    .badge {
        display: inline-block;
        padding: 0.1em 0.6em;
        margin-right: 0.4em;
        border-radius: 1em;
        font-size: 0.85em;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
    }
    .meta { margin: 0.8em 0; }
    .location { font-family: var(--vscode-editor-font-family); opacity: 0.85; }
    hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); margin: 1.2em 0; }
</style>
</head>
<body>
    <h1>${escapeHtml(issue.message)}</h1>
    <div class="meta">${badges}</div>
    <div class="location">📍 ${escapeHtml(location)}</div>
    <p><a href="${escapeHtml(client.issueUrl(issue, branch))}">Open this issue on SonarCloud</a></p>
    <hr>
    <h2>${escapeHtml(rule?.name ?? issue.rule)} <small><code>${escapeHtml(issue.rule)}</code></small></h2>
    ${ruleDescription || '<p><em>Rule description unavailable.</em></p>'}
</body>
</html>`;
}

function badge(text: string): string {
    return `<span class="badge">${escapeHtml(text)}</span>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
