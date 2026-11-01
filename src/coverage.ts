import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Parsing for the coverage formats the language profiles produce, plus the
 * test-result formats that sit next to them. Everything is normalised to one
 * model — per-file line hit counts — so the report does not care which
 * ecosystem produced the numbers.
 */

export interface FileCoverage {
    /** Workspace-relative POSIX path. */
    path: string;
    /** Line number → times executed (0 means instrumented but never hit). */
    lines: Map<number, number>;
    branchesCovered: number;
    branchesTotal: number;
}

export interface CoverageData {
    files: FileCoverage[];
    /** Human label of the detected format, e.g. "LCOV". */
    format: string;
    /** Workspace-relative path of the parsed report. */
    reportPath: string;
    /** Report file mtime, so the UI can flag a stale report. */
    generatedAt: Date;
    /** Reported paths that could not be matched to a workspace file. */
    unresolvedPaths: string[];
}

export interface CoverageTotals {
    linesCovered: number;
    linesTotal: number;
    branchesCovered: number;
    branchesTotal: number;
}

export interface TestTotals {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    /** How many result files contributed. */
    sources: number;
}

/**
 * A line number a report can plausibly mean. Malformed reports do contain
 * negative or absurd values, and counting them would both skew the coverage
 * percentage and put phantom rows in the report.
 */
const MAX_PLAUSIBLE_LINE = 10_000_000;

function parseLineNumber(value: string | undefined): number | undefined {
    const line = Number(value);
    return Number.isInteger(line) && line > 0 && line <= MAX_PLAUSIBLE_LINE ? line : undefined;
}

function parseHitCount(value: string | undefined): number {
    const hits = Number(value);
    return Number.isFinite(hits) && hits > 0 ? hits : 0;
}

/** Raw parser output, before report paths are matched to workspace files. */
interface RawFile {
    reportedPath: string;
    lines: Map<number, number>;
    branchesCovered: number;
    branchesTotal: number;
}

export function totalsFor(files: FileCoverage[]): CoverageTotals {
    const totals: CoverageTotals = { linesCovered: 0, linesTotal: 0, branchesCovered: 0, branchesTotal: 0 };
    for (const file of files) {
        for (const hits of file.lines.values()) {
            totals.linesTotal++;
            if (hits > 0) {
                totals.linesCovered++;
            }
        }
        totals.branchesCovered += file.branchesCovered;
        totals.branchesTotal += file.branchesTotal;
    }
    return totals;
}

export function percent(covered: number, total: number): number | undefined {
    return total > 0 ? (covered / total) * 100 : undefined;
}

export interface CoverageGate {
    /** False when no threshold is configured or nothing changed to judge. */
    applicable: boolean;
    passed: boolean;
    threshold: number;
    percent: number | undefined;
    covered: number;
    total: number;
}

/**
 * Verdict for "is this branch covered well enough to merge?". A branch that
 * changes no instrumented lines passes trivially — there is nothing to cover,
 * and failing it would just train people to ignore the gate.
 */
export function evaluateGate(covered: number, total: number, threshold: number): CoverageGate {
    const ratio = percent(covered, total);
    const applicable = threshold > 0 && total > 0;
    return {
        applicable,
        passed: !applicable || (ratio ?? 100) >= threshold,
        threshold,
        percent: ratio,
        covered,
        total
    };
}

/**
 * Split a file's instrumented lines into what the editor should mark. Changed
 * uncovered lines are called out separately: on a feature branch they are the
 * lines a reviewer will actually ask about.
 */
export function classifyLines(
    file: FileCoverage,
    changedLines: Set<number> | undefined
): { uncovered: number[]; uncoveredChanged: number[] } {
    const uncovered: number[] = [];
    const uncoveredChanged: number[] = [];
    for (const [line, hits] of file.lines) {
        if (hits > 0) {
            continue;
        }
        if (changedLines?.has(line)) {
            uncoveredChanged.push(line);
        } else {
            uncovered.push(line);
        }
    }
    uncovered.sort((a, b) => a - b);
    uncoveredChanged.sort((a, b) => a - b);
    return { uncovered, uncoveredChanged };
}

// ---------------------------------------------------------------- formats ---

