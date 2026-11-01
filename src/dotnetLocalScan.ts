import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError, SonarProject } from './client';
import {
    buildCoverageSummary,
    buildTestExecutionSummary,
    buildUnitTestCountSummary,
    explainMissingTestMetrics,
    POST_SCAN_SUMMARY_METRICS,
    sentenceCase,
    tryGetBranchDetails
} from './scanSummary';
import { killProcessTree, processGroupOptions } from './processRunner';
import { canRunDotnetCoverage, ensureDotnetCoverageAvailable, ensureDotnetScannerAvailable, withDotnetToolPath } from './scannerInstall';
import { SonarState } from './state';

const HOST_URL = 'https://sonarcloud.io';
const DOTNET_SCANNER_DOCS_URL =
    'https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-for-dotnet.md';
const CE_POLL_INTERVAL_MS = 3000;
const CE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const REPORT_TASK_PATHS = [
    path.join('.scannerwork', 'report-task.txt'),
    path.join('.sonarqube', 'out', '.sonar', 'report-task.txt'),
    path.join('.sonarqube', 'out', 'sonar', 'report-task.txt')
];
const DOTNET_SCAN_GITIGNORE_ENTRY = '.sonarqube/';
const LOCAL_SCAN_COVERAGE_DIRECTORY = path.join('coverage', 'sonarcloud-local-scan');
const LOCAL_SCAN_COVERAGE_RUNSETTINGS_FILE = path.join(LOCAL_SCAN_COVERAGE_DIRECTORY, 'coverage.runsettings');
const IGNORED_SEARCH_SEGMENTS = new Set(['.git', 'bin', 'obj', 'node_modules']);
const SCAN_ARTIFACT_DIRECTORIES = ['.scannerwork', '.sonarqube'];
const DEFAULT_COVERAGE_RUNSETTINGS = String.raw`<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
    <DataCollectionRunSettings>
        <DataCollectors>
            <DataCollector friendlyName="XPlat Code Coverage">
                <Configuration>
                    <Format>opencover</Format>
                    <CodeCoverage>
                        <ModulePaths>
                            <Exclude>
                                <ModulePath>.*[\\/]microsoft\..*</ModulePath>
                                <ModulePath>.*[\\/]system\..*</ModulePath>
                                <ModulePath>.*[\\/]dapper.*</ModulePath>
                                <ModulePath>.*[\\/]fluentvalidation.*</ModulePath>
                                <ModulePath>.*[\\/]moq.*</ModulePath>
                                <ModulePath>.*[\\/]xunit.*</ModulePath>
                                <ModulePath>.*[\\/]stackexchange.*</ModulePath>
                                <ModulePath>.*[\\/]durabletask.*</ModulePath>
                                <ModulePath>.*[\\/]pipelines.*</ModulePath>
                                <ModulePath>.*[\\/]bunit.*</ModulePath>
                                <ModulePath>.*[\\/]bouncycastle.*</ModulePath>
                                <ModulePath>.*[\\/]richardszalay.*</ModulePath>
                                <ModulePath>.*[\\/]utilities.testing.*</ModulePath>
                            </Exclude>
                        </ModulePaths>
                    </CodeCoverage>
                </Configuration>
            </DataCollector>
        </DataCollectors>
    </DataCollectionRunSettings>
</RunSettings>
`;

class CommandNotFoundError extends Error {
    constructor(public readonly command: string) {
        super(`Could not find "${command}".`);
    }
}

export interface DotnetLocalTestSettings {
    enabled: boolean;
    buildTarget: string;
    projectsToBuild: string;
    projectsToBuildExplicit: boolean;
    buildArgs: string[];
    projectsToTest: string;
    dotnetTestArgs: string[];
    dotnetTestArgsExplicit: boolean;
    sonarExcludePattern: string;
    sonarInclusions: string;
    openCoverReportsPaths: string;
    vstestReportsPaths: string;
    /** True when the user set the value in settings; otherwise the extension manages exact report paths itself. */
    openCoverReportsPathsExplicit: boolean;
    vstestReportsPathsExplicit: boolean;
}

type ManagedCoverageTool = 'xplat' | 'dotnet-coverage';

/**
 * When the extension runs the tests itself it controls --results-directory,
 * so it can hand the scanner exact report file paths instead of wildcard
 * patterns — some scanner setups fail to resolve wildcards, which silently
 * drops coverage from the upload.
 */
interface ManagedCoveragePlan {
    /** One results directory per test project ("results-1", "results-2", …). */
    resultsDirs: string[];
    /** Deterministic copy target per test project ("coverage-1.opencover.xml", …). */
    coverageReports: string[];
    /** Deterministic TRX path per test project. */
    trxReports: string[];
    /** False when the user manages --results-directory themselves. */
    managed: boolean;
}

interface DotnetTestExecutionTarget {
    path: string;
    usesPrebuiltModule: boolean;
}

interface MissingCoverageExplanation {
    outputMessage: string;
    toastMessage: string;
}

interface DotnetScanBuildPlan {
    buildTargets: string[];
    prebuildTestProjects: vscode.Uri[];
    reuseBuildOutputsForTests: boolean;
    reroutedFromSolution: boolean;
}

export function planManagedCoverage(
    settings: DotnetLocalTestSettings,
    testProjects: vscode.Uri[],
    coverageRoot: string,
    coverageTool: ManagedCoverageTool
): ManagedCoveragePlan {
    const managed = settings.enabled && testProjects.length > 0 && !settings.dotnetTestArgs.includes('--results-directory');
    const resultsDirs = testProjects.map((_, i) => path.join(coverageRoot, `results-${i + 1}`));
    const coverageExtension = coverageTool === 'dotnet-coverage' ? '.xml' : '.opencover.xml';
    return {
        managed,
        resultsDirs,
        coverageReports: testProjects.map((_, i) => path.join(coverageRoot, `coverage-${i + 1}${coverageExtension}`)),
        trxReports: resultsDirs.map(dir => path.join(dir, 'test_results.trx'))
    };
}

interface RunDotnetLocalScanOptions {
    client: SonarCloudClient;
    state: SonarState;
    output: vscode.OutputChannel;
    folder: vscode.WorkspaceFolder;
    project: SonarProject;
    organization: string;
    token: string;
    branchName: string;
    referenceBranchName?: string;
    settings: DotnetLocalTestSettings;
    extraScannerArgs: string[];
}

export async function hasDotnetArtifacts(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const solutions = await findWorkspaceFiles(folder, ['**/*.sln'], 1);
    if (solutions.length > 0) {
        return true;
    }

    const projects = await findWorkspaceFiles(folder, ['**/*.csproj', '**/*.vbproj', '**/*.fsproj'], 1);
    return projects.length > 0;
}

