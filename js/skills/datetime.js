/**
 * Date/Time Skill
 * Handles date and time queries
 */
import { state } from '../state.js';

export const datetime = {
    name: 'datetime',
    description: 'Provides current date and time information',
    patterns: [
        /what\s+time\s+is\s+it/i,
        /what'?s\s+the\s+time/i,
        /tell\s+me\s+the\s+time/i,
        /current\s+time/i,
        /what\s+day\s+is\s+it/i,
        /what\s+date\s+is\s+it/i,
        /what'?s\s+today'?s?\s+date/i,
        /current\s+date/i,
        /day\s+of\s+the\s+week/i,
        /what\s+month/i,
        /year/i
    ],

    /**
     * Execute date/time command
     */
    execute(input, context = {}) {
        const text = input.toLowerCase();
        const now = new Date();
        
        // Time queries
        if (text.match(/time/i) && !text.match(/time\s+(?:zone|difference|duration)/i)) {
            return this._getTime(text, now);
        }
        
        // Date queries
        if (text.match(/date|day|month|year/i)) {
            return this._getDate(text, now);
        }
        
        // Default: return both
        return {
            success: true,
            result: this._formatFullDateTime(now)
        };
    },

    /**
     * Get current time
     */
    _getTime(text, now) {
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        
        let timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')}`;
        
        if (text.includes('seconds')) {
            timeStr += `:${seconds.toString().padStart(2, '0')}`;
        }
        
        timeStr += ` ${ampm}`;
        
        return {
            success: true,
            result: `The current time is ${timeStr}`,
            time: now.getTime()
        };
    },

    /**
     * Get current date
     */
    _getDate(text, now) {
        const options = { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        };
        
        const dateStr = now.toLocaleDateString('en-US', options);
        
        if (text.includes('day') && !text.includes('month') && !text.includes('year')) {
            const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
            return {
                success: true,
                result: `Today is ${dayName}, ${dateStr}`
            };
        }
        
        if (text.includes('month') && !text.includes('year')) {
            const monthName = now.toLocaleDateString('en-US', { month: 'long' });
            const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
            return {
                success: true,
                result: `We're in ${monthName}. It has ${daysInMonth} days.`
            };
        }
        
        if (text.includes('year')) {
            return {
                success: true,
                result: `The year is ${now.getFullYear()}`
            };
        }
        
        return {
            success: true,
            result: `Today's date is ${dateStr}`
        };
    },

    /**
     * Format full date and time
     */
    _formatFullDateTime(now) {
        const timeResult = this._getTime('', now);
        const dateResult = this._getDate('', now);
        
        return `${dateResult.result}. ${timeResult.result.replace('The current time is ', '')}`;
    }
};
