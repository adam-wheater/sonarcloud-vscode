'use strict';

/**
 * Minimal stand-in for the "vscode" module so the extension's logic modules can
 * be exercised under plain Node. Only the surface the tested code touches is
 * implemented; anything else is left undefined deliberately, so a test that
 * wanders into untested territory fails loudly instead of silently passing.
 */

const path = require('path');

class Uri {
    constructor(fsPath) {
        this.fsPath = fsPath;
        this.scheme = 'file';
        this.path = fsPath.replace(/\\/g, '/');
    }
    static file(fsPath) {
        return new Uri(fsPath);
    }
    static parse(value) {
        return new Uri(value);
    }
    static joinPath(base, ...segments) {
        return new Uri(path.join(base.fsPath, ...segments));
    }
    toString() {
        return this.path;
    }
}

class RelativePattern {
    constructor(base, pattern) {
        this.baseUri = base && base.uri ? base.uri : base;
        this.pattern = pattern;
    }
}

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = listener => {
            this.listeners.push(listener);
            return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
        };
    }
    fire(value) {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }
    dispose() {
        this.listeners = [];
    }
}

class CancellationTokenSource {
    constructor() {
        this._listeners = [];
        this.token = {
            isCancellationRequested: false,
            onCancellationRequested: listener => {
                this._listeners.push(listener);
                return { dispose: () => {} };
            }
        };
    }
    cancel() {
        this.token.isCancellationRequested = true;
        for (const listener of this._listeners) {
            listener();
        }
    }
    dispose() {}
}

class ThemeIcon {
    constructor(id, color) {
        this.id = id;
        this.color = color;
    }
}

class ThemeColor {
    constructor(id) {
        this.id = id;
    }
}

class MarkdownString {
    constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
    }
    appendMarkdown(value) {
        this.value += value;
        return this;
    }
}

class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
}

class CodeAction {
    constructor(title, kind) {
        this.title = title;
        this.kind = kind;
    }
}

class CancellationError extends Error {
    constructor() {
        super('Canceled');
        this.name = 'Canceled';
    }
}

// ------------------------------------------------------- coverage API ------

class TestCoverageCount {
    constructor(covered, total) {
        this.covered = covered;
        this.total = total;
    }
}

class FileCoverage {
    constructor(uri, statementCoverage, branchCoverage, declarationCoverage) {
        this.uri = uri;
        this.statementCoverage = statementCoverage;
        this.branchCoverage = branchCoverage;
        this.declarationCoverage = declarationCoverage;
    }
}

class StatementCoverage {
    constructor(executed, location, branches) {
        this.executed = executed;
        this.location = location;
        this.branches = branches;
    }
}

class TestRunRequest {
    constructor(include, exclude, profile) {
        this.include = include;
        this.exclude = exclude;
        this.profile = profile;
    }
}

/** Mirrors TestItemCollection: iterating yields [id, item] pairs. */
class TestItemCollection {
    constructor() {
        this.map = new Map();
    }
    get size() {
        return this.map.size;
    }
    add(item) {
        this.map.set(item.id, item);
    }
    get(id) {
        return this.map.get(id);
    }
    delete(id) {
        this.map.delete(id);
    }
    replace(items) {
        this.map = new Map(items.map(item => [item.id, item]));
    }
    forEach(callback) {
        for (const item of this.map.values()) {
            callback(item, this);
        }
    }
    [Symbol.iterator]() {
        return this.map.entries();
    }
}

function createTestController(id, label) {
    const controller = {
        id,
        label,
        items: new TestItemCollection(),
        profiles: [],
        runs: [],
        disposed: false,
        createTestItem: (itemId, itemLabel, uri) => ({ id: itemId, label: itemLabel, uri, children: new TestItemCollection() }),
        createRunProfile(profileLabel, kind, runHandler, isDefault) {
            const profile = {
                label: profileLabel,
                kind,
                runHandler,
                isDefault,
                loadDetailedCoverage: undefined,
                disposed: false,
                dispose() {
                    this.disposed = true;
                }
            };
            controller.profiles.push(profile);
            return profile;
        },
        createTestRun(request, name, persist) {
            const run = {
                request,
                name,
                persist,
                coverage: [],
                ended: false,
                addCoverage: fileCoverage => run.coverage.push(fileCoverage),
                end: () => (run.ended = true)
            };
            controller.runs.push(run);
            return run;
        },
        dispose() {
            controller.disposed = true;
        }
    };
    harness.testControllers.push(controller);
    return controller;
}

