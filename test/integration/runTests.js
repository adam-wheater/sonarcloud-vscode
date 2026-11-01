'use strict';

/**
 * Launches a real VS Code, installs this extension into it and runs the suite
 * in test/integration/suite. This is the only layer that can prove the things
 * the stub cannot: that the extension actually activates, that its commands
 * and views are registered with the host, and that webviews and editor
 * decorations are accepted by the real API.
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
    const workspace = path.resolve(__dirname, 'fixture');

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                workspace,
                '--disable-extensions', // only ours, so nothing else colours the results
                '--disable-gpu',
                '--no-sandbox',
                '--disable-workspace-trust'
            ]
        });
    } catch (err) {
        console.error('Integration tests failed:', err && err.message ? err.message : err);
        process.exit(1);
    }
}

void main();
