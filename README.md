# SonarCloud Stats — VS Code Extension

Browse SonarCloud analysis results without leaving VS Code: projects, open issues (with severity and type filters), code coverage and other quality measures — for the main branch or any analyzed branch.

## Features

- **SonarCloud sidebar** (activity bar icon) with four views:
  - **Projects** — every project in your organization; click one to select it.
  - **Issues** — open issues for the selected project, grouped by file. Each issue shows its message, rule name, severity, type and `file:line` location. Clicking an issue opens the file at the exact location if it exists in your workspace; an eye icon opens a details panel with the full rule description, a link icon opens the issue on sonarcloud.io, and a sparkle icon sends the issue to Copilot Chat to fix (see below). Projects with more than 500 issues get a **Load more** row.
  - **Security Hotspots** — security-sensitive code awaiting review, grouped by file with risk (high/medium/low) and category. Click to jump to the code, or open the hotspot on sonarcloud.io for the full review flow.
  - **Coverage & Measures** — quality gate status, the new-code metrics the gate judges (coverage, bugs, vulnerabilities, hotspots, smells, duplication on new code), plus overall / line / condition coverage, unit-test counts, duplication, technical debt, ratings and lines of code.
- **Problems panel integration** — the loaded issues appear as real VS Code diagnostics (squiggles) on matching files in your workspace, with the rule key linking back to SonarCloud. Disable with the `sonarcloud.showDiagnostics` setting.
- **Quick fixes on the squiggles** — the lightbulb on a SonarCloud diagnostic offers *Fix this issue with Copilot*, *Explain this SonarCloud rule* and *Resolve on SonarCloud*, so you can act on a finding from the line you are reading instead of hunting for it in the sidebar. They appear in the Problems panel too.
- **Status bar summary** — quality gate state and open-issue count for the selected project/branch; click it to open the sidebar. When the gate has failed, the tooltip lists **which conditions failed** and by how much (`Coverage on New Code is 42.4%, required ≥ 80.0%`), so you don't have to open the web UI to find out why.
- **Failing quality gate conditions** — the Quality Gate row in **Coverage & Measures** expands to show every condition that tripped, with the value it reached and the bar it missed.
- **New issues since you last looked** — issues that were not in the list the last time this workspace saw it are marked `NEW`, and the view header says how many appeared and since when. The first complete, unfiltered load quietly becomes the baseline (so a project you have never opened is not "all new"); **SonarCloud: Mark Issues as Seen** resets it once you have triaged, and **Toggle New Issues Only** narrows the view to just the arrivals.
- **Severity filter** (`Blocker`, `Critical`, `Major`, `Minor`, `Info`), **type filter** (`Bug`, `Vulnerability`, `Code Smell`) and a **new-code toggle** (history icon) that limits issues to the project's new-code period — what the quality gate actually evaluates.
- **Issue actions** — right-click an issue to assign it (with a member picker), add a comment, or resolve it as false positive / won't fix / confirmed (resolving requires the *Administer Issues* permission on the project).
- **Branch selection** — the git-branch icon lists every branch SonarCloud has analyzed for the project. The branch currently checked out in your workspace is detected and highlighted, so you can jump straight to your feature branch's latest analysis. Issues, hotspots and measures all follow the selected branch.
- Selections and filters are remembered per workspace.

## Setup

1. Install the extension (see below) and open the **SonarCloud** icon in the activity bar.
2. Set the API token (key icon in the Projects view title, or **SonarCloud: Set API Token**): paste a token generated on sonarcloud.io under **Account → Security**. The token is stored in VS Code's secret storage, never in settings files. If you want to run local scans, that token also needs **Execute Analysis** permission on the target project or organization.
3. Set the organization (organization icon in the Projects view title, or **SonarCloud: Set Organization**): with a token stored, the extension lists the organizations your token has access to so you can pick one — or enter the key manually (the `my-org` part of `https://sonarcloud.io/organizations/my-org`).
4. Pick a project in the **Projects** view — issues and measures load automatically.

Both buttons stay in the Projects view title bar, so you can change the token or switch organization at any time. Switching organization clears the selected project.

## Local coverage report

**SonarCloud: Local Coverage Report** (beaker icon in the Coverage & Measures view, the status bar, or the command palette) answers "is this branch well covered enough to merge?" without a SonarCloud scan at all — it runs your tests, reads the report they produce, and shows:

