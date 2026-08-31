/**
 * ALICE Model Adapter Base Interface (Phase 6.2)
 * ------------------------------------------------------------------
 * Provider-neutral base interface for AI model integration.
 *
 * Architecture:
 *     AI Brain → Model Adapter → Provider
 *
 * Core capabilities:
 *   - Structured and natural language generation
 *   - Optional streaming interface
 *   - Execution timeout enforcement
 *   - AbortSignal cancellation support
 *   - Error normalization into standard AI error hierarchy
 *   - Output size bounding
 */
import { CONFIG } from '../config.js';

// ==================================================================
// Error Hierarchy
// ==================================================================

export class AIError extends Error {
    constructor(message, code = 'AI_ERROR', details = null) {
        super(message);
        this.name = 'AIError';
        this.code = code;
        this.details = details;
    }
}

export class AITimeoutError extends AIError {
    constructor(message = 'AI model request timed out', timeoutMs = 0) {
        super(message, 'AI_TIMEOUT', { timeoutMs });
        this.name = 'AITimeoutError';
    }
}

export class AICancellationError extends AIError {
    constructor(message = 'AI model request was cancelled') {
        super(message, 'AI_CANCELLED');
        this.name = 'AICancellationError';
    }
}

export class AIValidationError extends AIError {
    constructor(message = 'AI output validation failed', errors = []) {
        super(message, 'AI_VALIDATION', { errors });
        this.name = 'AIValidationError';
    }
}

export class AIProviderError extends AIError {
    constructor(message = 'AI provider error', originalError = null) {
        super(message, 'AI_PROVIDER', { original: originalError?.message || null });
        this.name = 'AIProviderError';
    }
}

// ==================================================================
// Base Model Adapter
// ==================================================================

export class ModelAdapter {
    constructor(config = {}) {
        this._config = { ...config };
    }

    /**
     * Primary generation method. Must be implemented by subclasses.
     * @param {string|Object} prompt - Input prompt or structured context
     * @param {Object} [options]
     * @param {number} [options.timeout] - Timeout in milliseconds
     * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
     * @param {string} [options.responseFormat='json'] - Expected format ('json' | 'text' | 'plan')
     * @param {number} [options.maxOutputSize] - Max allowed output characters
     * @returns {Promise<{ text: string, structured?: Object, usage?: Object }>}
     */
    async generate(prompt, options = {}) {
        throw new Error('generate() must be implemented by concrete ModelAdapter');
    }

    /**
     * Optional streaming generation interface.
     * @param {string|Object} prompt
     * @param {Object} [options]
     * @returns {AsyncGenerator<string>}
     */
    async *generateStream(prompt, options = {}) {
        const result = await this.generate(prompt, options);
        yield result.text;
    }

    /**
     * Wrap any async operation with timeout and cancellation support.
     * @param {Promise<any>} promise
     * @param {number} timeoutMs
     * @param {AbortSignal} [signal]
     * @returns {Promise<any>}
     */
    async withTimeout(promise, timeoutMs = 0, signal = null) {
        const effectiveTimeout = timeoutMs > 0 ? timeoutMs : (CONFIG.ai?.timeout || 5000);

        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new AITimeoutError(`AI request timed out after ${effectiveTimeout}ms`, effectiveTimeout));
            }, effectiveTimeout);
        });

        let cancelPromise = null;
        let abortListener = null;
        if (signal) {
            if (signal.aborted) {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                throw new AICancellationError('AI request was aborted before start');
            }
            cancelPromise = new Promise((_, reject) => {
                abortListener = () => reject(new AICancellationError('AI request was cancelled by user/caller'));
                signal.addEventListener('abort', abortListener, { once: true });
            });
        }

        const races = [promise, timeoutPromise];
        if (cancelPromise) races.push(cancelPromise);

        try {
            return await Promise.race(races);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
        }
    }

    /**
     * Normalize any thrown exception into standard AIError.
     * @param {any} err
     * @returns {AIError}
     */
    normalizeError(err) {
        if (err instanceof AIError) return err;
        if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
            return new AICancellationError(err.message);
        }
        if (err?.name === 'TimeoutError') {
            return new AITimeoutError(err.message);
        }
        return new AIProviderError(err?.message || 'Unknown provider error', err);
    }

    /**
     * Parse structured output (JSON or markdown block) safely.
     * @param {string} rawText
     * @returns {Object} Parsed JSON object
     */
    parseStructuredOutput(rawText) {
        if (typeof rawText !== 'string' || rawText.trim().length === 0) {
            throw new AIValidationError('Empty or invalid output from AI model');
        }

        const maxOutputSize = CONFIG.ai?.maxOutputSize || 10000;
        if (rawText.length > maxOutputSize) {
            throw new AIValidationError(`Model output exceeded max size limit of ${maxOutputSize} characters`);
        }

        let jsonStr = rawText.trim();

        // Extract JSON from markdown code block if present (```json ... ```)
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        }

        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            throw new AIValidationError(`Failed to parse structured JSON from model output: ${e.message}`);
        }
    }
}
