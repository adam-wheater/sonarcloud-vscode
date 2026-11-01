import * as vscode from 'vscode';

/**
 * Where to write a setting the extension changes on the user's behalf.
 *
 * Writing to Global when a Workspace value exists is silently shadowed by it —
 * the setting "does not work" and nothing says why. Writing to Workspace with
 * no workspace open throws outright. So: write to the scope that is actually
 * in effect, and fall back to the widest scope that will accept the write.
 */
export function targetForSetting(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
    const scopes = config.inspect(key);
    if (scopes?.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (scopes?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    // A window with no folder open has no workspace settings file to write to.
    return hasWorkspace() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

function hasWorkspace(): boolean {
    return !!vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders ?? []).length > 0;
}
