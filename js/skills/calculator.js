/**
 * Calculator Skill
 * Handles mathematical calculations
 */
import { state } from '../state.js';

export const calculator = {
    name: 'calculator',
    description: 'Performs mathematical calculations',
    patterns: [
        /calculate/i,
        /what is\s+/i,
        /how much is\s+/i,
        /\d+\s*[\+\-\*\/\^]\s*\d+/,
        /percent(age)? of/i,
        /square root/i,
        /cube root/i,
        /sqrt/i,
        /\d+\s+times\s+\d+/i,
        /\d+\s+plus\s+\d+/i,
        /\d+\s+minus\s+\d+/i,
        /\d+\s+divided\s+by\s+\d+/i
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
