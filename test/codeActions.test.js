'use strict';

/**
 * Quick fixes on SonarCloud squiggles. The trap here is offering actions on
 * someone else's diagnostics, or on ours after the issue list has moved on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const { SonarCodeActions } = load('codeActions');
const { SonarDiagnostics } = load('diagnostics');

test.afterEach(() => cleanup());

const client = { issueUrl: () => 'https://sonarcloud.io/x' };

function issue(line, severity = 'CRITICAL', message = `problem at ${line}`) {
    return {
        issue: {
            key: `k-${line}`,
            rule: 'ts:S1481',
            severity,
            component: 'proj:src/a.ts',
            project: 'proj',
            line,
            message,
            type: 'CODE_SMELL',
            status: 'OPEN'
        },
        path: 'src/a.ts'
    };
}

/** Publish issues and return the provider plus the diagnostics VS Code would pass back. */
async function publish(items) {
    const folder = makeWorkspace({ 'src/a.ts': 'a\nb\nc\nd\n' });
    const diagnostics = new SonarDiagnostics(client, { branch: undefined });
    await diagnostics.publish(items);
    const collection = vscode.__harness.diagnosticCollections.find(c => c.name === 'sonarcloud');
    const [uriPath, published] = [...collection.entries][0] ?? [];
    return {
        folder,
        diagnostics,
        provider: new SonarCodeActions(diagnostics),
        document: { uri: vscode.Uri.file(uriPath ?? '/nope') },
        published: published ?? []
    };
}

test('a SonarCloud diagnostic offers fix, explain and resolve', async () => {
    const ctx = await publish([issue(2)]);
    try {
        const actions = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: ctx.published });
        assert.deepEqual(actions.map(a => a.command.command), [
            'sonarcloud.fixWithCopilot',
            'sonarcloud.showIssueDetails',
            'sonarcloud.resolveIssue'
        ]);
        assert.equal(actions[0].isPreferred, true, 'fixing is the obvious default');
        assert.match(actions[0].title, /critical/, 'the severity is named so the lightbulb is informative');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('actions carry the issue the command expects', async () => {
    const ctx = await publish([issue(3, 'MAJOR')]);
    try {
        const [fix] = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: ctx.published });
        const [node] = fix.command.arguments;
        assert.equal(node.kind, 'issue');
        assert.equal(node.issue.key, 'k-3');
        assert.equal(node.path, 'src/a.ts', 'the command needs the path to open the file');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('actions are attached to their diagnostic so the Problems panel offers them', async () => {
    const ctx = await publish([issue(2)]);
    try {
        const actions = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: ctx.published });
        for (const action of actions) {
            assert.deepEqual(action.diagnostics, [ctx.published[0]]);
            assert.equal(action.kind.value, 'quickfix');
        }
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('diagnostics from other extensions are ignored', async () => {
    const ctx = await publish([issue(2)]);
    try {
        const foreign = { message: 'eslint says no', source: 'eslint', range: ctx.published[0].range };
        const actions = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: [foreign] });
        assert.deepEqual(actions, [], 'we must not hijack another linter\'s lightbulb');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('the right issue is matched when a line has two of them', async () => {
    const ctx = await publish([issue(2, 'MAJOR', 'first problem'), issue(2, 'MINOR', 'second problem')]);
    try {
        const second = ctx.published.find(d => d.message === 'second problem');
        const [fix] = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: [second] });
        assert.equal(fix.command.arguments[0].issue.message, 'second problem');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('several selected diagnostics each get their own actions', async () => {
    const ctx = await publish([issue(1), issue(3)]);
    try {
        const actions = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: ctx.published });
        assert.equal(actions.length, 6, 'three actions per issue');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('after the issue list is cleared, stale squiggles offer nothing', async () => {
    const ctx = await publish([issue(2)]);
    try {
        ctx.diagnostics.clear();
        const actions = ctx.provider.provideCodeActions(ctx.document, undefined, { diagnostics: ctx.published });
        assert.deepEqual(actions, [], 'acting on an issue we no longer know about would misfire');
    } finally {
        ctx.diagnostics.dispose();
    }
});

test('a file with no SonarCloud issues offers nothing', async () => {
    const ctx = await publish([issue(2)]);
    try {
        const other = { uri: vscode.Uri.file('/elsewhere/b.ts') };
        assert.deepEqual(ctx.provider.provideCodeActions(other, undefined, { diagnostics: ctx.published }), []);
    } finally {
        ctx.diagnostics.dispose();
    }
});
