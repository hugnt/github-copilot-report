/**
 * GitHub Copilot "AIC" (AI Credits) / USD accounting + model display names.
 *
 * Matches the approach used by ailmind/github-copilot-chat-usage: AIC is read
 * exclusively from the credits Copilot actually billed for a request (the `nanoAiu`
 * metadata field, or the "X credits" text GitHub writes into `result.details` once
 * billing is reconciled). There is no token x published-rate estimate — if Copilot
 * didn't record a credit value for a request, its AIC/USD is unknown ("—"), not guessed.
 *
 * See `extractNanoAiu()` in chatHistoryProvider.ts for the extraction logic itself.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MONEY CONVERSION — the single deciding knob for AIC → USD.
 *
 * GitHub Copilot's usage-based billing draws a customer's budget down at a FIXED
 * rate of **1 AI credit = $0.01 USD** (a $10 budget covers 1,000 credits — see
 * https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals).
 *
 * Change `DEFAULT_USD_PER_AIC` here to alter the rate for everyone, or override it
 * live per-user via the `githubCopilotReport.usdPerAic` setting (loaded on refresh).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const DEFAULT_USD_PER_AIC = 0.01;

/** Divisor that turns Copilot's raw `nanoAiu` metadata into whole AIC (1 AIC = 1e9 nanoAiu). */
export const NANO_AIU_PER_AIC = 1_000_000_000;

let usdPerAic = DEFAULT_USD_PER_AIC;

/** Set the AIC→USD rate (from settings). Invalid / non-positive values reset to the default. */
export function setUsdPerAic(rate: number | undefined | null): void {
    usdPerAic = (typeof rate === 'number' && isFinite(rate) && rate > 0) ? rate : DEFAULT_USD_PER_AIC;
}

/** The AIC→USD rate currently in effect. */
export function getUsdPerAic(): number {
    return usdPerAic;
}

/** Convert AIC to USD using the current rate. Returns undefined when AIC is unknown. */
export function computeUsd(aic: number | undefined): number | undefined {
    return aic === undefined ? undefined : aic * usdPerAic;
}

/**
 * Friendly display names for models GitHub Copilot currently offers. Purely cosmetic —
 * unrelated model ids fall back to their raw id. Kept in sync with
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models.
 *
 * Keyed in the models' canonical "." version form (as the docs write them, e.g.
 * "claude-haiku-4.5"), NOT the "-" form Copilot's own storage actually uses
 * ("claude-haiku-4-5"). `getModelDisplayName()` tries the "." form first and only falls back
 * to a "-"-normalized lookup when that misses — see the comment there for why.
 */
const DEFAULT_DISPLAY_NAMES: Record<string, string> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────
    'gpt-4.1': 'GPT-4.1',
    'gpt-4o': 'GPT-4o',
    'gpt-5-mini': 'GPT-5 mini',
    'gpt-5.3-codex': 'GPT-5.3-Codex',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 mini',
    'gpt-5.4-nano': 'GPT-5.4 nano',
    'gpt-5.5': 'GPT-5.5',

    // ── Anthropic ───────────────────────────────────────────────────────────
    'claude-haiku-4.5': 'Claude Haiku 4.5',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'claude-sonnet-4.5': 'Claude Sonnet 4.5',
    'claude-sonnet-4.6': 'Claude Sonnet 4.6',
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-opus-4.5': 'Claude Opus 4.5',
    'claude-opus-4.6': 'Claude Opus 4.6',
    'claude-opus-4.7': 'Claude Opus 4.7',
    'claude-opus-4.8': 'Claude Opus 4.8',
    'claude-opus-4.8-fast': 'Claude Opus 4.8 (fast mode)',
    'claude-fable-5': 'Claude Fable 5',

    // ── Google ──────────────────────────────────────────────────────────────
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-3.1-pro': 'Gemini 3.1 Pro',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',

    // ── Microsoft ───────────────────────────────────────────────────────────
    'mai-code-1-flash': 'MAI-Code-1-Flash',

    // ── Moonshot AI ─────────────────────────────────────────────────────────
    'kimi-k2.7-code': 'Kimi K2.7 Code',

    // ── GitHub fine-tuned ───────────────────────────────────────────────────
    'raptor-mini': 'Raptor mini'
};

/** Live registry, seeded from defaults (dotted canonical keys) and augmented at runtime. */
const displayNameRegistry = new Map<string, string>(Object.entries(DEFAULT_DISPLAY_NAMES));

/**
 * Same names as `displayNameRegistry`, but keyed with every "." replaced by "-" — mirrors
 * whatever Copilot's storage actually writes ("claude-sonnet-4-6" rather than the doc-style
 * "claude-sonnet-4.6"). Only consulted when a lookup misses the dotted registry; see
 * `getModelDisplayName()`.
 */
const dashFallbackRegistry = new Map<string, string>(
    Array.from(displayNameRegistry.entries()).map(([id, name]) => [id.replace(/\./g, '-'), name])
);

