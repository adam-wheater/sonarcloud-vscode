'use strict';

/**
 * Test bootstrap: routes `require('vscode')` to the stub, exposes helpers for
 * building fixture workspaces on disk, and re-exports the compiled modules
 * under test from out/.
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vscodeStub = require('./vscodeStub');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return originalLoad(request, parent, isMain);
};

const OUT_DIR = path.join(__dirname, '..', 'out');

if (!fs.existsSync(OUT_DIR)) {
    throw new Error('out/ is missing — run "npm run compile" before the tests.');
}

/** Require a compiled module by its src-relative name, e.g. "coverage". */
function load(moduleName) {
    return require(path.join(OUT_DIR, `${moduleName}.js`));
}

const tempRoots = [];

/**
 * Create a throwaway directory tree and register it as the single workspace
 * folder. `files` maps relative paths to contents.
 */
function makeWorkspace(files = {}, name = 'fixture') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonarcloud-test-'));
    tempRoots.push(root);
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    const folder = { uri: vscodeStub.Uri.file(root), name, index: 0 };
    vscodeStub.__harness.workspaceFolders = [folder];
    return folder;
}

/** Point the stubbed findFiles at real files inside a fixture workspace. */
function indexWorkspace(folder, relativePaths) {
    vscodeStub.__harness.findFilesResult = relativePaths.map(relative => ({
        fsPath: path.join(folder.uri.fsPath, relative)
    }));
}

function cleanup() {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    vscodeStub.__reset();
}

/** Set a configuration value; `explicit` marks it as user-set for inspect(). */
function setConfig(key, value, explicit = true) {
    vscodeStub.__harness.configuration.set(key, value);
    if (explicit) {
        vscodeStub.__harness.explicitConfiguration.add(key);
    }
}

module.exports = { load, makeWorkspace, indexWorkspace, cleanup, setConfig, vscode: vscodeStub };
