'use strict';

/**
 * Tree providers and the diagnostics publisher. These decide what the user
 * actually sees, and their failure mode is a silently empty view.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const { HotspotsProvider } = load('hotspotsProvider');
const { MeasuresProvider } = load('measuresProvider');
const { ProjectsProvider } = load('projectsProvider');
const { SonarDiagnostics } = load('diagnostics');

test.afterEach(() => cleanup());

const project = { key: 'proj', name: 'Proj' };
const stateWith = (overrides = {}) => ({ project, branch: undefined, ...overrides });

// ------------------------------------------------------------- hotspots ----

function hotspot(key, component, probability = 'MEDIUM', line = 1) {
    return {
        key,
        component,
        project: 'proj',
        securityCategory: 'sql-injection',
        vulnerabilityProbability: probability,
        status: 'TO_REVIEW',
        line,
        message: `hotspot ${key}`
    };
}

test('hotspots group by file and sort worst risk first', async () => {
    const client = {
        searchHotspots: async () => ({
            hotspots: [
                hotspot('low', 'proj:a.ts', 'LOW', 5),
                hotspot('high', 'proj:a.ts', 'HIGH', 9),
                hotspot('medium', 'proj:a.ts', 'MEDIUM', 1)
            ],
            components: [{ key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
            total: 3
        })
    };
    const nodes = await new HotspotsProvider(client, stateWith()).getChildren();
    assert.equal(nodes[0].path, 'src/a.ts');
    assert.deepEqual(
        nodes[0].hotspots.map(node => node.hotspot.key),
        ['high', 'medium', 'low'],
        'a reviewer should meet the riskiest first'
    );
});

test('an empty hotspot list says so rather than rendering nothing', async () => {
    const client = { searchHotspots: async () => ({ hotspots: [], components: [], total: 0 }) };
    const nodes = await new HotspotsProvider(client, stateWith()).getChildren();
    assert.equal(nodes[0].kind, 'message');
    assert.match(nodes[0].text, /No security hotspots/);
});

test('hotspot loading errors surface as a row and a message', async () => {
    const client = {
        searchHotspots: async () => {
            throw new Error('boom');
        }
    };
    const nodes = await new HotspotsProvider(client, stateWith()).getChildren();
    assert.equal(nodes[0].kind, 'message');
    assert.match(nodes[0].text, /boom/);
    assert.ok(vscode.__harness.shownMessages.some(m => m.level === 'error'));
});

test('no project selected means no hotspot request', async () => {
    let called = false;
    const client = {
        searchHotspots: async () => {
            called = true;
            return { hotspots: [], components: [], total: 0 };
        }
    };
    assert.deepEqual(await new HotspotsProvider(client, { project: undefined }).getChildren(), []);
    assert.equal(called, false);
});

test('a hotspot tree item is labelled with risk and location', async () => {
    const client = {
        searchHotspots: async () => ({
            hotspots: [hotspot('h', 'proj:a.ts', 'HIGH', 42)],
            components: [{ key: 'proj:a.ts', path: 'src/a.ts', qualifier: 'FIL' }],
            total: 1
        })
    };
    const provider = new HotspotsProvider(client, stateWith());
    const [file] = await provider.getChildren();
    const item = provider.getTreeItem(file.hotspots[0]);
    assert.match(item.description, /L42/);
    assert.match(item.description, /High risk/);
    assert.equal(item.contextValue, 'hotspot');
    assert.equal(item.command.command, 'sonarcloud.openHotspot');
});

// ------------------------------------------------------------- measures ----

test('measures render with the right units and fall back to a dash', async () => {
    const client = {
        getMeasures: async () => new Map([
            ['coverage', '81.2'],
            ['sqale_rating', '2.0'],
            ['sqale_index', '510'],
            ['alert_status', 'ERROR'],
            ['ncloc', '12345']
        ])
    };
    const provider = new MeasuresProvider(client, stateWith());
    const nodes = await provider.getChildren();
    const render = key => provider.getTreeItem(nodes.find(node => node.spec.key === key)).description;

    assert.equal(render('coverage'), '81.2%');
    assert.equal(render('sqale_rating'), 'B', 'ratings read as letters, not 2.0');
    assert.equal(render('sqale_index'), '1d 30min', 'technical debt reads as time');
    assert.equal(render('alert_status'), 'Failed');
    assert.equal(render('ncloc'), '12,345');
    assert.equal(render('tests'), '—', 'a metric SonarCloud did not return');
});

test('a failed quality gate is coloured, a passing one differently', async () => {
    const provider = new MeasuresProvider({ getMeasures: async () => new Map([['alert_status', 'OK']]) }, stateWith());
    const nodes = await provider.getChildren();
    const gate = nodes.find(node => node.spec.key === 'alert_status');
    assert.equal(provider.getTreeItem(gate).iconPath.id, 'pass-filled');
});

test('missing test-execution metrics explain the long-lived branch rule', async () => {
    const provider = new MeasuresProvider({ getMeasures: async () => new Map() }, stateWith());
    const nodes = await provider.getChildren();
    const tooltip = provider.getTreeItem(nodes.find(node => node.spec.key === 'tests')).tooltip;
    assert.match(tooltip, /long-lived branches/, 'otherwise a blank looks like a broken upload');
});

test('a failing gate lists the conditions that failed', async () => {
    const client = {
        getMeasures: async () => new Map([['alert_status', 'ERROR']]),
        getQualityGateStatus: async () => ({
            status: 'ERROR',
            conditions: [
                { metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '42', status: 'ERROR' },
                { metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0', status: 'OK' }
            ]
        })
    };
    const provider = new MeasuresProvider(client, stateWith());
    const nodes = await provider.getChildren();
    const gate = nodes.find(node => node.kind === 'measure' && node.spec.key === 'alert_status');
    assert.match(provider.getTreeItem(gate).description, /Failed · 1 condition/);

    const children = await provider.getChildren(gate);
    assert.equal(children.length, 1, 'only the condition that failed');
    assert.match(provider.getTreeItem(children[0]).label, /Coverage on New Code is 42\.0%, required ≥ 80\.0%/);
});

test('a passing gate does not ask why it passed', async () => {
    let asked = false;
    const client = {
        getMeasures: async () => new Map([['alert_status', 'OK']]),
        getQualityGateStatus: async () => {
            asked = true;
            return { status: 'OK', conditions: [] };
        }
    };
    const nodes = await new MeasuresProvider(client, stateWith()).getChildren();
    assert.equal(asked, false, 'a request per refresh for nothing anyone will read');
    const gate = nodes.find(node => node.spec.key === 'alert_status');
    assert.deepEqual(gate.failures, []);
    assert.equal(new MeasuresProvider(client, stateWith()).getTreeItem(gate).collapsibleState, 0, 'nothing to expand');
});

test('measures still load when the gate detail call fails', async () => {
    const client = {
        getMeasures: async () => new Map([['alert_status', 'ERROR'], ['coverage', '10']]),
        getQualityGateStatus: async () => {
            throw new Error('403');
        }
    };
    const provider = new MeasuresProvider(client, stateWith());
    const nodes = await provider.getChildren();
    const gate = nodes.find(node => node.spec.key === 'alert_status');
    assert.equal(provider.getTreeItem(gate).description, 'Failed', 'the headline is still worth having');
    assert.deepEqual(await provider.getChildren(gate), []);
});

test('the measures view asks for the selected branch', async () => {
    let seen;
    const client = {
        getMeasures: async (key, branch) => {
            seen = { key, branch };
            return new Map();
        }
    };
    await new MeasuresProvider(client, stateWith({ branch: 'feature/x' })).getChildren();
    assert.deepEqual(seen, { key: 'proj', branch: 'feature/x' });
});

// ------------------------------------------------------------- projects ----

test('projects are cached, and only an explicit refresh refetches', async () => {
    let calls = 0;
    const client = {
        listProjects: async () => {
            calls++;
            return { projects: [{ key: 'a', name: 'A' }], total: 1 };
        }
    };
    const provider = new ProjectsProvider(client, { project: undefined }, async () => true);

    await provider.getChildren();
    await provider.getChildren();
    assert.equal(calls, 1, 'redrawing the tree must not hit the network');

    provider.refresh();
    await provider.getChildren();
    assert.equal(calls, 2);
});

test('an unconfigured extension lists nothing without calling the API', async () => {
    let called = false;
    const client = {
        listProjects: async () => {
            called = true;
            return { projects: [], total: 0 };
        }
    };
    const provider = new ProjectsProvider(client, { project: undefined }, async () => false);
    assert.deepEqual(await provider.getChildren(), []);
    assert.equal(called, false);
});

test('a truncated project list warns once, not on every redraw', async () => {
    const client = { listProjects: async () => ({ projects: [{ key: 'a', name: 'A' }], total: 5000 }) };
    const provider = new ProjectsProvider(client, { project: undefined }, async () => true);
    await provider.getChildren();
    provider.refresh();
    await provider.getChildren();
    const warnings = vscode.__harness.shownMessages.filter(m => m.level === 'warning');
    assert.equal(warnings.length, 1, 'repeating the warning would be nagging');
    assert.match(warnings[0].message, /5000 projects/);
});

test('the selected project is marked in the tree', async () => {
    const client = { listProjects: async () => ({ projects: [{ key: 'a', name: 'A' }], total: 1 }) };
    const provider = new ProjectsProvider(client, { project: { key: 'a', name: 'A' } }, async () => true);
    const [item] = await provider.getChildren();
    const rendered = provider.getTreeItem(item);
    assert.equal(rendered.iconPath.id, 'pass-filled');
    assert.match(rendered.tooltip, /selected/);
});

// ---------------------------------------------------------- diagnostics ----

function issueAt(path, line, severity) {
    return {
        issue: {
            key: `k-${line}`,
            rule: 'ts:S1',
            severity,
            component: `proj:${path}`,
            project: 'proj',
            line,
            message: `problem at ${line}`,
            type: 'CODE_SMELL',
            status: 'OPEN'
        },
        path
    };
}

const diagClient = { issueUrl: () => 'https://sonarcloud.io/x' };

/** The publisher creates its own collection; the stub records it. */
function publishedDiagnostics() {
    const collection = vscode.__harness.diagnosticCollections.find(c => c.name === 'sonarcloud');
    return collection ? collection.entries : new Map();
}

