/**
 * Reminders Skill
 * Handles reminders and task management
 */
import { state } from '../state.js';
import { memory } from '../memory.js';

export const reminders = {
    name: 'reminders',
    description: 'Manages reminders and tasks',
    patterns: [
        /remind\s+me/i,
        /set\s+(?:a\s+)?reminder/i,
        /remember\s+to/i,
        /don'?t\s+forget/i,
        /task/i,
        /to[- ]?do/i,
        /checklist/i,
        /show\s+(?:my\s+)?reminders/i,
        /what(?:\'s| is) on my (?:todo|reminder)/i,
        /upcoming\s+reminders/i,
        /delete\s+(?:my\s+)?reminder/i,
        /complete\s+(?:my\s+)?reminder/i,
        /done\s+(?:with\s+)?/i,
        /finished\s+(?:with\s+)?/i
    ],

    /**
     * Execute reminders command
     */
    execute(input, context = {}) {
        const text = input.toLowerCase();
        
        // Determine action
        if (text.match(/show|what'?s|upcoming/i) && (text.match(/reminder|todo|task/i) || text.match(/on\s+my/i))) {
            return this._showReminders();
        }
        
        if (text.match(/delete|remove/i) && text.match(/reminder/i)) {
            return this._deleteReminder(input);
        }
        
        if (text.match(/complete|done|finished/i)) {
            return this._completeReminder(input);
        }
        
        if (text.match(/remind|remember|don'?t forget/i)) {
            return this._addReminder(input);
        }
        
        if (text.match(/task|to[- ]?do|checklist/i)) {
            return this._handleTasks(input);
        }
        
        return {
            success: false,
            error: 'I\'m not sure what you want me to do with reminders'
        };
    },

    /**
     * Add a new reminder
     */
    _addReminder(input) {
        // Try to extract time
        let reminderText = input
            .replace(/remind\s+me\s+(?:to|that|about)/i, '')
            .replace(/remember\s+to\s+/i, '')
            .replace(/don'?t\s+forget\s+(?:to\s+)?/i, '')
            .replace(/set\s+(?:a\s+)?reminder\s+(?:to\s+)?/i, '')
            .trim();

        // Parse time from text
        const timeInfo = this._parseTime(reminderText);
        
        if (!timeInfo.text || !timeInfo.time) {
            return {
                success: false,
                error: 'When should I remind you? Try saying "remind me to [task] at [time]"'
            };
        }

        const reminder = memory.addReminder(timeInfo.text, timeInfo.time);
        
        const timeStr = new Date(timeInfo.time).toLocaleString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
        
        return {
            success: true,
            result: `I'll remind you to "${timeInfo.text}" at ${timeStr}`,
            reminder: reminder
        };
    },

    /**
     * Parse time from text
     */
    _parseTime(text) {
        const now = new Date();
        let targetTime = null;
        let remainingText = text;

        // Check for "at [time]"
        const atMatch = text.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (atMatch) {
            let hours = parseInt(atMatch[1]);
            const minutes = parseInt(atMatch[2] || '0');
            const period = atMatch[3]?.toLowerCase();

            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;

            targetTime = new Date(now);
            targetTime.setHours(hours, minutes, 0, 0);

            remainingText = text.replace(atMatch[0], '').trim();
        }

        // Check for relative times
        if (text.includes('in ')) {
            const inMatch = text.match(/in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
            if (inMatch) {
                const amount = parseInt(inMatch[1]);
                const unit = inMatch[2].toLowerCase();
                
                targetTime = new Date(now);
                if (unit.startsWith('min')) {
                    targetTime.setMinutes(targetTime.getMinutes() + amount);
                } else if (unit.startsWith('hour') || unit.startsWith('hr')) {
                    targetTime.setHours(targetTime.getHours() + amount);
                }
                
                remainingText = text.replace(inMatch[0], '').trim();
            }
        }

        // Check for "tomorrow"
        if (text.includes('tomorrow')) {
            targetTime = new Date(now);
            targetTime.setDate(targetTime.getDate() + 1);
            
            // Keep the hour if specified
            if (atMatch) {
                const hours = parseInt(atMatch[1]);
                const minutes = parseInt(atMatch[2] || '0');
                targetTime.setHours(hours, minutes, 0, 0);
            } else {
                targetTime.setHours(9, 0, 0, 0); // Default to 9 AM
            }
            
            remainingText = text.replace(/tomorrow/gi, '').replace(atMatch?.[0] || '', '').trim();
        }

        // Default: if only time specified, assume today
        if (!targetTime && atMatch) {
            targetTime = new Date(now);
            let hours = parseInt(atMatch[1]);
            const minutes = parseInt(atMatch[2] || '0');
            const period = atMatch[3]?.toLowerCase();

            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;

            targetTime.setHours(hours, minutes, 0, 0);
            
            // If time has passed, suggest tomorrow
            if (targetTime < now) {
                targetTime.setDate(targetTime.getDate() + 1);
            }
            
            remainingText = text.replace(atMatch[0], '').trim();
        }

        return {
            text: remainingText.replace(/to\s+/i, '').trim(),
            time: targetTime
        };
    },

    /**
     * Show all reminders
     */
    _showReminders() {
        const pending = memory.getReminders();
        const upcoming = memory.getUpcomingReminders();
        
        if (pending.length === 0 && upcoming.length === 0) {
            return {
                success: true,
                result: 'You don\'t have any upcoming reminders. Say "remind me to [task] at [time]" to create one.',
                reminders: []
            };
        }

        let response = 'Here are your reminders:\n';
        const allReminders = [...pending, ...upcoming].slice(0, 5);

        allReminders.forEach((reminder, i) => {
            const timeStr = new Date(reminder.time).toLocaleString('en-US', {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            response += `${i + 1}. "${reminder.text}" - ${timeStr}\n`;
        });

        return {
            success: true,
            result: response.trim(),
            reminders: allReminders
        };
    },

    /**
     * Complete a reminder
     */
    _completeReminder(input) {
        const number = input.match(/(?:complete|done|finished)\s+(?:reminder\s+)?#?(\d+)/i)?.[1];
        
        if (number) {
            const reminders = memory.getReminders();
            const index = parseInt(number) - 1;
            
            if (index >= 0 && index < reminders.length) {
                memory.completeReminder(reminders[index].id);
                return {
                    success: true,
                    result: `Marked "${reminders[index].text}" as complete!`
                };
            }
            
            return {
                success: false,
                error: `Couldn't find reminder number ${number}`
            };
        }

        // Mark most recent
        const pending = memory.getPendingReminders();
        if (pending.length > 0) {
            memory.completeReminder(pending[0].id);
            return {
                success: true,
                result: `Marked "${pending[0].text}" as complete!`
            };
        }

        return {
            success: false,
            error: 'No reminders to complete'
        };
    },

    /**
     * Delete a reminder
     */
    _deleteReminder(input) {
        const number = input.match(/delete\s+(?:my\s+)?reminder\s+#?(\d+)/i)?.[1];
        
        if (number) {
            const reminders = memory.getReminders();
            const index = parseInt(number) - 1;
            
            if (index >= 0 && index < reminders.length) {
                memory.deleteReminder(reminders[index].id);
                return {
                    success: true,
                    result: `Deleted reminder: "${reminders[index].text}"`
                };
            }
            
            return {
                success: false,
                error: `Couldn't find reminder number ${number}`
            };
        }

        return {
            success: false,
            error: 'Which reminder would you like to delete? Please specify the reminder number.'
        };
    },

    /**
     * Handle task-related commands
     */
    _handleTasks(input) {
        const text = input.toLowerCase();
        
        if (text.match(/show|what|list/i)) {
            return this._showReminders();
        }
        
        // Default to adding a task
        const taskText = input
            .replace(/task/i, '')
            .replace(/to[- ]?do/i, '')
            .replace(/add/i, '')
            .trim();
        
        if (taskText) {
            const reminder = memory.addReminder(taskText, Date.now() + 86400000); // Default to tomorrow
            return {
                success: true,
                result: `Added task: "${taskText}" for tomorrow`,
                reminder: reminder
            };
        }

        return {
            success: false,
            error: 'What task would you like to add?'
        };
    }
};
