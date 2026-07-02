import * as vscode from 'vscode';

export type FilterMode = 'week' | 'month' | 'all';

export interface DateRange {
    mode: FilterMode;
    start: number;   // inclusive epoch ms
    end: number;     // inclusive epoch ms
    label: string;   // e.g. "July 2026" or "This Week (Jun 30 – Jul 6)"
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDay(d: Date): string {
    return `${MONTHS[d.getMonth()].substring(0, 3)} ${d.getDate()}`;
}

/** Compute the concrete date range for a filter mode, relative to `now`. */
export function computeRange(mode: FilterMode, now: Date = new Date()): DateRange {
    if (mode === 'all') {
        return { mode, start: 0, end: Number.MAX_SAFE_INTEGER, label: 'All time' };
    }

    if (mode === 'week') {
        // ISO week: Monday 00:00 → Sunday 23:59:59.999
        const day = now.getDay(); // 0=Sun..6=Sat
        const daysFromMonday = (day + 6) % 7;
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromMonday, 0, 0, 0, 0);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
        return {
            mode,
            start: start.getTime(),
            end: end.getTime(),
            label: `This Week (${fmtDay(start)} – ${fmtDay(end)})`
        };
    }

    // month
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return {
        mode,
        start: start.getTime(),
        end: end.getTime(),
        label: `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
    };
}

export function isInRange(ts: number, range: DateRange): boolean {
    return ts >= range.start && ts <= range.end;
}

/** Holds the currently-selected filter mode and notifies listeners on change. */
export class FilterState {
    private _mode: FilterMode;
    private readonly _emitter = new vscode.EventEmitter<DateRange>();
    readonly onDidChange = this._emitter.event;

    constructor(initial: FilterMode = 'month') {
        this._mode = initial;
    }

    get mode(): FilterMode { return this._mode; }

    get range(): DateRange { return computeRange(this._mode); }

    setMode(mode: FilterMode): void {
        if (mode === this._mode) {
            // Still refresh (e.g. day rolled over) — fire anyway.
            this._emitter.fire(this.range);
            return;
        }
        this._mode = mode;
        this._emitter.fire(this.range);
    }

    dispose(): void {
        this._emitter.dispose();
    }
}
