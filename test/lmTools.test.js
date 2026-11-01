'use strict';

/**
 * The language-model tools are what Copilot actually calls. Their contract is
 * the JSON they return, so these tests read that JSON back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup, vscode } = require('./harness');

const { registerLanguageModelTools } = load('lmTools');

test.afterEach(() => cleanup());

/**
 * Capture the tools the extension registers, keyed by name. The stub's `lm`
 * object is replaced *in place* — swapping vscode.lm itself would not reach
 * the module, which holds an __importStar copy of the namespace.
 */
function registerTools(client, state, baselines) {
    const tools = new Map();
    const original = vscode.lm.registerTool;
    vscode.lm.registerTool = (name, tool) => {
        tools.set(name, tool);
        return { dispose: () => {} };
    };
    try {
        registerLanguageModelTools({ subscriptions: [] }, client, state, baselines);
    } finally {
        vscode.lm.registerTool = original;
    }
    return tools;
}

/** Tool results are LanguageModelTextPart wrappers; unwrap to the JSON. */
function resultJson(result) {
    const text = result.content ? result.content : result;
    const part = Array.isArray(text) ? text[0] : text;
    return JSON.parse(part.value !== undefined ? part.value : part);
}

function stubClient(overrides = {}) {
    return {
        organization: () => 'my-org',
        listProjects: async () => ({ projects: [{ key: 'p1', name: 'One' }], total: 1 }),
        searchIssues: async () => ({ issues: [], components: [], rules: [], total: 0 }),
        searchHotspots: async () => ({ hotspots: [], components: [], total: 0 }),
        getMeasures: async () => new Map(),
        getRule: async () => ({ key: 'r', name: 'Rule' }),
        ...overrides
    };
}

function stubState(overrides = {}) {
    return { project: undefined, branch: undefined, ...overrides };
}

test('all five tools are registered', () => {
    const tools = registerTools(stubClient(), stubState());
    assert.deepEqual(
        [...tools.keys()].sort(),
        [
            'sonarcloud_get_hotspots',
            'sonarcloud_get_issues',
            'sonarcloud_get_measures',
            'sonarcloud_get_rule',
            'sonarcloud_list_projects'
        ]
    );
});

test('listing projects reports the organization and the cap', async () => {
    const tools = registerTools(
        stubClient({ listProjects: async () => ({ projects: [{ key: 'p1', name: 'One' }], total: 2500 }) }),
        stubState()
    );
    const json = resultJson(await tools.get('sonarcloud_list_projects').invoke({}));
    assert.equal(json.organization, 'my-org');
    assert.equal(json.totalProjects, 2500);
    assert.match(json.note, /Only the first 1 projects/);
});

test('with no project selected, the issues tool tells the model how to recover', async () => {
    const tools = registerTools(stubClient(), stubState());
    const json = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    assert.match(json.error, /no project is selected/i);
    assert.match(json.error, /sonarcloud_list_projects/, 'the model is told which tool to call next');
});

test('the sidebar selection is used when no project is given', async () => {
    let seen;
    const tools = registerTools(
        stubClient({
            searchIssues: async options => {
                seen = options;
                return { issues: [], components: [], rules: [], total: 0 };
            }
        }),
        stubState({ project: { key: 'sidebar-proj', name: 'P' }, branch: 'feature/x' })
    );
    await tools.get('sonarcloud_get_issues').invoke({ input: {} });
    assert.equal(seen.projectKey, 'sidebar-proj');
    assert.equal(seen.branch, 'feature/x');
});

test("another project's branch is never inherited from the sidebar", async () => {
    // The sidebar branch belongs to the sidebar project; applying it elsewhere
    // queries a branch that may not exist there.
    let seen;
    const tools = registerTools(
        stubClient({
            searchIssues: async options => {
                seen = options;
                return { issues: [], components: [], rules: [], total: 0 };
            }
        }),
        stubState({ project: { key: 'sidebar-proj', name: 'P' }, branch: 'feature/x' })
    );
    await tools.get('sonarcloud_get_issues').invoke({ input: { projectKey: 'other-proj' } });
    assert.equal(seen.projectKey, 'other-proj');
    assert.equal(seen.branch, undefined, 'the foreign branch must not leak across projects');
});

