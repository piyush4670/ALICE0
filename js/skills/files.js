/**
 * Files Skill
 * Handles basic file operations
 */
import { state } from '../state.js';

export const files = {
    name: 'files',
    description: 'Manages files and documents',
    patterns: [
        /read\s+(?:me\s+)?(?:the\s+)?(?:file|document|pdf)/i,
        /open\s+(?:the\s+)?(?:file|document)/i,
        /download\s+(?:the\s+)?(?:file|document)/i,
        /create\s+(?:a\s+)?(?:file|document)/i,
        /write\s+(?:to\s+)?(?:a\s+)?(?:file|document)/i,
        /list\s+(?:my\s+)?files/i,
        /show\s+(?:my\s+)?files/i,
        /export/i,
        /save\s+(?:to\s+)?(?:a\s+)?file/i
    ],

    /**
     * Execute file command
     */
    execute(input, context = {}) {
        // Agent path: the planner has already prepared the document content.
        // This is used by the "create document" step of a multi-step task.
        if (context && context.content !== undefined) {
            return this._createFileContent(context);
        }

        const text = input.toLowerCase();
        
        if (text.match(/read|open/i)) {
            return this._readFile(input);
        }
        
        if (text.match(/create|write|new/i)) {
            return this._createFile(input);
        }
        
        if (text.match(/list|show/i)) {
            return this._listFiles();
        }
        
        return {
            success: false,
            error: 'I\'m not sure what you want me to do with files'
        };
    },

    /**
     * Create a file from already-prepared content (used by the agent).
     */
    _createFileContent({ content, filename }) {
        const name = filename || 'alice-document.txt';
        if (!content || !String(content).trim()) {
            return {
                success: false,
                error: 'There is no content to write to the document.'
            };
        }
        this._downloadFile(name, String(content));
        return {
            success: true,
            result: `Created document "${name}". The download should start automatically.`,
            filename: name
        };
    },

    /**
     * Read a file
     */
    _readFile(input) {
        // In browser context, we can only read files the user selects
        // Create a file input for user to select file
        const inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = '.txt,.md,.json,.js,.html,.css,.csv';
        
        inputEl.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const text = await file.text();
                    state.logActivity(`Read file: ${file.name}`, 'success');
                    // Show first 500 chars
                    const preview = text.substring(0, 500);
                    if (text.length > 500) {
                        state.logActivity(`File preview: ${preview}...`, 'info');
                    }
                } catch (err) {
                    state.logActivity(`Failed to read file: ${err.message}`, 'danger');
                }
            }
        };
        
        inputEl.click();
        
        return {
            success: true,
            result: 'Opening file picker... Please select a text file to read.',
            interactive: true
        };
    },

    /**
     * Create a file
     */
    _createFile(input) {
        // Extract filename and content
        const filenameMatch = input.match(/named?\s+["']?([\w\-\.]+)/i);
        const filename = filenameMatch ? filenameMatch[1] : 'alice-document.txt';
        
        const content = input
            .replace(/create\s+(?:a\s+)?(?:new\s+)?(?:file|document)/i, '')
            .replace(/named?\s+["']?[\w\-\.]+/i, '')
            .replace(/with\s+(?:the\s+)?content\s+/i, '')
            .replace(/containing\s+/i, '')
            .trim();

        if (!content) {
            return {
                success: false,
                error: 'What content would you like me to save to the file?'
            };
        }

        // Create and download the file
        this._downloadFile(filename, content);
        
        return {
            success: true,
            result: `Created file "${filename}" with your content. The download should start automatically.`
        };
    },

    /**
     * Download a file
     */
    _downloadFile(filename, content) {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        state.logActivity(`Downloaded file: ${filename}`, 'success');
    },

    /**
     * List files (limited in browser context)
     */
    _listFiles() {
        return {
            success: true,
            result: 'I can help you read text files. Just say "read a file" and select a file from your computer. I can also create new text files for you to download.'
        };
    }
};
