'use strict';

/**
 * "New since you last looked". The badge is only worth having if it is never
 * wrong: a false NEW on an issue you triaged last week makes the whole column
 * untrustworthy, so every uncertain case must fall back to marking nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, cleanup } = require('./harness');

const {
    describeNewIssues,
    isIssueBaseline,
    IssueBaselineStore,
    MAX_BASELINE_KEYS,
    MAX_BASELINE_SCOPES,
    newIssueKeys,
    relativeTime,
    toBaseline
} = load('newIssues');
const { IssuesProvider } = load('issuesProvider');

test.afterEach(() => cleanup());

test('a baseline survives a JSON round trip unchanged', () => {
    // Workspace state is JSON, so an undefined-valued key would come back
    // different from what was written.
    const baseline = toBaseline(['a', 'b']);
    assert.deepEqual(JSON.parse(JSON.stringify(baseline)), baseline);
    assert.ok(!('truncated' in baseline));
});

test('a project too large to baseline marks nothing new, rather than everything', () => {
    const huge = toBaseline(Array.from({ length: MAX_BASELINE_KEYS + 10 }, (_, i) => `k${i}`));
    assert.equal(huge.truncated, true);
    assert.equal(huge.keys.length, MAX_BASELINE_KEYS);
    assert.equal(
        newIssueKeys(huge, ['k0', 'k99999']).size,
        0,
        'the dropped keys would otherwise all look new'
    );
});

test('with no baseline nothing is new', () => {
    assert.equal(newIssueKeys(undefined, ['a', 'b']).size, 0);
});

test('keys absent from the baseline are the new ones', () => {
    const isNew = newIssueKeys(toBaseline(['a', 'b']), ['a', 'c']);
    assert.deepEqual([...isNew], ['c']);
});

test('an issue that was fixed does not make anything else look new', () => {
    assert.equal(newIssueKeys(toBaseline(['a', 'b']), ['a']).size, 0);
});

test('corrupt stored state is rejected', () => {
    assert.equal(isIssueBaseline(undefined), false);
    assert.equal(isIssueBaseline({ at: 'now' }), false);
    assert.equal(isIssueBaseline({ at: 'now', keys: [] }), true);
});

test('the header only mentions new issues when there are some', () => {
    assert.equal(describeNewIssues(0, '2 hours ago'), undefined);
    assert.equal(describeNewIssues(3, undefined), undefined);
    assert.equal(describeNewIssues(3, '2 hours ago'), '3 new since 2 hours ago');
});

test('an unreadable timestamp degrades to plain words', () => {
    assert.equal(relativeTime('not a date'), 'your last check');
});

// ---------------------------------------------------------------- store ---

function memento(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            store.set(key, value);
        },
        store
    };
}

test('a baseline is scoped to the project and branch', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', 'feature/x', toBaseline(['a']));
    assert.deepEqual(store.get('proj', 'feature/x').keys, ['a']);
    assert.equal(store.get('proj', 'main'), undefined, 'another branch has its own issue list');
    assert.equal(store.get('other', 'feature/x'), undefined);
});

test('the main branch and an unset branch are the same scope', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline(['a']));
    assert.deepEqual(store.get('proj', undefined).keys, ['a']);
});

test('old baselines are pruned rather than kept forever', async () => {
    // Every project/branch pair the workspace visits stores one; a long-lived
    // workspace would otherwise carry branches deleted months ago.
    const backing = memento();
    const store = new IssueBaselineStore(backing);
    for (let i = 0; i < MAX_BASELINE_SCOPES + 4; i++) {
        await store.set('proj', `branch-${i}`, toBaseline([`k${i}`], new Date(2020, 0, 1 + i)));
    }
    const stored = backing.store.get('sonarcloud.issueBaseline');
    assert.equal(Object.keys(stored).length, MAX_BASELINE_SCOPES);
    assert.ok(store.get('proj', `branch-${MAX_BASELINE_SCOPES + 3}`), 'the newest is kept');
    assert.equal(store.get('proj', 'branch-0'), undefined, 'the oldest is dropped');
});

test('a corrupt entry is dropped on the next write instead of poisoning the store', async () => {
    const backing = memento({ 'sonarcloud.issueBaseline': { 'proj@@old': { nonsense: true } } });
    const store = new IssueBaselineStore(backing);
    await store.set('proj', undefined, toBaseline(['a']));
    assert.deepEqual(Object.keys(backing.store.get('sonarcloud.issueBaseline')), ['proj@@']);
});

test('storing one project does not drop another', async () => {
    const backing = memento();
    const store = new IssueBaselineStore(backing);
    await store.set('one', undefined, toBaseline(['a']));
    await store.set('two', undefined, toBaseline(['b']));
    assert.deepEqual(store.get('one', undefined).keys, ['a']);
    assert.deepEqual(store.get('two', undefined).keys, ['b']);
});

// ------------------------------------------------------------- provider ---

function issue(key, line = 1) {
    return {
        key,
        rule: 'rule:1',
        severity: 'MAJOR',
        component: 'proj:src/a.ts',
        project: 'proj',
        line,
        message: `issue ${key}`,
        type: 'CODE_SMELL',
        status: 'OPEN'
    };
}

function clientWith(keys) {
    return {
        searchIssues: async () => ({
            issues: keys.map(key => issue(key)),
            components: [{ key: 'proj:src/a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
            rules: [],
            total: keys.length
        })
    };
}

const state = (overrides = {}) => ({
    project: { key: 'proj', name: 'Proj' },
    branch: undefined,
    severities: [],
    types: [],
    newCodeOnly: false,
    ...overrides
});

function issueNodes(nodes) {
    return nodes.filter(node => node.kind === 'file').flatMap(node => node.issues);
}

test('the first look establishes the baseline and flags nothing', async () => {
    const store = new IssueBaselineStore(memento());
    const provider = new IssuesProvider(clientWith(['a', 'b']), state(), store);
    const nodes = await provider.getChildren();
    assert.deepEqual(
        issueNodes(nodes).map(node => node.isNew),
        [false, false],
        'a project you have never opened is not "all new"'
    );
    assert.deepEqual(store.get('proj', undefined).keys, ['a', 'b']);
});

test('an issue that appeared since is flagged, and counted in the header', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline(['a']));
    const provider = new IssuesProvider(clientWith(['a', 'b']), state(), store);
    let loaded;
    provider.onDidLoad(info => (loaded = info));

    const nodes = await provider.getChildren();
    const flags = new Map(issueNodes(nodes).map(node => [node.issue.key, node.isNew]));
    assert.equal(flags.get('a'), false);
    assert.equal(flags.get('b'), true);
    assert.equal(loaded.newCount, 1);
    assert.ok(loaded.newSince, 'the header needs to say since when');
});

test('a new issue is labelled in the tree item, not just in the model', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline([]));
    const provider = new IssuesProvider(clientWith(['b']), state(), store);
    const node = issueNodes(await provider.getChildren())[0];
    const item = provider.getTreeItem(node);
    assert.match(item.description, /^NEW · /);
    assert.equal(item.contextValue, 'issue.new');
});

test('a filtered first look does not become the baseline', async () => {
    // It would record only the issues that passed the filter, so clearing the
    // filter later would report long-standing issues as new.
    const store = new IssueBaselineStore(memento());
    const provider = new IssuesProvider(clientWith(['a']), state({ severities: ['BLOCKER'] }), store);
    await provider.getChildren();
    assert.equal(store.get('proj', undefined), undefined);
});

test('a partially loaded first page does not become the baseline', async () => {
    const store = new IssueBaselineStore(memento());
    const client = {
        searchIssues: async () => ({
            issues: [issue('a')],
            components: [],
            rules: [],
            total: 900 // more pages behind this one
        })
    };
    await new IssuesProvider(client, state(), store).getChildren();
    assert.equal(store.get('proj', undefined), undefined, 'the other 899 are not new');
});

test('the only-new filter hides everything you have already seen', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline(['a']));
    const provider = new IssuesProvider(clientWith(['a', 'b']), state({ newIssuesOnly: true }), store);
    const nodes = await provider.getChildren();
    assert.deepEqual(
        issueNodes(nodes).map(node => node.issue.key),
        ['b']
    );
});

test('an only-new view with nothing new explains itself', async () => {
    // An empty tree with no message reads as a broken view.
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline(['a']));
    const provider = new IssuesProvider(clientWith(['a']), state({ newIssuesOnly: true }), store);
    const nodes = await provider.getChildren();
    assert.equal(nodes.length, 1);
    assert.match(nodes[0].text, /Nothing new since/);
});

test('an only-new view before any baseline says why it is empty', async () => {
    const provider = new IssuesProvider(clientWith(['a']), state({ newIssuesOnly: true }), new IssueBaselineStore(memento()));
    const nodes = await provider.getChildren();
    assert.match(nodes[0].text, /first look/);
});

test('marking as seen clears the flags on the next load', async () => {
    const store = new IssueBaselineStore(memento());
    await store.set('proj', undefined, toBaseline(['a']));
    const provider = new IssuesProvider(clientWith(['a', 'b']), state(), store);
    await provider.getChildren();

    assert.equal(await provider.markSeen(), true);
    const nodes = await provider.getChildren();
    assert.deepEqual(
        issueNodes(nodes).map(node => node.isNew),
        [false, false]
    );
});

test('marking as seen before anything is loaded reports that it did nothing', async () => {
    const store = new IssueBaselineStore(memento());
    const provider = new IssuesProvider(clientWith(['a']), state(), store);
    assert.equal(await provider.markSeen(), false);
});

test('without a baseline store the view behaves exactly as before', async () => {
    const provider = new IssuesProvider(clientWith(['a']), state());
    const nodes = await provider.getChildren();
    assert.equal(issueNodes(nodes)[0].isNew, false);
    assert.equal(await provider.markSeen(), false);
});
