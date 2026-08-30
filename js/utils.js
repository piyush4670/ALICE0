/**
 * ALICE Utilities
 * Helper functions for the interface
 */

/**
 * Format time for display
 */
export function formatTime(date) {
    return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

/**
 * Format date for display
 */
export function formatDate(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

/**
 * Create animated element with CSS class
 */
export function animateElement(element, animationClass, duration = 500) {
    return new Promise(resolve => {
        element.classList.add(animationClass);
        setTimeout(() => {
            element.classList.remove(animationClass);
            resolve();
        }, duration);
    });
}

/**
 * Animate number change
 */
export function animateNumber(start, end, duration, callback) {
    const startTime = performance.now();
    const range = end - start;
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic
        
        callback(start + (range * easeProgress));
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

/**
 * Delay helper
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate random ID
 */
export function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Linear interpolation
 */
export function lerp(start, end, t) {
    return start + (end - start) * t;
}

/**
 * Map value from one range to another
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
    return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

/**
 * Create CSS keyframes dynamically
 */
export function createKeyframes(name, frames) {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes ${name} {
            ${frames.map(f => `${f.at} { ${f.css} }`).join('\n')}
        }
    `;
    document.head.appendChild(style);
    return style;
}

/**
 * Create SVG element
 */
export function createSVG(tag, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
    });
    return element;
}

/**
 * Redact sensitive-looking tokens from a string before it is logged or
 * displayed. Uses the patterns defined in CONFIG.security. This keeps API
 * keys and credentials out of logs while preserving the rest of the message.
 */
import { CONFIG } from './config.js';

export function redact(text) {
    let out = String(text ?? '');
    for (const pattern of CONFIG.security.redactPatterns) {
        out = out.replace(pattern, '[REDACTED]');
    }
    return out;
}

/**
 * Escape a string for safe insertion into HTML (prevents markup injection
 * in dynamic HUD panels such as the task dashboard).
 */
export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Lightweight extractive text summarization (no external services).
 * Splits text into sentences, then returns an ordered selection of the most
 * representative ones. Used by the agent's "process information" step — this
 * is a general helper, not a duplicate of the `reader` skill (which operates
 * on user-selected documents).
 */
export function summarizeText(text, maxSentences = 3) {
    if (!text || typeof text !== 'string') return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return '';

    const sentences = clean
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 20);

    if (sentences.length === 0) {
        return clean.substring(0, 400);
    }
    if (sentences.length <= maxSentences) {
        return sentences.join(' ');
    }

    // Score sentences by word frequency (simple extractive ranking)
    const wordFreq = {};
    sentences.forEach(s => {
        s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).forEach(w => {
            if (w.length > 3) wordFreq[w] = (wordFreq[w] || 0) + 1;
        });
    });

    const score = s => {
        const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        const total = words.reduce((sum, w) => sum + (wordFreq[w] || 0), 0);
        return total / Math.max(1, words.length);
    };

    const ranked = sentences
        .map((s, i) => ({ s, i, score: score(s) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSentences)
        .sort((a, b) => a.i - b.i);

    return ranked.map(r => r.s).join(' ');
}

/**
 * Ease functions
 */
export const easing = {
    easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    easeOut: t => 1 - Math.pow(1 - t, 3),
    easeIn: t => t * t * t,
    elastic: t => Math.sin(-13 * Math.PI / 2 * (t + 1)) * Math.pow(2, -10 * t) + 1
};