/** Sniff the format from the file's content, not its name — names vary wildly. */
function detectFormat(content: string, reportPath: string): string | undefined {
    if (/^\s*(TN:|SF:)/m.test(content)) {
        return 'LCOV';
    }
    if (/^mode:\s*(set|count|atomic)/m.test(content)) {
        return 'Go coverage profile';
    }
    if (/<coverage[^>]*\bclover\b/i.test(content) || /<project[^>]*timestamp=/.test(content)) {
        return 'Clover XML';
    }
    if (/<report[^>]*>[\s\S]*<sourcefile/i.test(content) || /<\?xml[\s\S]*<report[^>]+name=/i.test(content)) {
        return 'JaCoCo XML';
    }
    if (/<CoverageSession/i.test(content)) {
        return 'OpenCover XML';
    }
    if (/<results[\s\S]*<modules/i.test(content)) {
        return 'dotnet-coverage XML';
    }
    if (/<coverage[^>]*(line-rate|lines-valid)/i.test(content)) {
        return 'Cobertura XML';
    }
    // Cobertura written by coverage.py sometimes lacks those attributes.
    if (/<coverage[\s\S]*<class[^>]+filename=/i.test(content)) {
        return 'Cobertura XML';
    }
    void reportPath;
    return undefined;
}

export async function parseCoverageReport(
    folder: vscode.WorkspaceFolder,
    relativeReportPath: string,
    /** Reused across watch refreshes; omit to build a fresh one. */
    fileIndex: WorkspaceFileIndex = new WorkspaceFileIndex(folder)
): Promise<CoverageData> {
    const absolute = path.isAbsolute(relativeReportPath)
        ? relativeReportPath
        : path.join(folder.uri.fsPath, relativeReportPath);
    const [content, stat] = await Promise.all([fs.readFile(absolute, 'utf8'), fs.stat(absolute)]);
    const format = detectFormat(content, absolute);
    if (!format) {
        throw new Error(
            `Could not recognise the coverage format of "${relativeReportPath}" — supported: LCOV, Cobertura, ` +
                'JaCoCo, OpenCover, dotnet-coverage XML, Clover and Go coverage profiles.'
        );
    }

    let raw: RawFile[];
    switch (format) {
        case 'LCOV':
            raw = parseLcov(content);
            break;
        case 'Go coverage profile':
            raw = parseGoProfile(content);
            break;
        case 'Cobertura XML':
            raw = parseCobertura(content);
            break;
        case 'JaCoCo XML':
            raw = parseJacoco(content);
            break;
        case 'OpenCover XML':
            raw = parseOpenCover(content);
            break;
        case 'dotnet-coverage XML':
            raw = parseDotnetCoverage(content);
            break;
        case 'Clover XML':
            raw = parseClover(content);
            break;
        default:
            raw = [];
    }

    const resolver = new WorkspacePathResolver(folder, fileIndex);
    const measured = raw.filter(entry => entry.lines.size > 0 || entry.branchesTotal > 0);
    // Resolving in series meant one file-system round trip per reported file,
    // waited on one at a time — with watch mode re-reading the report every few
    // seconds, that is the bulk of the work. The merge below still runs in
    // report order, so the result does not depend on which lookup won.
    const resolvedPaths = await mapWithConcurrency(measured, entry => resolver.resolve(entry.reportedPath));

    const files: FileCoverage[] = [];
    const unresolvedPaths: string[] = [];
    const byPath = new Map<string, FileCoverage>();
    for (const [index, entry] of measured.entries()) {
        const resolved = resolvedPaths[index];
        if (!resolved) {
            unresolvedPaths.push(entry.reportedPath);
            continue;
        }
        // Several report entries can map to one file (partial classes, merged runs).
        const existing = byPath.get(resolved);
        if (existing) {
            for (const [line, hits] of entry.lines) {
                existing.lines.set(line, Math.max(existing.lines.get(line) ?? 0, hits));
            }
            existing.branchesCovered += entry.branchesCovered;
            existing.branchesTotal += entry.branchesTotal;
        } else {
            const file: FileCoverage = {
                path: resolved,
                lines: entry.lines,
                branchesCovered: entry.branchesCovered,
                branchesTotal: entry.branchesTotal
            };
            byPath.set(resolved, file);
            files.push(file);
        }
    }

    return {
        files,
        format,
        reportPath: relativeReportPath,
        generatedAt: stat.mtime,
        unresolvedPaths: [...new Set(unresolvedPaths)].slice(0, 20)
    };
}

