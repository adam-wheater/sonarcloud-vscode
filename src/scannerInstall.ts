import AdmZip from 'adm-zip';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Locates the SonarScanner CLI, offering a fully automatic install when it is
 * missing. The platform-specific scanner archives bundle their own Java
 * runtime, so downloading one zip is a complete setup — no separate JDK.
 */

const SCANNER_VERSION = '7.1.0.4889';
const DOWNLOAD_BASE = 'https://binaries.sonarsource.com/Distribution/sonar-scanner-cli';
const SCANNER_DOCS_URL =
    'https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-cli.md';
const DOTNET_SCANNER_DOCS_URL =
    'https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-for-dotnet.md';
const DOTNET_COVERAGE_DOCS_URL = 'https://learn.microsoft.com/dotnet/core/additional-tools/dotnet-coverage';

export async function resolveScannerCommand(context: vscode.ExtensionContext): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration('sonarcloud').get<string>('scannerPath')?.trim();
    if (configured) {
        return configured;
    }

    const installed = await installedScannerBin(context);
    if (installed) {
        return installed;
    }

    if (await isOnPath('sonar-scanner')) {
        return 'sonar-scanner';
    }

    return offerAutomaticInstall(context);
}

export async function ensureDotnetScannerAvailable(): Promise<boolean> {
    if (!(await isOnPath('dotnet'))) {
        void vscode.window
            .showErrorMessage(
                'The .NET SDK was not found. Install .NET 3.1+ and SonarScanner for .NET to analyze .NET code locally.',
                'Install Instructions'
            )
            .then(choice => {
                if (choice === 'Install Instructions') {
                    void vscode.env.openExternal(vscode.Uri.parse(DOTNET_SCANNER_DOCS_URL));
                }
            });
        return false;
    }

    if (await canRunDotnetScanner()) {
        return true;
    }

    const install = 'Install Scanner';
    const manual = 'Install Manually';
    const choice = await vscode.window.showInformationMessage(
        'SonarScanner for .NET was not found. Install the dotnet-sonarscanner global tool now?',
        install,
        manual
    );
    if (choice === manual) {
        void vscode.env.openExternal(vscode.Uri.parse(DOTNET_SCANNER_DOCS_URL));
        return false;
    }
    if (choice !== install) {
        return false;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing SonarScanner for .NET',
                cancellable: false
            },
            async progress => {
                progress.report({ message: 'installing dotnet-sonarscanner…' });
                const installResult = await runDotnetCommand(['tool', 'install', '--global', 'dotnet-sonarscanner']);
                if (installResult.exitCode === 0) {
                    return;
                }

                progress.report({ message: 'updating existing dotnet-sonarscanner…' });
                const updateResult = await runDotnetCommand(['tool', 'update', '--global', 'dotnet-sonarscanner']);
                if (updateResult.exitCode !== 0) {
                    throw new Error(updateResult.output || installResult.output || 'dotnet-sonarscanner install failed.');
                }
            }
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`SonarScanner for .NET install failed: ${message}`);
        return false;
    }

    if (await canRunDotnetScanner()) {
        void vscode.window.showInformationMessage('SonarScanner for .NET installed.');
        return true;
    }

    void vscode.window.showErrorMessage('SonarScanner for .NET install completed, but the tool is still unavailable.');
    return false;
}

export async function canRunDotnetCoverage(): Promise<boolean> {
    if (await isOnPath('dotnet-coverage')) {
        return true;
    }

    const result = await runDotnetCommand(['tool', 'list', '--global']);
    return result.exitCode === 0 && /^dotnet-coverage\s+/im.test(result.output);
}

