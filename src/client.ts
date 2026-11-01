import { QualityGateStatus } from './qualityGate';

const API_BASE = 'https://sonarcloud.io/api';
const WEB_BASE = 'https://sonarcloud.io';
const RETRYABLE_SONARCLOUD_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const SONARCLOUD_GET_RETRY_ATTEMPTS = 3;
const SONARCLOUD_RETRY_BASE_DELAY_MS = 1000;
const SONARCLOUD_MAX_RETRY_DELAY_MS = 15000;
/**
 * A request that never returns is worse than one that fails: the view spins
 * forever and nothing ever says why. SonarCloud answers well inside this.
 */
const SONARCLOUD_REQUEST_TIMEOUT_MS = 30000;

export class SonarCloudError extends Error {
    constructor(message: string, public readonly status?: number) {
        super(message);
        this.name = 'SonarCloudError';
    }
}

export interface SonarProject {
    key: string;
    name: string;
}

export interface ProjectList {
    projects: SonarProject[];
    /** Total projects in the organization — can exceed projects.length, the fetch is capped. */
    total: number;
}

export interface SonarOrganization {
    key: string;
    name: string;
}

export interface SonarBranch {
    name: string;
    isMain: boolean;
    type: string;
    analysisDate?: string;
    status?: { qualityGateStatus?: string };
}

export interface TextRange {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
}

export interface SonarIssue {
    key: string;
    rule: string;
    severity: string;
    component: string;
    project: string;
    line?: number;
    textRange?: TextRange;
    message: string;
    type: string;
    status: string;
    effort?: string;
    tags?: string[];
    creationDate?: string;
}

export interface SonarHotspot {
    key: string;
    component: string;
    project: string;
    securityCategory: string;
    vulnerabilityProbability: string;
    status: string;
    line?: number;
    message: string;
}

export interface HotspotSearchResult {
    hotspots: SonarHotspot[];
    components: SonarComponentRef[];
    total: number;
}

export interface SonarComponentRef {
    key: string;
    path?: string;
    qualifier: string;
}

export interface SonarRuleRef {
    key: string;
    name: string;
}

export interface IssueSearchResult {
    issues: SonarIssue[];
    components: SonarComponentRef[];
    rules: SonarRuleRef[];
    total: number;
}

export interface SonarRuleDetails {
    key: string;
    name: string;
    htmlDesc?: string;
    severity?: string;
    type?: string;
    descriptionSections?: { key: string; content: string }[];
}

export interface IssueSearchOptions {
    projectKey: string;
    branch?: string;
    severities?: string[];
    types?: string[];
    /** Only issues introduced in the project's "new code" period. */
    newCodeOnly?: boolean;
    /** 1-based page of 500 issues; defaults to the first. */
    page?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

export class SonarCloudClient {
    constructor(
        private readonly getToken: () => Thenable<string | undefined>,
        private readonly getOrganization: () => string | undefined
    ) {}

    organization(): string {
        const org = this.getOrganization();
        if (!org) {
            throw new SonarCloudError('No SonarCloud organization configured. Run "SonarCloud: Set Organization".');
        }
        return org;
    }