/**
 * Run `worker` over every item, a bounded number at a time. Unbounded would
 * queue thousands of file-system calls at once and starve everything else in
 * the extension host.
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    worker: (item: T) => Promise<R>,
    limit = 64
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
}

function parseLcov(content: string): RawFile[] {
    const files: RawFile[] = [];
    let current: RawFile | undefined;
    for (const line of content.split(/\r?\n/)) {
        if (line.startsWith('SF:')) {
            current = { reportedPath: line.slice(3).trim(), lines: new Map(), branchesCovered: 0, branchesTotal: 0 };
            files.push(current);
        } else if (current && line.startsWith('DA:')) {
            const [lineNo, hits] = line.slice(3).split(',');
            const parsedLine = parseLineNumber(lineNo);
            if (parsedLine !== undefined) {
                current.lines.set(parsedLine, Math.max(current.lines.get(parsedLine) ?? 0, parseHitCount(hits)));
            }
        } else if (current && line.startsWith('BRDA:')) {
            // BRDA:<line>,<block>,<branch>,<taken | "-">
            const taken = line.slice(5).split(',')[3];
            current.branchesTotal++;
            if (taken !== '-' && Number(taken) > 0) {
                current.branchesCovered++;
            }
        } else if (line.startsWith('end_of_record')) {
            current = undefined;
        }
    }
    return files;
}

function parseGoProfile(content: string): RawFile[] {
    const byFile = new Map<string, RawFile>();
    // <path>:<startLine>.<startCol>,<endLine>.<endCol> <numStatements> <count>
    const entry = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/;
    for (const line of content.split(/\r?\n/)) {
        const match = entry.exec(line.trim());
        if (!match) {
            continue;
        }
        const [, file, start, end, count] = match;
        let raw = byFile.get(file);
        if (!raw) {
            raw = { reportedPath: file, lines: new Map(), branchesCovered: 0, branchesTotal: 0 };
            byFile.set(file, raw);
        }
        const hits = parseHitCount(count);
        const from = parseLineNumber(start);
        const to = parseLineNumber(end);
        if (from === undefined || to === undefined || to < from) {
            continue;
        }
        for (let n = from; n <= to; n++) {
            raw.lines.set(n, Math.max(raw.lines.get(n) ?? 0, hits));
        }
    }
    return [...byFile.values()];
}

function parseCobertura(content: string): RawFile[] {
    const files: RawFile[] = [];
    const sourceRoots = [...content.matchAll(/<source>([\s\S]*?)<\/source>/g)].map(m => m[1].trim());
    const classBlocks = content.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g);
    for (const [, attrs, body] of classBlocks) {
        const filename = attr(attrs, 'filename');
        if (!filename) {
            continue;
        }
        const raw: RawFile = {
            // Cobertura paths are relative to <source>; keep the root for resolution.
            reportedPath: sourceRoots.length === 1 ? path.posix.join(toPosix(sourceRoots[0]), filename) : filename,
            lines: new Map(),
            branchesCovered: 0,
            branchesTotal: 0
        };
        for (const [, lineAttrs] of body.matchAll(/<line\b([^>]*)\/?>/g)) {
            const number = parseLineNumber(attr(lineAttrs, 'number'));
            if (number === undefined) {
                continue;
            }
            raw.lines.set(number, Math.max(raw.lines.get(number) ?? 0, parseHitCount(attr(lineAttrs, 'hits'))));
            const condition = attr(lineAttrs, 'condition-coverage');
            const fraction = condition ? /\((\d+)\/(\d+)\)/.exec(condition) : undefined;
            if (fraction) {
                raw.branchesCovered += Number(fraction[1]);
                raw.branchesTotal += Number(fraction[2]);
            }
        }
        files.push(raw);
    }
    return files;
}

function parseJacoco(content: string): RawFile[] {
    const files: RawFile[] = [];
    for (const [, packageAttrs, packageBody] of content.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
        const packageName = attr(packageAttrs, 'name') ?? '';
        for (const [, fileAttrs, fileBody] of packageBody.matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
            const name = attr(fileAttrs, 'name');
            if (!name) {
                continue;
            }
            const raw: RawFile = {
                reportedPath: packageName ? `${packageName}/${name}` : name,
                lines: new Map(),
                branchesCovered: 0,
                branchesTotal: 0
            };
            for (const [, lineAttrs] of fileBody.matchAll(/<line\b([^>]*)\/?>/g)) {
                const number = parseLineNumber(attr(lineAttrs, 'nr'));
                if (number === undefined) {
                    continue;
                }
                // ci = covered instructions, cb/mb = covered/missed branches.
                raw.lines.set(number, Number(attr(lineAttrs, 'ci')) > 0 ? 1 : 0);
                const coveredBranches = Number(attr(lineAttrs, 'cb')) || 0;
                const missedBranches = Number(attr(lineAttrs, 'mb')) || 0;
                raw.branchesCovered += coveredBranches;
                raw.branchesTotal += coveredBranches + missedBranches;
            }
            files.push(raw);
        }
    }
    return files;
}

function parseOpenCover(content: string): RawFile[] {
    const byId = new Map<string, RawFile>();
    for (const [, fileAttrs] of content.matchAll(/<File\b([^>]*)\/?>/g)) {
        const uid = attr(fileAttrs, 'uid');
        const fullPath = attr(fileAttrs, 'fullPath');
        if (uid && fullPath) {
            byId.set(uid, { reportedPath: fullPath, lines: new Map(), branchesCovered: 0, branchesTotal: 0 });
        }
    }
    for (const [, pointAttrs] of content.matchAll(/<SequencePoint\b([^>]*)\/?>/g)) {
        const raw = byId.get(attr(pointAttrs, 'fileid') ?? '');
        const line = parseLineNumber(attr(pointAttrs, 'sl'));
        if (!raw || line === undefined) {
            continue;
        }
        const hits = parseHitCount(attr(pointAttrs, 'vc'));
        raw.lines.set(line, Math.max(raw.lines.get(line) ?? 0, hits));
    }
    for (const [, branchAttrs] of content.matchAll(/<BranchPoint\b([^>]*)\/?>/g)) {
        const raw = byId.get(attr(branchAttrs, 'fileid') ?? '');
        if (!raw) {
            continue;
        }
        raw.branchesTotal++;
        if ((Number(attr(branchAttrs, 'vc')) || 0) > 0) {
            raw.branchesCovered++;
        }
    }
    return [...byId.values()];
}

function parseDotnetCoverage(content: string): RawFile[] {
    const byId = new Map<string, RawFile>();
    for (const [, attrs] of content.matchAll(/<source_file\b([^>]*)\/?>/g)) {
        const id = attr(attrs, 'id');
        const filePath = attr(attrs, 'path');
        if (id && filePath) {
            byId.set(id, { reportedPath: filePath, lines: new Map(), branchesCovered: 0, branchesTotal: 0 });
        }
    }
    for (const [, attrs] of content.matchAll(/<range\b([^>]*)\/?>/g)) {
        const raw = byId.get(attr(attrs, 'source_id') ?? '');
        const start = parseLineNumber(attr(attrs, 'start_line'));
        if (!raw || start === undefined) {
            continue;
        }
        const end = parseLineNumber(attr(attrs, 'end_line'));
        const covered = (attr(attrs, 'covered') ?? '').toLowerCase();
        // "partial" means the line ran but not every branch — still a hit line.
        const hits = covered === 'no' ? 0 : 1;
        for (let n = start; n <= (end !== undefined ? Math.max(end, start) : start); n++) {
            raw.lines.set(n, Math.max(raw.lines.get(n) ?? 0, hits));
        }
        if (covered === 'partial') {
            raw.branchesTotal += 2;
            raw.branchesCovered += 1;
        }
    }
    return [...byId.values()];
}

function parseClover(content: string): RawFile[] {
    const files: RawFile[] = [];
    for (const [, fileAttrs, body] of content.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
        const filePath = attr(fileAttrs, 'path') ?? attr(fileAttrs, 'name');
        if (!filePath) {
            continue;
        }
        const raw: RawFile = { reportedPath: filePath, lines: new Map(), branchesCovered: 0, branchesTotal: 0 };
        for (const [, lineAttrs] of body.matchAll(/<line\b([^>]*)\/?>/g)) {
            const number = parseLineNumber(attr(lineAttrs, 'num'));
            if (number === undefined) {
                continue;
            }
            const count = parseHitCount(attr(lineAttrs, 'count'));
            raw.lines.set(number, Math.max(raw.lines.get(number) ?? 0, count));
            if (attr(lineAttrs, 'type') === 'cond') {
                const trueCount = Number(attr(lineAttrs, 'truecount')) || 0;
                const falseCount = Number(attr(lineAttrs, 'falsecount')) || 0;
                raw.branchesTotal += 2;
                raw.branchesCovered += (trueCount > 0 ? 1 : 0) + (falseCount > 0 ? 1 : 0);
            }
        }
        files.push(raw);
    }
    return files;
}

function attr(attributes: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes);
    return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function toPosix(value: string): string {
    return value.replace(/\\/g, '/');
}

// ----------------------------------------------------------- path mapping ---

/**
 * Coverage reports name files in their own terms: absolute build-machine
 * paths, package-qualified names, import paths. Map them onto workspace files,
 * falling back to a longest-suffix match against an index of the workspace.
 */
