/**
 * Model pricing for GitHub Copilot "AIC" (AI Credits) accounting.
 *
 * GitHub Copilot's usage-based billing expresses model cost as AICs per 1,000,000 tokens,
 * e.g. Claude Sonnet 4.6 is displayed in the chat data as:
 *      "pricing": "In: 300 · Out: 1500 AICs/1M tokens"
 *      "inputCost": 300, "outputCost": 1500, "cacheCost": 30
 *
 * AIC for a single request =
 *      inputTokens  / 1e6 * inputCost
 *    + outputTokens / 1e6 * outputCost
 *    + cacheTokens  / 1e6 * cacheCost
 *
 * Older "premium request" models are billed with a flat multiplier (e.g. "1x") instead
 * of per-token AICs; those are represented with `multiplier`.
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

export interface ModelPricing {
    /** AIC per 1,000,000 input (prompt) tokens. */
    inputCost?: number;
    /** AIC per 1,000,000 output (completion) tokens. */
    outputCost?: number;
    /** AIC per 1,000,000 cached input tokens. */
    cacheCost?: number;
    /** Premium-request multiplier for models billed per request rather than per token. */
    multiplier?: number;
    /** Optional friendly label. */
    displayName?: string;
}

/**
 * Confirmed/known defaults for every model GitHub Copilot currently offers, kept in sync with
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing (usage-based
 * AIC pricing) and https://docs.github.com/en/copilot/reference/ai-models/supported-models
 * (model catalog). Anything not listed here (or superseded) is resolved dynamically from the
 * session files (models embed their own pricing) or from the `githubCopilotReport.modelPricing`
 * setting. Values are AIC per 1,000,000 tokens (1 AIC = $0.01 USD).
 *
 * Note: a few models (GPT-5.4, GPT-5.5, Gemini 3.1 Pro) bill a higher "long context" tier once a
 * request exceeds their base context window; the entries below use the base/default tier, and the
 * dynamic session-file detector (`detectPricingInLine`) overrides with the real observed rate.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
    // ── OpenAI ──────────────────────────────────────────────────────────────
    'gpt-4-1': { multiplier: 0, displayName: 'GPT-4.1' },
    'gpt-4o': { multiplier: 0, displayName: 'GPT-4o' },
    'gpt-5-mini': { inputCost: 25, outputCost: 200, cacheCost: 2.5, displayName: 'GPT-5 mini' },
    'gpt-5-3-codex': { inputCost: 175, outputCost: 1400, cacheCost: 17.5, displayName: 'GPT-5.3-Codex' },
    'gpt-5-4': { inputCost: 250, outputCost: 1500, cacheCost: 25, displayName: 'GPT-5.4' },
    'gpt-5-4-mini': { inputCost: 75, outputCost: 450, cacheCost: 7.5, displayName: 'GPT-5.4 mini' },
    'gpt-5-4-nano': { inputCost: 20, outputCost: 125, cacheCost: 2, displayName: 'GPT-5.4 nano' },
    'gpt-5-5': { inputCost: 500, outputCost: 3000, cacheCost: 50, displayName: 'GPT-5.5' },

    // ── Anthropic ───────────────────────────────────────────────────────────
    'claude-haiku-4-5': { inputCost: 100, outputCost: 500, cacheCost: 10, displayName: 'Claude Haiku 4.5' },
    'claude-sonnet-4': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4' },
    'claude-sonnet-4-5': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4.5' },
    'claude-sonnet-4-6': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4.6' },
    'claude-sonnet-5': { inputCost: 200, outputCost: 1000, cacheCost: 20, displayName: 'Claude Sonnet 5' },
    'claude-opus-4-5': { inputCost: 500, outputCost: 2500, cacheCost: 50, displayName: 'Claude Opus 4.5' },
    'claude-opus-4-6': { inputCost: 500, outputCost: 2500, cacheCost: 50, displayName: 'Claude Opus 4.6' },
    'claude-opus-4-7': { inputCost: 500, outputCost: 2500, cacheCost: 50, displayName: 'Claude Opus 4.7' },
    'claude-opus-4-8': { inputCost: 500, outputCost: 2500, cacheCost: 50, displayName: 'Claude Opus 4.8' },
    'claude-opus-4-8-fast': { inputCost: 1000, outputCost: 5000, cacheCost: 100, displayName: 'Claude Opus 4.8 (fast mode)' },
    'claude-fable-5': { inputCost: 1000, outputCost: 5000, cacheCost: 100, displayName: 'Claude Fable 5' },

    // ── Google ──────────────────────────────────────────────────────────────
    'gemini-2-5-pro': { inputCost: 125, outputCost: 1000, cacheCost: 12.5, displayName: 'Gemini 2.5 Pro' },
    'gemini-3-flash': { inputCost: 50, outputCost: 300, cacheCost: 5, displayName: 'Gemini 3 Flash' },
    'gemini-3-1-pro': { inputCost: 200, outputCost: 1200, cacheCost: 20, displayName: 'Gemini 3.1 Pro' },
    'gemini-3-5-flash': { inputCost: 150, outputCost: 900, cacheCost: 15, displayName: 'Gemini 3.5 Flash' },

    // ── Microsoft ───────────────────────────────────────────────────────────
    'mai-code-1-flash': { inputCost: 75, outputCost: 450, cacheCost: 7.5, displayName: 'MAI-Code-1-Flash' },

    // ── Moonshot AI ─────────────────────────────────────────────────────────
    'kimi-k2-7-code': { inputCost: 95, outputCost: 400, cacheCost: 19, displayName: 'Kimi K2.7 Code' },

    // ── GitHub fine-tuned ───────────────────────────────────────────────────
    'raptor-mini': { inputCost: 25, outputCost: 200, cacheCost: 2.5, displayName: 'Raptor mini' }
};

/** Live registry, seeded from defaults and augmented at runtime. */
const registry = new Map<string, ModelPricing>();
for (const [id, p] of Object.entries(DEFAULT_PRICING)) {
    registry.set(id, { ...p });
}

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

