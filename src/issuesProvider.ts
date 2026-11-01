import * as path from 'path';
import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError, SonarIssue } from './client';
import { severityIcon, severityRank, titleCase } from './labels';
import { IssueBaselineStore, newIssueKeys, relativeTime, toBaseline } from './newIssues';
import { SonarState } from './state';

export interface FileNode {
    kind: 'file';
    /** Repo-relative path from SonarCloud, or undefined for project-level issues. */
    path?: string;
    issues: IssueNode[];
}

export interface IssueNode {
    kind: 'issue';
    issue: SonarIssue;
    /** Repo-relative path of the file the issue is in, when known. */
    path?: string;
    ruleName?: string;
    /** True when this issue was not in the list the last time it was seen. */
    isNew?: boolean;
}

export interface MessageNode {
    kind: 'message';
    text: string;
}

export interface LoadMoreNode {
    kind: 'loadMore';
    remaining: number;
}

export type IssuesTreeNode = FileNode | IssueNode | MessageNode | LoadMoreNode;

export interface IssuesLoadInfo {
    shown: number;
    total: number;
    /** Issues absent from the baseline, i.e. new since it was taken. */
    newCount?: number;
    /** How long ago the baseline was taken, e.g. "2 hours ago". */
    newSince?: string;
}

/** An issue paired with its repo-relative file path, as consumed by the diagnostics publisher. */
export interface LoadedIssue {
    issue: SonarIssue;
    path?: string;
}

const PAGE_SIZE = 500;
// issues/search rejects requests reaching past the 10,000th result.
const MAX_PAGES = 20;