/**
 * The workspace's source files, indexed by trailing path segments, for reports
 * that name files in a way the workspace layout does not match (absolute build
 * paths, most .NET formats). Building it walks the whole workspace, so with
 * watch mode re-reading a report every few seconds it is worth keeping between
 * parses — but never across an explicit run, where a file added since should
 * be picked up.
 */
export class WorkspaceFileIndex {
    private index: Map<string, string[]> | undefined;
    private builtAt = 0;

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly ttlMs = 60000
    ) {}

    /** Force the next lookup to walk the workspace again. */
    invalidate(): void {
        this.index = undefined;
    }

    async get(): Promise<Map<string, string[]>> {
        if (this.index && Date.now() - this.builtAt < this.ttlMs) {
            return this.index;
        }
        const index = new Map<string, string[]>();
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(this.folder, '**/*.{cs,vb,fs,ts,tsx,js,jsx,mjs,cjs,dart,java,kt,py,go,php,rb,scala,swift}'),
            '**/{node_modules,bin,obj,.git,dist,build,vendor,.venv,venv,target}/**',
            20000
        );
        for (const file of files) {
            const relative = toPosix(path.relative(this.folder.uri.fsPath, file.fsPath));
            const segments = relative.split('/');
            for (let take = 1; take <= Math.min(segments.length, 6); take++) {
                const key = segments.slice(-take).join('/').toLowerCase();
                const bucket = index.get(key);
                if (bucket) {
                    bucket.push(relative);
                } else {
                    index.set(key, [relative]);
                }
            }
        }
        this.index = index;
        this.builtAt = Date.now();
        return index;
    }
}

