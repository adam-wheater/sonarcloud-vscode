import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError } from './client';
import { IssueBaselineStore, newIssueKeys } from './newIssues';
import { describeCondition, failingConditions } from './qualityGate';
import { SonarState } from './state';

/**
 * Language Model tools exposing SonarCloud data to Copilot Chat (and any other
 * chat participant). Agent mode calls these to pull issues, measures and rule
 * descriptions, then edits the workspace to fix what they report.
 */

interface IssuesInput {
    projectKey?: string;
    branch?: string;
    severities?: string[];
    types?: string[];
    filePath?: string;
    maxResults?: number;
    /** Only issues absent from the list this workspace last saw. */
    onlyNew?: boolean;
}

interface MeasuresInput {
    projectKey?: string;
    branch?: string;
}

interface HotspotsInput {
    projectKey?: string;
    branch?: string;
    maxResults?: number;
}

interface RuleInput {
    ruleKey: string;
}

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_CAP = 200;
const RULE_DESCRIPTION_CHAR_LIMIT = 10_000;

export function registerLanguageModelTools(
    context: vscode.ExtensionContext,
    client: SonarCloudClient,
    state: SonarState,
    baselines?: IssueBaselineStore
): void {
    context.subscriptions.push(
        vscode.lm.registerTool('sonarcloud_list_projects', new ListProjectsTool(client)),
        vscode.lm.registerTool('sonarcloud_get_issues', new GetIssuesTool(client, state, baselines)),
        vscode.lm.registerTool('sonarcloud_get_measures', new GetMeasuresTool(client, state)),
        vscode.lm.registerTool('sonarcloud_get_hotspots', new GetHotspotsTool(client, state)),
        vscode.lm.registerTool('sonarcloud_get_rule', new GetRuleTool(client))
    );
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
    ]);
}

async function withApiErrors(
    run: () => Promise<vscode.LanguageModelToolResult>
): Promise<vscode.LanguageModelToolResult> {
    try {
        return await run();
    } catch (err) {
        const message = err instanceof SonarCloudError ? err.message : String(err);
        return jsonResult({
            error: message,
            hint: 'The user may need to run "SonarCloud: Set API Token" or "SonarCloud: Set Organization" in VS Code.'
        });
    }
}

/** Resolve the project to query: explicit input first, then the sidebar selection. */
function resolveProject(state: SonarState, projectKey?: string): { key: string } | { error: string } {
    const key = projectKey ?? state.project?.key;
    if (!key) {
        return {
            error:
                'No projectKey was given and no project is selected in the SonarCloud sidebar. ' +
                'Call sonarcloud_list_projects and pass one of the returned keys as projectKey.'
        };
    }
    return { key };
}

/**
 * Resolve the branch to query. The sidebar's branch selection belongs to the
 * sidebar's project — applying it to a different, explicitly requested project
 * would query a branch that may not exist there.
 */
function resolveBranch(state: SonarState, projectKey: string, branch?: string): string | undefined {
    if (branch) {
        return branch;
    }
    return projectKey === state.project?.key ? state.branch : undefined;
}

class ListProjectsTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly client: SonarCloudClient) {}

    async invoke(): Promise<vscode.LanguageModelToolResult> {
        return withApiErrors(async () => {
            const { projects, total } = await this.client.listProjects();
            return jsonResult({
                organization: this.client.organization(),
                totalProjects: total,
                note: total > projects.length ? `Only the first ${projects.length} projects are listed.` : undefined,
                projects
            });
        });
    }
}

class GetIssuesTool implements vscode.LanguageModelTool<IssuesInput> {
    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState,
        /** Read-only here: a tool call is not "looking", so it never re-baselines. */
        private readonly baselines?: IssueBaselineStore
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IssuesInput>
    ): Promise<vscode.LanguageModelToolResult> {
        return withApiErrors(async () => {
            const input = options.input ?? {};
            const project = resolveProject(this.state, input.projectKey);
            if ('error' in project) {
                return jsonResult(project);
            }
            const branch = resolveBranch(this.state, project.key, input.branch);
            const result = await this.client.searchIssues({
                projectKey: project.key,
                branch,
                severities: input.severities,
                types: input.types
            });

            const pathByComponent = new Map(result.components.map(c => [c.key, c.path]));
            const ruleNames = new Map(result.rules.map(r => [r.key, r.name]));
            const maxResults = Math.min(Math.max(input.maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_CAP);

            const baseline = this.baselines?.get(project.key, branch);
            const isNew = newIssueKeys(baseline, result.issues.map(issue => issue.key));

            let issues = result.issues.map(issue => ({
                key: issue.key,
                rule: issue.rule,
                ruleName: ruleNames.get(issue.rule),
                severity: issue.severity,
                type: issue.type,
                message: issue.message,
                file: pathByComponent.get(issue.component),
                line: issue.line,
                effort: issue.effort,
                tags: issue.tags?.length ? issue.tags : undefined,
                // Omitted entirely when there is no baseline, rather than
                // reported as false — "not new" and "unknown" are different
                // claims, and a model will act on the difference.
                isNew: baseline ? isNew.has(issue.key) : undefined
            }));
            if (input.filePath) {
                const needle = input.filePath;
                issues = issues.filter(i => i.file?.includes(needle));
            }
            if (input.onlyNew) {
                issues = issues.filter(i => i.isNew === true);
            }
            const returned = issues.slice(0, maxResults);

            let note =
                'File paths are relative to the root of the analyzed repository. ' +
                'Use sonarcloud_get_rule with an issue\'s rule key to learn why it is a problem and how to fix it.';
            if (input.onlyNew && !baseline) {
                note +=
                    ' Note: onlyNew was requested but this workspace has no record of a previous look at this ' +
                    'project, so nothing can be called new and no issues are returned.';
            }
            if (input.filePath && result.total > result.issues.length) {
                note +=
                    ` Warning: the filePath filter was applied to only the first ${result.issues.length} of ` +
                    `${result.total} issues — narrow severities/types to make the search exhaustive.`;
            }
            return jsonResult({
                project: project.key,
                branch: branch ?? 'main branch (default)',
                totalOpenIssuesMatchingServerFilters: result.total,
                returned: returned.length,
                note,
                issues: returned
            });
        });
    }
}

