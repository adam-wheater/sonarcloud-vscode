import * as vscode from 'vscode';

export const SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const;
export const ISSUE_TYPES = ['BUG', 'VULNERABILITY', 'CODE_SMELL'] as const;

const SEVERITY_ORDER: Record<string, number> = {
    BLOCKER: 0,
    CRITICAL: 1,
    MAJOR: 2,
    MINOR: 3,
    INFO: 4
};

export function severityRank(severity: string): number {
    return SEVERITY_ORDER[severity] ?? 99;
}

/** "CODE_SMELL" -> "Code Smell" */
export function titleCase(value: string): string {
    return value
        .toLowerCase()
        .split('_')
        .map(word => (word ? word[0].toUpperCase() + word.slice(1) : word))
        .join(' ');
}

export function severityIcon(severity: string): vscode.ThemeIcon {
    switch (severity) {
        case 'BLOCKER':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        case 'CRITICAL':
            return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
        case 'MAJOR':
            return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
        case 'MINOR':
            return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.blue'));
        case 'INFO':
            return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.foreground'));
        default:
            return new vscode.ThemeIcon('circle-outline');
    }
}

export function typeIcon(type: string): vscode.ThemeIcon {
    switch (type) {
        case 'BUG':
            return new vscode.ThemeIcon('bug');
        case 'VULNERABILITY':
            return new vscode.ThemeIcon('shield');
        case 'CODE_SMELL':
            return new vscode.ThemeIcon('beaker');
        default:
            return new vscode.ThemeIcon('circle-outline');
    }
}

/** Format sqale_index style minutes as "1d 2h 30min". */
export function formatDuration(minutesValue: string): string {
    const totalMinutes = Number(minutesValue);
    if (!Number.isFinite(totalMinutes)) {
        return minutesValue;
    }
    const minutesPerDay = 8 * 60; // SonarCloud counts an 8h work day
    const total = Math.round(totalMinutes);
    const days = Math.floor(total / minutesPerDay);
    const hours = Math.floor((total % minutesPerDay) / 60);
    const minutes = total % 60;
    const parts: string[] = [];
    if (days) {
        parts.push(`${days}d`);
    }
    if (hours) {
        parts.push(`${hours}h`);
    }
    if (minutes || parts.length === 0) {
        parts.push(`${minutes}min`);
    }
    return parts.join(' ');
}

/** Format 1.0..5.0 ratings as A..E. */
export function formatRating(value: string): string {
    const n = Math.round(Number(value));
    if (n >= 1 && n <= 5) {
        return String.fromCharCode('A'.charCodeAt(0) + n - 1);
    }
    return value;
}