test('issues are returned with the fields needed to fix them', async () => {
    const tools = registerTools(
        stubClient({
            searchIssues: async () => ({
                issues: [
                    {
                        key: 'i1',
                        rule: 'ts:S1481',
                        severity: 'MAJOR',
                        type: 'CODE_SMELL',
                        message: 'Unused',
                        component: 'proj:src/a.ts',
                        project: 'proj',
                        line: 12,
                        status: 'OPEN',
                        effort: '5min',
                        tags: ['unused']
                    }
                ],
                components: [{ key: 'proj:src/a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
                rules: [{ key: 'ts:S1481', name: 'Unused local variables should be removed' }],
                total: 1
            })
        }),
        stubState({ project: { key: 'proj', name: 'P' } })
    );
    const json = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    assert.equal(json.issues.length, 1);
    assert.deepEqual(json.issues[0], {
        key: 'i1',
        rule: 'ts:S1481',
        ruleName: 'Unused local variables should be removed',
        severity: 'MAJOR',
        type: 'CODE_SMELL',
        message: 'Unused',
        file: 'src/a.ts',
        line: 12,
        effort: '5min',
        tags: ['unused']
    });
    assert.match(json.note, /sonarcloud_get_rule/, 'the model is pointed at the rule tool');
});

test('the file filter narrows results and warns when it saw only one page', async () => {
    const issues = [
        { key: 'a', rule: 'r', severity: 'MAJOR', type: 'BUG', message: 'm', component: 'p:src/a.ts', project: 'p', status: 'OPEN' },
        { key: 'b', rule: 'r', severity: 'MAJOR', type: 'BUG', message: 'm', component: 'p:src/b.ts', project: 'p', status: 'OPEN' }
    ];
    const tools = registerTools(
        stubClient({
            searchIssues: async () => ({
                issues,
                components: [
                    { key: 'p:src/a.ts', path: 'src/a.ts', qualifier: 'FIL' },
                    { key: 'p:src/b.ts', path: 'src/b.ts', qualifier: 'FIL' }
                ],
                rules: [],
                total: 900
            })
        }),
        stubState({ project: { key: 'p', name: 'P' } })
    );
    const json = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: { filePath: 'src/a.ts' } }));
    assert.deepEqual(json.issues.map(i => i.key), ['a']);
    assert.match(json.note, /only the first 2 of 900/, 'a partial filter must not look exhaustive');
});

test('maxResults is clamped to a sane window', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
        key: `i${i}`,
        rule: 'r',
        severity: 'MAJOR',
        type: 'BUG',
        message: 'm',
        component: 'p:a.ts',
        project: 'p',
        status: 'OPEN'
    }));
    const tools = registerTools(
        stubClient({ searchIssues: async () => ({ issues: many, components: [], rules: [], total: 300 }) }),
        stubState({ project: { key: 'p', name: 'P' } })
    );
    const capped = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: { maxResults: 9999 } }));
    assert.equal(capped.issues.length, 200, 'an unbounded request would flood the model context');

    const floored = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: { maxResults: 0 } }));
    assert.equal(floored.issues.length, 1, 'zero would make the tool useless');
});

test('measures come back with a legend the model can interpret', async () => {
    const tools = registerTools(
        stubClient({
            getMeasures: async () => new Map([['coverage', '81.2'], ['sqale_rating', '1.0']])
        }),
        stubState({ project: { key: 'p', name: 'P' } })
    );
    const json = resultJson(await tools.get('sonarcloud_get_measures').invoke({ input: {} }));
    assert.equal(json.measures.coverage, '81.2');
    assert.match(json.note, /Ratings are 1\.0 \(A, best\)/, 'raw numbers alone would be misread');
});