export async function runDotnetLocalScan(options: RunDotnetLocalScanOptions): Promise<void> {
    const scannerReady = await ensureDotnetScannerAvailable();
    if (!scannerReady) {
        return;
    }

    const requestedBuildTargets = await resolveBuildTargets(options.folder, options.settings);
    if (requestedBuildTargets === null) {
        return;
    }

    const testProjects = options.settings.enabled ? await findTestProjects(options.folder, options.settings) : [];
    const buildPlan = await resolveDotnetScanBuildPlan(options.folder, options.settings, requestedBuildTargets, testProjects);
    const buildTargets = buildPlan.buildTargets;
    const coverageRoot = path.join(options.folder.uri.fsPath, LOCAL_SCAN_COVERAGE_DIRECTORY);
    const runsettingsPath = path.join(options.folder.uri.fsPath, LOCAL_SCAN_COVERAGE_RUNSETTINGS_FILE);
    const coverageTool = await resolveManagedCoverageTool(options.settings, testProjects);
    const coveragePlan = planManagedCoverage(options.settings, testProjects, coverageRoot, coverageTool);
    const beginArgs = buildDotnetBeginArgs(options, coveragePlan, coverageTool);
    const prebuildCommands = buildPlan.prebuildTestProjects.map(project =>
        buildDotnetBuildArgs(project.fsPath, options.settings, false, true)
    );
    const buildCommands = (buildTargets.length > 0 ? buildTargets : [undefined]).map(buildTarget =>
        buildDotnetBuildArgs(buildTarget, options.settings, shouldForceProductProjectClassification(buildTarget))
    );
    const reuseBuildOutputsForTests = buildPlan.reuseBuildOutputsForTests;

    options.output.clear();
    options.output.appendLine('Using SonarScanner for .NET.');
    await ensureDotnetScanGitignoreEntry(options.folder, options.output);
    if (buildPlan.reroutedFromSolution) {
        options.output.appendLine(
            'Prebuilding test projects outside SonarScanner and scanning only main projects so SonarScanner for .NET does not classify the whole solution as TEST code.'
        );
    }
    if (options.settings.enabled) {
        await prepareLocalScanCoverageArtifacts(options.folder, options.output, coveragePlan.managed, coverageTool);
        options.output.appendLine(
            coverageTool === 'dotnet-coverage'
                ? 'Using dotnet-coverage for .NET coverage collection.'
                : 'Using XPlat Code Coverage collector for .NET coverage collection.'
        );
    }
    if (!options.settings.enabled) {
        options.output.appendLine(
            'Tests are disabled. Enable "sonarcloud.localTest.enabled" and configure coverage-producing dotnet test arguments if you want local coverage metrics.'
        );
    }
    for (const prebuildArgs of prebuildCommands) {
        options.output.appendLine(`> dotnet ${prebuildArgs.join(' ')}`);
    }
    options.output.appendLine(`> dotnet ${renderRedactedArgs(beginArgs)}`);
    for (const buildArgs of buildCommands) {
        options.output.appendLine(`> dotnet ${buildArgs.join(' ')}`);
    }
    if (options.settings.enabled) {
        options.output.appendLine(
            coverageTool === 'dotnet-coverage'
                ? '> dotnet-coverage collect "dotnet test <project> ..." -f xml -o <coverage.xml>'
                : `> dotnet test ${options.settings.projectsToTest} ${options.settings.dotnetTestArgs.join(' ')}`.trim()
        );
    }
    options.output.appendLine('> dotnet sonarscanner end');
    options.output.appendLine(`> cwd: ${options.folder.uri.fsPath}`);
    options.output.show(true);

    let uploadedAnalysis = false;
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'SonarCloud local scan',
                cancellable: true
            },
            async (progress, cancelToken) => {
                if (buildPlan.prebuildTestProjects.length > 0) {
                    progress.report({ message: 'prebuilding test projects outside SonarScanner…' });
                    await prebuildDotnetProjects(
                        options.folder,
                        options.settings,
                        options.output,
                        cancelToken,
                        buildPlan.prebuildTestProjects,
                        'test projects outside SonarScanner so only main projects are analyzed'
                    );
                    if (cancelToken.isCancellationRequested) {
                        options.output.appendLine('Scan cancelled.');
                        return;
                    }
                }

                progress.report({ message: 'starting SonarScanner for .NET…' });
                const tokenEnv = { SONAR_TOKEN: options.token };
                let useExplicitTokenArgs = false;
                let result = await runCommand('dotnet', beginArgs, options.folder, options.output, cancelToken, tokenEnv);
                if (cancelToken.isCancellationRequested) {
                    options.output.appendLine('Scan cancelled.');
                    return;
                }
                if (result.exitCode !== 0) {
                    if (shouldRetryWithExplicitScannerToken(result.output)) {
                        useExplicitTokenArgs = true;
                        const beginArgsWithToken = addExplicitScannerToken(beginArgs, options.token);
                        options.output.appendLine('SonarScanner for .NET rejected env-based auth. Retrying begin with explicit scanner token.');
                        options.output.appendLine(`> dotnet ${renderRedactedArgs(beginArgsWithToken)}`);
                        result = await runCommand('dotnet', beginArgsWithToken, options.folder, options.output, cancelToken, tokenEnv);
                    }
                }
                if (cancelToken.isCancellationRequested) {
                    options.output.appendLine('Scan cancelled.');
                    return;
                }
                if (result.exitCode !== 0) {
                    throw new Error(buildScannerStepFailureMessage('begin', result.exitCode, result.output, options.project, options.organization));
                }

                for (const [index, buildArgs] of buildCommands.entries()) {
                    progress.report({
                        message: buildProgressMessage(buildTargets[index], index, buildCommands.length, options.folder)
                    });
                    result = await runCommand('dotnet', buildArgs, options.folder, options.output, cancelToken);
                    if (cancelToken.isCancellationRequested) {
                        options.output.appendLine('Scan cancelled.');
                        return;
                    }
                    if (result.exitCode !== 0) {
                        throw new Error(
                            `dotnet build exited with code ${result.exitCode} — see the "SonarCloud Local Scan" output for details.`
                        );
                    }
                }

                if (options.settings.enabled) {
                    progress.report({ message: `running dotnet test for "${options.settings.projectsToTest}"…` });
                    await runLocalTests(
                        options.folder,
                        options.settings,
                        options.output,
                        cancelToken,
                        testProjects,
                        coveragePlan,
                        runsettingsPath,
                        coverageTool,
                        reuseBuildOutputsForTests
                    );
                    if (cancelToken.isCancellationRequested) {
                        options.output.appendLine('Scan cancelled.');
                        return;
                    }
                }

                progress.report({ message: 'uploading SonarCloud analysis…' });
                result = await runCommand(
                    'dotnet',
                    buildDotnetEndArgs(options.token, useExplicitTokenArgs),
                    options.folder,
                    options.output,
                    cancelToken,
                    tokenEnv
                );
                if (cancelToken.isCancellationRequested) {
                    options.output.appendLine('Scan cancelled.');
                    return;
                }
                if (result.exitCode !== 0) {
                    throw new Error(buildScannerStepFailureMessage('end', result.exitCode, result.output, options.project, options.organization));
                }
                uploadedAnalysis = true;
                if (options.settings.enabled && coveragePlan.managed) {
                    summarizeCoverageImport(result.output, options.output, coveragePlan);
                }

                progress.report({ message: 'waiting for SonarCloud to process the report…' });
                const taskId = await readCeTaskId(options.folder);
                const processed = taskId ? await waitForCeTask(options.client, options.output, taskId, cancelToken) : false;
                if (cancelToken.isCancellationRequested) {
                    return;
                }

                await options.state.setBranch(options.branchName);
                if (processed) {
                    // Close the loop: ask SonarCloud what coverage it actually
                    // recorded, so "coverage silently missing" cannot happen again.
                    const readyNotes: string[] = [];
                    if (options.settings.enabled) {
                        try {
                            const measures = await options.client.getMeasures(
                                options.project.key,
                                options.branchName,
                                [...POST_SCAN_SUMMARY_METRICS]
                            );
                            const coverage = measures.get('coverage');
                            if (coverage !== undefined) {
                                const coverageSummary = buildCoverageSummary(measures);
                                if (coverageSummary) {
                                    readyNotes.push(sentenceCase(coverageSummary));
                                    options.output.appendLine(
                                        `SonarCloud reports ${coverageSummary} for branch "${options.branchName}".`
                                    );
                                }
                            } else {
                                const missingCoverage = explainMissingCoverage(result.output);
                                if (!missingCoverage) {
                                    options.output.appendLine(
                                        'Warning: SonarCloud processed the analysis but recorded NO coverage measure for the scanned ' +
                                            'branch — the coverage reports were not imported. Check the coverage import summary above, ' +
                                            'and re-run with "sonarcloud.localScan.verbose" enabled for the full report-path resolution log.'
                                    );
                                }
                                void vscode.window.showWarningMessage(
                                    missingCoverage?.toastMessage ??
                                        'SonarCloud processed the analysis, but no coverage was recorded — see the "SonarCloud Local Scan" output for the import summary.'
                                );
                            }

                            const testSummary = buildTestExecutionSummary(measures);
                            if (testSummary) {
                                const testCountSummary = buildUnitTestCountSummary(measures);
                                if (testCountSummary) {
                                    readyNotes.push(sentenceCase(testCountSummary));
                                }
                                options.output.appendLine(
                                    `SonarCloud reports ${testSummary} for branch "${options.branchName}".`
                                );
                            } else {
                                const branch = await tryGetBranchDetails(
                                    options.client,
                                    options.project.key,
                                    options.branchName
                                );
                                options.output.appendLine(explainMissingTestMetrics(branch, options.branchName));
                            }
                        } catch {
                            // Measure check is best-effort; the analysis itself succeeded.
                        }
                    }
                    void vscode.window.showInformationMessage(
                        `SonarCloud analysis for ${options.project.name} (branch "${options.branchName}") is ready${readyNotes.length > 0 ? `. ${readyNotes.join('. ')}.` : '.'}`
                    );
                } else {
                    void vscode.window.showWarningMessage(
                        'The scan was uploaded, but SonarCloud has not finished processing it yet — refresh the SonarCloud views in a moment.'
                    );
                }
            }
        );
    } catch (err) {
        if (err instanceof CommandNotFoundError) {
            const choice = await vscode.window.showErrorMessage(
                `${err.message} Install the .NET SDK and SonarScanner for .NET before running a .NET local scan.`,
                'Install Instructions',
                'Open Settings'
            );
            if (choice === 'Install Instructions') {
                void vscode.env.openExternal(vscode.Uri.parse(DOTNET_SCANNER_DOCS_URL));
            } else if (choice === 'Open Settings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'sonarcloud.localScan.mode');
            }
            return;
        }

        const message = err instanceof Error ? err.message : String(err);
        const choice = await vscode.window.showErrorMessage(`SonarCloud local scan failed: ${message}`, 'Show Output');
        if (choice === 'Show Output') {
            options.output.show(true);
        }
    } finally {
        await cleanupLocalScanCoverageArtifacts(options.folder, options.output);
        if (uploadedAnalysis) {
            await cleanupScanArtifacts(options.folder, options.output);
        }
    }
}