class WorkspacePathResolver {
    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly fileIndex: WorkspaceFileIndex
    ) {}

    async resolve(reportedPath: string): Promise<string | undefined> {
        const normalized = toPosix(reportedPath).replace(/^\.\//, '');
        const root = toPosix(this.folder.uri.fsPath);

        if (normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) {
            const relative = normalized.slice(root.length + 1);
            return (await this.exists(relative)) ? relative : this.suffixMatch(relative);
        }
        if (!path.posix.isAbsolute(normalized) && !/^[a-zA-Z]:/.test(normalized)) {
            if (await this.exists(normalized)) {
                return normalized;
            }
        }
        return this.suffixMatch(normalized);
    }

    private async exists(relative: string): Promise<boolean> {
        try {
            await fs.access(path.join(this.folder.uri.fsPath, relative));
            return true;
        } catch {
            return false;
        }
    }

    /** Match on the longest trailing path segments that identify exactly one file. */
    private async suffixMatch(reportedPath: string): Promise<string | undefined> {
        const index = await this.fileIndex.get();
        const segments = reportedPath.split('/').filter(Boolean);
        for (let take = Math.min(segments.length, 6); take >= 1; take--) {
            const key = segments.slice(-take).join('/').toLowerCase();
            const matches = index.get(key);
            if (matches?.length === 1) {
                return matches[0];
            }
        }
        return undefined;
    }

}

