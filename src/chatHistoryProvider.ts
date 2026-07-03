import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import Fuse from 'fuse.js';
import { registerModelPricing, computeAic, normalizeModelId, setUsdPerAic, DEFAULT_USD_PER_AIC, NANO_AIU_PER_AIC } from './modelPricing';

const CONFIG_NS = 'githubCopilotReport';

/**
 * Native SQLite reader using the sqlite3 CLI (best-effort). Used only to recover
 * AI-generated session titles / archived flags. When sqlite3 is not installed the
 * extension still works fully — titles fall back to the first prompt text and all
 * token / AIC data comes straight from the .jsonl session files.
 */
class NativeSqliteReader {
    private static _sqlite3Available: boolean | null = null;

    static isSqlite3Available(): boolean {
        if (this._sqlite3Available !== null) {
            return this._sqlite3Available;
        }
        try {
            execSync(process.platform === 'win32' ? 'where sqlite3' : 'which sqlite3', {
                encoding: 'utf8',
                timeout: 5000,
                stdio: 'pipe'
            });
            this._sqlite3Available = true;
        } catch {
            this._sqlite3Available = false;
            console.log('[CopilotReport] sqlite3 CLI not found — session titles will fall back to the first prompt.');
        }
        return this._sqlite3Available;
    }

    static query(dbPath: string, sql: string): string | null {
        if (!this.isSqlite3Available()) {
            return null;
        }
        try {
            const result = execSync(
                `sqlite3 -readonly -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
                { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 10000 }
            );
            return result.trim();
        } catch (err: any) {
            if (err.message?.includes('unknown option') || err.message?.includes('-json')) {
                return this.queryLegacy(dbPath, sql);
            }
            return null;
        }
    }

    static queryLegacy(dbPath: string, sql: string): string | null {
        try {
            const result = execSync(
                `sqlite3 -readonly "${dbPath}" "${sql.replace(/"/g, '\\"')}"`,
                { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 10000 }
            );
            return result.trim();
        } catch {
            return null;
        }
    }

    static getItemValue(dbPath: string, key: string): string | null {
        const sql = `SELECT value FROM ItemTable WHERE key = '${key}'`;
        const result = this.query(dbPath, sql);
        if (!result) {
            return null;
        }
        try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].value !== undefined) {
                return parsed[0].value;
            }
        } catch {
            return result;
        }
        return null;
    }
}

/** Per-prompt token & AIC usage, attached to the user message that started the request. */
export interface PromptUsage {
    inputTokens?: number;   // prompt tokens sent for this request (full context)
    outputTokens?: number;  // completion tokens produced
    cacheTokens?: number;   // cached input tokens (billed at cache rate)
    model?: string;         // raw model id (e.g. "copilot/claude-sonnet-4.6")
    aic?: number;           // AI Credits — actual (from nanoAiu) if available, else computed
    nanoAiu?: number;       // raw billed credits Copilot recorded (set only when present)
    requestId?: string;
    responseId?: string;
}

export interface FileLink {
    path: string;
    lineNumber?: number;
    exists: boolean;
    action?: 'created' | 'modified' | 'deleted' | 'referenced';
}

export interface ChatMessage {
    sessionId: string;
    timestamp: number;
    role: 'user' | 'assistant';
    content: string;
    preview: string;
    usage?: PromptUsage;   // only set on user messages that have request metadata
    fileLinks?: FileLink[]; // files referenced/changed in an assistant message
}

export interface ChatSession {
    id: string;
    title: string;
    timestamp: number;
    messages: ChatMessage[];
    workspace?: string;
    workspaceLabel?: string;
    filePath?: string;
    isArchived: boolean;
    isDeleted: boolean;
    // Aggregates over the whole session
    promptCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalAic: number;
    aicComplete: boolean;   // false if some prompts had unknown pricing
    models: string[];       // distinct model display ids used
}

export class ChatHistoryProvider {
    private sessions: ChatSession[] = [];
    private messages: ChatMessage[] = [];
    private fuse: Fuse<ChatMessage> | null = null;
    private sessionTitles: Map<string, { title: string; isEmpty: boolean; isArchived: boolean }> = new Map();
    private archivedSessionIds: Set<string> = new Set();
    private allCachedSessionIds: Map<string, boolean | null> = new Map();
    private workspaceLabels: Map<string, string> = new Map();
    private refreshing: Promise<void> | null = null;

