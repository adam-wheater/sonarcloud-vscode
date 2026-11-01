import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError } from './client';
import { describeCondition, failingConditions, QualityGateCondition } from './qualityGate';
import { SonarState } from './state';

const METRICS = ['alert_status', 'bugs', 'vulnerabilities', 'code_smells', 'security_hotspots'];

/**
 * Status bar summary for the selected project/branch: quality gate state and
 * total open issue count, visible without opening the sidebar.
 */
export class SonarStatusBar implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem('sonarcloud.status', vscode.StatusBarAlignment.Left, 50);
    private generation = 0;

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {
        this.item.name = 'SonarCloud';
        this.item.command = 'workbench.view.extension.sonarcloud';
    }

    dispose(): void {
        this.item.dispose();
    }

    async refresh(): Promise<void> {
        const project = this.state.project;
        if (!project) {
            this.generation++;
            this.item.hide();
            return;
        }
        const generation = ++this.generation;
        this.item.text = '$(sync~spin) SonarCloud';
        this.item.tooltip = `Loading SonarCloud status for ${project.name}…`;
        this.item.backgroundColor = undefined;
        this.item.show();
        try {
            const measures = await this.client.getMeasures(project.key, this.state.branch, METRICS);
            if (generation !== this.generation) {
                return;
            }
            const qualityGate = measures.get('alert_status');
            const issues =
                Number(measures.get('bugs') ?? 0) +
                Number(measures.get('vulnerabilities') ?? 0) +
                Number(measures.get('code_smells') ?? 0);
            const icon = qualityGate === 'OK' ? '$(pass-filled)' : qualityGate === 'ERROR' ? '$(error)' : '$(shield)';
            this.item.text = `${icon} SonarCloud: ${issues} issue${issues === 1 ? '' : 's'}`;
            this.item.backgroundColor =
                qualityGate === 'ERROR' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

            // Only ask why when it failed: "Failed" without a reason is what
            // sends people to the web UI.
            let failures: QualityGateCondition[] = [];
            if (qualityGate === 'ERROR') {
                try {
                    failures = failingConditions(
                        await this.client.getQualityGateStatus(project.key, this.state.branch)
                    );
                } catch {
                    // The headline status is still worth showing without it.
                }
                if (generation !== this.generation) {
                    return;
                }
            }

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**${project.name}** · ${this.state.branch ?? 'main branch'}\n\n`);
            tooltip.appendMarkdown(
                `Quality gate: **${qualityGate === 'OK' ? 'Passed' : qualityGate === 'ERROR' ? 'Failed' : 'Unknown'}**\n\n`
            );
            for (const condition of failures) {
                tooltip.appendMarkdown(`- ${describeCondition(condition)}\n`);
            }
            if (failures.length > 0) {
                tooltip.appendMarkdown('\n');
            }
            tooltip.appendMarkdown(`Bugs: ${measures.get('bugs') ?? '—'}\n\n`);
            tooltip.appendMarkdown(`Vulnerabilities: ${measures.get('vulnerabilities') ?? '—'}\n\n`);
            tooltip.appendMarkdown(`Code smells: ${measures.get('code_smells') ?? '—'}\n\n`);
            tooltip.appendMarkdown(`Security hotspots: ${measures.get('security_hotspots') ?? '—'}\n\n`);
            tooltip.appendMarkdown('Click to open the SonarCloud sidebar.');
            this.item.tooltip = tooltip;
        } catch (err) {
            if (generation !== this.generation) {
                return;
            }
            // Stay unobtrusive: show a muted state instead of an error popup.
            this.item.text = '$(shield) SonarCloud';
            this.item.tooltip = `SonarCloud status unavailable — ${
                err instanceof SonarCloudError ? err.message : String(err)
            }`;
        }
    }
}