- **Line coverage** — covered / total instrumented lines.
- **Condition coverage** — branch coverage, where the report format carries it.
- **Coverage on changed lines** — the pre-merge number: coverage restricted to the lines this branch adds or modifies versus its base. The diff is taken from the **merge base**, against the branch's upstream or `origin/main`/`origin/master`/`origin/develop` (override with `sonarcloud.coverage.baseBranch`), and includes uncommitted work — everything the merge would bring.
- **Unit test counts** — passed / failed / skipped, aggregated from any TRX or JUnit XML result files.

A **pass/fail banner** at the top answers the merge question directly: changed-line coverage is compared against `sonarcloud.coverage.changedLinesThreshold` (default 80%; set `0` to disable). A branch that changes no instrumented lines always passes, so the gate stays meaningful.

Below the tiles, a **changed files** table ranks what you touched by uncovered lines, and a **lowest coverage files** table ranks the whole repo. Clicking any file opens it at the first uncovered line. Changed source files with no coverage data at all are called out separately, since those are invisible in a percentage. **Copy summary for a PR** puts a Markdown version — verdict, metrics table and the files with gaps — on the clipboard.

The line-coverage tile also shows the **trend** — `+1.2 pts since the last run on this branch` — so a run answers "did this change help or hurt?", not just "what is the number". History is kept per workspace folder (last 25 runs) and prefers a baseline from the same branch, since comparing a feature branch against main's last run mostly measures the branch. Reset it with **SonarCloud: Clear Local Coverage History**.

**SonarCloud: Go to Next Uncovered Line** walks the gaps instead of making you read a table: it jumps to the next uncovered line in the file you are in — preferring the lines this branch changed, since 400 pre-existing gaps are not what you are here for — and wraps at the end. In a file with nothing left (or no coverage data), it offers the files that still owe tests, worst first.

**Uncovered lines are highlighted in the editor** after a run, with lines this branch changed marked more strongly (those are the ones a reviewer will ask about). Toggle with **SonarCloud: Toggle Coverage Highlighting** or `sonarcloud.coverage.highlightUncovered`; marks for a file are dropped as soon as you edit it, since the line numbers no longer line up.

After a run, a **status bar item** keeps the result in view: the coverage of the file you are editing alongside the project total, turning into a warning when changed-line coverage is below the threshold. Click it to reopen the report. The figure **survives a restart**, but a restored one is deliberately marked as history — a clock icon and a tooltip saying when it was measured — because it describes the code as it was, not as it is; it also stays quiet rather than re-raising a failed gate you may already have fixed. **SonarCloud: Clear Local Coverage History** forgets it. If the coverage command did not actually rewrite the report — a failed test run, say — the report says so above the figures rather than presenting old numbers as current.

Results are also published through **VS Code's own coverage UI**: the **Test Coverage** view lists the files with their percentages, and the editor's coverage gutter can be toggled on per file like any other coverage provider. This registers a `SonarCloud Local Coverage` entry in the Testing view — one item per workspace folder, runnable *with coverage* only, because measuring is what it does; it is not a test runner. Turn the whole thing off with `sonarcloud.coverage.nativeCoverage` if you would rather keep coverage in this extension's own report and highlighting.

**Watch mode** (`sonarcloud.coverage.watchReport`, or **SonarCloud: Toggle Coverage Watch**) keeps the figures live: after a run, the report it parsed is watched, and every time your own test watcher (`dotnet watch test`, `jest --watch`, …) rewrites it the status bar, gutter and report panel refresh. Only the report is re-read — the coverage command is never re-run, so nothing starts a test suite behind your back. A report that is still being written is skipped rather than half-read, and a watch refresh does not record a history entry, so the trend and the ratchet keep comparing against the last real run.

**The coverage ratchet** (`sonarcloud.coverage.ratchet`) fails a run when overall line coverage has *dropped* since the previous one. It catches what the changed-line gate cannot: deleted tests, or newly untested code the diff does not attribute to this branch. Losses smaller than `sonarcloud.coverage.ratchetTolerance` (default 0.1 pts) are treated as rounding, and the verdict names the run it compared against — including when that run was on another branch, since that comparison mostly measures the branch difference.

It reuses the language profile from the section below, so it runs the same coverage command as a local scan (turn that off with `sonarcloud.localScan.runCoverageCommand` to report on an existing report). Recognised formats: **LCOV**, **Cobertura**, **JaCoCo XML**, **OpenCover**, **dotnet-coverage XML**, **Clover** and **Go coverage profiles** — the format is detected from the file's content, not its name.

