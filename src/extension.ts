import * as vscode from 'vscode';
import { SonarBranch, SonarCloudClient, SonarCloudError, SonarProject } from './client';
import { SonarCodeActions } from './codeActions';
import { CoverageDecorations } from './coverageDecorations';
import { CoverageHistoryStore } from './coverageHistory';
import { nextGapLine, rankGaps } from './coverageNavigation';
import { CoverageStatusBar } from './coverageStatusBar';
import { NativeCoverageReporter } from './coverageTestController';
import { CoverageWatcher } from './coverageWatch';
import { SonarDiagnostics } from './diagnostics';
import { detectWorkspaceGitBranch } from './gitBranch';
import { HotspotNode, HotspotsProvider } from './hotspotsProvider';
import { showIssueDetails } from './issueDetails';
import { IssueNode, IssuesProvider, LoadedIssue } from './issuesProvider';
import { ISSUE_TYPES, SEVERITIES, titleCase } from './labels';
import { promptForLanguageProfile } from './languageProfiles';
import { registerLanguageModelTools } from './lmTools';
import { describeNewIssues, IssueBaselineStore } from './newIssues';
import { LocalCoverage } from './localCoverage';
import { LocalScanner } from './localScan';
import { MeasuresProvider } from './measuresProvider';
import { ProjectsProvider } from './projectsProvider';
import { targetForSetting } from './settings';
import { SonarState } from './state';
import { SonarStatusBar } from './statusBar';

const TOKEN_SECRET = 'sonarcloud.token';