function buildDotnetBeginArgs(
    options: RunDotnetLocalScanOptions,
    coveragePlan: ManagedCoveragePlan,
    coverageTool: ManagedCoverageTool
): string[] {
    // The token is intentionally absent: it travels via the SONAR_TOKEN
    // environment variable so it never shows up in the OS process list.
    return [
        'sonarscanner',
        'begin',
        `/k:${options.project.key}`,
        `/n:${options.project.name}`,
        `/o:${options.organization}`,
        `/d:sonar.host.url=${HOST_URL}`,
        `/d:sonar.projectBaseDir=${options.folder.uri.fsPath}`,
        `/d:sonar.branch.name=${options.branchName}`,
        ...(options.referenceBranchName && options.referenceBranchName !== options.branchName
            ? [`/d:sonar.newCode.referenceBranch=${options.referenceBranchName}`]
            : []),
        ...(vscode.workspace.getConfiguration('sonarcloud').get<boolean>('localScan.verbose')
            ? ['/d:sonar.verbose=true']
            : []),
        ...buildDotnetPropertyArgs(options.settings, coveragePlan, coverageTool),
        ...convertCliScannerArgsToDotnetArgs(options.extraScannerArgs)
    ];
}

export function buildDotnetBuildArgs(
    buildTarget: string | undefined,
    settings: DotnetLocalTestSettings,
    forceProductProjectClassification = false,
    suppressSonarScannerImport = false
): string[] {
    return [
        'build',
        ...(buildTarget ? [buildTarget] : []),
        ...settings.buildArgs,
        ...(forceProductProjectClassification ? ['-p:SonarQubeTestProject=false'] : []),
        ...(suppressSonarScannerImport ? ['-p:SonarQubeTargetsImported=true'] : [])
    ];
}

export function buildDotnetEndArgs(token: string, useExplicitTokenArgs: boolean): string[] {
    if (!useExplicitTokenArgs) {
        return ['sonarscanner', 'end'];
    }

    return addExplicitScannerToken(['sonarscanner', 'end'], token);
}

export function buildDotnetPropertyArgs(
    settings: DotnetLocalTestSettings,
    coveragePlan: ManagedCoveragePlan,
    coverageTool: ManagedCoverageTool
): string[] {
    // Prefer exact file paths over configured wildcard patterns whenever the
    // extension runs the tests itself and therefore knows where reports land.
    const coveragePaths =
        coveragePlan.managed && !settings.openCoverReportsPathsExplicit
            ? coveragePlan.coverageReports.join(',')
            : settings.openCoverReportsPaths;
    const vstestPaths =
        coveragePlan.managed && !settings.vstestReportsPathsExplicit
            ? coveragePlan.trxReports.join(',')
            : settings.vstestReportsPaths;
    const coveragePropertyName =
        coverageTool === 'dotnet-coverage' && coveragePlan.managed && !settings.openCoverReportsPathsExplicit
            ? 'sonar.cs.vscoveragexml.reportsPaths'
            : 'sonar.cs.opencover.reportsPaths';
    return [
        normalizeDotnetPropertyArg(settings.sonarExcludePattern),
        normalizeDotnetPropertyArg(settings.sonarInclusions),
        buildDotnetPropertyArg(coveragePropertyName, coveragePaths),
        buildDotnetPropertyArg('sonar.cs.vstest.reportsPaths', vstestPaths)
    ].filter((value): value is string => !!value);
}

async function resolveManagedCoverageTool(
    settings: DotnetLocalTestSettings,
    testProjects: vscode.Uri[]
): Promise<ManagedCoverageTool> {
    if (
        !settings.enabled ||
        testProjects.length === 0 ||
        settings.dotnetTestArgsExplicit ||
        settings.openCoverReportsPathsExplicit ||
        settings.vstestReportsPathsExplicit
    ) {
        return 'xplat';
    }

    if (await canRunDotnetCoverage()) {
        return 'dotnet-coverage';
    }

    return (await ensureDotnetCoverageAvailable()) ? 'dotnet-coverage' : 'xplat';
}

function buildDotnetPropertyArg(propertyName: string, propertyValue: string): string | undefined {
    const trimmed = propertyValue.trim();
    return trimmed ? `/d:${propertyName}=${trimmed}` : undefined;
}

export function normalizeDotnetPropertyArg(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.startsWith('/d:')) {
        return trimmed;
    }
    if (trimmed.startsWith('-d:')) {
        return `/d:${trimmed.slice(3)}`;
    }
    if (trimmed.startsWith('-D')) {
        return `/d:${trimmed.slice(2)}`;
    }
    return `/d:${trimmed}`;
}

export function convertCliScannerArgsToDotnetArgs(args: string[]): string[] {
    return args.flatMap(arg => {
        if (arg.startsWith('-D')) {
            return [`/d:${arg.slice(2)}`];
        }
        if (arg.startsWith('/d:')) {
            return [arg];
        }
        if (arg.startsWith('-d:')) {
            return [`/d:${arg.slice(3)}`];
        }
        return [];
    });
}

