import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Language profiles for local scans.
 *
 * Every ecosystem produces coverage differently and SonarCloud reads each
 * format through a different analysis property, so a "one size" local scan
 * silently uploads no coverage for anything but the language it was built
 * for. A profile bundles the three things that differ: how to recognise the
 * project, the command that produces a coverage report, and the property that
 * points SonarCloud at that report.
 */

export type ScannerKind = 'dotnet' | 'cli';

export interface CoverageCommand {
    command: string;
    args: string[];
    /** Shown in the progress notification, e.g. "flutter test --coverage". */
    label: string;
}

export interface CoverageSpec {
    /** Analysis property SonarCloud reads the report through. */
    property: string;
    /** Candidate report locations, relative to the scanned folder, in priority order. */
    reportPaths: string[];
    /** Command that produces the report; omitted when it cannot be inferred. */
    command?: CoverageCommand;
    /** What to run by hand when the command is unavailable or declined. */
    hint: string;
}

export interface LanguageProfile {
    id: string;
    label: string;
    /** One-liner shown in the picker. */
    detail: string;
    scanner: ScannerKind;
    /** Globs whose presence means "this project is (partly) this language". */
    markers: string[];
    coverage?: CoverageSpec;
    /** Extra analysis properties (without the -D prefix). */
    extraProperties?: string[];
    /** Shown in the output channel when the profile is used. */
    notes?: string;
}

export interface DetectedProfile {
    profile: LanguageProfile;
    /** Marker file that matched, for the "detected" hint in the picker. */
    evidence?: string;
}

const NODE_EXCLUSIONS = 'sonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/*.min.js';

/**
 * Ordered by detection priority: the first profile whose markers match wins
 * the "recommended" slot in the picker.
 */
export const LANGUAGE_PROFILES: LanguageProfile[] = [
    {
        id: 'dotnet',
        label: '.NET (C# / VB / F#)',
        detail: 'SonarScanner for .NET — builds the solution, runs dotnet test with coverage',
        scanner: 'dotnet',
        markers: ['**/*.sln', '**/*.slnx', '**/*.csproj', '**/*.vbproj', '**/*.fsproj']
    },
    {
        id: 'dart',
        label: 'Flutter / Dart',
        detail: 'flutter test --coverage → coverage/lcov.info',
        scanner: 'cli',
        markers: ['pubspec.yaml'],
        coverage: {
            property: 'sonar.dart.lcov.reportPaths',
            reportPaths: ['coverage/lcov.info'],
            command: { command: 'flutter', args: ['test', '--coverage'], label: 'flutter test --coverage' },
            hint: 'Run "flutter test --coverage" (or "dart run coverage:test_with_coverage" for a pure Dart package) to produce coverage/lcov.info.'
        },
        extraProperties: ['sonar.exclusions=**/*.g.dart,**/*.freezed.dart,**/generated/**,**/build/**']
    },
    {
        id: 'js',
        label: 'JavaScript / TypeScript (incl. React)',
        detail: 'npm test with coverage → coverage/lcov.info',
        scanner: 'cli',
        markers: ['package.json'],
        coverage: {
            property: 'sonar.javascript.lcov.reportPaths',
            reportPaths: ['coverage/lcov.info'],
            hint: 'Run your test command with coverage enabled (e.g. "npm test -- --coverage", jest/vitest "--coverage") so coverage/lcov.info exists.'
        },
        extraProperties: [NODE_EXCLUSIONS]
    },
    {
        id: 'java-maven',
        label: 'Java / Kotlin (Maven)',
        detail: 'mvn verify → JaCoCo XML report',
        scanner: 'cli',
        markers: ['pom.xml'],
        coverage: {
            property: 'sonar.coverage.jacoco.xmlReportPaths',
            reportPaths: ['target/site/jacoco/jacoco.xml'],
            command: { command: 'mvn', args: ['-B', 'verify'], label: 'mvn -B verify' },
            hint: 'Run "mvn verify" with the jacoco-maven-plugin "report" goal bound so target/site/jacoco/jacoco.xml exists.'
        },
        extraProperties: ['sonar.java.binaries=target/classes'],
        notes: 'For Maven projects the "mvn sonar:sonar" goal is the scanner SonarSource recommends; this CLI scan is a convenient stand-in but needs compiled classes in target/classes.'
    },
    {
        id: 'java-gradle',
        label: 'Java / Kotlin (Gradle)',
        detail: 'gradle test jacocoTestReport → JaCoCo XML report',
        scanner: 'cli',
        markers: ['build.gradle', 'build.gradle.kts'],
        coverage: {
            property: 'sonar.coverage.jacoco.xmlReportPaths',
            reportPaths: ['build/reports/jacoco/test/jacocoTestReport.xml'],
            command: { command: 'gradle', args: ['test', 'jacocoTestReport'], label: 'gradle test jacocoTestReport' },
            hint: 'Run "gradle test jacocoTestReport" with the jacoco plugin applied and XML report enabled.'
        },
        extraProperties: ['sonar.java.binaries=build/classes'],
        notes: 'For Gradle projects the SonarQube Gradle plugin is the scanner SonarSource recommends; this CLI scan needs compiled classes in build/classes.'
    },
    {
        id: 'python',
        label: 'Python',
        detail: 'pytest --cov → coverage.xml',
        scanner: 'cli',
        markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
        coverage: {
            property: 'sonar.python.coverage.reportPaths',
            reportPaths: ['coverage.xml'],
            command: {
                command: 'pytest',
                args: ['--cov=.', '--cov-report=xml'],
                label: 'pytest --cov=. --cov-report=xml'
            },
            hint: 'Run "pytest --cov=. --cov-report=xml" (needs pytest-cov) to produce coverage.xml.'
        },
        extraProperties: ['sonar.exclusions=**/.venv/**,**/venv/**,**/__pycache__/**']
    },
    {
        id: 'go',
        label: 'Go',
        detail: 'go test ./... -coverprofile=coverage.out',
        scanner: 'cli',
        markers: ['go.mod'],
        coverage: {
            property: 'sonar.go.coverage.reportPaths',
            reportPaths: ['coverage.out'],
            command: {
                command: 'go',
                args: ['test', './...', '-coverprofile=coverage.out'],
                label: 'go test ./... -coverprofile=coverage.out'
            },
            hint: 'Run "go test ./... -coverprofile=coverage.out" to produce the coverage profile.'
        }
    },
    {
        id: 'php',
        label: 'PHP',
        detail: 'phpunit --coverage-clover → coverage/clover.xml',
        scanner: 'cli',
        markers: ['composer.json'],
        coverage: {
            property: 'sonar.php.coverage.reportPaths',
            reportPaths: ['coverage/clover.xml', 'build/logs/clover.xml'],
            hint: 'Run "vendor/bin/phpunit --coverage-clover coverage/clover.xml" (needs Xdebug or PCOV) to produce the report.'
        },
        extraProperties: ['sonar.exclusions=**/vendor/**']
    },
    {
        id: 'ruby',
        label: 'Ruby',
        detail: 'SimpleCov → coverage/.resultset.json',
        scanner: 'cli',
        markers: ['Gemfile', '*.gemspec'],
        coverage: {
            property: 'sonar.ruby.coverage.reportPaths',
            reportPaths: ['coverage/.resultset.json'],
            hint: 'Run your test suite with SimpleCov enabled so coverage/.resultset.json exists.'
        }
    },
    {
        id: 'other',
        label: 'Other / no coverage',
        detail: 'Scan the sources only — no coverage report is produced or uploaded',
        scanner: 'cli',
        markers: []
    }
];

