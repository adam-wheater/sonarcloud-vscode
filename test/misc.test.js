'use strict';

/**
 * The remaining small modules: git branch detection, the issue details
 * webview and the status bar summary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const { detectWorkspaceGitBranch } = load('gitBranch');
const { showIssueDetails } = load('issueDetails');
const { SonarStatusBar } = load('statusBar');

test.afterEach(() => cleanup());

// -------------------------------------------------------- branch detection ---

test('the checked-out branch is read from .git/HEAD', async () => {
    makeWorkspace({ '.git/HEAD': 'ref: refs/heads/feature/my-work\n' });
    assert.equal(await detectWorkspaceGitBranch(), 'feature/my-work');
});

test('a detached HEAD reports no branch rather than a commit hash', async () => {
    makeWorkspace({ '.git/HEAD': '9f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90\n' });
    assert.equal(await detectWorkspaceGitBranch(), undefined);
});

test('a worktree, where .git is a file pointing elsewhere, still resolves', async () => {
    const folder = makeWorkspace({ 'placeholder.txt': '' });
    const realGitDir = path.join(folder.uri.fsPath, 'actual-git-dir');
    fs.mkdirSync(realGitDir, { recursive: true });
    fs.writeFileSync(path.join(realGitDir, 'HEAD'), 'ref: refs/heads/worktree-branch\n');
    fs.writeFileSync(path.join(folder.uri.fsPath, '.git'), `gitdir: ${realGitDir}\n`);

    assert.equal(await detectWorkspaceGitBranch(), 'worktree-branch');
});

test('a folder that is not a git checkout reports nothing', async () => {
    makeWorkspace({ 'readme.md': '# hi' });
    assert.equal(await detectWorkspaceGitBranch(), undefined);
});

test('branch names containing slashes survive intact', async () => {
    makeWorkspace({ '.git/HEAD': 'ref: refs/heads/release/2024.1/hotfix\n' });
    assert.equal(await detectWorkspaceGitBranch(), 'release/2024.1/hotfix');
});

test('with no workspace open there is nothing to detect', async () => {
    assert.equal(await detectWorkspaceGitBranch(), undefined);
});

// ------------------------------------------------------------ issue details ---

/** Capture the webview panel the details view creates. */
function capturePanel() {
    const panels = [];
    const original = vscode.window.createWebviewPanel;
    vscode.window.createWebviewPanel = (viewType, title, column, options) => {
        const panel = {
            viewType,
            title,
            options,
            webview: { html: '' },
            viewColumn: column,
            reveal() {
                this.revealed = true;
            },
            onDidDispose(handler) {
                this.disposeHandler = handler;
                return { dispose: () => {} };
            },
            dispose() {
                if (this.disposeHandler) {
                    this.disposeHandler();
                }
            }
        };
        panels.push(panel);
        return panel;
    };
    return {
        panels,
        // The details view deliberately keeps one panel in module state, so
        // each test must dispose it or the next one sees a reused panel.
        restore: () => {
            for (const panel of panels) {
                panel.dispose();
            }
            vscode.window.createWebviewPanel = original;
        }
    };
}

const issue = {
    key: 'AX1',
    rule: 'ts:S1481',
    severity: 'MAJOR',
    component: 'proj:src/a.ts',
    project: 'proj',
    line: 12,
    message: 'Remove this unused variable',
    type: 'CODE_SMELL',
    status: 'OPEN',
    effort: '5min'
};

const detailsClient = {
    getRule: async () => ({ key: 'ts:S1481', name: 'Unused locals', htmlDesc: '<p>Why it matters</p>' }),
    issueUrl: () => 'https://sonarcloud.io/project/issues?id=proj&open=AX1'
};

test('the details panel renders the issue, its rule and a link', async () => {
    const captured = capturePanel();
    try {
        await showIssueDetails(detailsClient, issue, 'src/a.ts', undefined);
        const [panel] = captured.panels;
        assert.equal(panel.options.enableScripts, false, 'rule HTML is third-party; scripts stay off');
        assert.match(panel.webview.html, /Remove this unused variable/);
        assert.match(panel.webview.html, /Why it matters/, 'the rule description is included');
        assert.match(panel.webview.html, /src\/a\.ts:12/);
        assert.match(panel.webview.html, /sonarcloud\.io/);
    } finally {
        captured.restore();
    }
});

test('the panel is reused rather than stacking an editor per issue', async () => {
    const captured = capturePanel();
    try {
        await showIssueDetails(detailsClient, issue, 'src/a.ts', undefined);
        await showIssueDetails(detailsClient, { ...issue, key: 'AX2', message: 'Second issue' }, 'src/b.ts', undefined);
        assert.equal(captured.panels.length, 1, 'clicking through issues must not open many tabs');
        assert.match(captured.panels[0].webview.html, /Second issue/, 'the panel shows the newest issue');
    } finally {
        captured.restore();
    }
});