/** Mutable state the tests drive; reset() puts it back to a clean slate. */
const harness = {
    configuration: new Map(),
    /** Values a test declares as "explicitly set by the user" for inspect(). */
    explicitConfiguration: new Set(),
    workspaceFolders: [],
    /**
     * null → findFiles globs the real fixture directory (the realistic path).
     * An array or function overrides that for tests that need exact control.
     */
    findFilesResult: null,
    /** Every findFiles call, so tests can assert on how the API was used. */
    findFilesCalls: [],
    /** Diagnostic collections created, so publishing can be inspected. */
    diagnosticCollections: [],
    shownMessages: [],
    /** The editor tests want the extension to consider active. */
    activeTextEditor: undefined,
    visibleTextEditors: [],
    /** Listeners registered for editor/document events, so tests can fire them. */
    editorListeners: { activeChanged: [], visibleChanged: [], documentChanged: [] },
    /** Config-change and workspace-folder listeners, so tests can fire them. */
    configurationListeners: [],
    workspaceFolderListeners: [],
    /** Output channels created, so tests can read what a run logged. */
    outputChannels: [],
    /** Webview panels created, so tests can assert one was *not* opened. */
    webviewPanels: [],
    /** Progress notifications started. */
    progressRuns: [],
    /** Settings written through update(), with the scope they were written to. */
    configurationUpdates: [],
    /** Test controllers created, so native coverage can be inspected. */
    testControllers: [],
    /** File system watchers created, so watch tests can fire events. */
    fileSystemWatchers: [],
    quickPickResponder: undefined,
    inputBoxResponder: undefined
};

/** Fire a configuration change for the given section prefix. */
function fireConfigurationChange(section) {
    const event = { affectsConfiguration: key => section === undefined || section.startsWith(key) || key.startsWith(section) };
    for (const listener of [...harness.configurationListeners]) {
        listener(event);
    }
}

function reset() {
    harness.configuration = new Map();
    harness.explicitConfiguration = new Set();
    harness.workspaceFolders = [];
    harness.findFilesResult = null;
    harness.findFilesCalls = [];
    harness.diagnosticCollections = [];
    harness.shownMessages = [];
    harness.activeTextEditor = undefined;
    harness.visibleTextEditors = [];
    harness.editorListeners = { activeChanged: [], visibleChanged: [], documentChanged: [] };
    harness.configurationListeners = [];
    harness.workspaceFolderListeners = [];
    harness.outputChannels = [];
    harness.webviewPanels = [];
    harness.progressRuns = [];
    harness.configurationUpdates = [];
    harness.testControllers = [];
    harness.fileSystemWatchers = [];
    harness.quickPickResponder = undefined;
    harness.inputBoxResponder = undefined;
}

/**
 * Convert the glob subset VS Code patterns use — `**`, `*`, `?`, `{a,b}` — into
 * a RegExp, so findFiles behaves like the real thing against fixture trees.
 */
function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*') {
            if (glob[i + 1] === '*') {
                // "**/" may match nothing at all; bare "**" matches anything.
                if (glob[i + 2] === '/') {
                    out += '(?:.*/)?';
                    i += 2;
                } else {
                    out += '.*';
                    i += 1;
                }
            } else {
                out += '[^/]*';
            }
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '{') {
            const end = glob.indexOf('}', i);
            const alternatives = glob.slice(i + 1, end).split(',');
            out += `(?:${alternatives.map(a => globToRegExp(a).source.slice(1, -1)).join('|')})`;
            i = end;
        } else if (char === '[') {
            // Character classes pass through — the default test-project glob
            // ("**/*[Tt]ests.csproj") relies on them.
            const end = glob.indexOf(']', i);
            if (end === -1) {
                out += '\\[';
            } else {
                out += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
                i = end;
            }
        } else {
            out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

function walk(root, current = '', collected = []) {
    let entries;
    try {
        entries = require('fs').readdirSync(path.join(root, current), { withFileTypes: true });
    } catch {
        return collected;
    }
    for (const entry of entries) {
        const relative = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walk(root, relative, collected);
        } else {
            collected.push(relative);
        }
    }
    return collected;
}