    constructor() {}

    /** Serialize refreshes so overlapping triggers (initial index + file watchers) can't corrupt state. */
    refresh(): Promise<void> {
        if (this.refreshing) {
            return this.refreshing;
        }
        this.refreshing = this._doRefresh().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async _doRefresh(): Promise<void> {
        this.sessions = [];
        this.messages = [];
        this.sessionTitles.clear();
        this.archivedSessionIds.clear();
        this.allCachedSessionIds.clear();
        this.workspaceLabels.clear();

        // Load pricing overrides from settings each refresh.
        const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
        // The AIC→USD rate (deciding money knob). Changing the setting takes effect on refresh.
        setUsdPerAic(cfg.get<number>('usdPerAic', DEFAULT_USD_PER_AIC));
        const overrides = cfg.get<Record<string, any>>('modelPricing', {});
        if (overrides && typeof overrides === 'object') {
            for (const [id, p] of Object.entries(overrides)) {
                if (p && typeof p === 'object') {
                    registerModelPricing(id, p as any);
                }
            }
        }

        const vscodePath = this.getVSCodeStoragePath();
        console.log('[CopilotReport] Refresh, storage path:', vscodePath);

        await this.loadSessionTitles(vscodePath);
        await this.parseWorkspaceStorage(vscodePath);
        this.buildSearchIndex();

        console.log('[CopilotReport] Indexed', this.sessions.length, 'sessions,', this.messages.length, 'messages');
    }

    private getVSCodeStoragePath(): string {
        const config = vscode.workspace.getConfiguration(CONFIG_NS);
        const customPath = config.get<string>('storagePath', '');
        if (customPath && customPath.trim() !== '') {
            return customPath.startsWith('~')
                ? path.join(os.homedir(), customPath.slice(1))
                : customPath;
        }
        const homeDir = os.homedir();
        if (process.platform === 'darwin') {
            return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User');
        } else if (process.platform === 'win32') {
            return path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User');
        }
        return path.join(homeDir, '.config', 'Code', 'User');
    }

    private async loadSessionTitles(basePath: string): Promise<void> {
        const workspaceStoragePath = path.join(basePath, 'workspaceStorage');
        if (!fs.existsSync(workspaceStoragePath)) {
            return;
        }
        if (!NativeSqliteReader.isSqlite3Available()) {
            return; // titles will fall back to first prompt text
        }

        const globalArchivedStatus = new Map<string, { archived: boolean | null; timestamp: number }>();
        try {
            const workspaces = fs.readdirSync(workspaceStoragePath);
            for (const workspace of workspaces) {
                const stateDbPath = path.join(workspaceStoragePath, workspace, 'state.vscdb');
                if (!fs.existsSync(stateDbPath)) {
                    continue;
                }
                const walPath = stateDbPath + '-wal';
                let dbMtime = fs.statSync(stateDbPath).mtimeMs;
                if (fs.existsSync(walPath)) {
                    dbMtime = Math.max(dbMtime, fs.statSync(walPath).mtimeMs);
                }
                try {
                    const archivedValue = NativeSqliteReader.getItemValue(stateDbPath, 'agentSessions.state.cache');
                    if (archivedValue) {
                        const archivedData = JSON.parse(archivedValue);
                        if (Array.isArray(archivedData)) {
                            for (const entry of archivedData) {
                                if (!entry.resource) { continue; }
                                const base64Id = entry.resource.split('/').pop();
                                if (!base64Id) { continue; }
                                try {
                                    const sessionId = Buffer.from(base64Id, 'base64').toString('utf8');
                                    const archivedStatus = entry.archived === true ? true : entry.archived === false ? false : null;
                                    const existing = globalArchivedStatus.get(sessionId);
                                    if (!existing || dbMtime > existing.timestamp) {
                                        globalArchivedStatus.set(sessionId, { archived: archivedStatus, timestamp: dbMtime });
                                    }
                                } catch { /* skip */ }
                            }
                        }
                    }

                    const titleValue = NativeSqliteReader.getItemValue(stateDbPath, 'chat.ChatSessionStore.index');
                    if (titleValue) {
                        const data = JSON.parse(titleValue);
                        if (data.entries) {
                            for (const [, entry] of Object.entries(data.entries) as [string, any][]) {
                                if (entry.sessionId && entry.title) {
                                    this.sessionTitles.set(entry.sessionId, {
                                        title: entry.title,
                                        isEmpty: entry.isEmpty === true,
                                        isArchived: false
                                    });
                                }
                            }
                        }
                    }
                } catch { /* skip workspace */ }
            }

            for (const [sessionId, status] of globalArchivedStatus) {
                this.allCachedSessionIds.set(sessionId, status.archived);
                if (status.archived === true) {
                    this.archivedSessionIds.add(sessionId);
                } else {
                    this.archivedSessionIds.delete(sessionId);
                }
                const titleInfo = this.sessionTitles.get(sessionId);
                if (titleInfo) {
                    titleInfo.isArchived = status.archived === true;
                }
            }
        } catch (err) {
            console.error('[CopilotReport] Error loading session titles:', err);
        }
    }

    private async parseWorkspaceStorage(basePath: string): Promise<void> {
        const workspaceStoragePath = path.join(basePath, 'workspaceStorage');
        if (!fs.existsSync(workspaceStoragePath)) {
            console.log('[CopilotReport] workspaceStorage not found');
            return;
        }
        try {
            const workspaces = fs.readdirSync(workspaceStoragePath);
            for (const workspace of workspaces) {
                const wsDir = path.join(workspaceStoragePath, workspace);
                const chatSessionsPath = path.join(wsDir, 'chatSessions');
                if (fs.existsSync(chatSessionsPath)) {
                    this.workspaceLabels.set(workspace, this.readWorkspaceLabel(wsDir));
                    await this.parseChatSessionsFolder(chatSessionsPath, workspace);
                }
            }
        } catch (error) {
            console.error('[CopilotReport] Error parsing workspace storage:', error);
        }
    }

    /** Try to derive a human-friendly workspace name from workspace.json. */
    private readWorkspaceLabel(wsDir: string): string {
        try {
            const metaPath = path.join(wsDir, 'workspace.json');
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const folder = meta.folder || meta.configuration?.path || '';
                if (folder) {
                    const decoded = decodeURIComponent(String(folder));
                    return path.basename(decoded.replace(/[\\/]+$/, '')) || decoded;
                }
            }
        } catch { /* ignore */ }
        return '';
    }

