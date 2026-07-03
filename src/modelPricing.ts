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
 */
const DEFAULT_DISPLAY_NAMES: Record<string, string> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────
    'gpt-4-1': 'GPT-4.1',
    'gpt-4o': 'GPT-4o',
    'gpt-5-mini': 'GPT-5 mini',
    'gpt-5-3-codex': 'GPT-5.3-Codex',
    'gpt-5-4': 'GPT-5.4',
    'gpt-5-4-mini': 'GPT-5.4 mini',
    'gpt-5-4-nano': 'GPT-5.4 nano',
    'gpt-5-5': 'GPT-5.5',

    // ── Anthropic ───────────────────────────────────────────────────────────
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-opus-4-5': 'Claude Opus 4.5',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-opus-4-7': 'Claude Opus 4.7',
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-opus-4-8-fast': 'Claude Opus 4.8 (fast mode)',
    'claude-fable-5': 'Claude Fable 5',

    // ── Google ──────────────────────────────────────────────────────────────
    'gemini-2-5-pro': 'Gemini 2.5 Pro',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-3-1-pro': 'Gemini 3.1 Pro',
    'gemini-3-5-flash': 'Gemini 3.5 Flash',

    // ── Microsoft ───────────────────────────────────────────────────────────
    'mai-code-1-flash': 'MAI-Code-1-Flash',

    // ── Moonshot AI ─────────────────────────────────────────────────────────
    'kimi-k2-7-code': 'Kimi K2.7 Code',

    // ── GitHub fine-tuned ───────────────────────────────────────────────────
    'raptor-mini': 'Raptor mini'
};

/** Live registry, seeded from defaults and augmented at runtime (session-file detection). */
const displayNameRegistry = new Map<string, string>(Object.entries(DEFAULT_DISPLAY_NAMES));

/**
 * Normalize a raw model id into a stable key.
 * Handles: "copilot/claude-sonnet-4.6", "claude-sonnet-4.6", "claude-sonnet-4-6" -> "claude-sonnet-4-6".
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
    // Unify version separators: dots -> dashes so "4.6" == "4-6"
    id = id.replace(/\./g, '-');
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
}

/** A friendly display name for a model id. Falls back to the trimmed raw id when unknown. */
export function getModelDisplayName(modelId: string | undefined | null): string {
    const raw = (modelId || '').toString();
    const key = normalizeModelId(modelId);
    if (key) {
        if (displayNameRegistry.has(key)) {
            return displayNameRegistry.get(key)!;
        }
        // Best-effort family fallback: match by prefix (e.g. "claude-sonnet-4-6-thinking").
        for (const [id, name] of displayNameRegistry) {
            if (key.startsWith(id) || id.startsWith(key)) {
                return name;
            }
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
