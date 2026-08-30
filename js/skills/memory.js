/**
 * Memory Skill
 * Handles user-controlled long-term memory
 */
import { state } from '../state.js';
import { memory } from '../memory.js';

export const memorySkill = {
    name: 'memory',
    description: 'Manages user-controlled long-term memory',
    patterns: [
        /remember\s+that/i,
        /remember\s+(?:my\s+)?/i,
        /save\s+(?:that|this)/i,
        /i\s+(?:have|own|use)\s+(?:a\s+)?/i,
        /my\s+(?:name|project|dog|cat|car|phone)/i,
        /what(?:\'s| is) (?:my|i)\s+/i,
        /do\s+you\s+remember/i,
        /forget\s+(?:that|this|my)/i,
        /delete\s+(?:that|this|my)/i,
        /what\s+do\s+i\s+(?:have|know|remember)/i,
        /recall\s+(?:that|my)/i,
        /tell\s+me\s+(?:my|about\s+my)/i
    ],

    /**
     * Execute memory command
     */
    execute(input, context = {}) {
        const text = input.toLowerCase();
        
        // Retrieval commands
        if (text.match(/what(?:\'s| is) (?:my|i)\s+/) || 
            text.match(/do\s+you\s+remember/i) ||
            text.match(/what\s+do\s+i\s+(?:have|know|remember)/i) ||
            text.match(/recall|tell\s+me\s+about/i)) {
            return this._recall(input);
        }
        
        // Forget/delete commands
        if (text.match(/forget|delete\s+(?:that|this|my)/i)) {
            return this._forget(input);
        }
        
        // Store commands
        if (text.match(/remember|save\s+(?:that|this)/i) ||
            text.match(/i\s+(?:have|own|use)\s+(?:a\s+)?/i)) {
            return this._remember(input);
        }
        
        return {
            success: false,
            error: 'I\'m not sure what you want me to do with memory'
        };
    },

    /**
     * Store a memory
     */
    _remember(input) {
        // Pattern: "Remember that my [key] is [value]"
        // Pattern: "My [key] is [value]"
        // Pattern: "I have a [key] called [value]"
        
        let key, value;
        
        // Extract key-value pairs
        const patterns = [
            /remember\s+(?:that\s+)?(?:my\s+)?(.+?)\s+is\s+(.+)/i,
            /my\s+(.+?)\s+is\s+(.+)/i,
            /remember\s+(?:that\s+)?i\s+(?:have\s+(?:a\s+)?|own\s+(?:a\s+)?)(.+)/i,
            /save\s+(?:that\s+)?(?:my\s+)?(.+?)\s+(?:as|called|named)\s+(.+)/i
        ];
        
        for (const pattern of patterns) {
            const match = input.match(pattern);
            if (match) {
                if (match[2]) {
                    key = match[1].trim();
                    value = match[2].trim();
                } else {
                    value = match[1].trim();
                    key = this._extractKey(value);
                }
                break;
            }
        }
        
        if (!key || !value) {
            return {
                success: false,
                error: 'What would you like me to remember? Try saying "Remember that my [something] is [value]".'
            };
        }
        
        memory.remember(key, value);
        
        return {
            success: true,
            result: `Okay, I'll remember that your ${key} is ${value}.`
        };
    },

    /**
     * Recall a memory
     */
    _recall(input) {
        // Extract what to recall
        let searchTerm = input
            .replace(/what(?:\'s| is) (?:my|i)\s+/i, '')
            .replace(/do\s+you\s+remember\s+(?:my\s+)?/i, '')
            .replace(/what\s+do\s+i\s+(?:have|know|remember)\s+/i, '')
            .replace(/recall|tell\s+me\s+(?:about\s+)?my\s+/i, '')
            .replace(/\?/g, '')
            .trim();
        
        if (!searchTerm || searchTerm === 'i' || searchTerm === 'me') {
            // List all memories
            const all = memory.getAllMemories();
            if (all.length === 0) {
                return {
                    success: true,
                    result: 'You haven\'t told me anything to remember yet. Just say "Remember that my [something] is [value]" to save information.'
                };
            }
            
            const list = all.slice(0, 5).map((m, i) => `${i + 1}. ${m.key}: ${m.value}`).join('\n');
            return {
                success: true,
                result: `Here's what I remember about you:\n${list}`
            };
        }
        
        // Search for specific memory
        const value = memory.recall(searchTerm);
        
        if (value !== null) {
            return {
                success: true,
                result: `Your ${searchTerm} is ${value}.`
            };
        }
        
        // Try fuzzy search
        const results = memory.search(searchTerm);
        if (results.length > 0) {
            const closest = results[0];
            return {
                success: true,
                result: `Based on what you told me, your ${closest.key} is ${closest.value}.`
            };
        }
        
        return {
            success: false,
            error: `I don't have anything saved about "${searchTerm}". Would you like me to remember it?`
        };
    },

    /**
     * Forget a memory
     */
    _forget(input) {
        // Extract what to forget
        const searchTerm = input
            .replace(/forget\s+(?:that|this|my\s+)?/i, '')
            .replace(/delete\s+(?:that|this|my\s+)?/i, '')
            .replace(/\?/g, '')
            .trim();
        
        if (!searchTerm) {
            return {
                success: false,
                error: 'What would you like me to forget? Please specify what to delete.'
            };
        }
        
        // Try exact match first
        if (memory.forget(searchTerm)) {
            return {
                success: true,
                result: `I've forgotten your ${searchTerm}.`
            };
        }
        
        // Try partial match
        const results = memory.search(searchTerm);
        if (results.length > 0) {
            memory.forget(results[0].key);
            return {
                success: true,
                result: `I've forgotten that your ${results[0].key} was ${results[0].value}.`
            };
        }
        
        return {
            success: false,
            error: `I don't have anything saved about "${searchTerm}" to forget.`
        };
    },

    /**
     * Extract a key from value
     */
    _extractKey(value) {
        // Take first significant words
        const words = value.split(' ').slice(0, 3);
        return words.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    }
};
