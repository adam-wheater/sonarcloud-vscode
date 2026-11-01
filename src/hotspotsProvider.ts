import * as path from 'path';
import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError, SonarHotspot } from './client';
import { titleCase } from './labels';
import { SonarState } from './state';

export interface HotspotFileNode {
    kind: 'file';
    path?: string;
    hotspots: HotspotNode[];
}

export interface HotspotNode {
    kind: 'hotspot';
    hotspot: SonarHotspot;
    path?: string;
}

export interface HotspotMessageNode {
    kind: 'message';
    text: string;
}

export type HotspotsTreeNode = HotspotFileNode | HotspotNode | HotspotMessageNode;

const PROBABILITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function probabilityIcon(probability: string): vscode.ThemeIcon {
    switch (probability) {
        case 'HIGH':
            return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
        case 'MEDIUM':
            return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.orange'));
        case 'LOW':
            return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.yellow'));
        default:
            return new vscode.ThemeIcon('flame');
    }
}

/** "sql-injection" -> "Sql Injection" */
function categoryLabel(category: string): string {
    return titleCase(category.replace(/-/g, '_'));
}

export class HotspotsProvider implements vscode.TreeDataProvider<HotspotsTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(node: HotspotsTreeNode): vscode.TreeItem {
        switch (node.kind) {
            case 'file': {
                const label = node.path ? path.posix.basename(node.path) : 'Project-level hotspots';
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
                if (node.path) {
                    const dir = path.posix.dirname(node.path);
                    item.description = dir === '.' ? `${node.hotspots.length}` : `${dir} · ${node.hotspots.length}`;
                    item.resourceUri = vscode.Uri.from({ scheme: 'sonarcloud', path: '/' + node.path });
                    item.tooltip = node.path;
                } else {
                    item.description = String(node.hotspots.length);
                    item.iconPath = new vscode.ThemeIcon('project');
                }
                item.contextValue = 'hotspotFile';
                return item;
            }
            case 'hotspot': {
                const hotspot = node.hotspot;
                const item = new vscode.TreeItem(hotspot.message, vscode.TreeItemCollapsibleState.None);
                item.id = hotspot.key;
                item.contextValue = 'hotspot';
                item.iconPath = probabilityIcon(hotspot.vulnerabilityProbability);
                const parts = [`${titleCase(hotspot.vulnerabilityProbability)} risk`, categoryLabel(hotspot.securityCategory)];
                if (hotspot.line !== undefined) {
                    parts.unshift(`L${hotspot.line}`);
                }
                item.description = parts.join(' · ');
                item.tooltip = new vscode.MarkdownString(
                    `**${hotspot.message}**\n\n` +
                        `Risk: **${titleCase(hotspot.vulnerabilityProbability)}** · Category: **${categoryLabel(hotspot.securityCategory)}**\n\n` +
                        (node.path ? `Location: \`${node.path}${hotspot.line !== undefined ? `:${hotspot.line}` : ''}\`\n\n` : '') +
                        'A hotspot is security-sensitive code to review, not a confirmed vulnerability.'
                );
                item.command = {
                    command: 'sonarcloud.openHotspot',
                    title: 'Open Hotspot Location',
                    arguments: [node]
                };
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                return item;
            }
        }
    }

    async getChildren(element?: HotspotsTreeNode): Promise<HotspotsTreeNode[]> {
        if (element) {
            return element.kind === 'file' ? element.hotspots : [];
        }
        const project = this.state.project;
        if (!project) {
            return [];
        }
        try {
            const result = await this.client.searchHotspots(project.key, this.state.branch);
            const pathByComponent = new Map<string, string | undefined>();
            for (const c of result.components) {
                pathByComponent.set(c.key, c.path);
            }

            const groups = new Map<string, HotspotFileNode>();
            for (const hotspot of result.hotspots) {
                const filePath = pathByComponent.get(hotspot.component);
                const groupKey = filePath ?? '';
                let group = groups.get(groupKey);
                if (!group) {
                    group = { kind: 'file', path: filePath, hotspots: [] };
                    groups.set(groupKey, group);
                }
                group.hotspots.push({ kind: 'hotspot', hotspot, path: filePath });
            }

            const nodes: HotspotsTreeNode[] = [...groups.values()].sort((a, b) =>
                (a.path ?? '').localeCompare(b.path ?? '')
            );
            for (const group of nodes as HotspotFileNode[]) {
                group.hotspots.sort(
                    (a, b) =>
                        (PROBABILITY_RANK[a.hotspot.vulnerabilityProbability] ?? 9) -
                            (PROBABILITY_RANK[b.hotspot.vulnerabilityProbability] ?? 9) ||
                        (a.hotspot.line ?? 0) - (b.hotspot.line ?? 0)
                );
            }
            if (result.total > result.hotspots.length) {
                nodes.push({
                    kind: 'message',
                    text: `Showing the first ${result.hotspots.length} of ${result.total} hotspots.`
                });
            }
            if (nodes.length === 0) {
                nodes.push({ kind: 'message', text: 'No security hotspots to review.' });
            }
            return nodes;
        } catch (err) {
            const message = err instanceof SonarCloudError ? err.message : String(err);
            void vscode.window.showErrorMessage(`SonarCloud: failed to load security hotspots — ${message}`);
            return [{ kind: 'message', text: message }];
        }
    }
}