export async function resolveBuildTargets(folder: vscode.WorkspaceFolder, settings: DotnetLocalTestSettings): Promise<string[] | null> {
    if (settings.buildTarget) {
        if (isProjectFileBuildTarget(settings.buildTarget) && isTestProject(settings.buildTarget)) {
            const fallbackTargets = await resolveDefaultBuildTargets(folder, settings);
            const configuredTarget = formatBuildTargetLabel(folder, settings.buildTarget);
            if (fallbackTargets.length > 0) {
                const fallbackLabel = summarizeBuildTargets(folder, fallbackTargets);
                void vscode.window.showWarningMessage(
                    `"sonarcloud.localTest.buildTarget" points to the test project "${configuredTarget}". Using ${fallbackLabel} instead so SonarScanner for .NET does not classify the whole build graph as test code.`
                );
                return fallbackTargets;
            }

            void vscode.window.showErrorMessage(
                `"sonarcloud.localTest.buildTarget" points to the test project "${configuredTarget}". Choose a solution or a non-test project for local SonarCloud scans.`
            );
            return null;
        }

        return [settings.buildTarget];
    }

    return resolveDefaultBuildTargets(folder, settings);
}

async function resolveDotnetScanBuildPlan(
    folder: vscode.WorkspaceFolder,
    settings: DotnetLocalTestSettings,
    requestedBuildTargets: string[],
    testProjects: vscode.Uri[]
): Promise<DotnetScanBuildPlan> {
    const usingSolutionTargets = requestedBuildTargets.length > 0 && requestedBuildTargets.every(isSolutionFileBuildTarget);
    if (!settings.enabled || testProjects.length === 0 || !usingSolutionTargets) {
        return {
            buildTargets: requestedBuildTargets,
            prebuildTestProjects: [],
            reuseBuildOutputsForTests: usingSolutionTargets,
            reroutedFromSolution: false
        };
    }

    const mainProjectTargets = await resolveMainProjectBuildTargets(folder, settings);
    if (mainProjectTargets.length === 0) {
        return {
            buildTargets: requestedBuildTargets,
            prebuildTestProjects: [],
            reuseBuildOutputsForTests: usingSolutionTargets,
            reroutedFromSolution: false
        };
    }

    return {
        buildTargets: mainProjectTargets,
        prebuildTestProjects: testProjects,
        reuseBuildOutputsForTests: true,
        reroutedFromSolution: true
    };
}

export async function resolveDefaultBuildTargets(folder: vscode.WorkspaceFolder, settings: DotnetLocalTestSettings): Promise<string[]> {
    const preferredSolutions = await resolvePreferredSolutionTargets(folder, settings);
    if (preferredSolutions.length > 0) {
        return preferredSolutions;
    }

    const mainProjectTargets = await resolveMainProjectBuildTargets(folder, settings);
    if (mainProjectTargets.length > 0) {
        return mainProjectTargets;
    }

    const allProjects = await findWorkspaceFiles(folder, ['**/*.csproj', '**/*.vbproj', '**/*.fsproj'], 2000);

    const solutions = await findWorkspaceFiles(folder, ['**/*.sln'], 50);
    if (solutions.length > 0) {
        return solutions.map(solution => solution.fsPath);
    }

    return allProjects.map(projectUri => projectUri.fsPath);
}

async function resolveMainProjectBuildTargets(folder: vscode.WorkspaceFolder, settings: DotnetLocalTestSettings): Promise<string[]> {

    const configuredProjects = settings.projectsToBuild
        ? await findWorkspaceFiles(folder, [settings.projectsToBuild], 2000)
        : [];
    const configuredMainProjects = configuredProjects.filter(projectUri => !isTestProject(projectUri.fsPath));
    if (configuredMainProjects.length > 0) {
        return configuredMainProjects.map(projectUri => projectUri.fsPath);
    }

    const allProjects = await findWorkspaceFiles(folder, ['**/*.csproj', '**/*.vbproj', '**/*.fsproj'], 2000);
    const nonTestProjects = allProjects.filter(projectUri => !isTestProject(projectUri.fsPath));
    if (nonTestProjects.length > 0) {
        return nonTestProjects.map(projectUri => projectUri.fsPath);
    }

    return [];
}

async function resolvePreferredSolutionTargets(
    folder: vscode.WorkspaceFolder,
    settings: DotnetLocalTestSettings
): Promise<string[]> {
    if (settings.projectsToBuildExplicit) {
        return [];
    }

    const configuredSolution = await resolveConfiguredDefaultSolutionBuildTarget(folder);
    if (configuredSolution) {
        return [configuredSolution];
    }

    const solutions = await findWorkspaceFiles(folder, ['**/*.sln', '**/*.slnx'], 50);
    return pickSolutionTargets(folder, solutions);
}

/**
 * Building every solution in a repo compiles shared projects more than once and
 * makes the scanner import them twice. When several exist, prefer the one at
 * the workspace root; failing that, take the shallowest, and say which was
 * chosen so the "wrong project analysed" case is visible rather than silent.
 */
export function pickSolutionTargets(folder: vscode.WorkspaceFolder, solutions: vscode.Uri[]): string[] {
    if (solutions.length <= 1) {
        return solutions.map(solution => solution.fsPath);
    }

    const depthOf = (solution: vscode.Uri) =>
        path.relative(folder.uri.fsPath, solution.fsPath).split(/[\\/]/).length;
    const shallowest = Math.min(...solutions.map(depthOf));
    const candidates = solutions.filter(solution => depthOf(solution) === shallowest);
    // A stable tie-break keeps repeated scans analysing the same solution.
    const chosen = candidates.sort((a, b) => a.fsPath.localeCompare(b.fsPath))[0];

    void vscode.window.showWarningMessage(
        `${solutions.length} solutions found; scanning "${path.relative(folder.uri.fsPath, chosen.fsPath)}". ` +
            'Set "sonarcloud.localTest.buildTarget" to choose a different one.'
    );
    return [chosen.fsPath];
}

async function resolveConfiguredDefaultSolutionBuildTarget(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const configuredSolution = vscode.workspace.getConfiguration('dotnet', folder.uri).get<string>('defaultSolution')?.trim();
    if (!configuredSolution) {
        return undefined;
    }

    const solutionPath = path.isAbsolute(configuredSolution)
        ? configuredSolution
        : path.join(folder.uri.fsPath, configuredSolution);
    try {
        await fs.access(solutionPath);
        return solutionPath;
    } catch {
        return undefined;
    }
}

