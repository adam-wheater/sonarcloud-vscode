import * as vscode from 'vscode';

export interface ProjectRef {
    key: string;
    name: string;
}

const KEYS = {
    project: 'sonarcloud.selectedProject',
    branch: 'sonarcloud.selectedBranch',
    severities: 'sonarcloud.filter.severities',
    types: 'sonarcloud.filter.types',
    newCode: 'sonarcloud.filter.newCode',
    scanLanguage: 'sonarcloud.scan.language',
    newIssuesOnly: 'sonarcloud.filter.newIssuesOnly'
} as const;

/**
 * Per-workspace selection state (project, branch, filters), persisted across sessions.
 */
export class SonarState {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly memento: vscode.Memento) {}

    get project(): ProjectRef | undefined {
        return this.memento.get<ProjectRef>(KEYS.project);
    }

    /** Selected branch name; undefined means the project's main branch. */
    get branch(): string | undefined {
        return this.memento.get<string>(KEYS.branch);
    }

    /** Empty array means "no severity filter" (show all). */
    get severities(): string[] {
        return this.memento.get<string[]>(KEYS.severities, []);
    }

    /** Empty array means "no type filter" (show all). */
    get types(): string[] {
        return this.memento.get<string[]>(KEYS.types, []);
    }

    /** When true, only issues introduced in the project's "new code" period are shown. */
    get newCodeOnly(): boolean {
        return this.memento.get<boolean>(KEYS.newCode, false);
    }

    async setProject(project: ProjectRef | undefined): Promise<void> {
        await this.memento.update(KEYS.project, project);
        await this.memento.update(KEYS.branch, undefined);
        this._onDidChange.fire();
    }

    async setBranch(branch: string | undefined): Promise<void> {
        await this.memento.update(KEYS.branch, branch);
        this._onDidChange.fire();
    }

    async setSeverities(severities: string[]): Promise<void> {
        await this.memento.update(KEYS.severities, severities);
        this._onDidChange.fire();
    }

    async setTypes(types: string[]): Promise<void> {
        await this.memento.update(KEYS.types, types);
        this._onDidChange.fire();
    }

    /**
     * Language profile chosen for local scans in this workspace, so the scan
     * only asks once. Undefined means "ask on the next scan".
     */
    get scanLanguage(): string | undefined {
        return this.memento.get<string>(KEYS.scanLanguage);
    }

    async setScanLanguage(languageId: string | undefined): Promise<void> {
        await this.memento.update(KEYS.scanLanguage, languageId);
        // Deliberately no onDidChange: this affects scanning, not the views.
    }

    /** When true, only issues that appeared since the last check are listed. */
    get newIssuesOnly(): boolean {
        return this.memento.get<boolean>(KEYS.newIssuesOnly, false);
    }

    async setNewIssuesOnly(newIssuesOnly: boolean): Promise<void> {
        await this.memento.update(KEYS.newIssuesOnly, newIssuesOnly);
        this._onDidChange.fire();
    }

    async setNewCodeOnly(newCodeOnly: boolean): Promise<void> {
        await this.memento.update(KEYS.newCode, newCodeOnly);
        this._onDidChange.fire();
    }

    async clearFilters(): Promise<void> {
        await this.memento.update(KEYS.severities, []);
        await this.memento.update(KEYS.types, []);
        await this.memento.update(KEYS.newCode, false);
        await this.memento.update(KEYS.newIssuesOnly, false);
        this._onDidChange.fire();
    }
}