/**
 * Register / merge pricing for a model. Used by the dynamic detector (parsing session files)
 * and by user configuration. Only defined fields overwrite existing ones.
 */
export function registerModelPricing(modelId: string, pricing: ModelPricing): void {
    const key = normalizeModelId(modelId);
    if (!key) {
        return;
    }
    const existing = registry.get(key) || {};
    const merged: ModelPricing = { ...existing };
    if (typeof pricing.inputCost === 'number') { merged.inputCost = pricing.inputCost; }
    if (typeof pricing.outputCost === 'number') { merged.outputCost = pricing.outputCost; }
    if (typeof pricing.cacheCost === 'number') { merged.cacheCost = pricing.cacheCost; }
    if (typeof pricing.multiplier === 'number') { merged.multiplier = pricing.multiplier; }
    if (pricing.displayName) { merged.displayName = pricing.displayName; }
    registry.set(key, merged);
}

/** Look up pricing for a model id (normalized internally). Returns undefined if unknown. */
export function getPricing(modelId: string | undefined | null): ModelPricing | undefined {
    const key = normalizeModelId(modelId);
    if (!key) {
        return undefined;
    }
    if (registry.has(key)) {
        return registry.get(key);
    }
    // Best-effort family fallback: match by prefix (e.g. "claude-sonnet-4-6-thinking").
    for (const [id, p] of registry) {
        if (key.startsWith(id) || id.startsWith(key)) {
            return p;
        }
    }
    return undefined;
}

/** A friendly display name for a model id. */
export function getModelDisplayName(modelId: string | undefined | null): string {
    const raw = (modelId || '').toString();
    const pricing = getPricing(modelId);
    if (pricing?.displayName) {
        return pricing.displayName;
    }
    // Fall back to the trimmed raw id.
    if (raw.includes('/')) {
        return raw.substring(raw.lastIndexOf('/') + 1);
    }
    return raw || 'unknown';
}

/**
 * Compute AIC for a single request. Returns undefined when the model's per-token pricing
 * is unknown (so callers can distinguish "0 AIC" from "unknown").
 */
export function computeAic(
    inputTokens: number,
    outputTokens: number,
    cacheTokens: number,
    modelId: string | undefined | null
): number | undefined {
    const pricing = getPricing(modelId);
    if (!pricing || (pricing.inputCost === undefined && pricing.outputCost === undefined)) {
        return undefined;
    }
    const inCost = pricing.inputCost ?? 0;
    const outCost = pricing.outputCost ?? 0;
    const cCost = pricing.cacheCost ?? 0;
    // Cached tokens are billed at the (cheaper) cache rate; the remaining input at the input rate.
    const billableInput = Math.max(0, inputTokens - cacheTokens);
    const aic =
        (billableInput / 1_000_000) * inCost +
        (cacheTokens / 1_000_000) * cCost +
        (outputTokens / 1_000_000) * outCost;
    return aic;
}

/** Load pricing overrides from the user's settings object. */
export function loadPricingOverrides(overrides: Record<string, ModelPricing> | undefined): void {
    if (!overrides || typeof overrides !== 'object') {
        return;
    }
    for (const [id, p] of Object.entries(overrides)) {
        if (p && typeof p === 'object') {
            registerModelPricing(id, p);
        }
    }
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