async function ensureDotnetScanGitignoreEntry(folder: vscode.WorkspaceFolder, output: vscode.OutputChannel): Promise<void> {
    try {
        const gitRoot = await findGitRoot(folder.uri.fsPath);
        if (!gitRoot) {
            return;
        }

        const gitignorePath = path.join(gitRoot, '.gitignore');
        let content = '';
        try {
            content = await fs.readFile(gitignorePath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }

        if (hasGitignoreEntry(content, '.sonarqube')) {
            return;
        }

        const nextContent = appendGitignoreEntry(content, DOTNET_SCAN_GITIGNORE_ENTRY);
        await fs.writeFile(gitignorePath, nextContent, 'utf8');

        const displayPath = path.relative(folder.uri.fsPath, gitignorePath) || '.gitignore';
        output.appendLine(`Added ${DOTNET_SCAN_GITIGNORE_ENTRY} to ${displayPath}.`);
    } catch (err) {
        output.appendLine(
            `Warning: could not update .gitignore for SonarScanner for .NET output — ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

async function prepareLocalScanCoverageArtifacts(
    folder: vscode.WorkspaceFolder,
    output: vscode.OutputChannel,
    managed: boolean,
    coverageTool: ManagedCoverageTool
): Promise<void> {
    const coverageDirectory = path.join(folder.uri.fsPath, LOCAL_SCAN_COVERAGE_DIRECTORY);
    const runsettingsPath = path.join(folder.uri.fsPath, LOCAL_SCAN_COVERAGE_RUNSETTINGS_FILE);

    await fs.mkdir(coverageDirectory, { recursive: true });
    if (!managed || coverageTool !== 'xplat') {
        return;
    }

    await fs.writeFile(runsettingsPath, DEFAULT_COVERAGE_RUNSETTINGS, 'utf8');

    output.appendLine(`Prepared coverage collector settings in ${path.relative(folder.uri.fsPath, runsettingsPath) || runsettingsPath}.`);
}

async function cleanupLocalScanCoverageArtifacts(folder: vscode.WorkspaceFolder, output: vscode.OutputChannel): Promise<void> {
    const coverageDirectory = path.join(folder.uri.fsPath, LOCAL_SCAN_COVERAGE_DIRECTORY);

    try {
        await fs.access(coverageDirectory);
    } catch {
        return;
    }

    try {
        await fs.rm(coverageDirectory, { recursive: true, force: true, maxRetries: 2 });
        output.appendLine(`Cleaned up local coverage artifacts: ${LOCAL_SCAN_COVERAGE_DIRECTORY}.`);
    } catch (err) {
        output.appendLine(
            `Warning: could not remove ${LOCAL_SCAN_COVERAGE_DIRECTORY} after the scan — ${
                err instanceof Error ? err.message : String(err)
            }`
        );
    }
}

async function cleanupScanArtifacts(folder: vscode.WorkspaceFolder, output: vscode.OutputChannel): Promise<void> {
    const removedDirectories: string[] = [];

    for (const relativePath of SCAN_ARTIFACT_DIRECTORIES) {
        const artifactPath = path.join(folder.uri.fsPath, relativePath);
        try {
            await fs.access(artifactPath);
        } catch {
            continue;
        }

        try {
            await fs.rm(artifactPath, { recursive: true, force: true, maxRetries: 2 });
            removedDirectories.push(relativePath);
        } catch (err) {
            output.appendLine(
                `Warning: could not remove ${relativePath} after the scan — ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    if (removedDirectories.length > 0) {
        output.appendLine(`Cleaned up local scan artifacts: ${removedDirectories.join(', ')}.`);
    }
}

export async function findTestProjects(folder: vscode.WorkspaceFolder, settings: DotnetLocalTestSettings): Promise<vscode.Uri[]> {
    if (!settings.enabled) {
        return [];
    }
    if (!settings.projectsToTest) {
        throw new Error('"sonarcloud.localTest.projectsToTest" must not be empty when local tests are enabled.');
    }
    const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, settings.projectsToTest), undefined, 2000);
    return matches
        .filter(project => !hasIgnoredSearchSegment(path.relative(folder.uri.fsPath, project.fsPath)))
        .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

async function runLocalTests(
    folder: vscode.WorkspaceFolder,
    settings: DotnetLocalTestSettings,
    output: vscode.OutputChannel,
    cancelToken: vscode.CancellationToken,
    testProjects: vscode.Uri[],
    coveragePlan: ManagedCoveragePlan,
    runsettingsPath: string,
    coverageTool: ManagedCoverageTool,
    reuseBuildOutputsForTests: boolean
): Promise<void> {
    if (testProjects.length === 0) {
        output.appendLine(`Warning: no test projects matched "${settings.projectsToTest}" in ${folder.name}; continuing without coverage.`);
        return;
    }

    output.appendLine(`Running dotnet test for ${testProjects.length} project(s)...`);
    if (reuseBuildOutputsForTests) {
        output.appendLine('Reusing prior build outputs for dotnet test to avoid duplicate SonarScanner project imports.');
    }
    for (const [index, project] of testProjects.entries()) {
        if (cancelToken.isCancellationRequested) {
            return;
        }

        const relativeProject = path.relative(folder.uri.fsPath, project.fsPath) || project.fsPath;
        const executionTarget = await resolveDotnetTestExecutionTarget(
            folder,
            project.fsPath,
            settings,
            reuseBuildOutputsForTests,
            output
        );
        const args = buildDotnetTestArgs(
            executionTarget.path,
            settings.dotnetTestArgs,
            coveragePlan,
            coverageTool,
            index,
            runsettingsPath,
            reuseBuildOutputsForTests && !executionTarget.usesPrebuiltModule
        );
        const command = coverageTool === 'dotnet-coverage' && coveragePlan.managed ? 'dotnet-coverage' : 'dotnet';
        const commandArgs =
            coverageTool === 'dotnet-coverage' && coveragePlan.managed
                ? buildDotnetCoverageCollectArgs(args, coveragePlan.coverageReports[index])
                : args;
        output.appendLine(`> ${command} ${renderCommandArgs(commandArgs)}`);
        const result = await runCommand(command, commandArgs, folder, output, cancelToken);
        if (cancelToken.isCancellationRequested) {
            return;
        }
        if (result.exitCode !== 0) {
            throw new Error(`${command} failed for ${relativeProject} with exit code ${result.exitCode}.`);
        }

        if (coveragePlan.managed) {
            if (coverageTool === 'dotnet-coverage') {
                await confirmCoverageReport(coveragePlan, index, relativeProject, output, 'dotnet-coverage XML');
            } else {
                await collectCoverageReport(coveragePlan, index, relativeProject, output);
            }
        }
    }

    if (coveragePlan.managed) {
        const ready = await countExistingFiles(coveragePlan.coverageReports);
        if (ready === 0) {
            if (coverageTool === 'dotnet-coverage') {
                output.appendLine(
                    'Warning: no dotnet-coverage XML reports were produced, so NO coverage will be uploaded. ' +
                        'See the command output above to confirm dotnet-coverage wrote each expected report file.'
                );
            } else {
                output.appendLine(
                    'Warning: no OpenCover coverage reports were produced, so NO coverage will be uploaded. ' +
                        'Ensure every test project references the "coverlet.collector" NuGet package (3.2 or newer), ' +
                        'or install the global "dotnet-coverage" tool so local scans can use SonarSource\'s documented XML flow instead.'
                );
            }
        } else {
            output.appendLine(`${ready} of ${coveragePlan.coverageReports.length} coverage report(s) ready for upload.`);
        }
    }
}

async function prebuildDotnetProjects(
    folder: vscode.WorkspaceFolder,
    settings: DotnetLocalTestSettings,
    output: vscode.OutputChannel,
    cancelToken: vscode.CancellationToken,
    projects: vscode.Uri[],
    purpose: string
): Promise<void> {
    output.appendLine(`Prebuilding ${projects.length} project(s) outside SonarScanner: ${purpose}.`);
    for (const project of projects) {
        if (cancelToken.isCancellationRequested) {
            return;
        }

        const relativeProject = path.relative(folder.uri.fsPath, project.fsPath) || project.fsPath;
        const args = buildDotnetBuildArgs(project.fsPath, settings, false, true);
        output.appendLine(`> dotnet ${args.join(' ')}`);
        const result = await runCommand('dotnet', args, folder, output, cancelToken);
        if (cancelToken.isCancellationRequested) {
            return;
        }
        if (result.exitCode !== 0) {
            throw new Error(`dotnet build failed for ${relativeProject} while prebuilding ${purpose}.`);
        }
    }
}

async function resolveDotnetTestExecutionTarget(
    folder: vscode.WorkspaceFolder,
    projectPath: string,
    settings: DotnetLocalTestSettings,
    reuseBuildOutputsForTests: boolean,
    output: vscode.OutputChannel
): Promise<DotnetTestExecutionTarget> {
    if (!reuseBuildOutputsForTests || settings.dotnetTestArgsExplicit) {
        return { path: projectPath, usesPrebuiltModule: false };
    }

    const builtModule = await resolveBuiltTestModule(projectPath, settings);
    if (!builtModule) {
        output.appendLine(
            `Warning: could not resolve a unique built test module for "${relativeProjectLabel(folder, projectPath)}". ` +
                'Falling back to project-based dotnet test, which may let SonarScanner for .NET re-import referenced projects as TEST code.'
        );
        return { path: projectPath, usesPrebuiltModule: false };
    }

    output.appendLine(
        `Reusing built test module ${path.relative(folder.uri.fsPath, builtModule) || builtModule} for ` +
            `"${relativeProjectLabel(folder, projectPath)}" so dotnet test stays out of MSBuild.`
    );
    return { path: builtModule, usesPrebuiltModule: true };
}

export function buildDotnetTestArgs(
    projectPath: string,
    dotnetTestArgs: string[],
    coveragePlan: ManagedCoveragePlan,
    coverageTool: ManagedCoverageTool,
    index: number,
    runsettingsPath: string,
    reuseBuildOutputsForTests: boolean
): string[] {
    const normalizedTestArgs = coverageTool === 'dotnet-coverage' ? stripCoverageCollectorArgs(dotnetTestArgs) : [...dotnetTestArgs];
    const moduleTarget = isCompiledTestModule(projectPath);
    const effectiveTestArgs = moduleTarget ? stripBuildOnlyDotnetTestArgs(normalizedTestArgs) : normalizedTestArgs;
    const args = ['test', projectPath, ...effectiveTestArgs];
    if (!coveragePlan.managed) {
        return args;
    }

    if (coverageTool === 'xplat' && !hasCliOption(effectiveTestArgs, ['--settings'])) {
        args.push('--settings', runsettingsPath);
    }
    if (reuseBuildOutputsForTests && !moduleTarget && !hasCliOption(effectiveTestArgs, ['--no-build'])) {
        args.push('--no-build');
    }
    args.push('--results-directory', coveragePlan.resultsDirs[index]);
    return args;
}

export function stripCoverageCollectorArgs(args: string[]): string[] {
    const normalized: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--collect') {
            index++;
            continue;
        }
        if (/^--collect(?::|=)/i.test(arg)) {
            continue;
        }
        normalized.push(arg);
    }
    return normalized;
}

