import { formatDuration, formatRating } from './labels';

/**
 * Why the quality gate failed. "Failed" on its own sends people to the
 * SonarCloud web UI to find out which condition tripped and by how much;
 * the answer is one API call away, so it belongs in the editor.
 */

export interface QualityGateCondition {
    metricKey: string;
    /** SonarCloud's operator for the *error* case: GT fails above, LT fails below. */
    comparator: string;
    errorThreshold: string;
    actualValue?: string;
    /** OK, ERROR, or NO_VALUE when the metric was never computed. */
    status: string;
    /** Present when the condition is judged over the new-code period. */
    periodIndex?: number;
}

export interface QualityGateStatus {
    /** OK, ERROR, or NONE when no gate applies. */
    status: string;
    conditions: QualityGateCondition[];
    /** Conditions SonarCloud skipped, e.g. on a small new-code period. */
    ignoredConditions?: boolean;
}

export function failingConditions(status: QualityGateStatus | undefined): QualityGateCondition[] {
    return (status?.conditions ?? []).filter(condition => condition.status === 'ERROR');
}

/** Metric keys SonarCloud reports as percentages. */
const PERCENT_METRICS = new Set([
    'coverage',
    'new_coverage',
    'line_coverage',
    'new_line_coverage',
    'branch_coverage',
    'new_branch_coverage',
    'duplicated_lines_density',
    'new_duplicated_lines_density',
    'security_hotspots_reviewed',
    'new_security_hotspots_reviewed'
]);

const RATING_METRICS = new Set([
    'reliability_rating',
    'new_reliability_rating',
    'security_rating',
    'new_security_rating',
    'sqale_rating',
    'new_maintainability_rating',
    'security_review_rating',
    'new_security_review_rating'
]);

const DURATION_METRICS = new Set(['sqale_index', 'new_technical_debt']);

const METRIC_NAMES: Record<string, string> = {
    coverage: 'Coverage',
    line_coverage: 'Line Coverage',
    branch_coverage: 'Condition Coverage',
    duplicated_lines_density: 'Duplicated Lines',
    bugs: 'Bugs',
    vulnerabilities: 'Vulnerabilities',
    code_smells: 'Code Smells',
    security_hotspots: 'Security Hotspots',
    security_hotspots_reviewed: 'Security Hotspots Reviewed',
    reliability_rating: 'Reliability Rating',
    security_rating: 'Security Rating',
    security_review_rating: 'Security Review Rating',
    sqale_rating: 'Maintainability Rating',
    maintainability_rating: 'Maintainability Rating',
    sqale_index: 'Technical Debt',
    technical_debt: 'Technical Debt',
    ncloc: 'Lines of Code',
    violations: 'Issues',
    blocker_violations: 'Blocker Issues',
    critical_violations: 'Critical Issues',
    tests: 'Unit Tests',
    test_errors: 'Test Errors',
    test_failures: 'Test Failures'
};

/** "new_coverage" → "Coverage on New Code"; unknown keys are humanised, not hidden. */
export function metricLabel(metricKey: string): string {
    const isNew = metricKey.startsWith('new_');
    const base = isNew ? metricKey.slice(4) : metricKey;
    const name =
        METRIC_NAMES[metricKey] ??
        METRIC_NAMES[base] ??
        base
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    return isNew ? `${name} on New Code` : name;
}

export function formatMetricValue(metricKey: string, value: string | undefined): string {
    if (value === undefined || value === '') {
        return '—';
    }
    if (RATING_METRICS.has(metricKey)) {
        return formatRating(value);
    }
    if (DURATION_METRICS.has(metricKey)) {
        return formatDuration(value);
    }
    if (PERCENT_METRICS.has(metricKey)) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : `${value}%`;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toLocaleString() : value;
}

/**
 * "Coverage on New Code is 42.0%, required ≥ 80.0%" — the actual value and the
 * bar it missed, which is what tells you how far off you are.
 */
export function describeCondition(condition: QualityGateCondition): string {
    const label = metricLabel(condition.metricKey);
    const actual = formatMetricValue(condition.metricKey, condition.actualValue);
    const threshold = formatMetricValue(condition.metricKey, condition.errorThreshold);
    // The comparator names the failing side, so the requirement is its inverse.
    const requirement = condition.comparator === 'GT' ? `≤ ${threshold}` : `≥ ${threshold}`;
    if (condition.status === 'NO_VALUE' || condition.actualValue === undefined) {
        return `${label} was not measured (required ${requirement})`;
    }
    return `${label} is ${actual}, required ${requirement}`;
}

/** A one-line summary for the status bar tooltip. */
export function summariseFailures(status: QualityGateStatus | undefined): string | undefined {
    const failing = failingConditions(status);
    if (failing.length === 0) {
        return undefined;
    }
    return failing.map(describeCondition).join('; ');
}
