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
 * Confirmed defaults observed in the local Copilot chat data. Anything not listed here is
 * resolved dynamically from the session files (models embed their own pricing) or from the
 * `githubCopilotReport.modelPricing` setting. Values are AIC per 1,000,000 tokens.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
    'claude-sonnet-4-6': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4.6' },
    'claude-sonnet-4-5': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4.5' },
    'claude-sonnet-4': { inputCost: 300, outputCost: 1500, cacheCost: 30, displayName: 'Claude Sonnet 4' },
    'gpt-4-1': { multiplier: 0, displayName: 'GPT-4.1' },
    'gpt-4o': { multiplier: 0, displayName: 'GPT-4o' },
    'gpt-5-mini': { multiplier: 0, displayName: 'GPT-5 mini' }
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
