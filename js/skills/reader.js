/**
 * Reader Skill
 * Reads and processes documents
 */
import { state } from '../state.js';

export const reader = {
    name: 'reader',
    description: 'Reads and summarizes documents',
    patterns: [
        /read\s+(?:this|me|the|a)/i,
        /summarize/i,
        /what\s+does\s+(?:it|the)\s+say/i,
        /what(?:\'s| is) (?:in|written) (?:here|the)/i,
        /read\s+aloud/i,
        /read\s+out\s+(?:loud|load)/i,
        /extract\s+(?:the\s+)?(?:information|text)/i,
        /parse\s+(?:the\s+)?document/i
    ],

    /**
     * Execute reader command
     */
    execute(input, context = {}) {
        const text = input.toLowerCase();
        
        if (text.match(/summarize/i)) {
            return this._summarize(input);
        }
        
        if (text.match(/read\s+(?:aloud|out)/i)) {
            return this._readAloud(input);
        }
        
        return this._readDocument(input);
    },

    /**
     * Read a document (opens file picker)
     */
    _readDocument(input) {
        const inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.txt,.md,.json,.js,.html,.css,.csv,.xml,.pdf';
        
        inputEl.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const text = await file.text();
                    state.logActivity(`Read document: ${file.name} (${text.length} chars)`, 'success');
                    
                    // Store for reference
                    state.set('lastReadDocument', {
                        name: file.name,
                        content: text,
                        timestamp: Date.now()
                    });
                    
                } catch (err) {
                    state.logActivity(`Failed to read document: ${err.message}`, 'danger');
                }
            }
        };
        
        inputEl.click();
        
        return {
            success: true,
            result: 'Opening document picker... Please select a file to read.',
            interactive: true
        };
    },

    /**
     * Summarize content
     */
    _summarize(input) {
        const lastDoc = state.get('lastReadDocument');
        
        if (!lastDoc) {
            return {
                success: false,
                error: 'I don\'t have any document to summarize. Please read a document first.'
            };
        }

        const content = lastDoc.content;
        
        // Simple extractive summarization
        const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
        
        if (sentences.length <= 3) {
            return {
                success: true,
                result: `Here's the content of "${lastDoc.name}":\n\n${content.substring(0, 500)}${content.length > 500 ? '...' : ''}`
            };
        }

        // Take first and last significant sentences
        const summary = [
            sentences[0].trim(),
            sentences[Math.floor(sentences.length / 2)].trim(),
            sentences[sentences.length - 1].trim()
        ].join('. ');

        return {
            success: true,
            result: `Summary of "${lastDoc.name}" (from ${sentences.length} sentences):\n\n${summary}.`,
            originalLength: content.length,
            summaryLength: summary.length
        };
    },

    /**
     * Read content aloud
     */
    _readAloud(input) {
        const lastDoc = state.get('lastReadDocument');
        
        if (!lastDoc) {
            return {
                success: false,
                error: 'I don\'t have any document to read. Please read a document first.'
            };
        }

        // Will be read by conversation manager using TTS
        return {
            success: true,
            result: lastDoc.content.substring(0, 3000), // Limit for TTS
            readAloud: true
        };
    }
};