test('hotspots are labelled as review items, not confirmed vulnerabilities', async () => {
    const tools = registerTools(
        stubClient({
            searchHotspots: async () => ({
                hotspots: [
                    {
                        key: 'h1',
                        component: 'p:src/a.ts',
                        project: 'p',
                        securityCategory: 'sql-injection',
                        vulnerabilityProbability: 'HIGH',
                        status: 'TO_REVIEW',
                        line: 4,
                        message: 'Check this query'
                    }
                ],
                components: [{ key: 'p:src/a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
                total: 1
            })
        }),
        stubState({ project: { key: 'p', name: 'P' } })
    );
    const json = resultJson(await tools.get('sonarcloud_get_hotspots').invoke({ input: {} }));
    assert.equal(json.hotspots[0].file, 'src/a.ts');
    assert.equal(json.hotspots[0].vulnerabilityProbability, 'HIGH');
    assert.match(json.note, /not confirmed\s+vulnerabilities/i);
});

test('the rule tool requires a key and reports an unknown rule', async () => {
    const tools = registerTools(stubClient({ getRule: async () => undefined }), stubState());
    const missingKey = resultJson(await tools.get('sonarcloud_get_rule').invoke({ input: {} }));
    assert.match(missingKey.error, /ruleKey is required/);

    const unknown = resultJson(await tools.get('sonarcloud_get_rule').invoke({ input: { ruleKey: 'x:S1' } }));
    assert.match(unknown.error, /was not found/);
});

test('a very long rule description is truncated rather than flooding the context', async () => {
    const tools = registerTools(
        stubClient({ getRule: async () => ({ key: 'r', name: 'R', htmlDesc: 'x'.repeat(50000) }) }),
        stubState()
    );
    const json = resultJson(await tools.get('sonarcloud_get_rule').invoke({ input: { ruleKey: 'r' } }));
    assert.ok(json.descriptionHtml.length < 11000);
    assert.match(json.descriptionHtml, /truncated/);
});

test('rules without htmlDesc fall back to their description sections', async () => {
    const tools = registerTools(
        stubClient({
            getRule: async () => ({
                key: 'r',
                name: 'R',
                descriptionSections: [{ key: 'root_cause', content: 'why' }, { key: 'how_to_fix', content: 'how' }]
            })
        }),
        stubState()
    );
    const json = resultJson(await tools.get('sonarcloud_get_rule').invoke({ input: { ruleKey: 'r' } }));
    assert.match(json.descriptionHtml, /why/);
    assert.match(json.descriptionHtml, /how/);
});

test('API failures come back as a structured error with a fix hint', async () => {
    const { SonarCloudError } = load('client');
    const tools = registerTools(
        stubClient({
            searchIssues: async () => {
                throw new SonarCloudError('SonarCloud rejected the API token (401).', 401);
            }
        }),
        stubState({ project: { key: 'p', name: 'P' } })
    );
    const json = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    assert.match(json.error, /401/);
    assert.match(json.hint, /Set API Token|Set Organization/);
});

test('a tool invoked with no input object at all does not throw', async () => {
    const tools = registerTools(stubClient(), stubState({ project: { key: 'p', name: 'P' } }));
    const json = resultJson(await tools.get('sonarcloud_get_issues').invoke({}));
    assert.equal(json.project, 'p');
});


// ------------------------------------------------- new issues and the gate ---

const { IssueBaselineStore, toBaseline } = load('newIssues');

function baselineStore(initial) {
    const store = new Map();
    const memento = {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            store.set(key, value);
        }
    };
    return { store: new IssueBaselineStore(memento), memento };
}

function issuesClient(keys) {
    return stubClient({
        searchIssues: async () => ({
            issues: keys.map(key => ({
                key,
                rule: 'r:1',
                severity: 'MAJOR',
                type: 'CODE_SMELL',
                component: 'proj:a.ts',
                project: 'proj',
                line: 1,
                message: `issue ${key}`
            })),
            components: [{ key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
            rules: [],
            total: keys.length
        })
    });
}

test('issues carry whether they are new, once there is something to compare against', async () => {
    const { store } = baselineStore();
    await store.set('proj', undefined, toBaseline(['old']));
    const tools = registerTools(issuesClient(['old', 'fresh']), stubState({ project: { key: 'proj' } }), store);
    const result = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    const flags = new Map(result.issues.map(issue => [issue.key, issue.isNew]));
    assert.equal(flags.get('old'), false);
    assert.equal(flags.get('fresh'), true);
});

test('without a baseline, newness is absent rather than reported as false', async () => {
    // "not new" and "we have no idea" are different claims, and a model will
    // act on the difference.
    const tools = registerTools(issuesClient(['a']), stubState({ project: { key: 'proj' } }), baselineStore().store);
    const result = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    assert.ok(!('isNew' in result.issues[0]));
});

test('onlyNew returns just the arrivals', async () => {
    const { store } = baselineStore();
    await store.set('proj', undefined, toBaseline(['old']));
    const tools = registerTools(issuesClient(['old', 'fresh']), stubState({ project: { key: 'proj' } }), store);
    const result = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: { onlyNew: true } }));
    assert.deepEqual(result.issues.map(issue => issue.key), ['fresh']);
});

