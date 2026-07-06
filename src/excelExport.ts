import * as ExcelJS from 'exceljs';
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

/** A selectable column for the Prompts sheet. Single source of truth for the picker + the sheet. */
export interface ExportColumn {
    id: string;
    header: string;
    width: number;
    /** Pre-ticked in the picker (the "necessary" fields). */
    defaultOn: boolean;
    /** Short description shown in the picker. */
    detail?: string;
    /** Value extractor for a data row. */
    get: (r: PromptRow, index: number) => any;
    /** Cell number format. */
    numFmt?: string;
    /** True for numeric columns that should be summed in the TOTAL row. */
    sum?: boolean;
}

// Canonical order == the order columns appear in the export/picker.
// Default-ticked (necessary) fields first, extras last.
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

function resolveColumns(columnIds?: string[]): ExportColumn[] {
    if (!columnIds || columnIds.length === 0) {
        return EXPORT_COLUMNS.filter(c => c.defaultOn);
    }
    // Keep the canonical order defined above, include only picked ids.
    return EXPORT_COLUMNS.filter(c => columnIds.includes(c.id));
}

interface BuiltData {
    rows: PromptRow[];
    totals: { chats: number; prompts: number; input: number; output: number; aic: number; aicComplete: boolean };
    byModel: Map<string, { display: string; prompts: number; input: number; output: number; aic: number; aicComplete: boolean }>;
    byDay: Map<string, { prompts: number; input: number; output: number; aic: number }>;
}

const HEADER_FILL: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F6FEB' }
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 14, color: { argb: 'FF1F6FEB' } };

function dayKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type DateSortOrder = 'asc' | 'desc';

/** Collect the prompt-level rows for the given sessions within the range. */
function buildData(sessions: ChatSession[], range: DateRange, sortOrder: DateSortOrder = 'asc'): BuiltData {
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

            // user prompt
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

            // Totals
            chatSet.add(session.id);
            totals.prompts++;
            if (input !== null) { totals.input += input; }
            if (output !== null) { totals.output += output; }
            if (aic !== null) { totals.aic += aic; } else { totals.aicComplete = false; }

            // By model
            const mkey = model ? normalizeModelId(model) : 'unknown';
            if (!byModel.has(mkey)) {
                byModel.set(mkey, { display: model ? getModelDisplayName(model) : 'Unknown', prompts: 0, input: 0, output: 0, aic: 0, aicComplete: true });
            }
            const mm = byModel.get(mkey)!;
            mm.prompts++;
            if (input !== null) { mm.input += input; }
            if (output !== null) { mm.output += output; }
            if (aic !== null) { mm.aic += aic; } else { mm.aicComplete = false; }

            // By day
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

function styleHeader(row: ExcelJS.Row): void {
    row.eachCell(cell => {
        cell.fill = HEADER_FILL;
        cell.font = HEADER_FONT;
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } };
    });
    row.height = 20;
}

function buildSummarySheet(ws: ExcelJS.Worksheet, data: BuiltData, range: DateRange): void {
    const rate = getUsdPerAic();
    const usdOf = (aic: number) => Number((aic * rate).toFixed(4));
    ws.columns = [
        { width: 26 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }
    ];

    const title = ws.addRow(['GitHub Copilot Usage Report']);
    title.getCell(1).font = TITLE_FONT;
    ws.mergeCells(`A${title.number}:E${title.number}`);

    ws.addRow(['Period', range.label]);
    ws.addRow(['Generated', new Date().toLocaleString()]);
    ws.addRow([]);

    const totLabel = ws.addRow(['Totals']);
    totLabel.getCell(1).font = { bold: true, size: 12 };
    const plus = data.totals.aicComplete ? '' : ' (+)';
    ws.addRow(['Chats', data.totals.chats]);
    ws.addRow(['Prompts', data.totals.prompts]);
    ws.addRow(['Input tokens', data.totals.input]);
    ws.addRow(['Output tokens', data.totals.output]);
    ws.addRow(['Total tokens', data.totals.input + data.totals.output]);
    const aicRow = ws.addRow(['AIC used' + plus, Number(data.totals.aic.toFixed(2))]);
    aicRow.getCell(1).font = { bold: true };
    aicRow.getCell(2).font = { bold: true };
    const usdRow = ws.addRow(['USD (est.)' + plus, usdOf(data.totals.aic)]);
    usdRow.getCell(1).font = { bold: true };
    usdRow.getCell(2).font = { bold: true };
    usdRow.getCell(2).numFmt = '$#,##0.0000';
    ws.addRow(['Rate', `1 AIC = ${formatUsdRate(rate)} (githubCopilotReport.usdPerAic)`]);
    if (!data.totals.aicComplete) {
        ws.addRow(['Note', '“(+)” = some prompts have no billed-credit data recorded yet; AIC/USD is a lower bound.']);
    }
    ws.addRow([]);

    // By model table
    const mHead = ws.addRow(['By Model', 'Prompts', 'Input', 'Output', 'AIC', 'USD (est.)']);
    styleHeader(mHead);
    const modelsSorted = Array.from(data.byModel.values()).sort((a, b) => b.aic - a.aic);
    for (const m of modelsSorted) {
        const r = ws.addRow([m.display, m.prompts, m.input, m.output, Number(m.aic.toFixed(2)), usdOf(m.aic)]);
        r.getCell(6).numFmt = '$#,##0.0000';
    }
    ws.addRow([]);

    // By day table
    const dHead = ws.addRow(['By Day', 'Prompts', 'Input', 'Output', 'AIC', 'USD (est.)']);
    styleHeader(dHead);
    const daysSorted = Array.from(data.byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [dk, d] of daysSorted) {
        const r = ws.addRow([dk, d.prompts, d.input, d.output, Number(d.aic.toFixed(2)), usdOf(d.aic)]);
        r.getCell(6).numFmt = '$#,##0.0000';
    }

    // Number formats for token columns (best-effort across the sheet).
    ws.eachRow(row => {
        [2, 3, 4, 5].forEach(ci => {
            const cell = row.getCell(ci);
            if (typeof cell.value === 'number' && Number.isInteger(cell.value) && cell.value >= 1000) {
                cell.numFmt = '#,##0';
            }
        });
    });
}