function stripBuildOnlyDotnetTestArgs(args: string[]): string[] {
    const normalized: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (matchesCliOption(arg, ['--configuration', '-c'])) {
            if (isSeparateCliOption(arg, ['--configuration', '-c'])) {
                index++;
            }
            continue;
        }
        if (matchesCliOption(arg, ['--no-build', '--no-restore', '--disable-build-servers'])) {
            continue;
        }
        normalized.push(arg);
    }
    return normalized;
}

export function buildDotnetCoverageCollectArgs(dotnetTestArgs: string[], coverageReportPath: string): string[] {
    return ['collect', buildProcessCommandString(['dotnet', ...dotnetTestArgs]), '-f', 'xml', '-o', coverageReportPath];
}

function shouldForceProductProjectClassification(buildTarget: string | undefined): boolean {
    return !!buildTarget && isProjectFileBuildTarget(buildTarget) && !isTestProject(buildTarget);
}

function buildProcessCommandString(args: string[]): string {
    return args.map(quoteProcessArg).join(' ');
}

function quoteProcessArg(arg: string): string {
    return /[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function renderCommandArgs(args: string[]): string {
    return args.map(arg => (/\s/u.test(arg) ? `"${arg}"` : arg)).join(' ');
}

function hasCliOption(args: string[], optionNames: string[]): boolean {
    return args.some(arg => matchesCliOption(arg, optionNames));
}

function matchesCliOption(arg: string, optionNames: string[]): boolean {
    return optionNames.some(option => arg === option || arg.startsWith(`${option}=`) || arg.startsWith(`${option}:`));
}

function isSeparateCliOption(arg: string, optionNames: string[]): boolean {
    return optionNames.includes(arg);
}

function isCompiledTestModule(testTarget: string): boolean {
    const extension = path.extname(testTarget).toLowerCase();
    return extension === '.dll' || extension === '.exe';
}

async function resolveBuiltTestModule(projectPath: string, settings: DotnetLocalTestSettings): Promise<string | undefined> {
    const projectDirectory = path.dirname(projectPath);
    const configuration =
        readCliOptionValue(settings.dotnetTestArgs, ['--configuration', '-c']) ??
        readCliOptionValue(settings.buildArgs, ['--configuration', '-c']) ??
        'Debug';
    const preferredFramework =
        readCliOptionValue(settings.dotnetTestArgs, ['--framework', '-f']) ??
        readCliOptionValue(settings.buildArgs, ['--framework', '-f']);
    const assemblyNames = await resolvePossibleAssemblyNames(projectPath);
    const configurationRoot = path.join(projectDirectory, 'bin', configuration);
    const preferredRoot = preferredFramework ? path.join(configurationRoot, preferredFramework) : configurationRoot;

    const preferredCandidates = await findBuiltTestModuleCandidates(preferredRoot, assemblyNames);
    const preferredMatch = chooseBuiltTestModule(preferredCandidates, preferredRoot);
    if (preferredMatch) {
        return preferredMatch;
    }

    if (preferredRoot === configurationRoot) {
        return undefined;
    }

    return chooseBuiltTestModule(await findBuiltTestModuleCandidates(configurationRoot, assemblyNames), configurationRoot);
}

async function resolvePossibleAssemblyNames(projectPath: string): Promise<string[]> {
    const names = new Set<string>([path.basename(projectPath, path.extname(projectPath))]);
    try {
        const content = await fs.readFile(projectPath, 'utf8');
        const assemblyName = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(content)?.[1]?.trim();
        if (assemblyName) {
            names.add(assemblyName);
        }
    } catch {
        // default project-name assembly fallback is usually enough
    }
    return [...names];
}

async function findBuiltTestModuleCandidates(searchRoot: string, assemblyNames: string[]): Promise<string[]> {
    try {
        await fs.access(searchRoot);
    } catch {
        return [];
    }

    const matches = new Set<string>();
    for (const assemblyName of assemblyNames) {
        for (const extension of ['.dll', '.exe']) {
            const fileName = `${assemblyName}${extension}`;
            for (const match of await findFilesRecursive(searchRoot, fileName)) {
                matches.add(match);
            }
        }
    }

    return [...matches];
}

function chooseBuiltTestModule(candidates: string[], searchRoot: string): string | undefined {
    const preferred = candidates.filter(candidate => isPreferredBuiltTestModuleCandidate(candidate, searchRoot));
    const pool = preferred.length > 0 ? preferred : candidates;
    if (pool.length === 0) {
        return undefined;
    }
    if (pool.length === 1) {
        return pool[0];
    }

    const ranked = pool
        .map(candidate => ({
            candidate,
            depth: path.relative(searchRoot, candidate).split(path.sep).length,
            relativePath: path.relative(searchRoot, candidate)
        }))
        .sort((a, b) => a.depth - b.depth || a.relativePath.localeCompare(b.relativePath));

    if (ranked.length > 1 && ranked[0].depth === ranked[1].depth) {
        return undefined;
    }

    return ranked[0]?.candidate;
}

function isPreferredBuiltTestModuleCandidate(candidate: string, searchRoot: string): boolean {
    const ignoredSegments = new Set(['publish', 'ref', 'refint']);
    return !path
        .relative(searchRoot, candidate)
        .split(path.sep)
        .some(segment => ignoredSegments.has(segment.toLowerCase()));
}

function readCliOptionValue(args: string[], optionNames: string[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (isSeparateCliOption(arg, optionNames)) {
            return args[index + 1];
        }

        for (const option of optionNames) {
            if (arg.startsWith(`${option}=`) || arg.startsWith(`${option}:`)) {
                return arg.slice(option.length + 1);
            }
        }
    }
    return undefined;
}

function relativeProjectLabel(folder: vscode.WorkspaceFolder, projectPath: string): string {
    return path.relative(folder.uri.fsPath, projectPath) || projectPath;
}

async function confirmCoverageReport(
    coveragePlan: ManagedCoveragePlan,
    index: number,
    relativeProject: string,
    output: vscode.OutputChannel,
    expectedLabel: string
): Promise<void> {
    const report = coveragePlan.coverageReports[index];
    try {
        await fs.access(report);
    } catch {
        output.appendLine(
            `Warning: "${relativeProject}" produced no ${expectedLabel} report at ${path.basename(report)}.`
        );
        return;
    }
    if (await coverageReportLooksEmpty(report)) {
        output.appendLine(
            `Warning: the coverage report for "${relativeProject}" contains no modules — the test run likely executed ` +
                'no tests (check the --filter value) or the coverage profiler did not attach. It will add nothing to the upload.'
        );
        return;
    }
    output.appendLine(`Coverage report ready: ${path.basename(report)} (${relativeProject})`);
}

/**
 * A structurally valid but moduleless report is the classic silent failure:
 * the file exists, every "is it there" check passes, and SonarCloud still
 * shows no coverage. Both formats list instrumented assemblies as <module>
 * (dotnet-coverage XML) or <Module> (OpenCover) elements.
 */
export async function coverageReportLooksEmpty(reportPath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(reportPath, 'utf8');
        return !/<module[\s>]/i.test(content);
    } catch {
        return false; // unreadable — let the scanner report what it sees
    }
}

/**
 * The end step's log is the ground truth for whether coverage entered the
 * analysis: the C# plugin prints one "Parsing ..." line per imported report
 * plus a statistics line. Surface that verdict instead of leaving it buried.
 */
export function summarizeCoverageImport(
    endOutput: string,
    output: vscode.OutputChannel,
    coveragePlan: ManagedCoveragePlan
): void {
    const parsed =
        (endOutput.match(/Parsing the Visual Studio coverage XML report/gi) ?? []).length +
        (endOutput.match(/Parsing the OpenCover report/gi) ?? []).length;
    const statistics = /Coverage Report Statistics:[^\r\n]*/i.exec(endOutput)?.[0];
    const notFound = /(?:could not be found|not found)[^\r\n]*report[^\r\n]*/i.exec(endOutput)?.[0];
    if (parsed > 0) {
        output.appendLine(
            `SonarCloud imported ${parsed} coverage report(s) during "end".${statistics ? ` ${statistics.trim()}` : ''}`
        );
        const missingCoverage = explainMissingCoverage(endOutput);
        if (missingCoverage) {
            output.appendLine(missingCoverage.outputMessage);
        }
        return;
    }
    output.appendLine(
        'Warning: the scanner "end" step did not log parsing ANY coverage report, so SonarCloud received no coverage. ' +
            `${coveragePlan.coverageReports.length} report path(s) were passed at "begin". ` +
            (notFound ? `Scanner said: "${notFound.trim()}". ` : '') +
            'Enable "sonarcloud.localScan.verbose" and re-run to see how the scanner resolved the report paths.'
    );
}

function explainMissingCoverage(endOutput: string): MissingCoverageExplanation | undefined {
    const coverageStats = parseCoverageReportStatistics(endOutput);
    const testOnlyProjects = /SonarScanner for \.NET detected only TEST files and no MAIN files/i.test(endOutput);
    const csharpProjectCounts = /Found\s+(\d+)\s+MSBuild C# projects:\s+(\d+)\s+TEST projects\./i.exec(endOutput);
    const allCsharpProjectsAreTests =
        csharpProjectCounts !== null && Number.parseInt(csharpProjectCounts[1], 10) === Number.parseInt(csharpProjectCounts[2], 10);
    const testOnlyCoverage = coverageStats !== undefined && coverageStats.mainFiles === 0 && coverageStats.testFiles > 0;

    if (!testOnlyProjects && !allCsharpProjectsAreTests && !testOnlyCoverage) {
        return undefined;
    }

    const countsNote = coverageStats
        ? ` Coverage stats were ${coverageStats.mainFiles} main files and ${coverageStats.testFiles} test files.`
        : '';
    return {
        outputMessage:
            'Warning: SonarScanner for .NET treated this analysis as TEST-only C# code, so imported coverage could not map to main files and SonarCloud recorded no branch coverage.' +
            countsNote +
            ' This usually happens when dotnet test re-enters MSBuild on a test project path after a solution build.',
        toastMessage:
            'SonarCloud processed the analysis, but SonarScanner treated the .NET scan as TEST-only — see the "SonarCloud Local Scan" output.'
    };
}

function parseCoverageReportStatistics(
    endOutput: string
): { totalFiles: number; mainFiles: number; testFiles: number } | undefined {
    const match =
        /Coverage Report Statistics:\s*(\d+)\s+files,\s*(\d+)\s+main files,\s*(\d+)\s+main files with coverage,\s*(\d+)\s+test files/i.exec(
            endOutput
        );
    if (!match) {
        return undefined;
    }

    return {
        totalFiles: Number.parseInt(match[1], 10),
        mainFiles: Number.parseInt(match[2], 10),
        testFiles: Number.parseInt(match[4], 10)
    };
}

/**
 * The XPlat collector writes coverage to <resultsDir>/<random-guid>/coverage.opencover.xml.
 * Copy it to the deterministic path the scanner was given at "begin", and say
 * loudly when a test run produced nothing.
 */
async function collectCoverageReport(
    coveragePlan: ManagedCoveragePlan,
    index: number,
    relativeProject: string,
    output: vscode.OutputChannel
): Promise<void> {
    const produced = await findFileRecursive(coveragePlan.resultsDirs[index], 'coverage.opencover.xml');
    if (!produced) {
        output.appendLine(
            `Warning: "${relativeProject}" produced no coverage.opencover.xml — its results will be missing from the upload. ` +
                'Does the project reference the "coverlet.collector" package?'
        );
        return;
    }
    await fs.copyFile(produced, coveragePlan.coverageReports[index]);
    if (await coverageReportLooksEmpty(coveragePlan.coverageReports[index])) {
        output.appendLine(
            `Warning: the coverage report for "${relativeProject}" contains no modules — the test run likely executed ` +
                'no tests (check the --filter value). It will add nothing to the upload.'
        );
        return;
    }
    output.appendLine(`Coverage report ready: ${path.basename(coveragePlan.coverageReports[index])} (${relativeProject})`);
}

async function findFileRecursive(dir: string, fileName: string): Promise<string | undefined> {
    let entries: string[];
    try {
        entries = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
        return undefined;
    }
    const match = entries.find(entry => path.basename(entry) === fileName);
    return match ? path.join(dir, match) : undefined;
}

async function findFilesRecursive(dir: string, fileName: string): Promise<string[]> {
    let entries: string[];
    try {
        entries = (await fs.readdir(dir, { recursive: true })) as string[];
    } catch {
        return [];
    }

    return entries.filter(entry => path.basename(entry) === fileName).map(entry => path.join(dir, entry));
}

async function countExistingFiles(paths: string[]): Promise<number> {
    let count = 0;
    for (const file of paths) {
        try {
            await fs.access(file);
            count++;
        } catch {
            // missing — already warned per project
        }
    }
    return count;
}

async function runCommand(
    command: string,
    args: string[],
    folder: vscode.WorkspaceFolder,
    output: vscode.OutputChannel,
    cancelToken: vscode.CancellationToken,
    extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; output: string }> {
    return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
        let tail = '';
        const child = spawn(command, args, {
            cwd: folder.uri.fsPath,
            env: withDotnetToolPath({ ...process.env, ...extraEnv }),
            shell: false,
            ...processGroupOptions()
        });
        const cancellation = cancelToken.onCancellationRequested(() => killProcessTree(child));
        child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            tail = appendOutputTail(tail, text);
            output.append(text);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            tail = appendOutputTail(tail, text);
            output.append(text);
        });
        child.on('error', err => {
            cancellation.dispose();
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new CommandNotFoundError(command));
            } else {
                reject(err);
            }
        });
        child.on('close', code => {
            cancellation.dispose();
            resolve({ exitCode: code ?? 1, output: tail });
        });
    });
}

