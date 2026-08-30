/**
 * Notes Skill
 * Handles note-taking functionality
 */
import { state } from '../state.js';
import { memory } from '../memory.js';

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
     * Execute notes command
     */
    execute(input, context = {}) {
        const text = input.toLowerCase();
        
        // Determine action
        if (text.match(/show|what are|read|find|search/i) && text.match(/notes?/i)) {
            return this._showNotes(input);
        }
        
        if (text.match(/delete|remove/i) && text.match(/notes?/i)) {
            return this._deleteNote(input);
        }
        
        if (text.match(/take|write|remember|save|add|note/i)) {
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
    _deleteNote(input) {
        const noteNumber = input.match(/delete\s+(?:note\s+)?#?(\d+)/i)?.[1];
        
        if (noteNumber) {
            const notes = memory.getNotes();
            const index = parseInt(noteNumber) - 1;
            
            if (index >= 0 && index < notes.length) {
                const note = notes[index];
                memory.deleteNote(note.id);
                return {
                    success: true,
                    result: `Deleted note: "${note.title}"`
                };
            }
            
            return {
                success: false,
                error: `I couldn't find note number ${noteNumber}`
            };
        }

        // Try to find by keyword
        const keyword = input.replace(/delete\s+(?:my\s+)?note\s+(?:about\s+)?/i, '').trim();
        if (keyword) {
            const results = memory.searchNotes(keyword);
            if (results.length > 0) {
                memory.deleteNote(results[0].id);
                return {
                    success: true,
                    result: `Deleted note: "${results[0].title}"`
                };
            }
        }

        return {
            success: false,
            error: 'Which note would you like to delete? Please specify the note number or content.'
        };
    }
};