test('onlyNew with no baseline says why it returned nothing', async () => {
    // Silently returning zero issues would read as "the project is clean".
    const tools = registerTools(issuesClient(['a']), stubState({ project: { key: 'proj' } }), baselineStore().store);
    const result = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: { onlyNew: true } }));
    assert.deepEqual(result.issues, []);
    assert.match(result.note, /no record of a previous look/);
});

test('the tools work without a baseline store at all', async () => {
    const tools = registerTools(issuesClient(['a']), stubState({ project: { key: 'proj' } }));
    const result = resultJson(await tools.get('sonarcloud_get_issues').invoke({ input: {} }));
    assert.equal(result.issues.length, 1);
});

test('a failed quality gate comes with the conditions that failed', async () => {
    // "alert_status: ERROR" alone tells a model the gate failed but not what
    // to fix.
    const client = stubClient({
        getMeasures: async () => new Map([['alert_status', 'ERROR']]),
        getQualityGateStatus: async () => ({
            status: 'ERROR',
            conditions: [
                { metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '42', status: 'ERROR' },
                { metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0', status: 'OK' }
            ]
        })
    });
    const tools = registerTools(client, stubState({ project: { key: 'proj' } }));
    const result = resultJson(await tools.get('sonarcloud_get_measures').invoke({ input: {} }));
    assert.deepEqual(result.failedQualityGateConditions, ['Coverage on New Code is 42.0%, required ≥ 80.0%']);
});

test('a passing gate is not interrogated about why it passed', async () => {
    let asked = false;
    const client = stubClient({
        getMeasures: async () => new Map([['alert_status', 'OK']]),
        getQualityGateStatus: async () => {
            asked = true;
            return { status: 'OK', conditions: [] };
        }
    });
    const tools = registerTools(client, stubState({ project: { key: 'proj' } }));
    const result = resultJson(await tools.get('sonarcloud_get_measures').invoke({ input: {} }));
    assert.equal(asked, false);
    assert.ok(!('failedQualityGateConditions' in result));
});

test('measures survive the gate detail call failing', async () => {
    const client = stubClient({
        getMeasures: async () => new Map([['alert_status', 'ERROR'], ['coverage', '10']]),
        getQualityGateStatus: async () => {
            throw new Error('403');
        }
    });
    const tools = registerTools(client, stubState({ project: { key: 'proj' } }));
    const result = resultJson(await tools.get('sonarcloud_get_measures').invoke({ input: {} }));
    assert.equal(result.measures.coverage, '10');
});