async function readCeTaskId(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    for (const relativePath of REPORT_TASK_PATHS) {
        try {
            const content = await fs.readFile(path.join(folder.uri.fsPath, relativePath), 'utf8');
            const taskId = /^ceTaskId=(.+)$/m.exec(content)?.[1]?.trim();
            if (taskId) {
                return taskId;
            }
        } catch {
            // Try the next known scanner output location.
        }
    }
    return undefined;
}

async function waitForCeTask(
    client: SonarCloudClient,
    output: vscode.OutputChannel,
    taskId: string,
    cancelToken: vscode.CancellationToken
): Promise<boolean> {
    const deadline = Date.now() + CE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline && !cancelToken.isCancellationRequested) {
        let status: string;
        let errorMessage: string | undefined;
        try {
            ({ status, errorMessage } = await client.getCeTask(taskId));
        } catch (err) {
            output.appendLine(
                `Warning: could not check analysis status — ${err instanceof SonarCloudError ? err.message : String(err)}`
            );
            return false;
        }
        if (status === 'SUCCESS') {
            return true;
        }
        if (status === 'FAILED' || status === 'CANCELED') {
            throw new Error(`SonarCloud could not process the analysis report${errorMessage ? `: ${errorMessage}` : '.'}`);
        }
        await delay(CE_POLL_INTERVAL_MS);
    }
    return false;
}