/**
 * Normalize a raw model id into a stable key: lowercase, provider prefix stripped
 * ("copilot/claude-sonnet-4.6" -> "claude-sonnet-4.6"), duplicate dashes collapsed.
 * Deliberately preserves "." as-is — callers decide whether/when to fall back to "-".
 */
export function normalizeModelId(modelId: string | undefined | null): string {
    if (!modelId) {
        return '';
    }
    let id = String(modelId).trim().toLowerCase();
    // Drop provider prefix ("copilot/..." , "github/...")
    if (id.includes('/')) {
        id = id.substring(id.lastIndexOf('/') + 1);
    }
    // Collapse duplicate dashes
    id = id.replace(/-+/g, '-');
    return id;
}

/** Register / override a model's friendly display name. Used by session-file detection and settings. */
export function registerModelDisplayName(modelId: string, displayName: string | undefined): void {
    const key = normalizeModelId(modelId);
    if (!key || !displayName) {
        return;
    }
    displayNameRegistry.set(key, displayName);
    dashFallbackRegistry.set(key.replace(/\./g, '-'), displayName);
}

/**
 * Best-effort keyword match for a model id that isn't registered verbatim — e.g. a brand-new
 * "claude-haiku-5" released after this table was last updated, or an id with extra suffixes
 * ("claude-sonnet-4-6-thinking", dated snapshots, etc). Tokenizes both the unknown id and every
 * registered id on '-' and scores by how many tokens they share, requiring the leading token
 * (the vendor/family root, e.g. "claude"/"gpt"/"gemini") to match so we never cross vendors.
 * Picks the registered id with the highest overlap (ties broken by closest token-count), so a
 * near-miss id resolves to its closest known relative instead of falling through to the raw id.
 */
function findClosestDisplayName(key: string): string | undefined {
    const keyTokens = key.split('-').filter(Boolean);
    if (keyTokens.length === 0) {
        return undefined;
    }
    const vendorToken = keyTokens[0];
    const keySet = new Set(keyTokens);

    let bestName: string | undefined;
    let bestScore = -Infinity;
    for (const [id, name] of dashFallbackRegistry) {
        const idTokens = id.split('-').filter(Boolean);
        if (idTokens[0] !== vendorToken) {
            continue;
        }
        let overlap = 0;
        for (const t of idTokens) {
            if (keySet.has(t)) { overlap++; }
        }
        // Require the vendor root plus at least one more shared keyword (e.g. "haiku", "5") —
        // matching on vendor alone is too weak a signal to pick a specific model.
        if (overlap < 2) {
            continue;
        }
        const score = overlap - Math.abs(idTokens.length - keyTokens.length) * 0.1;
        if (score > bestScore) {
            bestScore = score;
            bestName = name;
        }
    }
    return bestName;
}

/**
 * A friendly display name for a model id. Falls back to the trimmed raw id when unknown.
 *
 * Tries the canonical "." form first (matching the table's keys); only if that misses does it
 * retry with "." normalized to "-" — that's the form Copilot's own storage actually uses, so in
 * practice most real ids resolve on this second attempt, not the first.
 */
export function getModelDisplayName(modelId: string | undefined | null): string {
    const raw = (modelId || '').toString();
    const key = normalizeModelId(modelId);
    if (key) {
        if (displayNameRegistry.has(key)) {
            return displayNameRegistry.get(key)!;
        }
        const dashKey = key.replace(/\./g, '-');
        if (dashFallbackRegistry.has(dashKey)) {
            return dashFallbackRegistry.get(dashKey)!;
        }
        const closest = findClosestDisplayName(dashKey);
        if (closest) {
            return closest;
        }
    }
    if (raw.includes('/')) {
        return raw.substring(raw.lastIndexOf('/') + 1);
    }
    return raw || 'unknown';
}

/** Round AIC to a sensible number of decimals for display. */
export function formatAic(aic: number | undefined): string {
    if (aic === undefined) {
        return '—';
    }
    if (aic === 0) {
        return '0';
    }
    if (aic < 0.01) {
        return aic.toFixed(4);
    }
    if (aic < 10) {
        return aic.toFixed(2);
    }
    return aic.toFixed(1);
}

/** Format a USD amount for display (e.g. "$0.11", tiny values shown to 4 dp). */
export function formatUsd(usd: number | undefined): string {
    if (usd === undefined) {
        return '—';
    }
    if (usd === 0) {
        return '$0.00';
    }
    if (Math.abs(usd) < 0.01) {
        return '$' + usd.toFixed(4);
    }
    return '$' + usd.toFixed(2);
}

/** Compact token formatter: 1234 -> "1.2k". */
export function formatTokens(tokens: number | undefined): string {
    if (tokens === undefined || tokens === null) {
        return '—';
    }
    if (tokens < 1000) {
        return String(tokens);
    }
    if (tokens < 1_000_000) {
        return (tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0) + 'k';
    }
    return (tokens / 1_000_000).toFixed(2) + 'M';
}
