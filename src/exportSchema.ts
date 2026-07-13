import { ChatSession } from './chatHistoryProvider';
import { DateRange, isInRange } from './filterState';
import { getModelDisplayName, normalizeModelId, getUsdPerAic } from './modelPricing';

interface PromptRow {
    date: Date;
    workspace: string;
    sessionTitle: string;
    sessionId: string;
    prompt: string;
    response: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    aic: number | null;
    usd: number | null;
}

export interface ExportColumn {
    id: string;
    header: string;
    width: number;
    defaultOn: boolean;
    detail?: string;
    get: (r: PromptRow, index: number) => any;
    numFmt?: string;
    sum?: boolean;
}

export const EXPORT_COLUMNS: ExportColumn[] = [
    { id: 'index', header: '#', width: 5, defaultOn: true, detail: 'Row number', get: (_r, i) => i + 1 },
    { id: 'session', header: 'Session', width: 34, defaultOn: false, detail: 'Chat session title', get: r => r.sessionTitle },
    { id: 'model', header: 'Model', width: 18, defaultOn: true, detail: 'Model used', get: r => r.model },
    { id: 'prompt', header: 'Prompt', width: 60, defaultOn: true, detail: 'Your message text', get: r => r.prompt.replace(/\s+/g, ' ').trim() },
    { id: 'aic', header: 'AIC', width: 10, defaultOn: true, detail: 'AI Credits used', get: r => r.aic, numFmt: '0.00', sum: true },
    { id: 'usd', header: 'USD (est.)', width: 12, defaultOn: false, detail: 'Estimated cost = AIC × rate', get: r => r.usd, numFmt: '$#,##0.0000', sum: true },
    { id: 'inputTokens', header: 'Input Tokens', width: 14, defaultOn: false, detail: 'Token · prompt (input)', get: r => r.inputTokens, numFmt: '#,##0', sum: true },
    { id: 'outputTokens', header: 'Output Tokens', width: 15, defaultOn: false, detail: 'Token · completion (output)', get: r => r.outputTokens, numFmt: '#,##0', sum: true },
    { id: 'totalTokens', header: 'Total Tokens', width: 14, defaultOn: false, detail: 'Token · input + output', get: r => r.totalTokens, numFmt: '#,##0', sum: true },
    { id: 'date', header: 'Date', width: 18, defaultOn: true, detail: 'Prompt date & time', get: r => r.date, numFmt: 'yyyy-mm-dd hh:mm' },
    { id: 'workspace', header: 'Workspace', width: 20, defaultOn: false, detail: 'Project / folder', get: r => r.workspace },
    { id: 'response', header: 'Response', width: 60, defaultOn: false, detail: 'Assistant reply text', get: r => r.response.replace(/\s+/g, ' ').trim() }
];

export const DEFAULT_EXPORT_COLUMN_IDS = EXPORT_COLUMNS.filter(c => c.defaultOn).map(c => c.id);

export type DateSortOrder = 'asc' | 'desc';

function resolveColumns(columnIds?: string[]): ExportColumn[] {
    if (!columnIds || columnIds.length === 0) {
        return EXPORT_COLUMNS.filter(c => c.defaultOn);
    }
    return EXPORT_COLUMNS.filter(c => columnIds.includes(c.id));
}

interface BuiltData {
    rows: PromptRow[];
    totals: { chats: number; prompts: number; input: number; output: number; aic: number; aicComplete: boolean };
    byModel: Map<string, { display: string; prompts: number; input: number; output: number; aic: number; aicComplete: boolean }>;
    byDay: Map<string, { prompts: number; input: number; output: number; aic: number }>;
}

function dayKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildData(sessions: ChatSession[], range: DateRange, sortOrder: DateSortOrder = 'asc'): BuiltData {
    const rows: PromptRow[] = [];
    const totals = { chats: 0, prompts: 0, input: 0, output: 0, aic: 0, aicComplete: true };
    const byModel = new Map<string, { display: string; prompts: number; input: number; output: number; aic: number; aicComplete: boolean }>();
    const byDay = new Map<string, { prompts: number; input: number; output: number; aic: number }>();
    const chatSet = new Set<string>();

    for (const session of sessions) {
        if (session.isDeleted) { continue; }
        let lastRow: PromptRow | null = null;

        for (const msg of session.messages) {
            if (range.mode !== 'all' && !isInRange(msg.timestamp, range)) {
                continue;
            }
            if (msg.role === 'assistant') {
                if (lastRow && !lastRow.response) {
                    lastRow.response = msg.content;
                }
                continue;
            }

            const u = msg.usage;
            const input = u && typeof u.inputTokens === 'number' ? u.inputTokens : null;
            const output = u && typeof u.outputTokens === 'number' ? u.outputTokens : null;
            const total = (input !== null || output !== null) ? (input || 0) + (output || 0) : null;
            const aic = u && typeof u.aic === 'number' ? u.aic : null;
            const usd = aic !== null ? aic * getUsdPerAic() : null;
            const model = u?.model || '';

            const row: PromptRow = {
                date: new Date(msg.timestamp),
                workspace: session.workspaceLabel || '',
                sessionTitle: session.title,
                sessionId: session.id,
                prompt: msg.content,
                response: '',
                model: model ? getModelDisplayName(model) : '',
                inputTokens: input,
                outputTokens: output,
                totalTokens: total,
                aic,
                usd
            };
            rows.push(row);
            lastRow = row;

            chatSet.add(session.id);
            totals.prompts++;
            if (input !== null) { totals.input += input; }
            if (output !== null) { totals.output += output; }
            if (aic !== null) { totals.aic += aic; } else { totals.aicComplete = false; }

            const mkey = model ? normalizeModelId(model) : 'unknown';
            if (!byModel.has(mkey)) {
                byModel.set(mkey, { display: model ? getModelDisplayName(model) : 'Unknown', prompts: 0, input: 0, output: 0, aic: 0, aicComplete: true });
            }
            const mm = byModel.get(mkey)!;
            mm.prompts++;
            if (input !== null) { mm.input += input; }
            if (output !== null) { mm.output += output; }
            if (aic !== null) { mm.aic += aic; } else { mm.aicComplete = false; }

            const dk = dayKey(row.date);
            if (!byDay.has(dk)) { byDay.set(dk, { prompts: 0, input: 0, output: 0, aic: 0 }); }
            const dd = byDay.get(dk)!;
            dd.prompts++;
            if (input !== null) { dd.input += input; }
            if (output !== null) { dd.output += output; }
            if (aic !== null) { dd.aic += aic; }
        }
    }

    totals.chats = chatSet.size;
    rows.sort((a, b) => sortOrder === 'desc' ? b.date.getTime() - a.date.getTime() : a.date.getTime() - b.date.getTime());
    return { rows, totals, byModel, byDay };
}

export function resolveExportColumns(columnIds?: string[]): ExportColumn[] {
    return resolveColumns(columnIds);
}

function fmtDateTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cellToText(col: ExportColumn, v: any): string {
    if (v === null || v === undefined) { return ''; }
    if (v instanceof Date) { return fmtDateTime(v); }
    if (typeof v === 'number') {
        if (col.id === 'aic') { return v.toFixed(2); }
        if (col.id === 'usd') { return v.toFixed(4); }
        return String(v);
    }
    return String(v).replace(/[\t\r\n]+/g, ' ').trim();
}

export interface ClipboardResult { text: string; rows: number; columns: number; }

export function buildClipboardTsv(sessions: ChatSession[], range: DateRange, columnIds?: string[], sortOrder: DateSortOrder = 'asc'): ClipboardResult {
    const data = buildData(sessions, range, sortOrder);
    const cols = resolveColumns(columnIds);

    const lines: string[] = [];
    lines.push(cols.map(c => c.header).join('\t'));
    data.rows.forEach((r, i) => {
        lines.push(cols.map(c => cellToText(c, c.get(r, i))).join('\t'));
    });

    const labelCol = cols.find(c => !c.sum && c.id !== 'index') || cols[0];
    const totalCells = cols.map(c => {
        if (c.id === labelCol.id) { return 'TOTAL'; }
        if (!c.sum) { return ''; }
        if (c.id === 'inputTokens') { return String(data.totals.input); }
        if (c.id === 'outputTokens') { return String(data.totals.output); }
        if (c.id === 'totalTokens') { return String(data.totals.input + data.totals.output); }
        if (c.id === 'aic') { return data.totals.aic.toFixed(2); }
        if (c.id === 'usd') { return (data.totals.aic * getUsdPerAic()).toFixed(4); }
        return '';
    });
    lines.push(totalCells.join('\t'));

    return { text: lines.join('\r\n'), rows: data.rows.length, columns: cols.length };
}