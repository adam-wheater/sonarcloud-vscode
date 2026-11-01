'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { load, makeWorkspace, cleanup, vscode } = require('./harness');

const { getChangedLines, resolveBaseRef } = load('gitChanges');

function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** A real repository with a base branch and a feature branch on top of it. */
function makeRepo(files = {}) {
    const folder = makeWorkspace(files);
    const root = folder.uri.fsPath;
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'base']);
    return { folder, root };
}

test.afterEach(() => cleanup());

test('changed lines come from the merge base, not the branch tip', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'l1\nl2\nl3\n' });
    git(root, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nCHANGED\nl3\nADDED\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'feature work']);

    // Main moves on after the branch point; those lines must not be attributed
    // to the feature branch.
    git(root, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(root, 'b.txt'), 'unrelated\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'main moves on']);
    git(root, ['checkout', '-q', 'feature']);

    const changes = await getChangedLines(folder, 'main');
    assert.ok(changes);
    assert.deepEqual([...changes.byFile.keys()], ['a.txt']);
    assert.deepEqual([...changes.byFile.get('a.txt')].sort((x, y) => x - y), [2, 4]);
    assert.equal(changes.totalChangedLines, 2);
});

test('uncommitted work counts — it is part of what a merge would bring', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'l1\nl2\n' });
    git(root, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nl2\nl3-uncommitted\n');

    const changes = await getChangedLines(folder, 'main');
    assert.ok(changes);
    assert.deepEqual([...changes.byFile.get('a.txt')], [3]);
});

test('deleted files are excluded from changed lines', async () => {
    const { folder, root } = makeRepo({ 'gone.txt': 'x\n', 'kept.txt': 'y\n' });
    git(root, ['checkout', '-qb', 'feature']);
    fs.rmSync(path.join(root, 'gone.txt'));
    fs.writeFileSync(path.join(root, 'kept.txt'), 'y\nz\n');

    const changes = await getChangedLines(folder, 'main');
    assert.ok(changes);
    assert.deepEqual([...changes.byFile.keys()], ['kept.txt']);
});

test('single-line hunks (no count in the header) are captured', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'l1\nl2\nl3\n' });
    git(root, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nONLY-THIS\nl3\n');

    const changes = await getChangedLines(folder, 'main');
    assert.deepEqual([...changes.byFile.get('a.txt')], [2]);
});

test('paths with spaces (which git quotes) are unquoted', async () => {
    const { folder, root } = makeRepo({ 'dir name/file name.txt': 'l1\n' });
    git(root, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(root, 'dir name/file name.txt'), 'l1\nl2\n');

    const changes = await getChangedLines(folder, 'main');
    assert.deepEqual([...changes.byFile.keys()], ['dir name/file name.txt']);
});

test('a branch identical to its base reports no changes', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'l1\n' });
    git(root, ['checkout', '-qb', 'feature']);

    const changes = await getChangedLines(folder, 'main');
    assert.ok(changes);
    assert.equal(changes.byFile.size, 0);
    assert.equal(changes.totalChangedLines, 0);
});

test('resolveBaseRef rejects a configured ref that does not exist', async () => {
    const { folder } = makeRepo({ 'a.txt': 'x\n' });
    assert.equal(await resolveBaseRef(folder, 'origin/nope'), undefined);
});

test('resolveBaseRef honours an existing configured ref', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'x\n' });
    git(root, ['branch', 'release']);
    assert.equal(await resolveBaseRef(folder, 'release'), 'release');
});

test('resolveBaseRef falls back to a local main when no remote exists', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'x\n' });
    git(root, ['checkout', '-qb', 'feature']);
    assert.equal(await resolveBaseRef(folder, undefined), 'main');
});

test('resolveBaseRef does not pick the branch it is already on', async () => {
    const { folder, root } = makeRepo({ 'a.txt': 'x\n' });
    // On main itself, "main" is a useless base: it would report zero changes.
    const resolved = await resolveBaseRef(folder, undefined);
    assert.notEqual(resolved, undefined);
    const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    assert.equal(head, 'main');
});

test('a non-git directory yields no diff rather than throwing', async () => {
    const folder = makeWorkspace({ 'a.txt': 'x\n' });
    assert.equal(await resolveBaseRef(folder, undefined), undefined);
    assert.equal(await getChangedLines(folder, 'main'), undefined);
});

test('vscode stub is reset between tests', () => {
    assert.deepEqual(vscode.__harness.shownMessages, []);
});

test('added content that looks like a diff header is not read as one', async () => {
    // Adding a line beginning with "++ " produces a "+++ " line in the diff.
    // Read as a file header, it switches the parser to a file that does not
    // exist — and every later hunk of the real file is credited to that ghost,
    // so those changed lines silently vanish from the coverage gate.
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const { folder, root } = makeRepo({ 'notes.md': base });
    git(root, ['checkout', '-qb', 'feature']);

    const edited = base.split('\n');
    edited[1] = '++ a nested bullet'; // line 2, the trap
    edited[17] = 'a real change'; // line 18, in a later hunk
    fs.writeFileSync(path.join(root, 'notes.md'), edited.join('\n'));
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'tricky content']);

    const changes = await getChangedLines(folder, 'main');
    assert.ok(changes);
    assert.deepEqual([...changes.byFile.keys()], ['notes.md'], 'no ghost file invented from file content');
    assert.deepEqual(
        [...changes.byFile.get('notes.md')].sort((a, b) => a - b),
        [2, 18],
        'the hunk after the trap still belongs to the file it is in'
    );
});
