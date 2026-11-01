import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SonarCloudClient, SonarCloudError } from './client';
import { DotnetLocalTestSettings, runDotnetLocalScan } from './dotnetLocalScan';
import { detectWorkspaceGitBranch } from './gitBranch';
import {
    coverageScannerArgs,
    findCoverageReport,
    LanguageProfile,
    resolveCoverageCommand,
    resolveLanguageProfile
} from './languageProfiles';
// Shared with the tool runner: a locally redeclared class would not match the
// errors runTool throws, so the "install it" guidance would never fire.
import { CommandNotFoundError, killProcessTree, processGroupOptions, runTool } from './processRunner';
import {
    buildCoverageSummary,
    buildTestExecutionSummary,
    buildUnitTestCountSummary,
    explainMissingTestMetrics,
    POST_SCAN_SUMMARY_METRICS,
    sentenceCase,
    tryGetBranchDetails
} from './scanSummary';
import { resolveScannerCommand } from './scannerInstall';
import { SonarState } from './state';

const HOST_URL = 'https://sonarcloud.io';
const SCANNER_DOCS_URL =
    'https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-cli.md';
const CE_POLL_INTERVAL_MS = 3000;
const CE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

class ScannerNotFoundError extends Error {
    constructor(public readonly command: string) {
        super(`Could not find "${command}".`);
    }
}

interface LocalTestSettings {
    enabled: boolean;
    buildTarget: string;
    projectsToBuild: string;
    buildArgs: string[];
    projectsToTest: string;
    dotnetTestArgs: string[];
    sonarExcludePattern: string;
    sonarInclusions: string;
    openCoverReportsPaths: string;
    vstestReportsPaths: string;
}

/**
 * Runs the SonarScanner CLI against a workspace folder and uploads the analysis
 * to SonarCloud, then waits for the server-side compute-engine task to finish
 * so the sidebar can refresh with the new results.
 */