/** Human-friendly rendering of the AIC→USD rate for the report header (e.g. "$0.01"). */
function formatUsdRate(rate: number): string {
    return '$' + (rate < 0.01 ? rate.toFixed(4) : rate.toFixed(2));
}

function colLetter(n: number): string {
    // 1 -> A, 26 -> Z, 27 -> AA
    let s = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function buildPromptsSheet(ws: ExcelJS.Worksheet, data: BuiltData, cols: ExportColumn[]): void {
    ws.columns = cols.map(c => ({ header: c.header, key: c.id, width: c.width }));

    styleHeader(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: `${colLetter(cols.length)}1` };

    data.rows.forEach((r, i) => {
        const values: Record<string, any> = {};
        for (const c of cols) {
            values[c.id] = c.get(r, i);
        }
        const row = ws.addRow(values);
        for (const c of cols) {
            if (c.numFmt) {
                row.getCell(c.id).numFmt = c.numFmt;
            }
        }
    });

    // Totals row: label in the first text-like column, sums under numeric columns.
    const totalValues: Record<string, any> = {};
    const labelCol = cols.find(c => !c.sum && c.id !== 'index') || cols[0];
    totalValues[labelCol.id] = 'TOTAL';
    for (const c of cols) {
        if (!c.sum) { continue; }
        if (c.id === 'inputTokens') { totalValues[c.id] = data.totals.input; }
        else if (c.id === 'outputTokens') { totalValues[c.id] = data.totals.output; }
        else if (c.id === 'totalTokens') { totalValues[c.id] = data.totals.input + data.totals.output; }
        else if (c.id === 'aic') { totalValues[c.id] = Number(data.totals.aic.toFixed(2)); }
        else if (c.id === 'usd') { totalValues[c.id] = Number((data.totals.aic * getUsdPerAic()).toFixed(4)); }
    }
    const totalRow = ws.addRow(totalValues);
    totalRow.font = { bold: true };
    for (const c of cols) {
        if (c.numFmt) { totalRow.getCell(c.id).numFmt = c.numFmt; }
    }
    totalRow.eachCell(cell => {
        cell.border = { top: { style: 'double', color: { argb: 'FF888888' } } };
    });
}

/**
 * Build the workbook and write it to `filePath`.
 * @param columnIds  ids of the Prompts-sheet columns to include (defaults to the necessary set).
 * @returns the number of prompt rows exported.
 */
export async function exportToExcel(
    sessions: ChatSession[],
    range: DateRange,
    filePath: string,
    columnIds?: string[],
    sortOrder: DateSortOrder = 'asc'
): Promise<number> {
    const data = buildData(sessions, range, sortOrder);
    const cols = resolveColumns(columnIds);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Github Copilot Report';
    wb.created = new Date();

    const summary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF1F6FEB' } } });
    buildSummarySheet(summary, data, range);

    const prompts = wb.addWorksheet('Prompts');
    buildPromptsSheet(prompts, data, cols);

    await wb.xlsx.writeFile(filePath);
    return data.rows.length;
}

function fmtDateTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Convert a single cell value to clipboard text (tab/newline-safe). */
function cellToText(col: ExportColumn, v: any): string {
    if (v === null || v === undefined) { return ''; }
    if (v instanceof Date) { return fmtDateTime(v); }
    if (typeof v === 'number') {
        if (col.id === 'aic') { return v.toFixed(2); }
        if (col.id === 'usd') { return v.toFixed(4); }
        return String(v);
    }
    // Collapse tabs/newlines so each prompt stays in a single spreadsheet cell.
    return String(v).replace(/[\t\r\n]+/g, ' ').trim();
}

export interface ClipboardResult { text: string; rows: number; columns: number; }

/**
 * Build a TSV (tab-separated) block for the clipboard, using the same selected columns.
 * Pastes cleanly into Excel / Google Sheets (one prompt per row, columns split by tab).
 * Includes a header row and a TOTAL row.
 */
export function buildClipboardTsv(sessions: ChatSession[], range: DateRange, columnIds?: string[], sortOrder: DateSortOrder = 'asc'): ClipboardResult {
    const data = buildData(sessions, range, sortOrder);
    const cols = resolveColumns(columnIds);

    const lines: string[] = [];
    lines.push(cols.map(c => c.header).join('\t'));
    data.rows.forEach((r, i) => {
        lines.push(cols.map(c => cellToText(c, c.get(r, i))).join('\t'));
    });

    // TOTAL row (mirrors the sheet).
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