export async function ensureDotnetCoverageAvailable(): Promise<boolean> {
    if (await canRunDotnetCoverage()) {
        return true;
    }

    const install = 'Install Coverage Tool';
    const continueWithout = 'Continue Without';
    const manual = 'Install Manually';
    const choice = await vscode.window.showInformationMessage(
        'dotnet-coverage was not found. Install the global dotnet-coverage tool now? Choose "Continue Without" to keep using XPlat Code Coverage for this scan.',
        install,
        continueWithout,
        manual
    );
    if (choice === manual) {
        void vscode.env.openExternal(vscode.Uri.parse(DOTNET_COVERAGE_DOCS_URL));
        return false;
    }
    if (choice !== install) {
        return false;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing dotnet-coverage',
                cancellable: false
            },
            async progress => {
                progress.report({ message: 'installing dotnet-coverage…' });
                const installResult = await runDotnetCommand(['tool', 'install', '--global', 'dotnet-coverage']);
                if (installResult.exitCode === 0) {
                    return;
                }

                progress.report({ message: 'updating existing dotnet-coverage…' });
                const updateResult = await runDotnetCommand(['tool', 'update', '--global', 'dotnet-coverage']);
                if (updateResult.exitCode !== 0) {
                    throw new Error(updateResult.output || installResult.output || 'dotnet-coverage install failed.');
                }
            }
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`dotnet-coverage install failed: ${message}`);
        return false;
    }

    if (await canRunDotnetCoverage()) {
        void vscode.window.showInformationMessage('dotnet-coverage installed.');
        return true;
    }

    void vscode.window.showErrorMessage('dotnet-coverage install completed, but the tool is still unavailable.');
    return false;
}

/** e.g. "linux-x64", "macosx-aarch64", "windows-x64" — the artifacts that ship a bundled JRE. */
export function platformArtifact(): string | undefined {
    const os =
        process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macosx'
              : process.platform === 'linux'
                ? 'linux'
                : undefined;
    const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : undefined;
    if (!os || !arch) {
        return undefined;
    }
    if (os === 'windows' && arch === 'aarch64') {
        // No Windows ARM build is published; the x64 one runs under emulation.
        return 'windows-x64';
    }
    return `${os}-${arch}`;
}

function installRoot(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'sonar-scanner');
}

function installedBinPath(context: vscode.ExtensionContext, artifact: string): string {
    const binName = process.platform === 'win32' ? 'sonar-scanner.bat' : 'sonar-scanner';
    return path.join(installRoot(context), `sonar-scanner-${SCANNER_VERSION}-${artifact}`, 'bin', binName);
}

async function installedScannerBin(context: vscode.ExtensionContext): Promise<string | undefined> {
    const artifact = platformArtifact();
    if (!artifact) {
        return undefined;
    }
    const bin = installedBinPath(context, artifact);
    try {
        await fs.access(bin);
        return bin;
    } catch {
        return undefined;
    }
}

/** Cheap PATH probe via where/which — avoids actually launching the JVM. */
function isOnPath(command: string): Promise<boolean> {
    return new Promise(resolve => {
        const probe = process.platform === 'win32' ? spawn('where', [command]) : spawn('which', [command]);
        probe.on('error', () => resolve(false));
        probe.on('close', code => resolve(code === 0));
    });
}

async function offerAutomaticInstall(context: vscode.ExtensionContext): Promise<string | undefined> {
    const artifact = platformArtifact();
    if (!artifact) {
        void vscode.window
            .showErrorMessage(
                `The SonarScanner CLI was not found, and no prebuilt scanner exists for this platform ` +
                    `(${process.platform}/${process.arch}). Install it manually and set "sonarcloud.scannerPath".`,
                'Install Instructions'
            )
            .then(choice => {
                if (choice === 'Install Instructions') {
                    void vscode.env.openExternal(vscode.Uri.parse(SCANNER_DOCS_URL));
                }
            });
        return undefined;
    }

    const download = 'Download Scanner';
    const manual = 'Install Manually';
    const choice = await vscode.window.showInformationMessage(
        `The SonarScanner CLI was not found. Download SonarScanner ${SCANNER_VERSION} (~60 MB, includes its own ` +
            'Java runtime) into the extension storage? This is a one-time setup.',
        download,
        manual
    );
    if (choice === manual) {
        void vscode.env.openExternal(vscode.Uri.parse(SCANNER_DOCS_URL));
        return undefined;
    }
    if (choice !== download) {
        return undefined;
    }

    try {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing SonarScanner CLI',
                cancellable: true
            },
            (progress, cancelToken) => installScanner(context, artifact, progress, cancelToken)
        );
    } catch (err) {
        if (err instanceof vscode.CancellationError) {
            return undefined;
        }
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`SonarScanner install failed: ${message}`);
        return undefined;
    }
}

