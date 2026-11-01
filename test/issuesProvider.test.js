'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup } = require('./harness');

const { IssuesProvider } = load('issuesProvider');
const { SonarState } = load('state');

test.afterEach(() => cleanup());

/** Memento backed by a plain Map, matching the slice SonarState uses. */
function memento(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        store
    };
}

function issue(key, component, line, severity = 'MAJOR') {
    return {
        key,
        rule: 'ts:S1',
        severity,
        component,
        project: 'proj',
        line,
        message: `issue ${key}`,
        type: 'CODE_SMELL',
        status: 'OPEN'
    };
}

/** Client stub that serves pages of issues and records the queries it saw. */
function fakeClient(pages) {
    const queries = [];
    return {
        queries,
        async searchIssues(options) {
            queries.push(options);
            const page = pages[(options.page ?? 1) - 1] ?? { issues: [], components: [], rules: [] };
            return {
                issues: page.issues,
                components: page.components ?? [],
                rules: page.rules ?? [],
                total: pages.reduce((sum, p) => sum + p.issues.length, 0)
            };
        }
    };
}

test('issues are grouped by file and sorted by line', async () => {
    const client = fakeClient([
        {
            issues: [issue('c', 'proj:b.ts', 5), issue('a', 'proj:a.ts', 9), issue('b', 'proj:a.ts', 2)],
            components: [
                { key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' },
                { key: 'proj:b.ts', path: 'src/b.ts', qualifier: 'FIL' }
            ],
            rules: [{ key: 'ts:S1', name: 'Rule one' }]
        }
    ]);
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const provider = new IssuesProvider(client, state);

    const nodes = await provider.getChildren();
    assert.deepEqual(nodes.map(n => n.path), ['src/a.ts', 'src/b.ts']);
    const [fileA] = nodes;
    assert.deepEqual(fileA.issues.map(i => i.issue.key), ['b', 'a'], 'sorted by line within a file');
    assert.equal(fileA.issues[0].ruleName, 'Rule one', 'rule names are resolved');
});

test('project-level issues (no file path) get their own group', async () => {
    const client = fakeClient([{ issues: [issue('x', 'proj', undefined)], components: [{ key: 'proj', qualifier: 'TRK' }] }]);
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const nodes = await new IssuesProvider(client, state).getChildren();
    assert.equal(nodes[0].kind, 'file');
    assert.equal(nodes[0].path, undefined);
});

test('no project selected means no requests at all', async () => {
    const client = fakeClient([{ issues: [] }]);
    const provider = new IssuesProvider(client, new SonarState(memento()));
    assert.deepEqual(await provider.getChildren(), []);
    assert.equal(client.queries.length, 0);
});

test('filters and the new-code toggle reach the API', async () => {
    const client = fakeClient([{ issues: [] }]);
    const state = new SonarState(
        memento({
            'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' },
            'sonarcloud.selectedBranch': 'feature/x',
            'sonarcloud.filter.severities': ['BLOCKER'],
            'sonarcloud.filter.types': ['BUG'],
            'sonarcloud.filter.newCode': true
        })
    );
    await new IssuesProvider(client, state).getChildren();
    assert.deepEqual(client.queries[0], {
        projectKey: 'proj',
        branch: 'feature/x',
        severities: ['BLOCKER'],
        types: ['BUG'],
        newCodeOnly: true,
        page: 1
    });
});