export function findProfile(id: string | undefined): LanguageProfile | undefined {
    return id ? LANGUAGE_PROFILES.find(profile => profile.id === id) : undefined;
}

/** Profiles whose marker files exist in the folder, in profile priority order. */
export async function detectProfiles(folder: vscode.WorkspaceFolder): Promise<DetectedProfile[]> {
    const detected: DetectedProfile[] = [];
    for (const profile of LANGUAGE_PROFILES) {
        if (profile.markers.length === 0) {
            continue;
        }
        const evidence = await firstMatch(folder, profile.markers);
        if (evidence) {
            detected.push({ profile, evidence });
        }
    }
    return detected;
}

async function firstMatch(folder: vscode.WorkspaceFolder, markers: string[]): Promise<string | undefined> {
    for (const marker of markers) {
        // Markers without a slash also match one level down, so monorepo-ish
        // layouts (client/package.json) are still recognised.
        const pattern = marker.includes('/') ? marker : `{${marker},*/${marker}}`;
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, pattern),
            '**/{node_modules,bin,obj,.git,build,vendor}/**',
            1
        );
        if (matches.length > 0) {
            return vscode.workspace.asRelativePath(matches[0], false);
        }
    }
    return undefined;
}

/**
 * The JS profile's coverage command depends on the project's own scripts, and
 * the Dart one on whether it is Flutter or plain Dart — resolve those against
 * the workspace rather than guessing a single command for everyone.
 */
export async function resolveCoverageCommand(
    folder: vscode.WorkspaceFolder,
    profile: LanguageProfile
): Promise<CoverageCommand | undefined> {
    if (profile.id === 'js') {
        return resolveNodeCoverageCommand(folder);
    }
    if (profile.id === 'dart') {
        return (await isFlutterProject(folder))
            ? { command: 'flutter', args: ['test', '--coverage'], label: 'flutter test --coverage' }
            : {
                  command: 'dart',
                  args: ['run', 'coverage:test_with_coverage'],
                  label: 'dart run coverage:test_with_coverage'
              };
    }
    return profile.coverage?.command;
}

async function isFlutterProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
    try {
        const pubspec = await fs.readFile(path.join(folder.uri.fsPath, 'pubspec.yaml'), 'utf8');
        return /^\s*(flutter:|sdk:\s*flutter)/m.test(pubspec);
    } catch {
        return false;
    }
}

/**
 * Prefer a coverage-specific script the project already defines — those carry
 * the repo's own flags — before falling back to the generic runner form.
 */