class GetMeasuresTool implements vscode.LanguageModelTool<MeasuresInput> {
    private static readonly METRICS = [
        'alert_status',
        'new_coverage',
        'new_bugs',
        'new_vulnerabilities',
        'new_security_hotspots',
        'new_code_smells',
        'new_duplicated_lines_density',
        'coverage',
        'line_coverage',
        'branch_coverage',
        'tests',
        'test_errors',
        'test_failures',
        'skipped_tests',
        'duplicated_lines_density',
        'bugs',
        'vulnerabilities',
        'security_hotspots',
        'code_smells',
        'sqale_index',
        'reliability_rating',
        'security_rating',
        'sqale_rating',
        'ncloc'
    ];

    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MeasuresInput>
    ): Promise<vscode.LanguageModelToolResult> {
        return withApiErrors(async () => {
            const input = options.input ?? {};
            const project = resolveProject(this.state, input.projectKey);
            if ('error' in project) {
                return jsonResult(project);
            }
            const branch = resolveBranch(this.state, project.key, input.branch);
            const values = await this.client.getMeasures(project.key, branch, GetMeasuresTool.METRICS);
            // "alert_status: ERROR" on its own tells a model the gate failed
            // but not what to fix; the conditions say which metric missed and
            // by how much. Only asked for when it actually failed.
            let failedConditions: string[] | undefined;
            if (values.get('alert_status') === 'ERROR') {
                try {
                    const status = await this.client.getQualityGateStatus(project.key, branch);
                    failedConditions = failingConditions(status).map(describeCondition);
                } catch {
                    // The measures are still worth returning without it.
                }
            }
            return jsonResult({
                project: project.key,
                branch: branch ?? 'main branch (default)',
                note:
                    'Percentages are 0-100. Ratings are 1.0 (A, best) to 5.0 (E, worst). ' +
                    'sqale_index is technical debt in minutes. alert_status OK means the quality gate passed. ' +
                    'SonarCloud only publishes test-execution metrics such as unit test counts on long-lived branches.',
                measures: Object.fromEntries(values),
                failedQualityGateConditions: failedConditions
            });
        });
    }
}

class GetHotspotsTool implements vscode.LanguageModelTool<HotspotsInput> {
    constructor(
        private readonly client: SonarCloudClient,
        private readonly state: SonarState
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<HotspotsInput>
    ): Promise<vscode.LanguageModelToolResult> {
        return withApiErrors(async () => {
            const input = options.input ?? {};
            const project = resolveProject(this.state, input.projectKey);
            if ('error' in project) {
                return jsonResult(project);
            }
            const branch = resolveBranch(this.state, project.key, input.branch);
            const result = await this.client.searchHotspots(project.key, branch);
            const pathByComponent = new Map(result.components.map(c => [c.key, c.path]));
            const maxResults = Math.min(Math.max(input.maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_CAP);
            const hotspots = result.hotspots.slice(0, maxResults).map(h => ({
                key: h.key,
                message: h.message,
                category: h.securityCategory,
                vulnerabilityProbability: h.vulnerabilityProbability,
                file: pathByComponent.get(h.component),
                line: h.line
            }));
            return jsonResult({
                project: project.key,
                branch: branch ?? 'main branch (default)',
                totalHotspotsToReview: result.total,
                returned: hotspots.length,
                note:
                    'Security hotspots are security-sensitive code that needs human review — not confirmed ' +
                    'vulnerabilities. Review whether the flagged code is safe in context before changing it.',
                hotspots
            });
        });
    }
}

class GetRuleTool implements vscode.LanguageModelTool<RuleInput> {
    constructor(private readonly client: SonarCloudClient) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RuleInput>
    ): Promise<vscode.LanguageModelToolResult> {
        return withApiErrors(async () => {
            const ruleKey = options.input?.ruleKey;
            if (!ruleKey) {
                return jsonResult({ error: 'ruleKey is required, e.g. "typescript:S1481".' });
            }
            const rule = await this.client.getRule(ruleKey);
            if (!rule) {
                return jsonResult({ error: `Rule "${ruleKey}" was not found.` });
            }
            let description =
                rule.htmlDesc ?? (rule.descriptionSections ?? []).map(s => s.content).join('\n');
            if (description.length > RULE_DESCRIPTION_CHAR_LIMIT) {
                description = description.slice(0, RULE_DESCRIPTION_CHAR_LIMIT) + '\n…(truncated)';
            }
            return jsonResult({
                key: rule.key,
                name: rule.name,
                severity: rule.severity,
                type: rule.type,
                descriptionHtml: description
            });
        });
    }
}