    private async parseChatSessionsFolder(folderPath: string, workspaceId: string): Promise<void> {
        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                if (file.endsWith('.jsonl')) {
                    await this.parseCopilotChatJsonl(path.join(folderPath, file), workspaceId);
                }
            }
        } catch (error) {
            console.error('[CopilotReport] Error parsing chat sessions folder:', error);
        }
    }

    /** Detect embedded model definitions (with pricing) and register them dynamically. */
    private detectPricingInLine(rawLine: string): void {
        if (rawLine.indexOf('"inputCost"') === -1) {
            return;
        }
        // Cheap balanced-brace scan around each inputCost occurrence.
        let searchFrom = 0;
        while (true) {
            const idx = rawLine.indexOf('"inputCost"', searchFrom);
            if (idx === -1) { break; }
            searchFrom = idx + 1;
            // Walk back to enclosing '{'
            let depth = 0, start = idx;
            while (start > 0) {
                start--;
                const c = rawLine[start];
                if (c === '}') { depth++; }
                else if (c === '{') { if (depth === 0) { break; } depth--; }
            }
            // Walk forward to matching '}'
            let d = 0, end = idx;
            while (end < rawLine.length) {
                const c = rawLine[end];
                if (c === '{') { d++; }
                else if (c === '}') { d--; if (d === 0) { end++; break; } }
                end++;
            }
            try {
                const obj = JSON.parse(rawLine.substring(start, end));
                const id = obj.version || obj.id || obj.family || obj.name;
                if (id && typeof obj.inputCost === 'number') {
                    registerModelPricing(String(id), {
                        inputCost: obj.inputCost,
                        outputCost: obj.outputCost,
                        cacheCost: obj.cacheCost,
                        displayName: obj.name
                    });
                }
            } catch { /* ignore malformed slice */ }
        }
    }

    private isRequestItem(it: any): boolean {
        return it && typeof it === 'object' && it.requestId && it.message;
    }

    /**
     * If a value is a result object carrying metadata, return that metadata.
     *
     * Doesn't require promptTokens/outputTokens to be present: a stopped/cancelled
     * generation can still emit a result whose metadata lacks token counts but whose
     * `details` text (or another field `buildUsageFromMeta` checks) carries the billed
     * credits — rejecting it here would throw that away and show "no usage data" even
     * though partial billing info exists in the log.
     */
    private resultMetadataOf(v: any): any | null {
        if (v && typeof v === 'object' && v.metadata && typeof v.metadata === 'object') {
            return v.metadata;
        }
        return null;
    }

    private buildUsageFromMeta(meta: any, request: any, resultDetails?: unknown): PromptUsage {
        const inputTokens: number | undefined =
            typeof meta.promptTokens === 'number' ? meta.promptTokens : undefined;
        const outputTokens: number | undefined =
            typeof meta.outputTokens === 'number' ? meta.outputTokens
                : (typeof request?.completionTokens === 'number' ? request.completionTokens : undefined);
        // Cached input tokens, if present.
        let cacheTokens = 0;
        const tokenDetails = meta.promptTokenDetails;
        if (tokenDetails && typeof tokenDetails === 'object') {
            const c = tokenDetails.cacheReadTokens ?? tokenDetails.cachedTokens ?? tokenDetails.cacheTokens;
            if (typeof c === 'number') { cacheTokens = c; }
        }
        const model = meta.resolvedModel || request?.modelId || '';

        // Prefer the ACTUAL billed credits Copilot records (nanoAiu) — this matches the
        // number shown in Copilot's own usage view exactly. Only fall back to computing
        // AIC from tokens × model price when Copilot didn't record a credit value.
        const nanoAiu = this.extractNanoAiu(meta, request, resultDetails);
        let aic: number | undefined;
        if (nanoAiu !== undefined) {
            aic = nanoAiu / NANO_AIU_PER_AIC;
        } else if (inputTokens !== undefined || outputTokens !== undefined) {
            aic = computeAic(inputTokens || 0, outputTokens || 0, cacheTokens, model);
        }
        return {
            inputTokens,
            outputTokens,
            cacheTokens: cacheTokens || undefined,
            model,
            aic,
            nanoAiu,
            requestId: request?.requestId,
            responseId: meta.responseId
        };
    }

    /** Best-effort read of the raw billed credits Copilot may record for a request, normalized to nanoAiu. */
    private extractNanoAiu(meta: any, request: any, resultDetails?: unknown): number | undefined {
        const candidates = [
            meta?.copilotUsageNanoAiu, meta?.nanoAiu, meta?.nanoAiU,
            meta?.usage?.copilotUsageNanoAiu, meta?.usage?.nanoAiu,
            request?.copilotUsageNanoAiu, request?.nanoAiu
        ];
        for (const c of candidates) {
            if (typeof c === 'number' && isFinite(c) && c >= 0) {
                return c;
            }
        }
        // Copilot's human-readable usage line — e.g. "Raptor mini • 2.0 credits" — is written
        // to `result.details` once billing is fully reconciled. It's more reliable than the
        // `copilotCredits` number on the request record, which is an early estimate that we've
        // observed staying stuck at a much smaller provisional value (e.g. 0.13 vs. the final 1.96).
        const fromDetails = this.parseCreditsFromDetails(resultDetails ?? request?.result?.details);
        if (fromDetails !== undefined) {
            return fromDetails;
        }
        const credits = request?.copilotCredits ?? meta?.copilotCredits;
        if (typeof credits === 'number' && isFinite(credits) && credits >= 0) {
            return credits * NANO_AIU_PER_AIC;
        }
        return undefined;
    }

    /** Parse "... 2.0 credits" out of Copilot's free-text usage summary. */
    private parseCreditsFromDetails(detailsValue: unknown): number | undefined {
        if (typeof detailsValue !== 'string') {
            return undefined;
        }
        const match = detailsValue.match(/(\d+(?:\.\d+)?)\s+(?:ai\s+)?credits?\b/i);
        if (!match) {
            return undefined;
        }
        const credits = Number(match[1]);
        return isFinite(credits) ? credits * NANO_AIU_PER_AIC : undefined;
    }

    /** Extract assistant response text from a request stub (best-effort). */
    private extractResponseText(request: any): string {
        let responseText = '';
        const toolOutputs: string[] = [];
        if (Array.isArray(request.response)) {
            for (const respPart of request.response) {
                if (!respPart || typeof respPart !== 'object') { continue; }
                if ('kind' in respPart) {
                    const kind = respPart.kind;
                    if (kind === 'text' && typeof respPart.value === 'string') {
                        responseText += respPart.value;
                    } else if (kind === 'toolInvocationSerialized' && respPart.invocationMessage?.value) {
                        toolOutputs.push(respPart.invocationMessage.value);
                    }
                } else if (typeof respPart.value === 'string') {
                    responseText += respPart.value;
                } else if (respPart.value?.content) {
                    responseText += respPart.value.content;
                }
            }
        } else if (typeof request.response === 'string') {
            responseText = request.response;
        } else if (request.response?.value?.content) {
            responseText = request.response.value.content;
        }
        if (toolOutputs.length > 0) {
            responseText = toolOutputs.join('\n') + (responseText ? '\n\n' + responseText : '');
        }
        return responseText;
    }

    private extractUserText(request: any): string {
        if (request.message?.text) {
            return request.message.text;
        }
        if (request.renderedUserMessage) {
            return this.extractTextFromRendered(request.renderedUserMessage);
        }
        if (request.result?.metadata?.renderedUserMessage) {
            return this.extractTextFromRendered(request.result.metadata.renderedUserMessage);
        }
        return '';
    }

    private async parseCopilotChatJsonl(filePath: string, workspaceId: string): Promise<void> {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length === 0) { return; }

            const firstLine = JSON.parse(lines[0]);
            const sessionData = firstLine.v || firstLine;
            if (typeof sessionData !== 'object' || Array.isArray(sessionData)) {
                return;
            }
            const sessionId = sessionData.sessionId || path.basename(filePath, '.jsonl');

            // Ordered request records + per-request usage (sequential delta join).
            const requestRecs: any[] = [];
            const requestIndexById = new Map<string, number>();
            const usages: (PromptUsage | undefined)[] = [];
            let currentIdx = -1;

            const ingestRequestItem = (it: any) => {
                const rid = it.requestId;
                if (requestIndexById.has(rid)) {
                    // Re-emission / update of an existing request; merge useful fields.
                    const i = requestIndexById.get(rid)!;
                    const existing = requestRecs[i];
                    if (Array.isArray(it.response) && it.response.length) { existing.response = it.response; }
                    if (typeof it.completionTokens === 'number') { existing.completionTokens = it.completionTokens; }
                    if (it.modelId) { existing.modelId = it.modelId; }
                    if (it.message?.text && !existing.message?.text) { existing.message = it.message; }
                    currentIdx = i;
                } else {
                    requestIndexById.set(rid, requestRecs.length);
                    requestRecs.push(it);
                    usages.push(undefined);
                    currentIdx = requestRecs.length - 1;
                    // Snapshot form may embed the result inline.
                    const embedded = this.resultMetadataOf(it.result);
                    if (embedded) {
                        usages[currentIdx] = this.buildUsageFromMeta(embedded, it, it.result?.details);
                    }
                }
            };

            const processValue = (o: any, rawLine: string) => {
                const kind = o?.kind;
                const v = o?.v;

                // Snapshot requests[]
                if (kind === 0 && v && Array.isArray(v.requests)) {
                    for (const it of v.requests) {
                        if (this.isRequestItem(it)) { ingestRequestItem(it); }
                    }
                }

                // Delta: v may be a request item, an array of items, or a result object.
                const items = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
                for (const it of items) {
                    if (this.isRequestItem(it)) { ingestRequestItem(it); }
                }

                // Result metadata (attach to the current request if not already set).
                const meta = this.resultMetadataOf(v);
                if (meta && currentIdx >= 0 && usages[currentIdx] === undefined) {
                    usages[currentIdx] = this.buildUsageFromMeta(meta, requestRecs[currentIdx], v?.details);
                }

                // Dynamic pricing detection.
                this.detectPricingInLine(rawLine);
            };

            for (const line of lines) {
                let o: any;
                try { o = JSON.parse(line); } catch { continue; }
                processValue(o, line);
            }

            // Resolve title.
            const storedInfo = this.sessionTitles.get(sessionId);
            let sessionTitle = storedInfo?.title || sessionData.customTitle || '';
            if (!sessionTitle && requestRecs.length > 0) {
                const firstMsg = this.extractUserText(requestRecs[0]);
                if (firstMsg) {
                    sessionTitle = firstMsg.length > 60 ? firstMsg.substring(0, 57) + '...' : firstMsg;
                }
            }
            if (!sessionTitle) {
                sessionTitle = `Session ${sessionId.substring(0, 8)}`;
            }

            // Determine session timestamp (latest activity).
            let lastMsgTimestamp = sessionData.creationDate || Date.now();
            for (const req of requestRecs) {
                if (typeof req.timestamp === 'number' && req.timestamp > lastMsgTimestamp) {
                    lastMsgTimestamp = req.timestamp;
                }
            }

            const inArchivedSet = this.archivedSessionIds.has(sessionId);
            const finalIsArchived = (storedInfo?.isArchived === true) || inArchivedSet;

            const session: ChatSession = {
                id: sessionId,
                title: sessionTitle,
                timestamp: lastMsgTimestamp,
                messages: [],
                workspace: workspaceId,
                workspaceLabel: this.workspaceLabels.get(workspaceId) || '',
                filePath,
                isArchived: finalIsArchived,
                isDeleted: false,
                promptCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalAic: 0,
                aicComplete: true,
                models: []
            };

            const modelSet = new Set<string>();

            for (let i = 0; i < requestRecs.length; i++) {
                const request = requestRecs[i];
                const usage = usages[i];
                const msgTimestamp = request.timestamp || sessionData.creationDate || session.timestamp;

                const userText = this.extractUserText(request);
                if (userText) {
                    const userMsg: ChatMessage = {
                        sessionId,
                        timestamp: msgTimestamp,
                        role: 'user',
                        content: userText,
                        preview: userText.substring(0, 200),
                        usage
                    };
                    session.messages.push(userMsg);

                    // Aggregate usage.
                    session.promptCount++;
                    if (usage) {
                        if (typeof usage.inputTokens === 'number') { session.totalInputTokens += usage.inputTokens; }
                        if (typeof usage.outputTokens === 'number') { session.totalOutputTokens += usage.outputTokens; }
                        if (typeof usage.aic === 'number') {
                            session.totalAic += usage.aic;
                        } else {
                            session.aicComplete = false;
                        }
                        if (usage.model) { modelSet.add(normalizeModelId(usage.model)); }
                    } else {
                        session.aicComplete = false;
                    }
                }

                const responseText = this.extractResponseText(request);
                if (responseText) {
                    const fileLinks = this.extractFileLinks(responseText);
                    session.messages.push({
                        sessionId,
                        timestamp: msgTimestamp,
                        role: 'assistant',
                        content: responseText,
                        preview: responseText.substring(0, 200),
                        fileLinks: fileLinks.length > 0 ? fileLinks : undefined
                    });
                }
            }

            session.models = Array.from(modelSet);

            if (storedInfo?.isEmpty === true) {
                return; // skip sessions VS Code marked empty/deleted
            }
            if (session.messages.length === 0) {
                return; // nothing useful to show
            }

            this.messages.push(...session.messages);
            this.sessions.push(session);
        } catch (error) {
            console.error(`[CopilotReport] Error parsing JSONL ${filePath}:`, error);
        }
    }

    /** Extract file references / changes from an assistant response (used by the chat viewer). */
    private extractFileLinks(content: string): FileLink[] {
        const fileLinks: FileLink[] = [];
        const seen = new Map<string, FileLink>();
        const addFileLink = (filePath: string, action: FileLink['action'], lineNumber?: number) => {
            filePath = filePath.replace(/[,;:!?)'"]+$/, '').trim();
            if (!filePath) { return; }
            const existing = seen.get(filePath);
            if (existing) {
                if (action === 'created' || action === 'modified') { existing.action = action; }
                if (lineNumber && !existing.lineNumber) { existing.lineNumber = lineNumber; }
            } else {
                const link: FileLink = { path: filePath, lineNumber, exists: this.checkFileExists(filePath), action };
                seen.set(filePath, link);
                fileLinks.push(link);
            }
        };

        const copilotFilePatterns: { pattern: RegExp; action: FileLink['action'] }[] = [
            { pattern: /Creating\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'created' },
            { pattern: /Created\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'created' },
            { pattern: /Editing\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Edited\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Writing\s+(?:to\s+)?\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Wrote\s+(?:to\s+)?\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Updating\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Updated\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'modified' },
            { pattern: /Deleting\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'deleted' },
            { pattern: /Deleted\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'deleted' },
            { pattern: /Reading\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'referenced' },
            { pattern: /Read\s+\[\]\(file:\/\/\/([^)]+)\)/gi, action: 'referenced' }
        ];
        for (const { pattern, action } of copilotFilePatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                let filePath = match[1];
                let lineNumber: number | undefined;
                const lineMatch = filePath.match(/^(.+?)#(?:L)?(\d+)/);
                if (lineMatch) { filePath = lineMatch[1]; lineNumber = parseInt(lineMatch[2]); }
                filePath = decodeURIComponent(filePath);
                addFileLink(filePath, action, lineNumber);
            }
        }

        // Standalone file:// URIs
        const fileUriRegex = /file:\/\/\/([^\s"<>,;)]+)/g;
        let match;
        while ((match = fileUriRegex.exec(content)) !== null) {
            let filePath = match[1];
            let lineNumber: number | undefined;
            const lineMatch = filePath.match(/^(.+?)#(?:L)?(\d+)/);
            if (lineMatch) { filePath = lineMatch[1]; lineNumber = parseInt(lineMatch[2]); }
            filePath = decodeURIComponent(filePath);
            addFileLink(filePath, 'referenced', lineNumber);
        }
        return fileLinks;
    }

    private checkFileExists(filePath: string): boolean {
        try {
            if (fs.existsSync(filePath)) { return true; }
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    if (fs.existsSync(path.join(folder.uri.fsPath, filePath))) { return true; }
                }
            }
            return false;
        } catch {
            return false;
        }
    }

    private extractTextFromRendered(rendered: any[]): string {
        if (!Array.isArray(rendered)) { return ''; }
        let text = '';
        for (const part of rendered) {
            if (part.type === 1 && part.text) {
                const match = part.text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
                if (match) {
                    text = match[1].trim().replace(/\s*\(See <attachments>.*?\)/g, '').trim();
                } else if (!text) {
                    text = part.text;
                }
            }
        }
        return text;
    }

    private buildSearchIndex(): void {
        const config = vscode.workspace.getConfiguration(CONFIG_NS);
        const threshold = config.get<number>('fuzzyThreshold', 0.4);
        this.fuse = new Fuse(this.messages, {
            keys: ['content', 'preview'],
            threshold,
            ignoreLocation: true,
            includeScore: true,
            minMatchCharLength: 2
        });
    }

    search(query: string): ChatMessage[] {
        if (!this.fuse || !query.trim()) { return []; }
        const config = vscode.workspace.getConfiguration(CONFIG_NS);
        const maxResults = config.get<number>('maxResults', 200);
        return this.fuse.search(query, { limit: maxResults }).map(r => r.item);
    }

    searchSessionsByTitle(query: string): ChatSession[] {
        if (!query.trim()) { return []; }
        const lowerQuery = query.toLowerCase();
        return this.sessions
            .filter(s => s.title.toLowerCase().includes(lowerQuery) && !s.isDeleted)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    getSessions(): ChatSession[] {
        return [...this.sessions].sort((a, b) => b.timestamp - a.timestamp);
    }

    getSessionCount(): number { return this.sessions.length; }
    getMessageCount(): number { return this.messages.length; }
    getPromptCount(): number { return this.sessions.reduce((n, s) => n + s.promptCount, 0); }

    /** Aggregate totals over all prompts whose timestamp falls in [start,end]. */
    getRangeSummary(start: number, end: number): {
        chats: number; prompts: number; input: number; output: number; aic: number; aicComplete: boolean;
    } {
        const result = { chats: 0, prompts: 0, input: 0, output: 0, aic: 0, aicComplete: true };
        const chatSet = new Set<string>();
        for (const session of this.sessions) {
            if (session.isDeleted) { continue; }
            for (const msg of session.messages) {
                if (msg.role !== 'user') { continue; }
                if (msg.timestamp < start || msg.timestamp > end) { continue; }
                chatSet.add(session.id);
                result.prompts++;
                const u = msg.usage;
                if (u) {
                    if (typeof u.inputTokens === 'number') { result.input += u.inputTokens; }
                    if (typeof u.outputTokens === 'number') { result.output += u.outputTokens; }
                    if (typeof u.aic === 'number') { result.aic += u.aic; } else { result.aicComplete = false; }
                } else {
                    result.aicComplete = false;
                }
            }
        }
        result.chats = chatSet.size;
        return result;
    }

    getSessionById(sessionId: string): ChatSession | undefined {
        return this.sessions.find(s => s.id === sessionId);
    }

    getSessionByMessage(message: ChatMessage): ChatSession | undefined {
        return this.sessions.find(s => s.id === message.sessionId);
    }
}