    private async request<T>(path: string, params: Params, method: 'GET' | 'POST' = 'GET'): Promise<T> {
        const token = await this.getToken();
        if (!token) {
            throw new SonarCloudError('No SonarCloud API token set. Run "SonarCloud: Set API Token".', 401);
        }
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== '') {
                search.set(key, String(value));
            }
        }
        const query = search.toString();
        const url = method === 'GET' ? `${API_BASE}/${path}?${query}` : `${API_BASE}/${path}`;
        const maxAttempts = method === 'GET' ? SONARCLOUD_GET_RETRY_ATTEMPTS : 1;
        let res: Awaited<ReturnType<typeof fetch>> | undefined;
        let lastNetworkError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                res = await fetch(url, {
                    method,
                    headers: {
                        Authorization: 'Basic ' + Buffer.from(`${token}:`).toString('base64'),
                        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
                    },
                    body: method === 'POST' ? query : undefined,
                    signal: AbortSignal.timeout(SONARCLOUD_REQUEST_TIMEOUT_MS)
                });
            } catch (err) {
                lastNetworkError = asNetworkError(err);
                if (method === 'GET' && attempt < maxAttempts) {
                    await delay(getRetryDelayMs(null, attempt));
                    continue;
                }

                throw new SonarCloudError(`Could not reach SonarCloud: ${lastNetworkError.message}`);
            }

            if (!shouldRetrySonarCloudResponse(method, res.status, attempt, maxAttempts)) {
                break;
            }

            await delay(getRetryDelayMs(res.headers.get('Retry-After'), attempt));
        }

        if (!res) {
            throw new SonarCloudError(`Could not reach SonarCloud: ${lastNetworkError?.message ?? 'Unknown network error.'}`);
        }

        if (!res.ok) {
            let message = `SonarCloud request failed (HTTP ${res.status}).`;
            try {
                const body = (await res.json()) as { errors?: { msg: string }[] };
                if (body?.errors?.length) {
                    message = body.errors.map(e => e.msg).join('; ');
                }
            } catch {
                // keep generic message
            }
            if (res.status === 401) {
                message = 'SonarCloud rejected the API token (401). Run "SonarCloud: Set API Token" to update it.';
            } else if (res.status === 504) {
                message = 'SonarCloud timed out (HTTP 504). This is usually transient; retry in a moment.';
            }
            throw new SonarCloudError(message, res.status);
        }
        // Some POST endpoints reply with an empty body.
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }

    /** Organizations the token's user is a member of. Does not require an organization to be configured. */
    async listMyOrganizations(): Promise<SonarOrganization[]> {
        const res = await this.request<any>('organizations/search', { member: true, ps: 500 });
        return (res.organizations ?? []).map((o: any) => ({ key: o.key, name: o.name }));
    }

    async listProjects(): Promise<ProjectList> {
        const organization = this.organization();
        const projects: SonarProject[] = [];
        const pageSize = 500;
        let total = 0;
        for (let page = 1; page <= 4; page++) {
            const res = await this.request<any>('components/search', {
                organization,
                qualifiers: 'TRK',
                ps: pageSize,
                p: page
            });
            for (const c of res.components ?? []) {
                projects.push({ key: c.key, name: c.name });
            }
            total = res.paging?.total ?? projects.length;
            if (page * pageSize >= total) {
                break;
            }
        }
        return {
            projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
            total: Math.max(total, projects.length)
        };
    }

    async listBranches(projectKey: string): Promise<SonarBranch[]> {
        const res = await this.request<any>('project_branches/list', { project: projectKey });
        return res.branches ?? [];
    }

    async searchIssues(opts: IssueSearchOptions): Promise<IssueSearchResult> {
        const res = await this.request<any>('issues/search', {
            organization: this.organization(),
            componentKeys: opts.projectKey,
            branch: opts.branch,
            severities: opts.severities?.length ? opts.severities.join(',') : undefined,
            types: opts.types?.length ? opts.types.join(',') : undefined,
            sinceLeakPeriod: opts.newCodeOnly ? true : undefined,
            resolved: false,
            additionalFields: 'rules',
            s: 'FILE_LINE',
            asc: true,
            ps: 500,
            p: opts.page
        });
        return {
            issues: res.issues ?? [],
            components: res.components ?? [],
            rules: res.rules ?? [],
            total: res.total ?? res.paging?.total ?? (res.issues?.length ?? 0)
        };
    }

    async getMeasures(projectKey: string, branch: string | undefined, metricKeys: string[]): Promise<Map<string, string>> {
        const res = await this.request<any>('measures/component', {
            component: projectKey,
            branch,
            metricKeys: metricKeys.join(',')
        });
        const values = new Map<string, string>();
        for (const m of res.component?.measures ?? []) {
            // "new_*" metrics are reported per new-code period, not as a plain value.
            const value = m.value ?? m.period?.value ?? m.periods?.[0]?.value;
            if (value !== undefined) {
                values.set(m.metric, String(value));
            }
        }
        return values;
    }

    /**
     * Which quality gate conditions passed or failed. The `alert_status`
     * measure says only pass/fail; this says why.
     */
    async getQualityGateStatus(projectKey: string, branch?: string): Promise<QualityGateStatus> {
        const res = await this.request<any>('qualitygates/project_status', {
            projectKey,
            branch,
            organization: this.organization()
        });
        const projectStatus = res.projectStatus ?? {};
        return {
            status: projectStatus.status ?? 'NONE',
            conditions: (projectStatus.conditions ?? []).map((c: any) => ({
                metricKey: c.metricKey,
                comparator: c.comparator,
                errorThreshold: c.errorThreshold,
                actualValue: c.actualValue,
                status: c.status,
                periodIndex: c.periodIndex
            })),
            ignoredConditions: projectStatus.ignoredConditions
        };
    }

    /** Security hotspots awaiting review. Separate endpoint — issues/search never returns them. */
    async searchHotspots(projectKey: string, branch?: string): Promise<HotspotSearchResult> {
        const res = await this.request<any>('hotspots/search', {
            projectKey,
            branch,
            status: 'TO_REVIEW',
            ps: 500
        });
        return {
            hotspots: res.hotspots ?? [],
            components: res.components ?? [],
            total: res.paging?.total ?? (res.hotspots?.length ?? 0)
        };
    }

    /** Members of the organization, for the assignee picker. */
    async listOrganizationMembers(): Promise<{ login: string; name: string }[]> {
        const res = await this.request<any>('organizations/search_members', {
            organization: this.organization(),
            ps: 100
        });
        return (res.users ?? []).map((u: any) => ({ login: u.login, name: u.name }));
    }

    /** Assign an issue; omit assignee to unassign. */
    async assignIssue(issueKey: string, assignee?: string): Promise<void> {
        await this.request('issues/assign', { issue: issueKey, assignee }, 'POST');
    }

    async addIssueComment(issueKey: string, text: string): Promise<void> {
        await this.request('issues/add_comment', { issue: issueKey, text }, 'POST');
    }

    /** e.g. "falsepositive", "wontfix", "confirm" — requires Administer Issues permission. */
    async transitionIssue(issueKey: string, transition: string): Promise<void> {
        await this.request('issues/do_transition', { issue: issueKey, transition }, 'POST');
    }

    /** Status of a background compute-engine task (created when a scanner uploads a report). */
    async getCeTask(taskId: string): Promise<{ status: string; errorMessage?: string }> {
        const res = await this.request<any>('ce/task', { id: taskId });
        return { status: res.task?.status ?? 'UNKNOWN', errorMessage: res.task?.errorMessage };
    }

    async getRule(ruleKey: string): Promise<SonarRuleDetails> {
        const res = await this.request<any>('rules/show', {
            key: ruleKey,
            organization: this.organization()
        });
        return res.rule;
    }

    issueUrl(issue: SonarIssue, branch?: string): string {
        let url = `${WEB_BASE}/project/issues?id=${encodeURIComponent(issue.project)}&open=${encodeURIComponent(issue.key)}`;
        if (branch) {
            url += `&branch=${encodeURIComponent(branch)}`;
        }
        return url;
    }

    hotspotUrl(projectKey: string, hotspotKey: string, branch?: string): string {
        let url = `${WEB_BASE}/project/security_hotspots?id=${encodeURIComponent(projectKey)}&hotspots=${encodeURIComponent(hotspotKey)}`;
        if (branch) {
            url += `&branch=${encodeURIComponent(branch)}`;
        }
        return url;
    }

    projectUrl(projectKey: string, branch?: string): string {
        let url = `${WEB_BASE}/project/overview?id=${encodeURIComponent(projectKey)}`;
        if (branch) {
            url += `&branch=${encodeURIComponent(branch)}`;
        }
        return url;
    }
}

function shouldRetrySonarCloudResponse(
    method: 'GET' | 'POST',
    status: number,
    attempt: number,
    maxAttempts: number
): boolean {
    return method === 'GET' && attempt < maxAttempts && RETRYABLE_SONARCLOUD_STATUS_CODES.has(status);
}

export function getRetryDelayMs(retryAfterHeader: string | null, attempt: number): number {
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        // SonarCloud can ask for a very long wait; blocking a view refresh for
        // minutes looks like a hang, so cap it and let the user retry instead.
        return Math.min(retryAfterSeconds * 1000, SONARCLOUD_MAX_RETRY_DELAY_MS);
    }

    return Math.min(SONARCLOUD_RETRY_BASE_DELAY_MS * attempt, SONARCLOUD_MAX_RETRY_DELAY_MS);
}

/** A timed-out fetch reports "The operation was aborted", which explains nothing. */
function asNetworkError(err: unknown): Error {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return new Error(`no response within ${SONARCLOUD_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    return err instanceof Error ? err : new Error(String(err));
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