test('a "load more" row appears while pages remain, and paging fetches them', async () => {
    const pageOne = { issues: Array.from({ length: 500 }, (_, i) => issue(`a${i}`, 'proj:a.ts', i + 1)) };
    const pageTwo = { issues: [issue('b1', 'proj:a.ts', 900)] };
    const components = [{ key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' }];
    const client = fakeClient([
        { ...pageOne, components },
        { ...pageTwo, components }
    ]);
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const provider = new IssuesProvider(client, state);

    const first = await provider.getChildren();
    const loadMore = first.find(node => node.kind === 'loadMore');
    assert.ok(loadMore, 'a load-more row is offered');
    assert.equal(loadMore.remaining, 1);

    provider.loadMore();
    const second = await provider.getChildren();
    assert.equal(client.queries.length, 3, 'page 1 refetched plus page 2');
    assert.deepEqual(client.queries.map(q => q.page), [1, 1, 2]);
    assert.equal(second.find(node => node.kind === 'loadMore'), undefined, 'nothing left to load');
    assert.equal(second[0].issues.length, 501);
});

test('refresh resets paging back to the first page', async () => {
    const components = [{ key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' }];
    const client = fakeClient([
        { issues: Array.from({ length: 500 }, (_, i) => issue(`a${i}`, 'proj:a.ts', i + 1)), components },
        { issues: [issue('b1', 'proj:a.ts', 900)], components }
    ]);
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const provider = new IssuesProvider(client, state);

    await provider.getChildren();
    provider.loadMore();
    await provider.getChildren();
    provider.refresh();
    client.queries.length = 0;
    await provider.getChildren();
    assert.deepEqual(client.queries.map(q => q.page), [1], 'back to a single page');
});

test('an empty result explains itself instead of rendering nothing', async () => {
    const client = fakeClient([{ issues: [] }]);
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const nodes = await new IssuesProvider(client, state).getChildren();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].kind, 'message');
    assert.match(nodes[0].text, /No open issues match/);
});

test('a failed load surfaces the error and signals listeners', async () => {
    const client = {
        async searchIssues() {
            throw new Error('network down');
        }
    };
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const provider = new IssuesProvider(client, state);
    let failed = false;
    provider.onDidFailLoad(() => (failed = true));

    const nodes = await provider.getChildren();
    assert.equal(nodes[0].kind, 'message');
    assert.match(nodes[0].text, /network down/);
    assert.equal(failed, true, 'the stale issue count must be cleared by listeners');
});

test('a superseded load does not publish its results', async () => {
    // Two loads race; only the newer one may drive diagnostics and counts.
    let release;
    const gate = new Promise(resolve => (release = resolve));
    let call = 0;
    const client = {
        async searchIssues() {
            call++;
            if (call === 1) {
                await gate;
                return { issues: [issue('old', 'proj:a.ts', 1)], components: [], rules: [], total: 1 };
            }
            return { issues: [issue('new', 'proj:a.ts', 2)], components: [], rules: [], total: 1 };
        }
    };
    const state = new SonarState(memento({ 'sonarcloud.selectedProject': { key: 'proj', name: 'Proj' } }));
    const provider = new IssuesProvider(client, state);
    const published = [];
    provider.onDidLoadIssues(items => published.push(items.map(i => i.issue.key)));

    const slow = provider.getChildren();
    const fast = provider.getChildren();
    await fast;
    release();
    await slow;

    assert.deepEqual(published, [['new']], 'the stale response must not publish');
});

test('state: setting a project clears the previously selected branch', async () => {
    const store = memento({
        'sonarcloud.selectedProject': { key: 'old', name: 'Old' },
        'sonarcloud.selectedBranch': 'feature/x'
    });
    const state = new SonarState(store);
    await state.setProject({ key: 'new', name: 'New' });
    assert.equal(state.branch, undefined, 'a branch from another project would 404');
    assert.deepEqual(state.project, { key: 'new', name: 'New' });
});

test('state: clearing filters resets severity, type and new-code together', async () => {
    const state = new SonarState(
        memento({
            'sonarcloud.filter.severities': ['BLOCKER'],
            'sonarcloud.filter.types': ['BUG'],
            'sonarcloud.filter.newCode': true
        })
    );
    await state.clearFilters();
    assert.deepEqual(state.severities, []);
    assert.deepEqual(state.types, []);
    assert.equal(state.newCodeOnly, false);
});

test('state: changes fire a single event so views refresh once', async () => {
    const state = new SonarState(memento());
    let fired = 0;
    state.onDidChange(() => fired++);
    await state.setBranch('main');
    await state.setSeverities(['MAJOR']);
    assert.equal(fired, 2);
});

test('state: the scan language is remembered without disturbing the views', async () => {
    const state = new SonarState(memento());
    let fired = 0;
    state.onDidChange(() => fired++);
    await state.setScanLanguage('dart');
    assert.equal(state.scanLanguage, 'dart');
    assert.equal(fired, 0, 'language choice is not view state');
});