export function activate(context: vscode.ExtensionContext): void {
    const state = new SonarState(context.workspaceState);
    const getToken = () => context.secrets.get(TOKEN_SECRET);
    const getOrganization = () =>
        vscode.workspace.getConfiguration('sonarcloud').get<string>('organization') || undefined;
    const client = new SonarCloudClient(getToken, getOrganization);
    const isConfigured = async () => !!(await getToken()) && !!getOrganization();

    const projectsProvider = new ProjectsProvider(client, state, isConfigured);
    const issueBaselines = new IssueBaselineStore(context.workspaceState);
    const issuesProvider = new IssuesProvider(client, state, issueBaselines);
    const hotspotsProvider = new HotspotsProvider(client, state);
    const measuresProvider = new MeasuresProvider(client, state);
    const diagnostics = new SonarDiagnostics(client, state);
    const statusBar = new SonarStatusBar(client, state);
    context.subscriptions.push(
        diagnostics,
        statusBar,
        // Quick fixes on the squiggles the diagnostics publish.
        vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new SonarCodeActions(diagnostics), {
            providedCodeActionKinds: SonarCodeActions.providedCodeActionKinds
        })
    );

    const projectsView = vscode.window.createTreeView('sonarcloud.projects', {
        treeDataProvider: projectsProvider
    });
    const issuesView = vscode.window.createTreeView('sonarcloud.issues', {
        treeDataProvider: issuesProvider
    });
    const hotspotsView = vscode.window.createTreeView('sonarcloud.hotspots', {
        treeDataProvider: hotspotsProvider
    });
    const measuresView = vscode.window.createTreeView('sonarcloud.measures', {
        treeDataProvider: measuresProvider
    });
    context.subscriptions.push(projectsView, issuesView, hotspotsView, measuresView);

    function refreshAll(): void {
        projectsProvider.refresh();
        issuesProvider.refresh();
        hotspotsProvider.refresh();
        measuresProvider.refresh();
        void statusBar.refresh();
    }

    async function updateContexts(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'sonarcloud.configured', await isConfigured());
        await vscode.commands.executeCommand('setContext', 'sonarcloud.projectSelected', !!state.project);
    }

    function updateViewDescriptions(): void {
        const project = state.project;
        const scope = project ? `${project.name} · ${state.branch ?? 'main branch'}` : '';
        issuesView.description = scope;
        hotspotsView.description = scope;
        measuresView.description = scope;
    }

    // The issues currently shown in the Issues view (after filters), as last
    // loaded — consumed by the bulk "fix with Copilot" command.
    let loadedIssues: LoadedIssue[] = [];

    function filterSummary(): string {
        const parts: string[] = [];
        if (state.newCodeOnly) {
            parts.push('new code only');
        }
        if (state.newIssuesOnly) {
            parts.push('new since last check');
        }
        if (state.severities.length) {
            parts.push(`severity: ${state.severities.map(titleCase).join(', ')}`);
        }
        if (state.types.length) {
            parts.push(`type: ${state.types.map(titleCase).join(', ')}`);
        }
        return parts.join(' · ');
    }

    context.subscriptions.push(
        issuesProvider.onDidLoad(({ shown, total, newCount, newSince }) => {
            const counts = total > shown ? `${shown} of ${total} open issues` : `${total} open issue${total === 1 ? '' : 's'}`;
            const filters = filterSummary();
            const base = filters ? `${counts} — filtered (${filters})` : counts;
            const fresh = describeNewIssues(newCount ?? 0, newSince);
            issuesView.message = fresh ? `${base} · ${fresh}` : base;
        }),
        // A failed load renders an error row; the old count above it would lie.
        issuesProvider.onDidFailLoad(() => {
            issuesView.message = undefined;
        }),
        issuesProvider.onDidLoadIssues(items => {
            loadedIssues = items;
            void diagnostics.publish(items);
        })
    );

    context.subscriptions.push(
        state.onDidChange(() => {
            void updateContexts();
            updateViewDescriptions();
            if (!state.project) {
                issuesView.message = undefined;
                diagnostics.clear();
            }
            issuesProvider.refresh();
            hotspotsProvider.refresh();
            measuresProvider.refresh();
            projectsProvider.redraw(); // updates the selected-project checkmark without refetching
            void statusBar.refresh();
        }),
        context.secrets.onDidChange(e => {
            if (e.key === TOKEN_SECRET) {
                void updateContexts();
                refreshAll();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('sonarcloud.organization')) {
                // The old project list and selection belong to the previous organization.
                projectsProvider.refresh();
                // Clearing the selection fires state.onDidChange, which updates
                // contexts and refreshes the issue/measure views.
                void state.setProject(undefined);
            }
            if (e.affectsConfiguration('sonarcloud.showDiagnostics')) {
                if (SonarDiagnostics.enabled) {
                    issuesProvider.refresh(); // reload fires onDidLoadIssues, which republishes
                } else {
                    diagnostics.clear();
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('sonarcloud.setToken', async () => {
            const token = await vscode.window.showInputBox({
                title: 'SonarCloud API Token',
                prompt: 'Generate a token on sonarcloud.io under Account → Security. Local scans also need Execute Analysis permission on the target project or organization. Leave empty to clear the stored token.',
                password: true,
                ignoreFocusOut: true
            });
            if (token === undefined) {
                return;
            }
            if (token === '') {
                await context.secrets.delete(TOKEN_SECRET);
                void vscode.window.showInformationMessage('SonarCloud token cleared.');
            } else {
                await context.secrets.store(TOKEN_SECRET, token.trim());
                void vscode.window.showInformationMessage('SonarCloud token saved.');
            }
        }),

        vscode.commands.registerCommand('sonarcloud.setOrganization', async () => {
            let organizationKey: string | undefined;
            let manualEntry = true;

            // With a token stored we can list the user's organizations instead of asking for the key blind.
            if (await getToken()) {
                interface OrgPick extends vscode.QuickPickItem {
                    key?: string;
                }
                let items: OrgPick[] | undefined;
                try {
                    const current = getOrganization();
                    const organizations = await client.listMyOrganizations();
                    if (organizations.length > 0) {
                        items = organizations.map(org => ({
                            label: org.name,
                            description: org.key === current ? `${org.key} · current` : org.key,
                            key: org.key
                        }));
                        items.push({ label: '$(edit) Enter an organization key manually…' });
                    }
                } catch (err) {
                    const message = err instanceof SonarCloudError ? err.message : String(err);
                    void vscode.window.showWarningMessage(
                        `SonarCloud: could not list your organizations (${message}); enter the key manually.`
                    );
                }
                if (items) {
                    const chosen = await vscode.window.showQuickPick(items, {
                        title: 'SonarCloud Organization',
                        placeHolder: 'Organizations your token has access to'
                    });
                    if (!chosen) {
                        return;
                    }
                    if (chosen.key) {
                        organizationKey = chosen.key;
                        manualEntry = false;
                    }
                }
            }

            if (manualEntry) {
                const value = await vscode.window.showInputBox({
                    title: 'SonarCloud Organization',
                    prompt: 'Organization key, e.g. "my-org" from https://sonarcloud.io/organizations/my-org',
                    value: getOrganization() ?? '',
                    ignoreFocusOut: true
                });
                if (value === undefined) {
                    return;
                }
                organizationKey = value.trim();
            }

            // Write to the scope currently in effect — updating Global while a
            // workspace-level value exists would be silently shadowed by it.
            const config = vscode.workspace.getConfiguration('sonarcloud');
            await config.update('organization', organizationKey, targetForSetting(config, 'organization'));
        }),

        vscode.commands.registerCommand('sonarcloud.refresh', () => refreshAll()),

        vscode.commands.registerCommand('sonarcloud.selectProject', async (project: SonarProject) => {
            await state.setProject({ key: project.key, name: project.name });
        }),

        vscode.commands.registerCommand('sonarcloud.selectBranch', async () => {
            const project = state.project;
            if (!project) {
                void vscode.window.showInformationMessage('Select a SonarCloud project first.');
                return;
            }
            let branches: SonarBranch[];
            try {
                branches = await client.listBranches(project.key);
            } catch (err) {
                const message = err instanceof SonarCloudError ? err.message : String(err);
                void vscode.window.showErrorMessage(`SonarCloud: failed to list branches — ${message}`);
                return;
            }
            const currentCheckout = await detectWorkspaceGitBranch();
            branches.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name));

            interface BranchPick extends vscode.QuickPickItem {
                branch: SonarBranch;
            }
            const items: BranchPick[] = branches.map(branch => {
                const notes: string[] = [];
                if (branch.isMain) {
                    notes.push('main branch');
                }
                if (branch.name === currentCheckout) {
                    notes.push('current checkout');
                }
                if (branch.status?.qualityGateStatus) {
                    notes.push(`quality gate: ${branch.status.qualityGateStatus === 'OK' ? 'passed' : 'failed'}`);
                }
                return {
                    label: `$(git-branch) ${branch.name}`,
                    description: notes.join(' · '),
                    detail: branch.analysisDate
                        ? `Last analysis: ${new Date(branch.analysisDate).toLocaleString()}`
                        : 'Not analyzed yet',
                    branch
                };
            });
            const quickPick = vscode.window.createQuickPick<BranchPick>();
            quickPick.title = `SonarCloud branch for ${project.name}`;
            quickPick.placeholder = 'Select the branch to view analysis for';
            quickPick.items = items;
            const active = items.find(
                i => i.branch.name === (state.branch ?? currentCheckout) || (!state.branch && !currentCheckout && i.branch.isMain)
            );
            if (active) {
                quickPick.activeItems = [active];
            }
            quickPick.onDidAccept(async () => {
                const picked = quickPick.selectedItems[0];
                quickPick.hide();
                if (picked) {
                    // Store undefined for the main branch so the default analysis is used.
                    await state.setBranch(picked.branch.isMain ? undefined : picked.branch.name);
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }),

        vscode.commands.registerCommand('sonarcloud.filterSeverity', async () => {
            const current = state.severities;
            const picks = await vscode.window.showQuickPick(
                SEVERITIES.map(severity => ({
                    label: titleCase(severity),
                    value: severity,
                    picked: current.length === 0 || current.includes(severity)
                })),
                {
                    canPickMany: true,
                    title: 'Filter Issues by Severity',
                    placeHolder: 'Severities to show — selecting all (or none) clears the filter'
                }
            );
            if (!picks) {
                return;
            }
            const values = picks.map(p => p.value);
            await state.setSeverities(values.length === 0 || values.length === SEVERITIES.length ? [] : values);
        }),

        vscode.commands.registerCommand('sonarcloud.filterType', async () => {
            const current = state.types;
            const picks = await vscode.window.showQuickPick(
                ISSUE_TYPES.map(type => ({
                    label: titleCase(type),
                    value: type,
                    picked: current.length === 0 || current.includes(type)
                })),
                {
                    canPickMany: true,
                    title: 'Filter Issues by Type',
                    placeHolder: 'Types to show — selecting all (or none) clears the filter'
                }
            );
            if (!picks) {
                return;
            }
            const values = picks.map(p => p.value);
            await state.setTypes(values.length === 0 || values.length === ISSUE_TYPES.length ? [] : values);
        }),

        vscode.commands.registerCommand('sonarcloud.clearFilters', async () => {
            await state.clearFilters();
        }),

        vscode.commands.registerCommand('sonarcloud.toggleNewCode', async () => {
            await state.setNewCodeOnly(!state.newCodeOnly);
        }),

        vscode.commands.registerCommand('sonarcloud.selectScanLanguage', async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            const folder =
                folders.length <= 1
                    ? folders[0]
                    : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to configure' });
            if (!folder) {
                void vscode.window.showInformationMessage('Open a folder before choosing a local scan language.');
                return;
            }
            const picked = await promptForLanguageProfile(folder, state.scanLanguage);
            if (!picked) {
                return;
            }
            await state.setScanLanguage(picked.id);
            const overridden = vscode.workspace
                .getConfiguration('sonarcloud')
                .get<string>('localScan.language', 'auto');
            void vscode.window.showInformationMessage(
                overridden && overridden !== 'auto'
                    ? `Local scans will use ${picked.label} once "sonarcloud.localScan.language" is set back to "auto" — that setting currently overrides this choice.`
                    : `Local scans in this workspace will be configured for ${picked.label}.`
            );
        }),

        vscode.commands.registerCommand('sonarcloud.loadMoreIssues', () => {
            issuesProvider.loadMore();
        }),

        vscode.commands.registerCommand('sonarcloud.toggleNewIssuesOnly', async () => {
            await state.setNewIssuesOnly(!state.newIssuesOnly);
        }),

        vscode.commands.registerCommand('sonarcloud.markIssuesSeen', async () => {
            if (await issuesProvider.markSeen()) {
                void vscode.window.showInformationMessage(
                    'Issues marked as seen — anything that turns up from now on is flagged as new.'
                );
            } else {
                void vscode.window.showInformationMessage(
                    'Load the Issues view for a project first — there is nothing to mark as seen yet.'
                );
            }
        }),

        vscode.commands.registerCommand('sonarcloud.assignIssue', async (node: IssueNode) => {
            if (!node?.issue) {
                return;
            }
            interface AssigneePick extends vscode.QuickPickItem {
                login?: string;
                manual?: boolean;
                unassign?: boolean;
            }
            const items: AssigneePick[] = [];
            try {
                const members = await client.listOrganizationMembers();
                items.push(...members.map(m => ({ label: m.name, description: m.login, login: m.login })));
            } catch {
                // Fall back to manual entry when the members endpoint is unavailable.
            }
            items.push(
                { label: '$(edit) Enter a login manually…', manual: true },
                { label: '$(discard) Unassign', unassign: true }
            );
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Assign SonarCloud Issue',
                placeHolder: 'Who should this issue be assigned to?',
                matchOnDescription: true
            });
            if (!picked) {
                return;
            }
            let assignee: string | undefined;
            if (picked.manual) {
                const login = await vscode.window.showInputBox({
                    title: 'Assign SonarCloud Issue',
                    prompt: 'SonarCloud login of the assignee',
                    ignoreFocusOut: true
                });
                if (!login) {
                    return;
                }
                assignee = login.trim();
            } else if (!picked.unassign) {
                assignee = picked.login;
            }
            try {
                await client.assignIssue(node.issue.key, assignee);
                void vscode.window.showInformationMessage(
                    assignee ? `Issue assigned to ${assignee}.` : 'Issue unassigned.'
                );
            } catch (err) {
                const message = err instanceof SonarCloudError ? err.message : String(err);
                void vscode.window.showErrorMessage(`SonarCloud: could not assign the issue — ${message}`);
            }
        }),

        vscode.commands.registerCommand('sonarcloud.commentIssue', async (node: IssueNode) => {
            if (!node?.issue) {
                return;
            }
            const text = await vscode.window.showInputBox({
                title: 'Comment on SonarCloud Issue',
                prompt: node.issue.message,
                placeHolder: 'Comment text (markdown supported)',
                ignoreFocusOut: true
            });
            if (!text?.trim()) {
                return;
            }
            try {
                await client.addIssueComment(node.issue.key, text.trim());
                void vscode.window.showInformationMessage('Comment added.');
            } catch (err) {
                const message = err instanceof SonarCloudError ? err.message : String(err);
                void vscode.window.showErrorMessage(`SonarCloud: could not add the comment — ${message}`);
            }
        }),

        vscode.commands.registerCommand('sonarcloud.resolveIssue', async (node: IssueNode) => {
            if (!node?.issue) {
                return;
            }
            interface TransitionPick extends vscode.QuickPickItem {
                transition: string;
            }
            const picked = await vscode.window.showQuickPick<TransitionPick>(
                [
                    {
                        label: 'False Positive',
                        description: 'The rule does not apply here',
                        transition: 'falsepositive'
                    },
                    {
                        label: "Won't Fix",
                        description: 'Valid, but not worth fixing',
                        transition: 'wontfix'
                    },
                    {
                        label: 'Confirm',
                        description: 'Mark the issue as confirmed (stays open)',
                        transition: 'confirm'
                    }
                ],
                {
                    title: 'Resolve SonarCloud Issue',
                    placeHolder: node.issue.message
                }
            );
            if (!picked) {
                return;
            }
            try {
                await client.transitionIssue(node.issue.key, picked.transition);
                void vscode.window.showInformationMessage(`Issue marked as ${picked.label}.`);
                issuesProvider.refresh(); // resolved issues leave the open list
            } catch (err) {
                const message = err instanceof SonarCloudError ? err.message : String(err);
                void vscode.window.showErrorMessage(
                    `SonarCloud: could not resolve the issue — ${message} (requires the "Administer Issues" permission).`
                );
            }
        }),

        vscode.commands.registerCommand('sonarcloud.fixWithCopilot', async (node: IssueNode) => {
            if (!node?.issue) {
                return;
            }
            const issue = node.issue;
            const location = node.path
                ? `${node.path}${issue.line !== undefined ? ` at line ${issue.line}` : ''}`
                : 'project level';
            const query =
                `Fix this SonarCloud issue in ${location}: "${issue.message}" ` +
                `(rule ${issue.rule}, ${titleCase(issue.severity)} ${titleCase(issue.type)}). ` +
                `Call the sonarcloud_get_rule tool with ruleKey "${issue.rule}" to learn why it is a ` +
                'problem and the intended fix. Before changing anything, make sure the current behavior is pinned by ' +
                'unit tests (write focused ones first if none cover this code, and run them). Then apply the fix and ' +
                're-run the tests to prove the observable behavior and outputs have not changed.';
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
            } catch {
                void vscode.window.showErrorMessage(
                    'Could not open a chat view — is a chat extension such as GitHub Copilot Chat installed?'
                );
            }
        }),

        vscode.commands.registerCommand('sonarcloud.fixAllWithCopilot', async () => {
            if (!state.project) {
                void vscode.window.showInformationMessage('Select a project in the SonarCloud sidebar first.');
                return;
            }
            if (loadedIssues.length === 0) {
                void vscode.window.showInformationMessage(
                    'No SonarCloud issues are loaded — open the Issues view (or relax the filters) first.'
                );
                return;
            }
            // Keep the prompt manageable; the sidebar filters are the knob for scoping the batch.
            const MAX_ISSUES = 100;
            const batch = loadedIssues.slice(0, MAX_ISSUES);
            const issueLines = batch.map(({ issue, path: filePath }) => {
                const location = filePath ? `${filePath}${issue.line !== undefined ? `:${issue.line}` : ''}` : 'project level';
                return `- ${location} — [${issue.rule}] ${issue.message} (${titleCase(issue.severity)} ${titleCase(issue.type)})`;
            });
            const filters = filterSummary();
            const truncationNote =
                loadedIssues.length > batch.length
                    ? ` (the first ${MAX_ISSUES} of ${loadedIssues.length} — narrow the sidebar filters to batch the rest later)`
                    : '';
            const query = [
                `Fix the following ${batch.length} SonarCloud issues${truncationNote} in this workspace` +
                    `${filters ? ` (currently filtered by ${filters})` : ''}. They are code-quality findings — the goal is to ` +
                    'resolve them WITHOUT changing any observable behavior or output.',
                '',
                'Group the issues by file and work through them file by file, following this strict order for each file:',
                '1. BEFORE changing anything, pin the current behavior with unit tests: if tests already cover the affected code, run them to confirm they pass; if not, write focused tests that capture the current observable behavior/outputs first, and run them.',
                '2. Apply the fixes for that file. Use the sonarcloud_get_rule tool with each issue\'s rule key (in brackets below) to understand why it is a problem and the fix the rule intends.',
                '3. Re-run the tests (and the build) to prove the outcome/output has not changed before moving to the next file.',
                '',
                'If a fix would necessarily change observable behavior, or you cannot pin the behavior with a test, skip that issue and list it at the end with a short explanation instead of guessing.',
                '',
                'Issues to fix:',
                ...issueLines
            ].join('\n');
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
            } catch {
                void vscode.window.showErrorMessage(
                    'Could not open a chat view — is a chat extension such as GitHub Copilot Chat installed?'
                );
            }
        }),

        vscode.commands.registerCommand('sonarcloud.openHotspot', async (node: HotspotNode) => {
            if (!node?.hotspot) {
                return;
            }
            const uri = node.path ? await findInWorkspace(node.path) : undefined;
            if (uri) {
                const line = node.hotspot.line;
                const range =
                    line !== undefined
                        ? new vscode.Range(Math.max(line - 1, 0), 0, Math.max(line - 1, 0), 0)
                        : undefined;
                await vscode.window.showTextDocument(uri, { selection: range, preview: true });
                return;
            }
            await vscode.env.openExternal(
                vscode.Uri.parse(client.hotspotUrl(node.hotspot.project, node.hotspot.key, state.branch))
            );
        }),

        vscode.commands.registerCommand('sonarcloud.openHotspotInBrowser', async (node: HotspotNode) => {
            if (node?.hotspot) {
                await vscode.env.openExternal(
                    vscode.Uri.parse(client.hotspotUrl(node.hotspot.project, node.hotspot.key, state.branch))
                );
            }
        }),

        vscode.commands.registerCommand('sonarcloud.openIssue', async (node: IssueNode) => {
            if (!node?.issue) {
                return;
            }
            const uri = node.path ? await findInWorkspace(node.path) : undefined;
            if (uri) {
                const issue = node.issue;
                const range = issue.textRange
                    ? new vscode.Range(
                          Math.max(issue.textRange.startLine - 1, 0),
                          issue.textRange.startOffset,
                          Math.max(issue.textRange.endLine - 1, 0),
                          issue.textRange.endOffset
                      )
                    : issue.line !== undefined
                      ? new vscode.Range(Math.max(issue.line - 1, 0), 0, Math.max(issue.line - 1, 0), 0)
                      : undefined;
                await vscode.window.showTextDocument(uri, { selection: range, preview: true });
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                node.path
                    ? `"${node.path}" was not found in this workspace.`
                    : 'This issue has no file location.',
                'Show Details',
                'Open on SonarCloud'
            );
            if (choice === 'Show Details') {
                await showIssueDetails(client, node.issue, node.path, state.branch);
            } else if (choice === 'Open on SonarCloud') {
                await vscode.env.openExternal(vscode.Uri.parse(client.issueUrl(node.issue, state.branch)));
            }
        }),

        vscode.commands.registerCommand('sonarcloud.showIssueDetails', async (node: IssueNode) => {
            if (node?.issue) {
                await showIssueDetails(client, node.issue, node.path, state.branch);
            }
        }),

        vscode.commands.registerCommand('sonarcloud.openIssueInBrowser', async (node: IssueNode) => {
            if (node?.issue) {
                await vscode.env.openExternal(vscode.Uri.parse(client.issueUrl(node.issue, state.branch)));
            }
        }),

        vscode.commands.registerCommand('sonarcloud.openProjectInBrowser', async (project: SonarProject) => {
            if (project?.key) {
                await vscode.env.openExternal(vscode.Uri.parse(client.projectUrl(project.key, state.branch)));
            }
        })
    );

    const localScanner = new LocalScanner(context, client, state, getToken);
    const coverageDecorations = new CoverageDecorations();
    const coverageHistory = new CoverageHistoryStore(context.workspaceState);
    const localCoverage = new LocalCoverage(state, coverageDecorations, coverageHistory);
    const coverageStatusBar = new CoverageStatusBar(context.workspaceState);
    // Publishes runs through VS Code's own coverage UI, and keeps them current
    // when an external test watcher rewrites the report.
    const nativeCoverage = new NativeCoverageReporter(folder => localCoverage.run({ folder }));
    const coverageWatcher = new CoverageWatcher(folder => localCoverage.refreshFromReport(folder));
    context.subscriptions.push(
        localScanner,
        coverageDecorations,
        localCoverage,
        coverageStatusBar,
        nativeCoverage,
        coverageWatcher,
        localCoverage.onDidRun(run => {
            coverageStatusBar.update(run);
            if (run.coverage) {
                nativeCoverage.publish(run.folder, run.coverage);
                coverageWatcher.track(run.folder, run.coverage.reportPath);
                coverageStatusBar.setWatching(coverageWatcher.isWatching);
            }
        }),
        vscode.commands.registerCommand('sonarcloud.openCoverageReport', () => localCoverage.reveal()),
        vscode.commands.registerCommand('sonarcloud.scanLocally', () => localScanner.run()),
        vscode.commands.registerCommand('sonarcloud.localCoverage', () => localCoverage.run()),
        vscode.commands.registerCommand('sonarcloud.toggleCoverageWatch', async () => {
            const watching = await coverageWatcher.toggle();
            coverageStatusBar.setWatching(coverageWatcher.isWatching);
            const target = coverageWatcher.target;
            if (watching && !target) {
                void vscode.window
                    .showInformationMessage(
                        'Coverage watch is on. Run local coverage once so it knows which report to watch.',
                        'Run Local Coverage'
                    )
                    .then(choice => {
                        if (choice === 'Run Local Coverage') {
                            void localCoverage.run();
                        }
                    });
                return;
            }
            void vscode.window.showInformationMessage(
                watching
                    ? `Watching "${target?.reportPath}" — coverage will refresh whenever your tests rewrite it.`
                    : 'Coverage watch is off.'
            );
        }),
        vscode.commands.registerCommand('sonarcloud.clearCoverageHistory', async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            const folder =
                folders.length <= 1
                    ? folders[0]
                    : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to clear history for' });
            if (!folder) {
                return;
            }
            await coverageHistory.clear(folder);
            await coverageStatusBar.clear();
            void vscode.window.showInformationMessage(`Local coverage history cleared for "${folder.name}".`);
        }),

        vscode.commands.registerCommand('sonarcloud.goToNextUncovered', async () => {
            if (!coverageDecorations.hasData || !coverageDecorations.coveredFolder) {
                // Not awaited: a notification stays up until it is dismissed,
                // and the command should not still be "running" until then.
                void vscode.window
                    .showInformationMessage(
                        'No coverage has been measured yet, so there are no gaps to walk.',
                        'Run Local Coverage'
                    )
                    .then(choice => {
                        if (choice === 'Run Local Coverage') {
                            void localCoverage.run();
                        }
                    });
                return;
            }
            const folder = coverageDecorations.coveredFolder;
            const editor = vscode.window.activeTextEditor;
            const gaps = editor ? coverageDecorations.gapsFor(editor.document.uri) : undefined;
            if (editor && gaps) {
                // Cursor line is zero-based; coverage lines are one-based.
                const line = nextGapLine(gaps, editor.selection.active.line + 1);
                if (line !== undefined) {
                    revealLine(editor, line);
                    return;
                }
            }

            // Nothing left in this file (or it has no coverage data): offer the
            // files that still owe tests, worst first.
            const ranked = rankGaps(coverageDecorations.gaps);
            if (ranked.length === 0) {
                void vscode.window.showInformationMessage('Every measured line is covered.');
                return;
            }
            interface GapPick extends vscode.QuickPickItem {
                gap: (typeof ranked)[number];
            }
            const picked = await vscode.window.showQuickPick<GapPick>(
                ranked.map(gap => ({
                    label: `$(file) ${gap.path}`,
                    description:
                        gap.changed > 0
                            ? `${gap.changed} uncovered changed line${gap.changed === 1 ? '' : 's'}`
                            : `${gap.total} uncovered line${gap.total === 1 ? '' : 's'}`,
                    gap
                })),
                { title: 'Uncovered lines', placeHolder: 'Files this branch has not covered' }
            );
            if (!picked) {
                return;
            }
            const document = await vscode.workspace.openTextDocument(
                vscode.Uri.joinPath(folder.uri, picked.gap.path)
            );
            revealLine(await vscode.window.showTextDocument(document, { preview: true }), picked.gap.firstLine);
        }),

        vscode.commands.registerCommand('sonarcloud.toggleCoverageHighlight', () => {
            const enabled = coverageDecorations.toggle();
            if (enabled && !coverageDecorations.hasData) {
                void vscode.window
                    .showInformationMessage(
                        'Coverage highlighting is on, but no coverage has been measured yet.',
                        'Run Local Coverage'
                    )
                    .then(choice => {
                        if (choice === 'Run Local Coverage') {
                            void localCoverage.run();
                        }
                    });
                return;
            }
            void vscode.window.showInformationMessage(
                enabled ? 'Uncovered lines are highlighted.' : 'Coverage highlighting is off.'
            );
        })
    );

    registerLanguageModelTools(context, client, state, issueBaselines);

    void updateContexts();
    updateViewDescriptions();
    void statusBar.refresh();
}

/** Put a one-based coverage line in view, with the cursor on it. */
function revealLine(editor: vscode.TextEditor, line: number): void {
    const zeroBased = Math.max(Math.min(line - 1, editor.document.lineCount - 1), 0);
    const range = editor.document.lineAt(zeroBased).range;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function findInWorkspace(relativePath: string): Promise<vscode.Uri | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const candidate = vscode.Uri.joinPath(folder.uri, relativePath);
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // keep looking
        }
    }
    // The SonarCloud project may live in a subdirectory of the workspace. Glob
    // patterns have no escape syntax, so skip this fallback for the rare path
    // that contains a metacharacter rather than match the wrong file.
    if (/[[\]{}*?]/.test(relativePath)) {
        return undefined;
    }
    const matches = await vscode.workspace.findFiles(`**/${relativePath}`, '**/node_modules/**', 1);
    return matches[0];
}

export function deactivate(): void {
    // nothing to clean up
}
