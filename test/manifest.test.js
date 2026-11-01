'use strict';

/**
 * The manifest and the code have to agree: a command registered but not
 * declared never appears, and a command declared but not registered throws
 * when invoked. Neither shows up at compile time, so check it here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

const declared = packageJson.contributes.commands.map(command => command.command);
const registered = [...SOURCE.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(match => match[1]);

test('every declared command is registered in the extension', () => {
    const missing = declared.filter(command => !registered.includes(command));
    assert.deepEqual(missing, [], 'declared but never registered — invoking these throws');
});

test('every registered command is declared in the manifest', () => {
    const missing = registered.filter(command => !declared.includes(command));
    assert.deepEqual(missing, [], 'registered but not declared — these are invisible to users');
});

test('commands are uniquely declared', () => {
    assert.equal(new Set(declared).size, declared.length);
});

test('every command carries a title and the SonarCloud category', () => {
    for (const command of packageJson.contributes.commands) {
        assert.ok(command.title, `${command.command} needs a title`);
        assert.equal(command.category, 'SonarCloud', `${command.command} should be grouped under SonarCloud`);
    }
});

test('menu entries only reference declared commands', () => {
    for (const [menu, entries] of Object.entries(packageJson.contributes.menus)) {
        for (const entry of entries) {
            assert.ok(declared.includes(entry.command), `${menu} references unknown command ${entry.command}`);
        }
    }
});

test('activation events only reference declared commands', () => {
    for (const event of packageJson.activationEvents) {
        if (event.startsWith('onCommand:')) {
            const command = event.slice('onCommand:'.length);
            assert.ok(declared.includes(command), `activation event for unknown command ${command}`);
        }
    }
});

test('activation events only reference declared views', () => {
    const views = Object.values(packageJson.contributes.views)
        .flat()
        .map(view => view.id);
    for (const event of packageJson.activationEvents) {
        if (event.startsWith('onView:')) {
            const view = event.slice('onView:'.length);
            assert.ok(views.includes(view), `activation event for unknown view ${view}`);
        }
    }
});

test('commands invoked internally by tree items exist', () => {
    // Tree items wire commands by string; a typo silently does nothing on click.
    const sources = fs
        .readdirSync(path.join(__dirname, '..', 'src'))
        .filter(file => file.endsWith('.ts'))
        .map(file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'))
        .join('\n');
    const invoked = [...sources.matchAll(/command:\s*'(sonarcloud\.[^']+)'/g)].map(match => match[1]);
    for (const command of new Set(invoked)) {
        assert.ok(declared.includes(command), `${command} is used but not declared`);
    }
});

test('every configuration property is namespaced and documented', () => {
    for (const [key, schema] of Object.entries(packageJson.contributes.configuration.properties)) {
        assert.ok(key.startsWith('sonarcloud.'), `${key} is outside the extension namespace`);
        assert.ok(
            schema.description || schema.markdownDescription,
            `${key} needs a description so it is usable from the settings UI`
        );
        assert.ok('default' in schema, `${key} needs an explicit default`);
    }
});

test('settings read in code are declared in the manifest', () => {
    const sources = fs
        .readdirSync(path.join(__dirname, '..', 'src'))
        .filter(file => file.endsWith('.ts'))
        .map(file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'))
        .join('\n');
    const declaredSettings = Object.keys(packageJson.contributes.configuration.properties);
    // Matches get<T>('some.key' ...) / inspect('some.key') on the sonarcloud config.
    const read = [...sources.matchAll(/(?:get|inspect)(?:<[^>]+>)?\(\s*'([a-z][\w.]*\.[\w.]+)'/gi)]
        .map(match => match[1])
        .filter(key => !key.startsWith('sonar.') && key !== 'dotnet.defaultSolution');
    for (const key of new Set(read)) {
        assert.ok(
            declaredSettings.includes(`sonarcloud.${key}`) || declaredSettings.includes(key),
            `setting "${key}" is read in code but not declared in package.json`
        );
    }
});

test('the compiled entry point matches the manifest main field', () => {
    assert.equal(packageJson.main, './out/extension.js');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'out', 'extension.js')), 'run npm run compile first');
});

test('the packaged extension declares its runtime dependencies', () => {
    const runtimeImports = fs
        .readdirSync(path.join(__dirname, '..', 'src'))
        .filter(file => file.endsWith('.ts'))
        .flatMap(file => {
            const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
            return [...source.matchAll(/from '([^.'][^']*)'/g)].map(match => match[1]);
        })
        .filter(name => name !== 'vscode' && !name.startsWith('node:'));
    const builtins = new Set(['fs', 'fs/promises', 'path', 'os', 'child_process', 'crypto', 'util', 'zlib']);
    for (const name of new Set(runtimeImports)) {
        if (builtins.has(name)) {
            continue;
        }
        assert.ok(
            packageJson.dependencies && name in packageJson.dependencies,
            `${name} is imported at runtime but is not a dependency`
        );
    }
});