async function resolveNodeCoverageCommand(folder: vscode.WorkspaceFolder): Promise<CoverageCommand | undefined> {
    const manager = await detectNodePackageManager(folder);
    let scripts: Record<string, string> = {};
    try {
        const raw = await fs.readFile(path.join(folder.uri.fsPath, 'package.json'), 'utf8');
        scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
        return undefined;
    }
    const preferred = ['test:coverage', 'coverage', 'test:cov'].find(name => scripts[name]);
    if (preferred) {
        return { command: manager, args: ['run', preferred], label: `${manager} run ${preferred}` };
    }
    if (!scripts.test) {
        return undefined;
    }
    // npm needs "--" to forward flags to the underlying runner; yarn/pnpm do not.
    const args = manager === 'npm' ? ['test', '--', '--coverage'] : ['test', '--coverage'];
    return { command: manager, args, label: `${manager} ${args.join(' ')}` };
}

async function detectNodePackageManager(folder: vscode.WorkspaceFolder): Promise<'npm' | 'yarn' | 'pnpm'> {
    const lockfiles: [string, 'yarn' | 'pnpm' | 'npm'][] = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['package-lock.json', 'npm']
    ];
    for (const [file, manager] of lockfiles) {
        try {
            await fs.access(path.join(folder.uri.fsPath, file));
            return manager;
        } catch {
            // try the next lockfile
        }
    }
    return 'npm';
}

/** First existing coverage report for the profile, relative to the folder. */
export async function findCoverageReport(
    folder: vscode.WorkspaceFolder,
    profile: LanguageProfile
): Promise<string | undefined> {
    for (const relative of profile.coverage?.reportPaths ?? []) {
        const candidate = path.join(folder.uri.fsPath, relative);
        try {
            const stat = await fs.stat(candidate);
            if (stat.size > 0) {
                return relative;
            }
        } catch {
            // try the next candidate
        }
    }
    return undefined;
}

interface ProfilePick extends vscode.QuickPickItem {
    profile: LanguageProfile;
}

/** The slice of workspace state the language resolution needs. */
export interface LanguagePreference {
    readonly scanLanguage: string | undefined;
    setScanLanguage(languageId: string | undefined): Promise<void>;
}

/**
 * Which language profile configures local tooling here: the explicit setting
 * wins, then the workspace's remembered choice, otherwise ask (detected
 * options first) and remember the answer so later runs are unprompted.
 */
export async function resolveLanguageProfile(
    folder: vscode.WorkspaceFolder,
    preference: LanguagePreference,
    options: { prompt?: boolean } = {}
): Promise<LanguageProfile | undefined> {
    const configured = vscode.workspace.getConfiguration('sonarcloud').get<string>('localScan.language', 'auto');
    if (configured && configured !== 'auto') {
        const profile = findProfile(configured);
        if (profile) {
            return profile;
        }
        if (options.prompt !== false) {
            void vscode.window.showWarningMessage(
                `Unknown "sonarcloud.localScan.language" value "${configured}" — asking which language to use instead.`
            );
        }
    }

    const remembered = findProfile(preference.scanLanguage);
    if (remembered) {
        return remembered;
    }

    // A background refresh must not throw a picker at someone who is typing.
    if (options.prompt === false) {
        return undefined;
    }

    const picked = await promptForLanguageProfile(folder, preference.scanLanguage);
    if (!picked) {
        return undefined;
    }
    await preference.setScanLanguage(picked.id);
    return picked;
}

/**
 * Ask which language the scan should be configured for, detected options
 * first. Returns undefined when the user dismisses the picker.
 */
export async function promptForLanguageProfile(
    folder: vscode.WorkspaceFolder,
    currentId: string | undefined
): Promise<LanguageProfile | undefined> {
    const detected = await detectProfiles(folder);
    const detectedIds = new Map(detected.map(d => [d.profile.id, d.evidence]));

    const items: ProfilePick[] = [];
    if (detected.length > 0) {
        items.push({ label: 'Detected in this folder', kind: vscode.QuickPickItemKind.Separator } as ProfilePick);
        for (const { profile, evidence } of detected) {
            items.push({
                label: profile.label,
                description: [evidence, profile.id === currentId ? 'current' : undefined].filter(Boolean).join(' · '),
                detail: profile.detail,
                profile
            });
        }
        items.push({ label: 'Other languages', kind: vscode.QuickPickItemKind.Separator } as ProfilePick);
    }
    for (const profile of LANGUAGE_PROFILES) {
        if (!detectedIds.has(profile.id)) {
            items.push({
                label: profile.label,
                description: profile.id === currentId ? 'current' : undefined,
                detail: profile.detail,
                profile
            });
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: `Local scan language for "${folder.name}"`,
        placeHolder: 'Determines how coverage is produced and which report SonarCloud reads',
        ignoreFocusOut: true
    });
    return picked?.profile;
}

/** Analysis properties (already -D prefixed) contributed by the profile. */
export function coverageScannerArgs(profile: LanguageProfile, reportPath: string | undefined): string[] {
    const args = (profile.extraProperties ?? []).map(property => `-D${property}`);
    if (reportPath && profile.coverage) {
        args.push(`-D${profile.coverage.property}=${reportPath}`);
    }
    return args;
}