test('diagnostics are published only for files that exist in the workspace', async () => {
    const folder = makeWorkspace({ 'src/a.ts': 'const a = 1;\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([issueAt('src/a.ts', 1, 'MAJOR'), issueAt('src/gone.ts', 2, 'MAJOR')]);
        const entries = publishedDiagnostics();
        assert.equal(entries.size, 1, 'a file outside the workspace has nowhere to show a squiggle');
        const [[file, diags]] = [...entries];
        assert.ok(file.endsWith('src/a.ts'));
        assert.equal(diags.length, 1);
        assert.equal(diags[0].message, 'problem at 1');
        assert.equal(diags[0].source, 'sonarcloud');
        assert.equal(diags[0].range.start.line, 0, 'SonarCloud lines are 1-based, VS Code lines are 0-based');
        assert.ok(folder);
    } finally {
        diagnostics.dispose();
    }
});

test('severity maps onto the buckets that decide squiggle colour', async () => {
    makeWorkspace({ 'src/a.ts': 'x\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([
            issueAt('src/a.ts', 1, 'BLOCKER'),
            issueAt('src/a.ts', 2, 'CRITICAL'),
            issueAt('src/a.ts', 3, 'MAJOR'),
            issueAt('src/a.ts', 4, 'MINOR'),
            issueAt('src/a.ts', 5, 'INFO'),
            issueAt('src/a.ts', 6, 'SOME_FUTURE_SEVERITY')
        ]);
        const [diags] = [...publishedDiagnostics().values()];
        const { Error: E, Warning: W, Information: I, Hint: H } = vscode.DiagnosticSeverity;
        assert.deepEqual(diags.map(d => d.severity), [E, E, W, I, H, W], 'an unknown severity defaults to Warning');
    } finally {
        diagnostics.dispose();
    }
});