test('a closed panel is recreated on the next request', async () => {
    const captured = capturePanel();
    try {
        await showIssueDetails(detailsClient, issue, 'src/a.ts', undefined);
        captured.panels[0].dispose();
        await showIssueDetails(detailsClient, issue, 'src/a.ts', undefined);
        assert.equal(captured.panels.length, 2, 'a disposed panel cannot be reused');
    } finally {
        captured.restore();
    }
});

test('details still render when the rule cannot be fetched', async () => {
    const captured = capturePanel();
    try {
        await showIssueDetails(
            {
                getRule: async () => {
                    throw new Error('offline');
                },
                issueUrl: () => 'https://sonarcloud.io/x'
            },
            issue,
            'src/a.ts',
            undefined
        );
        assert.match(captured.panels[0].webview.html, /Rule description unavailable/);
        assert.match(captured.panels[0].webview.html, /Remove this unused variable/);
    } finally {
        captured.restore();
    }
});

test('issue text is HTML-escaped', async () => {
    const captured = capturePanel();
    try {
        await showIssueDetails(
            detailsClient,
            { ...issue, message: 'Avoid <script>alert(1)</script> here' },
            'src/a.ts',
            undefined
        );
        assert.ok(!captured.panels[0].webview.html.includes('<script>alert(1)'), 'messages are data, not markup');
        assert.match(captured.panels[0].webview.html, /&lt;script&gt;/);
    } finally {
        captured.restore();
    }
});

// --------------------------------------------------------------- status bar ---

/** Capture the status bar item the summary creates. */
function captureStatusBar() {
    const items = [];
    const original = vscode.window.createStatusBarItem;
    vscode.window.createStatusBarItem = (id, alignment, priority) => {
        const item = {
            id,
            alignment,
            priority,
            text: '',
            show() {
                this.visible = true;
            },
            hide() {
                this.visible = false;
            },
            dispose() {}
        };
        items.push(item);
        return item;
    };
    return { items, restore: () => (vscode.window.createStatusBarItem = original) };
}

test('the status bar summarises the gate and the issue count', async () => {
    const captured = captureStatusBar();
    try {
        const client = {
            getMeasures: async () =>
                new Map([
                    ['alert_status', 'OK'],
                    ['bugs', '2'],
                    ['vulnerabilities', '1'],
                    ['code_smells', '7'],
                    ['security_hotspots', '3']
                ])
        };
        const bar = new SonarStatusBar(client, { project: { key: 'p', name: 'P' }, branch: undefined });
        await bar.refresh();
        const [item] = captured.items;
        assert.match(item.text, /10 issues/, 'bugs + vulnerabilities + smells');
        assert.match(item.text, /pass-filled/);
        assert.equal(item.visible, true);
        assert.equal(item.backgroundColor, undefined, 'a passing gate is not alarming');
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('a failing quality gate is highlighted', async () => {
    const captured = captureStatusBar();
    try {
        const client = { getMeasures: async () => new Map([['alert_status', 'ERROR'], ['bugs', '1']]) };
        const bar = new SonarStatusBar(client, { project: { key: 'p', name: 'P' }, branch: undefined });
        await bar.refresh();
        assert.match(captured.items[0].text, /error/);
        assert.ok(captured.items[0].backgroundColor, 'a failed gate should stand out');
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('with no project selected the status bar hides itself', async () => {
    const captured = captureStatusBar();
    try {
        const bar = new SonarStatusBar({ getMeasures: async () => new Map() }, { project: undefined });
        await bar.refresh();
        assert.equal(captured.items[0].visible, false);
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('an API failure leaves a muted status rather than an error popup', async () => {
    const captured = captureStatusBar();
    try {
        const client = {
            getMeasures: async () => {
                throw new Error('network down');
            }
        };
        const bar = new SonarStatusBar(client, { project: { key: 'p', name: 'P' }, branch: undefined });
        await bar.refresh();
        assert.match(captured.items[0].text, /SonarCloud/);
        assert.ok(!captured.items[0].text.includes('issues'));
        assert.equal(
            vscode.__harness.shownMessages.length,
            0,
            'the status bar must not nag with popups when it cannot refresh'
        );
        bar.dispose();
    } finally {
        captured.restore();
    }
});

test('a superseded refresh does not overwrite a newer result', async () => {
    const captured = captureStatusBar();
    try {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        let call = 0;
        const client = {
            getMeasures: async () => {
                call++;
                if (call === 1) {
                    await gate;
                    return new Map([['alert_status', 'ERROR'], ['bugs', '99']]);
                }
                return new Map([['alert_status', 'OK'], ['bugs', '1']]);
            }
        };
        const bar = new SonarStatusBar(client, { project: { key: 'p', name: 'P' }, branch: undefined });
        const slow = bar.refresh();
        const fast = bar.refresh();
        await fast;
        release();
        await slow;
        assert.match(captured.items[0].text, /1 issue/, 'the stale response must not win');
        bar.dispose();
    } finally {
        captured.restore();
    }
});
