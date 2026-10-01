/**
 * Notes Skill
 * Handles note-taking functionality
 */
import { state } from '../state.js';
import { memory } from '../memory.js';
import { permissions } from '../permissions.js';
import { CONFIG } from '../config.js';

export const notes = {
    name: 'notes',
    description: 'Manages notes and saved information',
    patterns: [
        /take\s+a\s+note/i,
        /write\s+this\s+down/i,
        /remember\s+this\s+note/i,
        /save\s+(?:this\s+)?note/i,
        /note\s+that/i,
        /add\s+note/i,
        /new\s+note/i,
        /show\s+(?:my\s+)?notes/i,
        /what\s+(?:are\s+)?my\s+notes/i,
        /read\s+(?:my\s+)?notes/i,
        /find\s+(?:my\s+)?notes/i,
        /search\s+(?:my\s+)?notes/i,
        /delete\s+(?:my\s+)?note/i,
        /remove\s+(?:my\s+)?note/i
    ],

    /**
     * Resolve deletion target from user input.
     * Distinguishes between note number deletion, single keyword matches,
     * multiple matches (ambiguous), zero matches, and empty input.
     */
    _parseDeletionTarget(input) {
        if (typeof input !== 'string') {
            return { type: 'invalid' };
        }

        // Check for note number first, e.g. "delete note 1", "delete note #1", "delete #1", "remove note 2"
        // Avoid treating "delete note about 123" as note number 123
        const isAboutNumber = /(?:about|called|titled|named)\s+\d+/i.test(input);
        const numMatch = !isAboutNumber && input.match(/(?:delete|remove)\s+(?:my\s+)?(?:note\s+)?(?:number\s+)?#?(\d+)(?:\s*$|\b)/i);

        if (numMatch) {
            const noteNumber = numMatch[1];
            const allNotes = memory.getNotes();
            const index = parseInt(noteNumber, 10) - 1;
            if (index >= 0 && index < allNotes.length) {
                return {
                    type: 'number',
                    noteNumber,
                    note: allNotes[index],
                    index
                };
            }
            return {
                type: 'number_not_found',
                noteNumber
            };
        }

        // Extract keyword
        let keyword = input
            .replace(/^(?:delete|remove)\s+(?:my\s+)?notes?(?:\s+(?:about|called|titled|named))?(?:\s+|$)/i, '')
            .trim();

        keyword = keyword.replace(/[.?!]+$/, '').trim();

        if (!keyword) {
            return { type: 'empty' };
        }

        const results = memory.searchNotes(keyword);
        if (results.length === 0) {
            return {
                type: 'keyword_zero',
                keyword
            };
        }

        if (results.length > 1) {
            return {
                type: 'keyword_multiple',
                keyword,
                matches: results
            };
        }

        return {
            type: 'keyword_single',
            keyword,
            note: results[0]
        };
    },

    /**
     * Bind approval to the exact note ID and operation.
     */
    getApprovalKey(input, context = {}) {
        const text = String(input ?? '').toLowerCase();
        const isDelete = (text.match(/\b(?:delete|remove)\b/i) && text.match(/\bnotes?\b/i)) ||
                         (context && context.action === 'delete');
        if (!isDelete) return null;

        const target = this._parseDeletionTarget(input);
        if (target.type === 'number' || target.type === 'keyword_single') {
            return `delete::${target.note.id}`;
        }
        return null;
    },

    /**
     * Execute notes command
     */
    async execute(input, context = {}) {
        // Agent path: save prepared content directly (used by "save to notes" step)
        if (context && context.action === 'create' && context.content !== undefined) {
            const content = String(context.content);
            const title = content.split(' ').slice(0, 5).join(' ') + (content.length > 30 ? '...' : '');
            const note = memory.addNote(title, content);
            return {
                success: true,
                result: `I've saved a note: "${title}"`,
                note
            };
        }

        const text = input.toLowerCase();
        
        // Determine action
        if (text.match(/\b(?:show|what\s+are|read|find|search)\b/i) && text.match(/\bnotes?\b/i)) {
            return this._showNotes(input);
        }
        
        if ((text.match(/\b(?:delete|remove)\b/i) && text.match(/\bnotes?\b/i)) || (context && context.action === 'delete')) {
            return this._deleteNote(input, context);
        }
        
        if (text.match(/\b(?:take|write|remember|save|add|note)\b/i)) {
            return this._addNote(input);
        }
        
        return {
            success: false,
            error: 'I\'m not sure what you want me to do with notes'
        };
    },

    /**
     * Add a new note
     */
    _addNote(input) {
        // Extract note content
        let content = input
            .replace(/take\s+a\s+note\s+(?:that|saying|says?|which|like|:)?/i, '')
            .replace(/write\s+this\s+down/i, '')
            .replace(/remember\s+this\s+note/i, '')
            .replace(/save\s+(?:this\s+)?note\s+(?:that|saying|:)?/i, '')
            .replace(/note\s+that\s+/i, '')
            .replace(/add\s+(?:a\s+)?note\s+(?:saying|:)?/i, '')
            .replace(/new\s+note\s+/i, '')
            .trim();

        if (!content) {
            return {
                success: false,
                error: 'What would you like me to note down?'
            };
        }

        // Generate title from first few words
        const title = content.split(' ').slice(0, 5).join(' ') + (content.length > 30 ? '...' : '');

        const note = memory.addNote(title, content);
        
        return {
            success: true,
            result: `I've saved your note: "${title}"`,
            note: note
        };
    },

    /**
     * Show all notes
     */
    _showNotes(input) {
        const allNotes = memory.getNotes();
        
        if (allNotes.length === 0) {
            return {
                success: true,
                result: 'You don\'t have any saved notes yet. Just say "take a note" followed by what you want to remember.',
                notes: []
            };
        }

        // Check if searching
        const searchTerm = input.match(/search\s+(?:my\s+)?notes\s+(?:for\s+)?(.+)/i)?.[1];
        
        let notesToShow = allNotes;
        if (searchTerm) {
            notesToShow = memory.searchNotes(searchTerm);
            if (notesToShow.length === 0) {
                return {
                    success: true,
                    result: `No notes found matching "${searchTerm}".`,
                    notes: []
                };
            }
        }

        // Format notes for display
        const formattedNotes = notesToShow.slice(0, 5).map((note, i) => 
            `${i + 1}. ${note.title}\n   "${note.content.substring(0, 100)}${note.content.length > 100 ? '...' : ''}"`
        ).join('\n');

        const countText = notesToShow.length === 1 ? 'note' : `${notesToShow.length} notes`;
        
        return {
            success: true,
            result: `You have ${countText}:\n${formattedNotes}`,
            notes: notesToShow
        };
    },

    /**
     * Delete a note
     */
    async _deleteNote(input, context = {}) {
        const target = this._parseDeletionTarget(input);

        if (target.type === 'number_not_found') {
            return {
                success: false,
                error: `I couldn't find note number ${target.noteNumber}`
            };
        }

        if (target.type === 'empty') {
            return {
                success: false,
                error: 'Which note would you like to delete? Please specify the note number or content.'
            };
        }

        if (target.type === 'keyword_zero') {
            return {
                success: false,
                error: `No note found matching "${target.keyword}".`
            };
        }

        if (target.type === 'keyword_multiple') {
            const allNotes = memory.getNotes();
            const formatted = target.matches.map(n => {
                const num = allNotes.findIndex(item => item.id === n.id) + 1;
                const prefix = num > 0 ? `#${num}: ` : '';
                const snippet = n.content ? ` - "${n.content.substring(0, 60)}${n.content.length > 60 ? '...' : ''}"` : '';
                return `- ${prefix}"${n.title}"${snippet}`;
            }).join('\n');

            const clarifyMsg = `Multiple notes match "${target.keyword}". Please specify which note to delete by number or more specific title:\n${formatted}`;
            return {
                success: false,
                error: clarifyMsg,
                clarification: clarifyMsg,
                matches: target.matches
            };
        }

        // Unambiguous target (number or keyword_single)
        const noteToDelete = target.note;

        // Re-check that the target still exists and is the intended note before deleting it
        const current = memory.getNote(noteToDelete.id);
        if (!current || current.id !== noteToDelete.id || current.title !== noteToDelete.title) {
            return {
                success: false,
                error: `I couldn't find note "${noteToDelete.title}" to delete.`
            };
        }

        const approvalKey = `notes::delete::${noteToDelete.id}`;

        // Ensure approval through the existing permission mechanism where required
        if (CONFIG?.permissions?.enabled) {
            const isApproved = permissions.isApproved(approvalKey);
            if (!isApproved) {
                const approved = await permissions.requestConfirmation({
                    title: 'Confirmation required',
                    message: 'destructive action (cannot be easily undone)',
                    action: input.slice(0, 300)
                });
                if (!approved) {
                    return {
                        success: false,
                        cancelled: true,
                        error: 'Cancelled — the action was not approved. Nothing was changed.'
                    };
                }
            }
        }

        // Perform safe deletion
        const deleted = memory.deleteNote(noteToDelete.id);
        if (!deleted) {
            return {
                success: false,
                error: `Failed to delete note "${noteToDelete.title}".`
            };
        }

        // Consume approval so a stale approval cannot delete another note
        permissions.consumeApproval(approvalKey);
        permissions.consumeApproval(`notes::${String(input ?? '').trim().toLowerCase()}`);

        return {
            success: true,
            result: `Deleted note: "${noteToDelete.title}"`
        };
    }
};
