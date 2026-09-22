/**
 * Calculator Skill
 * Handles mathematical calculations
 *
 * ROUTING RULE — mathematical content decides, framing words do not:
 *
 * The calculator claims a request only when the text carries mathematical
 * *content*: an arithmetic expression (operand operator operand, written
 * with symbols such as "25 * 4" or with words such as "20 divided by 4")
 * or a math keyword that appears in no ordinary sentence ("calculate",
 * "15 percent of", "square root", "sqrt", ...).
 *
 * Question framing alone is never a trigger. "what is ...", "how much
 * is ..." and friends also introduce knowledge questions — "What is the
 * capital of India?", "What is photosynthesis?" — which must reach the
 * knowledge/search path instead of being answered with
 * "Could not understand the calculation". Numbers in prose are not
 * arithmetic either: they only count when an operator joins two operands.
 *
 * Word operators below are exactly the ones execute() knows how to
 * evaluate, so anything routed here can actually be computed.
 */
import { state } from '../state.js';

export const calculator = {
    name: 'calculator',
    description: 'Performs mathematical calculations',
    patterns: [
        // Explicit request to compute something.
        /calculate/i,

        // Math keywords that never occur in ordinary prose.
        /\b(?:square|cube)\s+root\b/i,
        /\bsqrt\b/i,
        /\b\d[\d,.]*\s*percent(?:age)?\s+of\b/i,          // "15 percent of 200"

        // Arithmetic with symbol operators: "2 + 2", "25 * 4", "5 ^ 3".
        /\d\s*[+\-*/^×÷]\s*\d/,

        // Arithmetic spelled with words: "10 plus 5", "20 divided by 4",
        // "10 times 8", "$20 plus $5". The operator must join two numbers,
        // so prose that merely contains a number never matches.
        /\d[\d,.]*\s*(?:\$\s*)?(?:plus|minus|times|multiplied\s+by|divided\s+by)\s+(?:\$\s*)?\d[\d,.]*/i
    ],

    /**
     * Execute a calculation
     */
    execute(input) {
        const text = input.toLowerCase();
        
        try {
            // Handle percentage calculations
            if (text.includes('percent') || text.includes('percentage')) {
                const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:percent|percentage)/i);
                const ofMatch = text.match(/of\s+(\d+(?:,?\d+)*(?:\.\d+)?)/i);
                
                if (percentMatch && ofMatch) {
                    const percent = parseFloat(percentMatch[1]);
                    const of = parseFloat(ofMatch[1].replace(/,/g, ''));
                    const result = (percent / 100) * of;
                    return {
                        success: true,
                        result: `${percent}% of ${of} = ${this._formatNumber(result)}`,
                        value: result
                    };
                }
            }

            // Handle "what is X plus/minus/times/divided by Y"
            const mathWords = {
                'plus': '+',
                'minus': '-',
                'times': '*',
                'multiplied by': '*',
                'divided by': '/',
                '÷': '/'
            };

            let expression = text
                .replace(/what is\s+/i, '')
                .replace(/calculate\s+/i, '')
                .replace(/how much is\s+/i, '');

            // Convert words to symbols
            for (const [word, symbol] of Object.entries(mathWords)) {
                expression = expression.replace(new RegExp(word, 'gi'), symbol);
            }

            // Clean up the expression
            expression = expression
                .replace(/\s+/g, '')
                .replace(/[a-z]/gi, '')
                .replace(/×/g, '*')
                .replace(/÷/g, '/');

            // Check for valid math expression
            if (/^[\d\+\-\*\/\^\(\)\.]+$/.test(expression)) {
                // Handle power operator
                expression = expression.replace(/\^/g, '**');
                
                const result = Function('"use strict"; return (' + expression + ')')();
                
                if (typeof result === 'number' && isFinite(result)) {
                    return {
                        success: true,
                        result: `${input.match(/(\d+(?:\.\d+)?.*\d+(?:\.\d+)?)/i)?.[0]} = ${this._formatNumber(result)}`,
                        value: result
                    };
                }
            }

            // Try to parse as-is
            const cleanExpr = expression.replace(/[^\d\+\-\*\/\.\,\(\)]/g, '');
            if (cleanExpr && /^[\d\+\-\*\/\(\)\.]+$/.test(cleanExpr)) {
                const result = Function('"use strict"; return (' + cleanExpr.replace(/,/g, '') + ')')();
                return {
                    success: true,
                    result: `= ${this._formatNumber(result)}`,
                    value: result
                };
            }

            return {
                success: false,
                error: 'Could not understand the calculation'
            };

        } catch (e) {
            return {
                success: false,
                error: `Calculation error: ${e.message}`
            };
        }
    },

    /**
     * Format number for display
     */
    _formatNumber(num) {
        if (Number.isInteger(num)) {
            return num.toLocaleString();
        }
        // Round to reasonable precision
        const rounded = Math.round(num * 1000000) / 1000000;
        return rounded.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }
};