// ------------------------------------------------------------ test results ---

export interface TestTotalsOptions {
    /**
     * Reference time for the run being reported (usually the coverage report's
     * mtime). Result files older than this by more than an hour are treated as
     * leftovers from previous runs and ignored.
     */
    since?: Date;
}

const STALE_RESULT_GRACE_MS = 60 * 60 * 1000;

/**
 * Aggregate unit-test counts from TRX / JUnit XML result files.
 *
 * Two traps this avoids: a suite that writes both TRX and JUnit for the same
 * run would be counted twice (so one family wins), and result files left over
 * from earlier runs would inflate the totals (so they are filtered by age).
 */
export async function collectTestTotals(
    folder: vscode.WorkspaceFolder,
    options: TestTotalsOptions = {}
): Promise<TestTotals | undefined> {
    const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/{*.trx,TEST-*.xml,junit*.xml,test-results*.xml,*.junit.xml}'),
        '**/{node_modules,.git,vendor}/**',
        50
    );

    const cutoff = options.since ? options.since.getTime() - STALE_RESULT_GRACE_MS : undefined;
    const fresh: string[] = [];
    for (const file of found) {
        if (cutoff === undefined) {
            fresh.push(file.fsPath);
            continue;
        }
        try {
            const stat = await fs.stat(file.fsPath);
            if (stat.mtimeMs >= cutoff) {
                fresh.push(file.fsPath);
            }
        } catch {
            // unreadable — skip it
        }
    }

    // TRX and JUnit describing the same run must not both be counted.
    const trx = fresh.filter(file => file.toLowerCase().endsWith('.trx'));
    const selected = trx.length > 0 ? trx : fresh;

    const totals: TestTotals = { total: 0, passed: 0, failed: 0, skipped: 0, sources: 0 };
    for (const file of selected) {
        let content: string;
        try {
            content = await fs.readFile(file, 'utf8');
        } catch {
            continue;
        }
        const parsed = file.toLowerCase().endsWith('.trx') ? parseTrx(content) : parseJUnit(content);
        if (parsed) {
            totals.total += parsed.total;
            totals.passed += parsed.passed;
            totals.failed += parsed.failed;
            totals.skipped += parsed.skipped;
            totals.sources++;
        }
    }
    return totals.sources > 0 ? totals : undefined;
}

function parseTrx(content: string): Omit<TestTotals, 'sources'> | undefined {
    const counters = /<Counters\b([^>]*)\/?>/i.exec(content);
    if (!counters) {
        return undefined;
    }
    const attrs = counters[1];
    const total = Number(attr(attrs, 'total')) || 0;
    const failed = (Number(attr(attrs, 'failed')) || 0) + (Number(attr(attrs, 'error')) || 0);
    return {
        total,
        passed: Number(attr(attrs, 'passed')) || 0,
        failed,
        skipped: Number(attr(attrs, 'notExecuted')) || 0
    };
}

function parseJUnit(content: string): Omit<TestTotals, 'sources'> | undefined {
    // Prefer the aggregate <testsuites> element, but only when it actually
    // carries the counts — plenty of writers emit a bare wrapper and put the
    // numbers on the individual <testsuite> elements instead.
    const root = /<testsuites\b([^>]*)>/i.exec(content);
    const suites =
        root && attr(root[1], 'tests') !== undefined
            ? [root[1]]
            : [...content.matchAll(/<testsuite\b([^>]*)>/gi)].map(m => m[1]);
    if (suites.length === 0) {
        return undefined;
    }
    let total = 0;
    let failed = 0;
    let skipped = 0;
    for (const attrs of suites) {
        const tests = Number(attr(attrs, 'tests'));
        if (!Number.isFinite(tests)) {
            continue;
        }
        total += tests;
        failed += (Number(attr(attrs, 'failures')) || 0) + (Number(attr(attrs, 'errors')) || 0);
        skipped += (Number(attr(attrs, 'skipped')) || 0) + (Number(attr(attrs, 'disabled')) || 0);
    }
    return total > 0 ? { total, passed: Math.max(total - failed - skipped, 0), failed, skipped } : undefined;
}