async function canRunDotnetScanner(): Promise<boolean> {
    const shim = dotnetScannerShimPath();
    try {
        await fs.access(shim);
        return true;
    } catch {
        // Fall back to PATH/list probes below.
    }

    if (await isOnPath(dotnetScannerCommandName())) {
        return true;
    }

    const result = await runDotnetCommand(['tool', 'list', '--global']);
    return result.exitCode === 0 && /^dotnet-sonarscanner\s+/im.test(result.output);
}

function runDotnetCommand(args: string[]): Promise<{ exitCode: number; output: string }> {
    return new Promise(resolve => {
        let output = '';
        const child = spawn('dotnet', args, { shell: false, env: withDotnetToolPath(process.env) });
        child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.on('error', err => {
            output += err instanceof Error ? err.message : String(err);
            resolve({ exitCode: 1, output });
        });
        child.on('close', code => {
            resolve({ exitCode: code ?? 1, output: output.trim() });
        });
    });
}

export function withDotnetToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const toolsDir = dotnetToolsDir();
    const currentPath = env.PATH ?? env.Path ?? '';
    const segments = currentPath.split(path.delimiter).filter(Boolean);
    if (!segments.some(segment => path.normalize(segment) === path.normalize(toolsDir))) {
        segments.unshift(toolsDir);
    }

    return {
        ...env,
        PATH: segments.join(path.delimiter)
    };
}

function dotnetScannerShimPath(): string {
    return path.join(dotnetToolsDir(), dotnetScannerCommandName());
}

function dotnetToolsDir(): string {
    return path.join(os.homedir(), '.dotnet', 'tools');
}

function dotnetScannerCommandName(): string {
    return process.platform === 'win32' ? 'dotnet-sonarscanner.exe' : 'dotnet-sonarscanner';
}

async function installScanner(
    context: vscode.ExtensionContext,
    artifact: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancelToken: vscode.CancellationToken
): Promise<string> {
    const url = `${DOWNLOAD_BASE}/sonar-scanner-cli-${SCANNER_VERSION}-${artifact}.zip`;
    const root = installRoot(context);
    await fs.mkdir(root, { recursive: true });

    progress.report({ message: 'downloading…' });
    const zipBytes = await downloadWithProgress(url, progress, cancelToken);
    if (cancelToken.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    progress.report({ message: 'extracting…' });
    const zipPath = path.join(root, `download-${SCANNER_VERSION}-${artifact}.zip`);
    await fs.writeFile(zipPath, zipBytes);
    try {
        new AdmZip(zipPath).extractAllTo(root, true);
    } finally {
        await fs.rm(zipPath, { force: true });
    }

    const bin = installedBinPath(context, artifact);
    await fs.access(bin); // fail loudly if the archive layout was not what we expect

    // Zip extraction loses the executable bits the launcher and bundled JRE need.
    if (process.platform !== 'win32') {
        const installDir = path.dirname(path.dirname(bin));
        for (const dir of [path.join(installDir, 'bin'), path.join(installDir, 'jre', 'bin'), path.join(installDir, 'jre', 'lib')]) {
            try {
                for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                    if (entry.isFile()) {
                        await fs.chmod(path.join(dir, entry.name), 0o755);
                    }
                }
            } catch {
                // jre layout differs per platform; missing dirs are fine
            }
        }
    }

    void vscode.window.showInformationMessage(`SonarScanner ${SCANNER_VERSION} installed.`);
    return bin;
}

async function downloadWithProgress(
    url: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancelToken: vscode.CancellationToken
): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`download failed (HTTP ${res.status}) from ${url}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let reportedPercent = 0;
    for (;;) {
        if (cancelToken.isCancellationRequested) {
            await reader.cancel();
            throw new vscode.CancellationError();
        }
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) {
            const percent = Math.floor((received / total) * 100);
            if (percent > reportedPercent) {
                progress.report({
                    message: `downloading… ${percent}%`,
                    increment: percent - reportedPercent
                });
                reportedPercent = percent;
            }
        }
    }
    return Buffer.concat(chunks);
}
