import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError, SonarProject } from './client';
import { SonarState } from './state';

export class ProjectsProvider implements vscode.TreeDataProvider<SonarProject> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cached: SonarProject[] | undefined;
    private warnedTruncated = false;

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState,
        private readonly isConfigured: () => Promise<boolean>
    ) {}

    /** Drop the cached project list and refetch from SonarCloud. */
    refresh(): void {
        this.cached = undefined;
        this._onDidChangeTreeData.fire();
    }

    /** Repaint the items (e.g. the selected-project checkmark) without refetching. */
    redraw(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(project: SonarProject): vscode.TreeItem {
        const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.None);
        item.id = project.key;
        item.description = project.key;
        item.contextValue = 'project';
        const selected = this.state.project?.key === project.key;
        item.iconPath = selected
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('repo');
        item.tooltip = selected ? `${project.name} (selected)` : project.name;
        item.command = {
            command: 'sonarcloud.selectProject',
            title: 'Select Project',
            arguments: [project]
        };
        return item;
    }

    async getChildren(element?: SonarProject): Promise<SonarProject[]> {
        if (element) {
            return [];
        }
        if (!(await this.isConfigured())) {
            return [];
        }
        if (this.cached) {
            return this.cached;
        }
        try {
            const { projects, total } = await this.client.listProjects();
            this.cached = projects;
            if (total > projects.length && !this.warnedTruncated) {
                this.warnedTruncated = true;
                void vscode.window.showWarningMessage(
                    `SonarCloud: the organization has ${total} projects; only the first ${projects.length} are listed.`
                );
            }
            return projects;
        } catch (err) {
            const message = err instanceof SonarCloudError ? err.message : String(err);
            void vscode.window.showErrorMessage(`SonarCloud: failed to load projects — ${message}`);
            return [];
        }
    }
}