test('multiple issues in one file are published together', async () => {
    makeWorkspace({ 'src/a.ts': 'x\ny\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([issueAt('src/a.ts', 1, 'MAJOR'), issueAt('src/a.ts', 2, 'MINOR')]);
        const [diags] = [...publishedDiagnostics().values()];
        assert.equal(diags.length, 2);
    } finally {
        diagnostics.dispose();
    }
});

test('clearing removes every published diagnostic', async () => {
    makeWorkspace({ 'src/a.ts': 'x\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([issueAt('src/a.ts', 1, 'MAJOR')]);
        assert.equal(publishedDiagnostics().size, 1);
        diagnostics.clear();
        assert.equal(publishedDiagnostics().size, 0);
    } finally {
        diagnostics.dispose();
    }
});

test('diagnostics respect the showDiagnostics setting', async () => {
    makeWorkspace({ 'src/a.ts': 'x\n' });
    vscode.__harness.configuration.set('sonarcloud.showDiagnostics', false);
    assert.equal(SonarDiagnostics.enabled, false);
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([issueAt('src/a.ts', 1, 'MAJOR')]);
        assert.equal(publishedDiagnostics().size, 0, 'the setting must actually suppress publishing');
    } finally {
        diagnostics.dispose();
    }
});

test('project-level issues without a path are skipped rather than crashing', async () => {
    makeWorkspace({ 'src/a.ts': 'x\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        await diagnostics.publish([{ issue: issueAt('src/a.ts', 1, 'MAJOR').issue, path: undefined }]);
        assert.equal(publishedDiagnostics().size, 0);
    } finally {
        diagnostics.dispose();
    }
});

test('a superseded publish does not overwrite a newer one', async () => {
    makeWorkspace({ 'src/a.ts': 'x\n' });
    const diagnostics = new SonarDiagnostics(diagClient, { branch: undefined });
    try {
        const slow = diagnostics.publish([issueAt('src/a.ts', 1, 'MAJOR')]);
        diagnostics.clear();
        await slow;
        assert.equal(publishedDiagnostics().size, 0, 'a stale result must not repopulate the panel');
    } finally {
        diagnostics.dispose();
    }
});
