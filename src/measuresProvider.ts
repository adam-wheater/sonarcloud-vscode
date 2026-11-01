import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError } from './client';
import { formatDuration, formatRating } from './labels';
import { describeCondition, failingConditions, QualityGateCondition } from './qualityGate';
import { SonarState } from './state';

type MetricFormat = 'percent' | 'number' | 'rating' | 'duration' | 'status';

interface MetricSpec {
    key: string;
    label: string;
    icon: string;
    format: MetricFormat;
}

const METRICS: MetricSpec[] = [
    { key: 'alert_status', label: 'Quality Gate', icon: 'verified', format: 'status' },
    // New-code period — what the quality gate actually judges.
    { key: 'new_coverage', label: 'New Code: Coverage', icon: 'beaker', format: 'percent' },
    { key: 'new_bugs', label: 'New Code: Bugs', icon: 'bug', format: 'number' },
    { key: 'new_vulnerabilities', label: 'New Code: Vulnerabilities', icon: 'shield', format: 'number' },
    { key: 'new_security_hotspots', label: 'New Code: Security Hotspots', icon: 'flame', format: 'number' },
    { key: 'new_code_smells', label: 'New Code: Code Smells', icon: 'squirrel', format: 'number' },
    { key: 'new_duplicated_lines_density', label: 'New Code: Duplicated Lines', icon: 'copy', format: 'percent' },
    // Overall code
    { key: 'coverage', label: 'Overall Coverage', icon: 'beaker', format: 'percent' },
    { key: 'line_coverage', label: 'Line Coverage', icon: 'list-selection', format: 'percent' },
    { key: 'branch_coverage', label: 'Condition Coverage', icon: 'git-merge', format: 'percent' },
    { key: 'tests', label: 'Unit Tests', icon: 'checklist', format: 'number' },
    { key: 'test_errors', label: 'Test Errors', icon: 'error', format: 'number' },
    { key: 'test_failures', label: 'Test Failures', icon: 'warning', format: 'number' },
    { key: 'skipped_tests', label: 'Skipped Tests', icon: 'circle-slash', format: 'number' },
    { key: 'duplicated_lines_density', label: 'Duplicated Lines', icon: 'copy', format: 'percent' },
    { key: 'bugs', label: 'Bugs', icon: 'bug', format: 'number' },
    { key: 'vulnerabilities', label: 'Vulnerabilities', icon: 'shield', format: 'number' },
    { key: 'security_hotspots', label: 'Security Hotspots', icon: 'flame', format: 'number' },
    { key: 'code_smells', label: 'Code Smells', icon: 'squirrel', format: 'number' },
    { key: 'sqale_index', label: 'Technical Debt', icon: 'watch', format: 'duration' },
    { key: 'reliability_rating', label: 'Reliability Rating', icon: 'pulse', format: 'rating' },
    { key: 'security_rating', label: 'Security Rating', icon: 'lock', format: 'rating' },
    { key: 'sqale_rating', label: 'Maintainability Rating', icon: 'tools', format: 'rating' },
    { key: 'ncloc', label: 'Lines of Code', icon: 'file-code', format: 'number' }
];

export interface MeasureNode {
    kind: 'measure';
    spec: MetricSpec;
    value?: string;
    /** Failing gate conditions, shown as children of the Quality Gate row. */
    failures?: QualityGateCondition[];
}

export interface ConditionNode {
    kind: 'condition';
    condition: QualityGateCondition;
}

export type MeasuresTreeNode = MeasureNode | ConditionNode;

export class MeasuresProvider implements vscode.TreeDataProvider<MeasuresTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(node: MeasuresTreeNode): vscode.TreeItem {
        if (node.kind === 'condition') {
            const item = new vscode.TreeItem(describeCondition(node.condition), vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            item.tooltip = `${describeCondition(node.condition)}\n\n(metric: ${node.condition.metricKey})`;
            return item;
        }
        const failures = node.failures ?? [];
        const item = new vscode.TreeItem(
            node.spec.label,
            failures.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        item.description =
            failures.length > 0
                ? `${formatValue(node.spec.format, node.value)} · ${failures.length} condition${failures.length === 1 ? '' : 's'}`
                : formatValue(node.spec.format, node.value);
        item.iconPath = iconFor(node.spec, node.value);
        item.tooltip =
            failures.length > 0
                ? `${node.spec.label}: Failed\n\n${failures.map(c => `• ${describeCondition(c)}`).join('\n')}`
                : buildTooltip(node.spec, formatValue(node.spec.format, node.value));
        return item;
    }

    async getChildren(element?: MeasuresTreeNode): Promise<MeasuresTreeNode[]> {
        if (element) {
            return element.kind === 'measure'
                ? (element.failures ?? []).map(condition => ({ kind: 'condition' as const, condition }))
                : [];
        }
        const project = this.state.project;
        if (!project) {
            return [];
        }
        try {
            const values = await this.client.getMeasures(
                project.key,
                this.state.branch,
                METRICS.map(m => m.key)
            );
            // Only ask *why* when the gate actually failed — a passing gate has
            // no failures to list, and this saves a request per refresh.
            let failures: QualityGateCondition[] = [];
            if (values.get('alert_status') === 'ERROR') {
                try {
                    failures = failingConditions(
                        await this.client.getQualityGateStatus(project.key, this.state.branch)
                    );
                } catch {
                    // The gate detail is a nicety; the measures still stand.
                }
            }
            return METRICS.map(spec => ({
                kind: 'measure' as const,
                spec,
                value: values.get(spec.key),
                failures: spec.key === 'alert_status' ? failures : undefined
            }));
        } catch (err) {
            const message = err instanceof SonarCloudError ? err.message : String(err);
            void vscode.window.showErrorMessage(`SonarCloud: failed to load measures — ${message}`);
            return [];
        }
    }
}

function formatValue(format: MetricFormat, value?: string): string {
    if (value === undefined) {
        return '—';
    }
    switch (format) {
        case 'percent':
            return `${value}%`;
        case 'rating':
            return formatRating(value);
        case 'duration':
            return formatDuration(value);
        case 'status':
            return value === 'OK' ? 'Passed' : value === 'ERROR' ? 'Failed' : value;
        case 'number':
            return Number(value).toLocaleString();
    }
}

function iconFor(spec: MetricSpec, value?: string): vscode.ThemeIcon {
    if (spec.format === 'status' && value !== undefined) {
        return value === 'OK'
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    }
    return new vscode.ThemeIcon(spec.icon);
}

function buildTooltip(spec: MetricSpec, description: string): string {
    const tooltip = `${spec.label}: ${description} (metric: ${spec.key})`;
    if (description === '—' && isTestExecutionMetric(spec.key)) {
        return `${tooltip}\n\nSonarCloud only publishes test-execution metrics on long-lived branches.`;
    }
    return tooltip;
}

function isTestExecutionMetric(metricKey: string): boolean {
    return (
        metricKey === 'tests' ||
        metricKey === 'test_errors' ||
        metricKey === 'test_failures' ||
        metricKey === 'skipped_tests'
    );
}