## Local scans

**SonarCloud: Scan Project Locally** (play icon in the Projects view, shown once a project is selected) runs a full SonarCloud analysis of your workspace folder without a CI pipeline:

1. It asks which branch to report the scan as — defaulting to your checked-out git branch. SonarCloud keeps **one analysis per branch**, so the scan replaces that branch's previous analysis; use a scratch name like `local-scan` if you don't want to touch CI-analyzed branches.
2. The **first scan in a workspace asks which language the project is**, with the languages detected from your files (`pubspec.yaml`, `package.json`, `pom.xml`, `go.mod`, `*.csproj`, …) offered first. The answer is remembered per workspace — change it any time with **SonarCloud: Select Local Scan Language**, or pin it in settings with `sonarcloud.localScan.language`. The choice decides which coverage command runs and which analysis property SonarCloud reads the report through:

   | Language | Coverage command | Report → property |
   | --- | --- | --- |
   | .NET (C#/VB/F#) | `dotnet test` (see below) | OpenCover / `dotnet-coverage` XML |
   | Flutter / Dart | `flutter test --coverage` (or `dart run coverage:test_with_coverage`) | `coverage/lcov.info` → `sonar.dart.lcov.reportPaths` |
   | JavaScript / TypeScript (incl. React) | your `test:coverage`/`coverage` script, else `npm test -- --coverage` (yarn/pnpm detected from the lockfile) | `coverage/lcov.info` → `sonar.javascript.lcov.reportPaths` |
   | Java / Kotlin (Maven) | `mvn -B verify` | `target/site/jacoco/jacoco.xml` → `sonar.coverage.jacoco.xmlReportPaths` |
   | Java / Kotlin (Gradle) | `gradle test jacocoTestReport` | `build/reports/jacoco/test/jacocoTestReport.xml` → `sonar.coverage.jacoco.xmlReportPaths` |
   | Python | `pytest --cov=. --cov-report=xml` | `coverage.xml` → `sonar.python.coverage.reportPaths` |
   | Go | `go test ./... -coverprofile=coverage.out` | `coverage.out` → `sonar.go.coverage.reportPaths` |
   | PHP | run PHPUnit with `--coverage-clover` yourself | `coverage/clover.xml` → `sonar.php.coverage.reportPaths` |
   | Ruby | run your suite with SimpleCov yourself | `coverage/.resultset.json` → `sonar.ruby.coverage.reportPaths` |
   | Other | none | sources only, no coverage |

   Each profile also contributes sensible exclusions (generated Dart files, `node_modules`, `.venv`, `vendor`, …). Turn the command off with `sonarcloud.localScan.runCoverageCommand` to upload whatever report is already on disk, or point at a non-standard report with `sonarcloud.localScan.coverageReportPath`. The output channel states which report was found and which property it was passed through — or warns, with the exact command to run, when no coverage will be uploaded.
3. It then runs the scanner for that language, unless you override `sonarcloud.localScan.mode`:
  - For `.NET` repos (`.sln`, `.csproj`, `.vbproj`, `.fsproj`), it uses [SonarScanner for .NET](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-for-dotnet.md): `begin` → `dotnet build` → `dotnet test` with XPlat OpenCover collection → `end`. If `dotnet-sonarscanner` is missing, the extension offers to install it as a global `dotnet` tool.
  - For other repos, it uses the [SonarScanner CLI](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-cli.md). The scanner is resolved in this order: the `sonarcloud.scannerPath` setting → a copy the extension installed earlier → `sonar-scanner` on `PATH`. **If none is found, the extension offers to download it for you** (~60 MB into the extension's storage) — the platform archives bundle their own Java runtime, so no JDK install is needed. If SonarCloud's JRE auto-provisioning fails because the cache cannot extract its downloaded runtime, the extension retries automatically with auto-provisioning disabled and the scanner's bundled Java.
  In CLI mode the token is passed via the environment and never shown on the command line. In `.NET` mode the extension also passes the token via the `SONAR_TOKEN` environment variable, so it stays out of the process command line too. If SonarScanner for .NET rejects that env-based auth during `begin`, the extension retries once with an explicit `sonar.token` argument because some scanner setups still behave better with that form. When `sonarcloud.localTest.buildTarget` is empty, the extension now prefers `dotnet.defaultSolution` or workspace solution files before falling back to per-project builds; this avoids false build/reference errors in Blazor and other repos that only compile cleanly through the solution. Before a local `.NET` scan starts, the extension also ensures `.sonarqube/` is present in the nearest repo `.gitignore`, sets `sonar.newCode.referenceBranch` to SonarCloud's current main branch when scanning a non-main branch, and successful runs remove both `.sonarqube` and `.scannerwork` afterward.
  When `.NET` mode is active, the extension now mirrors the pipeline defaults unless you override them: it builds all matching main projects from `sonarcloud.localTest.projectsToBuild`, runs every project matching `sonarcloud.localTest.projectsToTest`, and points SonarCloud at deterministic per-project coverage/test-result files automatically. If the global `dotnet-coverage` tool is installed, local scans prefer that SonarSource-documented XML flow; if it is missing, the extension offers to install it before falling back to `XPlat Code Coverage` / OpenCover collection. In that fallback path each test project still needs `coverlet.collector`. In both cases the reports land under `coverage/sonarcloud-local-scan`. Set `sonarcloud.localTest.enabled` to `false` if you want to skip tests and coverage for a one-off local run.
4. When the upload finishes it polls SonarCloud's compute-engine task until the report is processed, then switches the sidebar to the scanned branch, refreshes the views, and reports the recorded overall / line / condition coverage plus unit-test counts when SonarCloud exposes them.

If the branch you enter is the project's **main branch** on SonarCloud, the extension asks for explicit confirmation first, since a local scan would replace the CI-produced analysis (and its coverage) until the next pipeline run.

SonarCloud only publishes test-execution metrics such as unit-test counts, failures and skipped tests for **long-lived branches**. Scratch or other short-lived branches can still show coverage while leaving those test counters blank.

If SonarScanner for .NET fails during `begin` with HTTP `403`, the token is authenticated but lacks permission to analyze that project. Use a token whose user has **Execute Analysis** for the project or organization, typically same credential used by CI.

Requirements: Automatic Analysis disabled for the project (SonarCloud rejects scanner uploads while it is on — CI-based pipelines already imply it is off). To include coverage for JavaScript or other non-.NET scanners, generate a report locally first and point the scanner at it via `sonarcloud.scannerArgs`, e.g. `-Dsonar.javascript.lcov.reportPaths=coverage/lcov.info`. For .NET repos, local scan now uses SonarScanner for .NET so branch issues, new-code gating, and coverage come from the supported `begin/build/test/end` flow. `sonarcloud.localTest.*` settings let you mirror common CI parameters such as `projectsToBuild`, `projectsToTest`, `sonarExcludePattern`, `sonar.cs.opencover.reportsPaths` and `sonar.cs.vstest.reportsPaths`. An existing `sonar-project.properties` in the folder is respected in CLI mode; in .NET mode use the scanner properties described above.

## Copilot integration

The extension registers five [language model tools](https://code.visualstudio.com/api/extension-guides/tools) that GitHub Copilot Chat (agent mode) and other chat participants can call:

| Tool | Reference | What it returns |
| --- | --- | --- |
| `sonarcloud_list_projects` | `#sonarcloudProjects` | Projects in the configured organization. |
| `sonarcloud_get_issues` | `#sonarcloudIssues` | Open issues with rule, message, severity, type, file and line — filterable by severity, type and file path, and by `onlyNew` for what has appeared since this workspace last looked. |
| `sonarcloud_get_measures` | `#sonarcloudMeasures` | Quality gate, new-code metrics, coverage, duplication, ratings, technical debt — plus the conditions that failed, when it failed. |
| `sonarcloud_get_hotspots` | `#sonarcloudHotspots` | Security hotspots awaiting review, with risk, category, file and line. |
| `sonarcloud_get_rule` | `#sonarcloudRule` | A rule's full description: why it's a problem and how to fix it. |

The issue, measure and hotspot tools default to the project/branch selected in the SonarCloud sidebar, so a prompt like *"fix the critical SonarCloud issues in this repo"* in agent mode will pull the selected project's issues, read each rule's fix guidance, and edit the affected files. You can also reference the tools explicitly in a prompt, e.g. `#sonarcloudIssues what are the worst problems in this project?`.

The **sparkle icon on any issue** in the Issues view does this for a single issue: it opens Copilot Chat in agent mode with a prompt containing the issue's message, rule and location, instructing it to pin the current behavior with tests first, read the rule's guidance, apply the fix, and re-run the tests to prove the output is unchanged.

The **wand icon in the Issues view title** does it for the whole batch: every issue currently shown (after your severity/type/new-code filters) is sent to Copilot Chat in one agent-mode prompt, grouped by file, with the same discipline — write/run tests capturing current behavior **before** each change, fix per the rule's guidance, then re-run tests and build to confirm nothing observable changed; issues whose fix would change behavior are skipped and listed instead. Batches cap at 100 issues — use the filters to scope what gets fixed. The Problems-panel diagnostics also mean agent mode sees SonarCloud findings alongside compiler errors when it inspects a file.

Requires VS Code 1.95+ and a chat extension (e.g. GitHub Copilot Chat) to be installed; the tools use the same token/organization you configured for the sidebar.

## Commands

| Command | Description |
| --- | --- |
| `SonarCloud: Set Organization` | Store the organization key (setting `sonarcloud.organization`). |
| `SonarCloud: Set API Token` | Store or clear the API token (secret storage). |
| `SonarCloud: Select Branch` | Choose which analyzed branch to view. |
| `SonarCloud: Filter by Severity` | Multi-select severity filter for the Issues view. |
| `SonarCloud: Filter by Type` | Multi-select type filter for the Issues view. |
| `SonarCloud: Toggle New Code Focus` | Limit the Issues view to the project's new-code period. |
| `SonarCloud: Clear Filters` | Reset all filters (severity, type, new code). |
| `SonarCloud: Refresh` | Reload all views from SonarCloud. |
| `SonarCloud: Scan Project Locally` | Run the scanner for the workspace's language, producing coverage, and upload the analysis to SonarCloud. |
| `SonarCloud: Select Local Scan Language` | Choose which language local scans configure themselves for (detected languages offered first). |
| `SonarCloud: Local Coverage Report` | Run tests locally and report overall / changed-line coverage and test counts, without a SonarCloud scan. |
| `SonarCloud: Toggle Coverage Highlighting` | Show or hide uncovered-line highlighting from the last local coverage run. |
| `SonarCloud: Toggle Coverage Watch` | Re-read the coverage report automatically whenever your test watcher rewrites it. |
| `SonarCloud: Go to Next Uncovered Line` | Jump to the next uncovered line, changed lines first; offers the worst files when the current one is done. |
| `SonarCloud: Clear Local Coverage History` | Forget past local coverage runs used for the trend comparison. |
| `SonarCloud: Mark Issues as Seen` | Take the currently loaded issues as the baseline, so only later arrivals are marked `NEW`. |
| `SonarCloud: Toggle New Issues Only` | Show only the issues that appeared since your last check. |

Issue context-menu actions (right-click an issue): **Fix with Copilot**, **Assign Issue…**, **Add Comment…**, **Resolve Issue…**.

## Development

```bash
npm install
npm run compile   # or: npm run watch
npm test          # compiles, then runs the suite
```

There are two test layers:

**Unit** (`npm test`) — `node:test` against the compiled output in `out/`. `test/harness.js` routes `require('vscode')` to a stub (`test/vscodeStub.js`) whose `findFiles` really globs a fixture directory, so language detection, report discovery and path mapping are exercised for real rather than mocked away; `makeWorkspace()` builds throwaway trees on disk, and the git tests create actual repositories. `test/manifest.test.js` cross-checks `package.json` against the source — commands registered but not declared, settings read but not contributed, menu entries pointing at nothing.

**Integration** (`npm run test:integration`) — launches a real VS Code via `@vscode/test-electron`, installs the extension and runs `test/integration/suite` inside the extension host. This is the only layer that can prove the extension actually activates, that its commands reach the command registry, that the report HTML survives a real webview's CSP, that decorations apply to a real editor (and clear when the file is edited), and that diagnostics land in the Problems panel. On a headless machine, run it under a virtual display: `xvfb-run -a npm run test:integration`.

`npm run test:all` runs both.

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

To package a `.vsix` for manual installation:

```bash
npx @vscode/vsce package
code --install-extension sonarcloud-vscode-*.vsix
```

## How it works

The extension calls the public SonarCloud Web API with your token (HTTP basic auth):

- `api/components/search` — projects in the organization
- `api/project_branches/list` — analyzed branches for a project
- `api/issues/search` — open issues, with `branch`, `severities`, `types` and `sinceLeakPeriod` parameters
- `api/hotspots/search` — security hotspots awaiting review
- `api/measures/component` — coverage and quality metrics (overall and new-code period)
- `api/rules/show` — rule descriptions for the issue details panel
- `api/issues/assign`, `api/issues/add_comment`, `api/issues/do_transition` — issue actions