export class LocalScanner implements vscode.Disposable {
    private running = false;
    private readonly output = vscode.window.createOutputChannel('SonarCloud Local Scan');

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: SonarCloudClient,
        private readonly state: SonarState,
        private readonly getToken: () => Thenable<string | undefined>
    ) {}

    dispose(): void {
        this.output.dispose();
    }

    async run(): Promise<void> {
        if (this.running) {
            void vscode.window.showInformationMessage('A SonarCloud local scan is already running.');
            return;
        }
        const project = this.state.project;
        if (!project) {
            void vscode.window.showInformationMessage(
                'Select a project in the SonarCloud sidebar first — the scan is uploaded to that project.'
            );
            return;
        }
        const token = await this.getToken();
        let organization: string;
        try {
            organization = this.client.organization();
        } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            return;
        }
        if (!token) {
            void vscode.window.showErrorMessage('No SonarCloud API token set. Run "SonarCloud: Set API Token".');
            return;
        }

        const folder = await pickWorkspaceFolder();
        if (!folder) {
            return;
        }

        const detectedBranch = await detectWorkspaceGitBranch();
        const branchInput = await vscode.window.showInputBox({
            title: 'Report scan as branch',
            prompt:
                'SonarCloud keeps one analysis per branch — this scan replaces that branch\'s previous analysis. ' +
                'Use a scratch name (e.g. "local-scan") to avoid overwriting CI results. Coverage uploads there, but SonarCloud only publishes unit-test-count metrics for long-lived branches.',
            value: detectedBranch ?? 'local-scan',
            ignoreFocusOut: true
        });
        if (branchInput === undefined) {
            return;
        }
        const branchName = branchInput.trim();
        if (!branchName) {
            void vscode.window.showErrorMessage('A branch name is required for the scan.');
            return;
        }
        // Conservative charset (covers real git branch names) — on Windows the
        // scanner is launched through cmd.exe, so shell metacharacters and "%"
        // in a free-typed value must never reach the command line.
        if (!/^[\w./-]+$/.test(branchName)) {
            void vscode.window.showErrorMessage(
                'Branch names may only contain letters, digits, "_", "-", "." and "/".'
            );
            return;
        }

        // Guardrail: overwriting the main branch's analysis clobbers what CI
        // produced (usually including coverage), so require explicit consent.
        let mainBranchName: string | undefined;
        try {
            const mainBranch = (await this.client.listBranches(project.key)).find(b => b.isMain);
            mainBranchName = mainBranch?.name;
            if (mainBranch && mainBranch.name === branchName) {
                const proceed = await vscode.window.showWarningMessage(
                    `"${branchName}" is the main branch of ${project.name} on SonarCloud. ` +
                        'A local scan replaces its current analysis. If this local run does not publish coverage, ' +
                        'coverage will stay missing until the next CI run re-analyzes it.',
                    { modal: true },
                    'Scan Main Branch Anyway'
                );
                if (proceed !== 'Scan Main Branch Anyway') {
                    return;
                }
            }
        } catch {
            // Could not check which branch is main — continue without the guardrail.
        }

        const languageProfile = await resolveLanguageProfile(folder, this.state);
        if (!languageProfile) {
            return; // the language picker was dismissed
        }
        const localScanMode = vscode.workspace.getConfiguration('sonarcloud').get<string>('localScan.mode', 'auto');
        const useDotnetScanner =
            localScanMode === 'dotnet' || (localScanMode !== 'cli' && languageProfile.scanner === 'dotnet');
        const localTest = this.getLocalTestSettings(folder, useDotnetScanner);
        if (useDotnetScanner) {
            this.running = true;
            try {
                await runDotnetLocalScan({
                    client: this.client,
                    state: this.state,
                    output: this.output,
                    folder,
                    project,
                    organization,
                    token,
                    branchName,
                    referenceBranchName: mainBranchName,
                    settings: localTest,
                    extraScannerArgs: vscode.workspace.getConfiguration('sonarcloud').get<string[]>('scannerArgs') ?? []
                });
            } finally {
                this.running = false;
            }
            return;
        }

        const scannerCommand = await resolveScannerCommand(this.context);
        if (!scannerCommand) {
            return; // messages/instructions already shown by the resolver
        }
        const extraArgs = vscode.workspace.getConfiguration('sonarcloud').get<string[]>('scannerArgs') ?? [];
        const baseArgs = [
            `-Dsonar.host.url=${HOST_URL}`,
            `-Dsonar.organization=${organization}`,
            `-Dsonar.projectKey=${project.key}`,
            `-Dsonar.branch.name=${branchName}`,
            ...(mainBranchName && mainBranchName !== branchName ? [`-Dsonar.newCode.referenceBranch=${mainBranchName}`] : []),
            ...(vscode.workspace.getConfiguration('sonarcloud').get<boolean>('localScan.verbose')
                ? ['-Dsonar.verbose=true']
                : []),
            ...this.buildLocalTestScannerArgs(folder, localTest)
        ];

        this.running = true;
        this.output.clear();
        this.output.appendLine(
            `Local scan language: ${languageProfile.label} (change with "SonarCloud: Select Local Scan Language").`
        );
        if (languageProfile.notes) {
            this.output.appendLine(languageProfile.notes);
        }
        this.output.appendLine(`> cwd: ${folder.uri.fsPath}`);
        this.output.show(true);
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'SonarCloud local scan',
                    cancellable: true
                },
                async (progress, cancelToken) => {
                    if (localTest.enabled) {
                        progress.report({ message: `running dotnet test for "${localTest.projectsToTest}"…` });
                        await this.runLocalTests(folder, localTest, cancelToken);
                        if (cancelToken.isCancellationRequested) {
                            this.output.appendLine('Scan cancelled.');
                            return;
                        }
                    }

                    const coverageArgs = await this.prepareLanguageCoverage(
                        folder,
                        languageProfile,
                        progress,
                        cancelToken
                    );
                    if (cancelToken.isCancellationRequested) {
                        this.output.appendLine('Scan cancelled.');
                        return;
                    }
                    const args = [...baseArgs, ...coverageArgs, ...extraArgs];

                    progress.report({ message: `running sonar-scanner on "${folder.name}"…` });
                    this.output.appendLine(`> ${scannerCommand} ${args.join(' ')}`);
                    const exitCode = await this.runScannerWithProvisioningFallback(
                        scannerCommand,
                        args,
                        folder,
                        token,
                        cancelToken
                    );
                    if (cancelToken.isCancellationRequested) {
                        this.output.appendLine('Scan cancelled.');
                        return;
                    }
                    if (exitCode !== 0) {
                        throw new Error(
                            `sonar-scanner exited with code ${exitCode} — see the "SonarCloud Local Scan" output for details.`
                        );
                    }

                    progress.report({ message: 'waiting for SonarCloud to process the report…' });
                    const taskId = await this.readCeTaskId(folder);
                    const processed = taskId ? await this.waitForCeTask(taskId, cancelToken) : false;
                    if (cancelToken.isCancellationRequested) {
                        return;
                    }

                    // Point the sidebar at the scanned branch; setBranch fires the
                    // state-change event, which refreshes every view.
                    await this.state.setBranch(branchName);
                    if (processed) {
                        const readyNotes: string[] = [];
                        try {
                            const measures = await this.client.getMeasures(project.key, branchName, [...POST_SCAN_SUMMARY_METRICS]);
                            const coverageSummary = buildCoverageSummary(measures);
                            if (coverageSummary) {
                                readyNotes.push(sentenceCase(coverageSummary));
                                this.output.appendLine(`SonarCloud reports ${coverageSummary} for branch "${branchName}".`);
                            }

                            const testSummary = buildTestExecutionSummary(measures);
                            if (testSummary) {
                                const testCountSummary = buildUnitTestCountSummary(measures);
                                if (testCountSummary) {
                                    readyNotes.push(sentenceCase(testCountSummary));
                                }
                                this.output.appendLine(`SonarCloud reports ${testSummary} for branch "${branchName}".`);
                            } else if (localTest.enabled) {
                                const branch = await tryGetBranchDetails(this.client, project.key, branchName);
                                this.output.appendLine(explainMissingTestMetrics(branch, branchName));
                            }
                        } catch {
                            // Measure check is best-effort; the analysis itself succeeded.
                        }
                        void vscode.window.showInformationMessage(
                            `SonarCloud analysis for ${project.name} (branch "${branchName}") is ready${readyNotes.length > 0 ? `. ${readyNotes.join('. ')}.` : '.'}`
                        );
                    } else {
                        void vscode.window.showWarningMessage(
                            'The scan was uploaded, but SonarCloud has not finished processing it yet — ' +
                                'refresh the SonarCloud views in a moment.'
                        );
                    }
                }
            );
        } catch (err) {
            if (err instanceof CommandNotFoundError) {
                const choice = await vscode.window.showErrorMessage(
                    `${err.message} Install it and make sure it is on PATH, or turn off ` +
                        '"sonarcloud.localScan.runCoverageCommand" to scan without producing coverage first.',
                    'Open Settings'
                );
                if (choice === 'Open Settings') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'sonarcloud.localScan');
                }
            } else if (err instanceof ScannerNotFoundError) {
                const choice = await vscode.window.showErrorMessage(
                    `${err.message} Install the SonarScanner CLI (requires Java 17+) or point the ` +
                        '"sonarcloud.scannerPath" setting at the executable.',
                    'Install Instructions',
                    'Open Settings'
                );
                if (choice === 'Install Instructions') {
                    void vscode.env.openExternal(vscode.Uri.parse(SCANNER_DOCS_URL));
                } else if (choice === 'Open Settings') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'sonarcloud.scannerPath');
                }
            } else {
                const message = err instanceof Error ? err.message : String(err);
                const choice = await vscode.window.showErrorMessage(`SonarCloud local scan failed: ${message}`, 'Show Output');
                if (choice === 'Show Output') {
                    this.output.show(true);
                }
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Produce (or locate) the coverage report this language reports through,
     * and return the analysis properties that point SonarCloud at it. Coverage
     * problems are reported but never abort the scan — issues still upload.
     */
    private async prepareLanguageCoverage(
        folder: vscode.WorkspaceFolder,
        profile: LanguageProfile,
        progress: vscode.Progress<{ message?: string }>,
        cancelToken: vscode.CancellationToken
    ): Promise<string[]> {
        if (!profile.coverage) {
            this.output.appendLine(
                'No coverage report is configured for this language — the scan uploads issues only.'
            );
            return coverageScannerArgs(profile, undefined);
        }

        const config = vscode.workspace.getConfiguration('sonarcloud');
        const configuredReport = config.get<string>('localScan.coverageReportPath', '').trim();
        let report = configuredReport || (await findCoverageReport(folder, profile));

        if (config.get<boolean>('localScan.runCoverageCommand', true)) {
            const command = await resolveCoverageCommand(folder, profile);
            if (command) {
                progress.report({ message: `running ${command.label}…` });
                this.output.appendLine(`> ${command.command} ${command.args.join(' ')}`);
                const result = await runTool(command.command, command.args, folder, cancelToken, this.output);
                if (cancelToken.isCancellationRequested) {
                    return [];
                }
                if (result.exitCode !== 0) {
                    // Failing tests still leave partial coverage worth uploading.
                    this.output.appendLine(
                        `Warning: "${command.label}" exited with code ${result.exitCode} — continuing with whatever coverage it produced.`
                    );
                }
                report = configuredReport || (await findCoverageReport(folder, profile));
            } else {
                this.output.appendLine(
                    `No coverage command could be inferred for ${profile.label}. ${profile.coverage.hint}`
                );
            }
        }

        if (!report) {
            this.output.appendLine(
                `Warning: no coverage report found (looked for ${profile.coverage.reportPaths.join(', ')}), so NO ` +
                    `coverage will be uploaded. ${profile.coverage.hint} ` +
                    'Set "sonarcloud.localScan.coverageReportPath" if your report lives elsewhere.'
            );
            return coverageScannerArgs(profile, undefined);
        }
        this.output.appendLine(`Coverage report ready: ${report} → ${profile.coverage.property}`);
        return coverageScannerArgs(profile, report);
    }

    private getLocalTestSettings(folder: vscode.WorkspaceFolder, useDotnetScanner: boolean): DotnetLocalTestSettings {
        const config = vscode.workspace.getConfiguration('sonarcloud');
        const isExplicit = (key: string): boolean => {
            const info = config.inspect(key);
            return (
                info?.globalValue !== undefined ||
                info?.workspaceValue !== undefined ||
                info?.workspaceFolderValue !== undefined
            );
        };
        const defaultEnabled = useDotnetScanner;

        return {
            enabled: isExplicit('localTest.enabled') ? config.get<boolean>('localTest.enabled', defaultEnabled) : defaultEnabled,
            buildTarget: expandSettingValue(config.get<string>('localTest.buildTarget', '').trim(), folder),
            projectsToBuild: config.get<string>('localTest.projectsToBuild', '**/*.csproj').trim(),
            projectsToBuildExplicit: isExplicit('localTest.projectsToBuild'),
            buildArgs: (config.get<string[]>('localTest.buildArgs') ?? ['--configuration', 'Release', '--no-incremental', '--disable-build-servers']).map(
                arg => expandSettingValue(arg, folder)
            ),
            projectsToTest: config.get<string>('localTest.projectsToTest', '**/*[Tt]ests.csproj').trim(),
            // No --no-build: test projects are excluded from the scanner build
            // step, so the test run must build them (inside begin/end, which is
            // fine — the scanner classifies them as test projects). --settings
            // and --results-directory are injected per test project by the scan.
            dotnetTestArgs: (
                config.get<string[]>('localTest.dotnetTestArgs') ?? [
                    '--configuration',
                    'Release',
                    '--collect',
                    'XPlat Code Coverage',
                    '--logger',
                    'trx;LogFileName=test_results.trx',
                    '--filter',
                    'TestCategory!=LocalTestOnly'
                ]
            ).map(arg =>
                expandSettingValue(arg, folder)
            ),
            dotnetTestArgsExplicit: isExplicit('localTest.dotnetTestArgs'),
            openCoverReportsPathsExplicit: isExplicit('localTest.openCoverReportsPaths'),
            vstestReportsPathsExplicit: isExplicit('localTest.vstestReportsPaths'),
            sonarExcludePattern: expandSettingValue(
                config
                    .get<string>(
                        'localTest.sonarExcludePattern',
                        'sonar.exclusions=**/*.Tests/**/*,**/*[Tt]ests/**/*,**/*Test*.cs,*.dll,**/*.json,**/*.css,**/wwwroot/**'
                    )
                    .trim(),
                folder
            ),
            sonarInclusions: expandSettingValue(
                config.get<string>('localTest.sonarInclusions', 'sonar.inclusions=**/*.cs').trim(),
                folder
            ),
            openCoverReportsPaths: expandSettingValue(
                config
                    .get<string>(
                        'localTest.openCoverReportsPaths',
                        '$(Build.SourcesDirectory)/coverage/sonarcloud-local-scan/**/coverage.opencover.xml'
                    )
                    .trim(),
                folder
            ),
            vstestReportsPaths: expandSettingValue(
                config
                    .get<string>(
                        'localTest.vstestReportsPaths',
                        '$(Build.SourcesDirectory)/coverage/sonarcloud-local-scan/**/*.trx,$(Build.SourcesDirectory)/TestResults/**/*.trx,$(Agent.TempDirectory)/**/TestResults/**/*.trx'
                    )
                    .trim(),
                folder
            )
        };
    }

    private buildLocalTestScannerArgs(folder: vscode.WorkspaceFolder, settings: LocalTestSettings): string[] {
        if (!settings.enabled) {
            return [];
        }

        return [
            normalizeSonarPropertyArg(settings.sonarExcludePattern, folder),
            normalizeSonarPropertyArg(settings.sonarInclusions, folder),
            buildSonarPropertyArg('sonar.cs.opencover.reportsPaths', settings.openCoverReportsPaths, folder),
            buildSonarPropertyArg('sonar.cs.vstest.reportsPaths', settings.vstestReportsPaths, folder)
        ].filter((value): value is string => !!value);
    }

    private async runLocalTests(
        folder: vscode.WorkspaceFolder,
        settings: LocalTestSettings,
        cancelToken: vscode.CancellationToken
    ): Promise<void> {
        if (!settings.projectsToTest) {
            throw new Error('"sonarcloud.localTest.projectsToTest" must not be empty when local tests are enabled.');
        }

        const testProjects = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, settings.projectsToTest),
            undefined,
            2000,
            cancelToken
        );
        if (testProjects.length === 0) {
            throw new Error(`No test projects matched "${settings.projectsToTest}" in ${folder.name}.`);
        }

        this.output.appendLine(`Running dotnet test for ${testProjects.length} project(s)...`);
        for (const project of testProjects) {
            if (cancelToken.isCancellationRequested) {
                return;
            }

            const relativeProject = path.relative(folder.uri.fsPath, project.fsPath) || project.fsPath;
            const args = ['test', project.fsPath, ...settings.dotnetTestArgs];
            this.output.appendLine(`> dotnet ${args.join(' ')}`);
            const result = await this.runCommand('dotnet', args, folder, cancelToken);
            if (cancelToken.isCancellationRequested) {
                return;
            }
            if (result.exitCode !== 0) {
                throw new Error(`dotnet test failed for ${relativeProject} with exit code ${result.exitCode}.`);
            }
        }
    }

    private async runScannerWithProvisioningFallback(
        command: string,
        args: string[],
        folder: vscode.WorkspaceFolder,
        token: string,
        cancelToken: vscode.CancellationToken
    ): Promise<number> {
        let result = await this.runScanner(command, args, folder, token, cancelToken);
        if (cancelToken.isCancellationRequested || result.exitCode === 0 || !shouldRetryWithoutJreProvisioning(result.output)) {
            return result.exitCode;
        }

        const retryEnv: Record<string, string> = {
            SONAR_SCANNER_SKIP_JRE_PROVISIONING: 'true'
        };
        const bundledJava = await resolveBundledScannerJava(command);
        if (bundledJava) {
            retryEnv.SONAR_SCANNER_JAVA_EXE_PATH = bundledJava;
        }

        this.output.appendLine('');
        this.output.appendLine('Retrying sonar-scanner with JRE auto-provisioning disabled...');
        if (bundledJava) {
            this.output.appendLine(`Using scanner Java: ${bundledJava}`);
        }

        result = await this.runScanner(command, args, folder, token, cancelToken, retryEnv);
        return result.exitCode;
    }

    private runCommand(
        command: string,
        args: string[],
        folder: vscode.WorkspaceFolder,
        cancelToken: vscode.CancellationToken,
        extraEnv: Record<string, string> = {}
    ): Promise<{ exitCode: number; output: string }> {
        return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
            let output = '';
            const child = spawn(command, args, {
                cwd: folder.uri.fsPath,
                env: { ...process.env, ...extraEnv },
                shell: false,
                ...processGroupOptions()
            });
            const cancellation = cancelToken.onCancellationRequested(() => killProcessTree(child));
            child.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output = appendOutputTail(output, text);
                this.output.append(text);
            });
            child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output = appendOutputTail(output, text);
                this.output.append(text);
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
                resolve({ exitCode: code ?? 1, output });
            });
        });
    }

    private runScanner(
        command: string,
        args: string[],
        folder: vscode.WorkspaceFolder,
        token: string,
        cancelToken: vscode.CancellationToken,
        extraEnv: Record<string, string> = {}
    ): Promise<{ exitCode: number; output: string }> {
        return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
            let output = '';
            // sonar-scanner is a .bat on Windows, which requires a shell — and with
            // shell:true Node joins the args unquoted, so quote them ourselves.
            const useShell = process.platform === 'win32';
            // The token goes through the environment so it never appears in the
            // process list or the output channel.
            const child = spawn(useShell ? windowsQuote(command) : command, useShell ? args.map(windowsQuote) : args, {
                cwd: folder.uri.fsPath,
                env: { ...process.env, ...extraEnv, SONAR_TOKEN: token },
                shell: useShell,
                ...processGroupOptions()
            });
            const cancellation = cancelToken.onCancellationRequested(() => killProcessTree(child));
            child.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output = appendOutputTail(output, text);
                this.output.append(text);
            });
            child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output = appendOutputTail(output, text);
                this.output.append(text);
            });
            child.on('error', err => {
                cancellation.dispose();
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(new ScannerNotFoundError(command));
                } else {
                    reject(err);
                }
            });
            child.on('close', code => {
                cancellation.dispose();
                resolve({ exitCode: code ?? 1, output });
            });
        });
    }

    /** The scanner writes the compute-engine task id to .scannerwork/report-task.txt. */
    private async readCeTaskId(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
        try {
            const file = path.join(folder.uri.fsPath, '.scannerwork', 'report-task.txt');
            const content = await fs.readFile(file, 'utf8');
            return /^ceTaskId=(.+)$/m.exec(content)?.[1]?.trim();
        } catch {
            return undefined;
        }
    }

    /** Poll the compute-engine task until SonarCloud has processed the uploaded report. */
    private async waitForCeTask(taskId: string, cancelToken: vscode.CancellationToken): Promise<boolean> {
        const deadline = Date.now() + CE_POLL_TIMEOUT_MS;
        while (Date.now() < deadline && !cancelToken.isCancellationRequested) {
            let status: string;
            let errorMessage: string | undefined;
            try {
                ({ status, errorMessage } = await this.client.getCeTask(taskId));
            } catch (err) {
                // A transient API error should not fail a scan that already uploaded.
                this.output.appendLine(
                    `Warning: could not check analysis status — ${
                        err instanceof SonarCloudError ? err.message : String(err)
                    }`
                );
                return false;
            }
            if (status === 'SUCCESS') {
                return true;
            }
            if (status === 'FAILED' || status === 'CANCELED') {
                throw new Error(
                    `SonarCloud could not process the analysis report${errorMessage ? `: ${errorMessage}` : '.'}`
                );
            }
            await delay(CE_POLL_INTERVAL_MS);
        }
        return false;
    }
}