export class IssuesProvider implements vscode.TreeDataProvider<IssuesTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _onDidLoad = new vscode.EventEmitter<IssuesLoadInfo>();
    readonly onDidLoad = this._onDidLoad.event;

    private readonly _onDidLoadIssues = new vscode.EventEmitter<LoadedIssue[]>();
    /** Fires with the full loaded issue list, so diagnostics can be published without a second API call. */
    readonly onDidLoadIssues = this._onDidLoadIssues.event;

    private readonly _onDidFailLoad = new vscode.EventEmitter<void>();
    readonly onDidFailLoad = this._onDidFailLoad.event;

    private pageLimit = 1;
    /** Increments per root load; guards events from slow, superseded requests. */
    private generation = 0;

    /** The issue keys of the last completed load, for "mark as seen". */
    private lastLoadedKeys: string[] = [];

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState,
        private readonly baselines?: IssueBaselineStore
    ) {}

    refresh(): void {
        this.pageLimit = 1;
        this._onDidChangeTreeData.fire();
    }

    /**
     * Take the currently loaded issues as the new baseline, so nothing that is
     * on screen right now counts as new next time.
     */
    async markSeen(): Promise<boolean> {
        const project = this.state.project;
        if (!this.baselines || !project || this.lastLoadedKeys.length === 0) {
            return false;
        }
        await this.baselines.set(project.key, this.state.branch, toBaseline(this.lastLoadedKeys));
        // Reload rather than repaint: the nodes carry their own "new" flag, and
        // a reload also picks up anything that arrived while you were reading.
        this._onDidChangeTreeData.fire();
        return true;
    }

    loadMore(): void {
        if (this.pageLimit < MAX_PAGES) {
            this.pageLimit++;
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(node: IssuesTreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'file':
                return this.fileTreeItem(node);
            case 'issue':
                return this.issueTreeItem(node);
            case 'loadMore': {
                const item = new vscode.TreeItem(
                    `Load ${Math.min(node.remaining, PAGE_SIZE)} more (${node.remaining} remaining)…`,
                    vscode.TreeItemCollapsibleState.None
                );
                item.iconPath = new vscode.ThemeIcon('ellipsis');
                item.command = { command: 'sonarcloud.loadMoreIssues', title: 'Load More Issues' };
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    private fileTreeItem(node: FileNode): vscode.TreeItem {
        const label = node.path ? path.posix.basename(node.path) : 'Project-level issues';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        if (node.path) {
            const dir = path.posix.dirname(node.path);
            item.description = dir === '.' ? `${node.issues.length}` : `${dir} · ${node.issues.length}`;
            // Lets the active file icon theme pick an icon by file name.
            item.resourceUri = vscode.Uri.from({ scheme: 'sonarcloud', path: '/' + node.path });
            item.tooltip = node.path;
        } else {
            item.description = String(node.issues.length);
            item.iconPath = new vscode.ThemeIcon('project');
        }
        item.contextValue = 'file';
        return item;
    }

    private issueTreeItem(node: IssueNode): vscode.TreeItem {
        const issue = node.issue;
        const item = new vscode.TreeItem(issue.message, vscode.TreeItemCollapsibleState.None);
        item.id = issue.key;
        item.contextValue = node.isNew ? 'issue.new' : 'issue';
        item.iconPath = severityIcon(issue.severity);
        const parts = [titleCase(issue.severity), titleCase(issue.type)];
        if (issue.line !== undefined) {
            parts.unshift(`L${issue.line}`);
        }
        if (node.isNew) {
            // The description is plain text, so this is a word rather than an icon.
            parts.unshift('NEW');
        }
        item.description = parts.join(' · ');

        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`**${escapeMarkdown(issue.message)}**\n\n`);
        if (node.isNew) {
            tooltip.appendMarkdown('$(sparkle) New since you last checked this project\n\n');
        }
        if (node.ruleName) {
            tooltip.appendMarkdown(`Rule: ${escapeMarkdown(node.ruleName)} (\`${issue.rule}\`)\n\n`);
        }
        tooltip.appendMarkdown(`Severity: **${titleCase(issue.severity)}** · Type: **${titleCase(issue.type)}**\n\n`);
        if (node.path) {
            tooltip.appendMarkdown(`Location: \`${node.path}${issue.line !== undefined ? `:${issue.line}` : ''}\`\n\n`);
        }
        if (issue.effort) {
            tooltip.appendMarkdown(`Effort: ${issue.effort}\n\n`);
        }
        if (issue.tags?.length) {
            tooltip.appendMarkdown(`Tags: ${issue.tags.join(', ')}\n\n`);
        }
        item.tooltip = tooltip;

        item.command = {
            command: 'sonarcloud.openIssue',
            title: 'Open Issue Location',
            arguments: [node]
        };
        return item;
    }

    private hasFilters(): boolean {
        return (
            this.state.severities.length > 0 ||
            this.state.types.length > 0 ||
            this.state.newCodeOnly ||
            this.state.newIssuesOnly === true
        );
    }

    async getChildren(element?: IssuesTreeNode): Promise<IssuesTreeNode[]> {
        if (element) {
            return element.kind === 'file' ? element.issues : [];
        }
        const project = this.state.project;
        if (!project) {
            return [];
        }
        const generation = ++this.generation;
        try {
            const issues: SonarIssue[] = [];
            const pathByComponent = new Map<string, string | undefined>();
            const ruleNames = new Map<string, string>();
            let total = 0;
            for (let page = 1; page <= this.pageLimit; page++) {
                const result = await this.client.searchIssues({
                    projectKey: project.key,
                    branch: this.state.branch,
                    severities: this.state.severities,
                    types: this.state.types,
                    newCodeOnly: this.state.newCodeOnly,
                    page
                });
                issues.push(...result.issues);
                for (const c of result.components) {
                    pathByComponent.set(c.key, c.path);
                }
                for (const r of result.rules) {
                    ruleNames.set(r.key, r.name);
                }
                total = result.total;
                if (page * PAGE_SIZE >= total) {
                    break;
                }
            }
            const loaded: LoadedIssue[] = issues.map(issue => ({
                issue,
                path: pathByComponent.get(issue.component)
            }));
            const keys = issues.map(issue => issue.key);
            const baseline = this.baselines?.get(project.key, this.state.branch);
            const isNew = newIssueKeys(baseline, keys);
            if (generation === this.generation) {
                this.lastLoadedKeys = keys;
                this._onDidLoad.fire({
                    shown: issues.length,
                    total,
                    newCount: isNew.size,
                    newSince: baseline ? relativeTime(baseline.at) : undefined
                });
                this._onDidLoadIssues.fire(loaded);
                // The first complete, unfiltered load establishes the baseline
                // silently: marking every existing issue as "new" on the first
                // run would be noise, and a filtered or partial load would
                // record a baseline that later reports old issues as new.
                if (!baseline && this.baselines && total === issues.length && !this.hasFilters()) {
                    await this.baselines.set(project.key, this.state.branch, toBaseline(keys));
                }
            }

            // "Only new" is applied here, not in the query: SonarCloud has no
            // notion of what this workspace has already seen.
            const onlyNew = this.state.newIssuesOnly === true;
            const groups = new Map<string, FileNode>();
            for (const { issue, path: filePath } of loaded) {
                if (onlyNew && !isNew.has(issue.key)) {
                    continue;
                }
                const groupKey = filePath ?? '';
                let group = groups.get(groupKey);
                if (!group) {
                    group = { kind: 'file', path: filePath, issues: [] };
                    groups.set(groupKey, group);
                }
                group.issues.push({
                    kind: 'issue',
                    issue,
                    path: filePath,
                    ruleName: ruleNames.get(issue.rule),
                    isNew: isNew.has(issue.key)
                });
            }

            const nodes: IssuesTreeNode[] = [...groups.values()].sort((a, b) =>
                (a.path ?? '').localeCompare(b.path ?? '')
            );
            for (const group of nodes as FileNode[]) {
                group.issues.sort(
                    (a, b) =>
                        (a.issue.line ?? 0) - (b.issue.line ?? 0) ||
                        severityRank(a.issue.severity) - severityRank(b.issue.severity)
                );
            }
            if (total > issues.length) {
                if (this.pageLimit < MAX_PAGES) {
                    nodes.push({ kind: 'loadMore', remaining: total - issues.length });
                } else {
                    nodes.push({
                        kind: 'message',
                        text: `Showing the first ${issues.length} of ${total} issues — narrow the filters to see the rest.`
                    });
                }
            }
            if (nodes.length === 0) {
                nodes.push({
                    kind: 'message',
                    text: onlyNew
                        ? baseline
                            ? `Nothing new since ${relativeTime(baseline.at)}.`
                            : 'Nothing is marked new yet — this is the first look at these issues.'
                        : 'No open issues match the current filters.'
                });
            }
            return nodes;
        } catch (err) {
            if (generation === this.generation) {
                this._onDidFailLoad.fire();
                const message = err instanceof SonarCloudError ? err.message : String(err);
                void vscode.window.showErrorMessage(`SonarCloud: failed to load issues — ${message}`);
                return [{ kind: 'message', text: message }];
            }
            return [];
        }
    }
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
