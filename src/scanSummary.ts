import { SonarBranch, SonarCloudClient } from './client';

export const POST_SCAN_SUMMARY_METRICS = [
    'coverage',
    'line_coverage',
    'branch_coverage',
    'tests',
    'test_errors',
    'test_failures',
    'skipped_tests'
] as const;

export async function tryGetBranchDetails(
    client: SonarCloudClient,
    projectKey: string,
    branchName: string
): Promise<SonarBranch | undefined> {
    try {
        return (await client.listBranches(projectKey)).find(branch => branch.name === branchName);
    } catch {
        return undefined;
    }
}

export function buildCoverageSummary(measures: Map<string, string>): string | undefined {
    const parts = [
        formatPercentMetric(measures, 'coverage', 'overall coverage'),
        formatPercentMetric(measures, 'line_coverage', 'line coverage'),
        formatPercentMetric(measures, 'branch_coverage', 'condition coverage')
    ].filter((value): value is string => !!value);
    return parts.length > 0 ? parts.join(', ') : undefined;
}

export function buildUnitTestCountSummary(measures: Map<string, string>): string | undefined {
    return formatCountMetric(measures, 'tests', 'unit test');
}

export function buildTestExecutionSummary(measures: Map<string, string>): string | undefined {
    const tests = buildUnitTestCountSummary(measures);
    if (!tests) {
        return undefined;
    }

    const parts = [
        tests,
        formatCountMetric(measures, 'test_errors', 'test error'),
        formatCountMetric(measures, 'test_failures', 'test failure'),
        formatCountMetric(measures, 'skipped_tests', 'skipped test')
    ].filter((value): value is string => !!value);

    return parts.join(', ');
}

export function explainMissingTestMetrics(branch: SonarBranch | undefined, branchName: string): string {
    if (branch && !isLongLivedBranch(branch)) {
        return (
            'Note: SonarCloud does not publish test-execution metrics such as unit test counts for ' +
            `${describeBranchType(branch)} branches. Coverage still uploads normally, so a missing ` +
            `"Unit Tests" measure on branch "${branchName}" does not mean the TRX report was skipped.`
        );
    }

    return (
        'Warning: SonarCloud processed the analysis but did not publish a "Unit Tests" measure for ' +
        `branch "${branchName}". Check the TRX import summary above and confirm the branch is ` +
        'long-lived, because SonarCloud only reports test-execution metrics on long-lived branches.'
    );
}

export function sentenceCase(value: string): string {
    return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatPercentMetric(measures: Map<string, string>, key: string, label: string): string | undefined {
    const value = measures.get(key);
    return value !== undefined ? `${label} ${value}%` : undefined;
}

function formatCountMetric(measures: Map<string, string>, key: string, singular: string): string | undefined {
    const value = measures.get(key);
    if (value === undefined) {
        return undefined;
    }

    const count = Number(value);
    const display = Number.isFinite(count) ? count.toLocaleString() : value;
    return `${display} ${count === 1 ? singular : `${singular}s`}`;
}

function isLongLivedBranch(branch: SonarBranch): boolean {
    return branch.isMain || branch.type.toUpperCase() === 'LONG';
}

function describeBranchType(branch: SonarBranch): string {
    const branchType = branch.type.toUpperCase();
    if (branchType === 'SHORT') {
        return 'short-lived';
    }
    if (branchType === 'LONG') {
        return 'long-lived';
    }
    return branch.type.toLowerCase();
}