/**
 * Excluding at the API level matters: findFiles applies maxResults *before*
 * we get to filter, so on a repo with a large bin/ or obj/ tree the leftovers
 * in there can consume the whole budget and hide the real projects.
 */
const SEARCH_EXCLUDE_GLOB = `**/{${[...IGNORED_SEARCH_SEGMENTS].join(',')}}/**`;

async function findWorkspaceFiles(folder: vscode.WorkspaceFolder, patterns: string[], maxResults: number): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, pattern),
            SEARCH_EXCLUDE_GLOB,
            maxResults
        );
        for (const match of matches) {
            if (results.length >= maxResults) {
                return results;
            }
            const relativePath = path.relative(folder.uri.fsPath, match.fsPath);
            if (hasIgnoredSearchSegment(relativePath) || seen.has(match.fsPath)) {
                continue;
            }
            seen.add(match.fsPath);
            results.push(match);
        }
    }
    return results;
}

export function renderRedactedArgs(args: string[]): string {
    return args
        .map(arg => {
            if (arg.startsWith('/d:sonar.token=')) {
                return '/d:sonar.token=***';
            }
            if (arg.startsWith('-d:sonar.token=')) {
                return '-d:sonar.token=***';
            }
            return arg;
        })
        .join(' ');
}

export function addExplicitScannerToken(args: string[], token: string): string[] {
    return [...args, `/d:sonar.token=${token}`];
}

export function shouldRetryWithExplicitScannerToken(output: string): boolean {
    return /(Response status code does not indicate success: (401|403)\.)|authentication|invalid credentials|access is denied/i.test(
        output
    );
}

function appendOutputTail(output: string, chunk: string): string {
    // Generous cap: the "end" step's coverage-import lines appear mid-log on
    // large solutions and must survive for summarizeCoverageImport to see them.
    const limit = 512 * 1024;
    const next = output + chunk;
    return next.length > limit ? next.slice(-limit) : next;
}

function buildProgressMessage(
    buildTarget: string | undefined,
    buildIndex: number,
    totalBuilds: number,
    folder: vscode.WorkspaceFolder
): string {
    const targetLabel = buildTarget ? formatBuildTargetLabel(folder, buildTarget) : folder.name;
    if (totalBuilds <= 1) {
        return `building "${targetLabel}"…`;
    }

    return `building ${buildIndex + 1}/${totalBuilds} "${targetLabel}"…`;
}

function summarizeBuildTargets(folder: vscode.WorkspaceFolder, buildTargets: string[]): string {
    if (buildTargets.length === 1) {
        return `"${formatBuildTargetLabel(folder, buildTargets[0])}"`;
    }

    if (buildTargets.every(isSolutionFileBuildTarget)) {
        return `${buildTargets.length} solution file${buildTargets.length === 1 ? '' : 's'}`;
    }

    return `${buildTargets.length} matching main projects`;
}

export function buildScannerStepFailureMessage(
    step: 'begin' | 'end',
    exitCode: number,
    output: string,
    project: SonarProject,
    organization: string
): string {
    if (/Response status code does not indicate success: 401\./i.test(output)) {
        return `dotnet sonarscanner ${step} was rejected by SonarCloud (HTTP 401). The configured token is invalid, expired, or missing for scanner authentication. Update the SonarCloud token and retry.`;
    }

    if (/Response status code does not indicate success: 403\./i.test(output)) {
        return (
            `dotnet sonarscanner ${step} was rejected by SonarCloud (HTTP 403). ` +
            `The token can likely browse project "${project.key}" in organization "${organization}", ` +
            `but it does not have permission to analyze it. Use a token with "Execute Analysis" permission ` +
            `for this project or organization, usually the same token your CI pipeline uses.`
        );
    }

    if (/Response status code does not indicate success: 504\./i.test(output)) {
        return `dotnet sonarscanner ${step} hit a SonarCloud timeout (HTTP 504). This is usually transient; retry the scan in a moment.`;
    }

    return `dotnet sonarscanner ${step} exited with code ${exitCode} — see the "SonarCloud Local Scan" output for details.`;
}

export function appendGitignoreEntry(content: string, entry: string): string {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    if (!content) {
        return `${entry}${lineEnding}`;
    }

    const separator = content.endsWith('\n') ? '' : lineEnding;
    return `${content}${separator}${entry}${lineEnding}`;
}

function hasIgnoredSearchSegment(relativePath: string): boolean {
    return relativePath.split(/[\\/]/).some(segment => IGNORED_SEARCH_SEGMENTS.has(segment));
}

async function findGitRoot(startPath: string): Promise<string | undefined> {
    let currentPath = path.resolve(startPath);
    while (true) {
        try {
            await fs.access(path.join(currentPath, '.git'));
            return currentPath;
        } catch {
            const parentPath = path.dirname(currentPath);
            if (parentPath === currentPath) {
                return undefined;
            }
            currentPath = parentPath;
        }
    }
}

export function hasGitignoreEntry(content: string, patternFragment: string): boolean {
    return content.split(/\r?\n/).some(line => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes(patternFragment);
    });
}

export function isProjectFileBuildTarget(buildTarget: string): boolean {
    const extension = path.extname(buildTarget).toLowerCase();
    return extension === '.csproj' || extension === '.vbproj' || extension === '.fsproj';
}

export function isSolutionFileBuildTarget(buildTarget: string): boolean {
    const extension = path.extname(buildTarget).toLowerCase();
    return extension === '.sln' || extension === '.slnx';
}

export function isTestProject(filePath: string): boolean {
    if (/(^|[\\/])tests?([\\/]|\.|$)/i.test(filePath)) {
        return true;
    }
    // Match "Foo.Tests", "FooTests", "foo_test" — but not "ContestApi" or
    // "LatestOrders", which a bare /test/i would misclassify and silently
    // exclude from the analyzed build.
    const name = path.basename(filePath, path.extname(filePath));
    return /(^|[.\-_])tests?([.\-_]|$)/i.test(name) || /Tests?$/.test(name);
}

function formatBuildTargetLabel(folder: vscode.WorkspaceFolder, buildTarget: string): string {
    if (!path.isAbsolute(buildTarget)) {
        return buildTarget;
    }

    return path.relative(folder.uri.fsPath, buildTarget) || buildTarget;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