function getConfiguration(section) {
    const fullKey = key => (section ? `${section}.${key}` : key);
    return {
        get(key, fallback) {
            const value = harness.configuration.get(fullKey(key));
            return value === undefined ? fallback : value;
        },
        inspect(key) {
            const name = fullKey(key);
            return harness.explicitConfiguration.has(name)
                ? { globalValue: harness.configuration.get(name) }
                : {};
        },
        async update(key, value, target) {
            harness.configuration.set(fullKey(key), value);
            harness.configurationUpdates.push({ key: fullKey(key), value, target });
        }
    };
}

/**
 * NOTE: `import * as vscode` compiles to __importStar, which takes a SHALLOW
 * COPY of this object at import time. Nested state (workspace, window, …) is
 * shared by reference and can be mutated later, but a top-level property added
 * after a module was required will never be seen by it. Everything the code
 * touches must therefore exist here from the start — hence the lm shims below,
 * which tests customise by replacing lm.registerTool rather than lm itself.
 */
const vscode = {
    lm: {
        registerTool: () => ({ dispose: () => {} })
    },
    LanguageModelTextPart: class {
        constructor(value) {
            this.value = value;
        }
    },
    LanguageModelToolResult: class {
        constructor(content) {
            this.content = content;
        }
    },
    Uri,
    RelativePattern,
    EventEmitter,
    CancellationTokenSource,
    CancellationError,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItem,
    Position,
    Range,
    Diagnostic,
    TestCoverageCount,
    FileCoverage,
    StatementCoverage,
    TestRunRequest,
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    tests: { createTestController },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    CodeAction,
    CodeActionKind: { QuickFix: { value: 'quickfix' }, Refactor: { value: 'refactor' } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        get workspaceFolders() {
            return harness.workspaceFolders;
        },
        getConfiguration,
        async findFiles(pattern, exclude, maxResults) {
            harness.findFilesCalls.push({
                pattern: pattern && pattern.pattern ? pattern.pattern : String(pattern),
                exclude: exclude && exclude.pattern ? exclude.pattern : exclude,
                maxResults
            });
            let result;
            if (typeof harness.findFilesResult === 'function') {
                result = await harness.findFilesResult(pattern, exclude, maxResults);
            } else if (Array.isArray(harness.findFilesResult)) {
                result = harness.findFilesResult;
            } else {
                // Glob the fixture tree the way the real API does.
                const base =
                    pattern && pattern.baseUri
                        ? pattern.baseUri.fsPath
                        : harness.workspaceFolders[0] && harness.workspaceFolders[0].uri.fsPath;
                const glob = pattern && pattern.pattern ? pattern.pattern : String(pattern);
                if (!base) {
                    return [];
                }
                const matcher = globToRegExp(glob);
                const excluder = exclude ? globToRegExp(typeof exclude === 'string' ? exclude : exclude.pattern) : undefined;
                result = walk(base)
                    .filter(relative => matcher.test(relative) && !(excluder && excluder.test(relative)))
                    .sort()
                    .map(relative => ({ fsPath: path.join(base, relative) }));
            }
            return maxResults ? result.slice(0, maxResults) : result;
        },
        fs: {
            /** Mirrors vscode.workspace.fs.stat: rejects when the file is absent. */
            async stat(uri) {
                const stats = require('fs').statSync(uri.fsPath);
                return {
                    type: stats.isDirectory() ? 2 : 1,
                    size: stats.size,
                    ctime: stats.ctimeMs,
                    mtime: stats.mtimeMs
                };
            },
            async readFile(uri) {
                return require('fs').readFileSync(uri.fsPath);
            }
        },
        onDidChangeTextDocument(listener) {
            harness.editorListeners.documentChanged.push(listener);
            return { dispose: () => {} };
        },
        onDidChangeConfiguration(listener) {
            harness.configurationListeners.push(listener);
            return { dispose: () => (harness.configurationListeners = harness.configurationListeners.filter(l => l !== listener)) };
        },
        onDidChangeWorkspaceFolders(listener) {
            harness.workspaceFolderListeners.push(listener);
            return { dispose: () => (harness.workspaceFolderListeners = harness.workspaceFolderListeners.filter(l => l !== listener)) };
        },
        createFileSystemWatcher(pattern, ignoreCreate, ignoreChange, ignoreDelete) {
            const watcher = {
                pattern: pattern && pattern.pattern ? pattern.pattern : String(pattern),
                base: pattern && pattern.baseUri ? pattern.baseUri.fsPath : undefined,
                ignoreCreate,
                ignoreChange,
                ignoreDelete,
                disposed: false,
                listeners: { change: [], create: [], delete: [] },
                onDidChange: listener => (watcher.listeners.change.push(listener), { dispose: () => {} }),
                onDidCreate: listener => (watcher.listeners.create.push(listener), { dispose: () => {} }),
                onDidDelete: listener => (watcher.listeners.delete.push(listener), { dispose: () => {} }),
                /** Test helper: pretend the watched file changed. */
                fire: (kind = 'change') => {
                    for (const listener of watcher.listeners[kind]) {
                        listener(new Uri(watcher.base || ''));
                    }
                },
                dispose: () => (watcher.disposed = true)
            };
            harness.fileSystemWatchers.push(watcher);
            return watcher;
        },
        asRelativePath(target, includeFolder) {
            const fsPath = typeof target === 'string' ? target : target.fsPath;
            const folder = harness.workspaceFolders[0];
            if (!folder) {
                return fsPath;
            }
            const relative = path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
            return includeFolder ? `${folder.name}/${relative}` : relative;
        }
    },
    window: {
        get activeTextEditor() {
            return harness.activeTextEditor;
        },
        get visibleTextEditors() {
            return harness.visibleTextEditors;
        },
        onDidChangeActiveTextEditor(listener) {
            harness.editorListeners.activeChanged.push(listener);
            return { dispose: () => {} };
        },
        onDidChangeVisibleTextEditors(listener) {
            harness.editorListeners.visibleChanged.push(listener);
            return { dispose: () => {} };
        },
        createTextEditorDecorationType(options) {
            return { options, dispose: () => {} };
        },
        showInformationMessage(message, ...rest) {
            harness.shownMessages.push({ level: 'info', message });
            return Promise.resolve(undefined);
        },
        showWarningMessage(message, ...rest) {
            harness.shownMessages.push({ level: 'warning', message });
            return Promise.resolve(undefined);
        },
        showErrorMessage(message, ...rest) {
            harness.shownMessages.push({ level: 'error', message });
            return Promise.resolve(undefined);
        },
        showQuickPick(items, options) {
            const resolved = Array.isArray(items) ? items : [];
            return Promise.resolve(
                harness.quickPickResponder ? harness.quickPickResponder(resolved, options) : undefined
            );
        },
        showInputBox(options) {
            return Promise.resolve(harness.inputBoxResponder ? harness.inputBoxResponder(options) : undefined);
        },
        createOutputChannel(name) {
            const lines = [];
            const channel = {
                name,
                lines,
                append: text => lines.push(text),
                appendLine: text => lines.push(text + '\n'),
                clear: () => (lines.length = 0),
                shown: 0,
                show: () => channel.shown++,
                dispose: () => {}
            };
            harness.outputChannels.push(channel);
            return channel;
        },
        createWebviewPanel(viewType, title, viewColumn, options) {
            const panel = {
                viewType,
                title,
                viewColumn,
                options,
                reveals: 0,
                disposed: false,
                messageListeners: [],
                disposeListeners: [],
                webview: {
                    html: '',
                    cspSource: 'vscode-webview:',
                    asWebviewUri: uri => uri,
                    postMessage: async () => true,
                    onDidReceiveMessage(listener) {
                        panel.messageListeners.push(listener);
                        return { dispose: () => {} };
                    }
                },
                reveal: () => panel.reveals++,
                onDidDispose(listener) {
                    panel.disposeListeners.push(listener);
                    return { dispose: () => {} };
                },
                dispose() {
                    panel.disposed = true;
                    for (const listener of panel.disposeListeners) {
                        listener();
                    }
                }
            };
            harness.webviewPanels.push(panel);
            return panel;
        },
        withProgress(options, task) {
            harness.progressRuns.push(options);
            const source = new CancellationTokenSource();
            return Promise.resolve(task({ report: () => {} }, source.token));
        },
        showWorkspaceFolderPick: async () => harness.workspaceFolders[0]
    },
    commands: {
        executeCommand: () => Promise.resolve(undefined),
        registerCommand: () => ({ dispose: () => {} })
    },
    languages: {
        registerCodeActionsProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: name => {
            const entries = new Map();
            const collection = {
                name,
                entries,
                set: (uri, diagnostics) => entries.set(uri.fsPath, diagnostics),
                clear: () => entries.clear(),
                dispose: () => {}
            };
            // Recorded so tests can assert on what was actually published.
            harness.diagnosticCollections.push(collection);
            return collection;
        }
    },
    __harness: harness,
    __reset: reset,
    __fireConfigurationChange: fireConfigurationChange
};

module.exports = vscode;