export function buildSonarPropertyArg(
    propertyName: string,
    propertyValue: string,
    folder: vscode.WorkspaceFolder
): string | undefined {
    const expanded = expandSettingValue(propertyValue, folder).trim();
    return expanded ? `-D${propertyName}=${expanded}` : undefined;
}

export function normalizeSonarPropertyArg(value: string, folder: vscode.WorkspaceFolder): string | undefined {
    const expanded = expandSettingValue(value, folder).trim();
    if (!expanded) {
        return undefined;
    }
    return expanded.startsWith('-D') ? expanded : `-D${expanded}`;
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showErrorMessage('Open the folder you want to scan before running a local scan.');
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to scan' });
}

/**
 * Quoting for cmd.exe: double quotes keep spaces together and stop `&`, `|`,
 * `<`, `>` and `^` from being interpreted. `%VAR%` expansion still happens
 * inside quotes, which is why free-typed values are validated upstream.
 */
export function windowsQuote(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

export function appendOutputTail(output: string, chunk: string): string {
    const next = output + chunk;
    return next.length > 64 * 1024 ? next.slice(-(64 * 1024)) : next;
}

export function expandSettingValue(value: string, folder: vscode.WorkspaceFolder): string {
    return value
        .replace(/\$\(Build\.SourcesDirectory\)/g, folder.uri.fsPath)
        .replace(/\$\(System\.DefaultWorkingDirectory\)/g, folder.uri.fsPath)
        .replace(/\$\(Agent\.TempDirectory\)/g, os.tmpdir())
        .replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath)
        .replace(/\$\{temp\}/g, os.tmpdir());
}

export function shouldRetryWithoutJreProvisioning(output: string): boolean {
    return /Failed to extract archive/i.test(output) && /AccessDeniedException/i.test(output);
}

export async function resolveBundledScannerJava(command: string): Promise<string | undefined> {
    if (!path.isAbsolute(command)) {
        return undefined;
    }
    const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
    const candidate = path.join(path.dirname(path.dirname(command)), 'jre', 'bin', javaName);
    try {
        await fs.access(candidate);
        return candidate;
    } catch {
        return undefined;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
