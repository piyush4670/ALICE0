/**
 * ALICE Configuration
 * Central configuration for the ALICE interface
 * Part 2+ will connect real services via these interfaces
 */
export const CONFIG = {
    // Authentication (placeholder - replace with real auth in Part 4)
    auth: {
        // Default PIN for prototype (in production, this would be server-side)
        defaultPin: '1234',
        maxAttempts: 5,
        lockoutDuration: 30000
    },

    // Boot sequence configuration
    boot: {
        sequenceDuration: 3000, // Total boot animation duration
        itemDelay: 400, // Delay between each boot item
        progressSpeed: 100 // Update frequency for progress bar
    },

    // Application states
    states: {
        IDLE: 'IDLE',
        LISTENING: 'LISTENING',
        PROCESSING: 'PROCESSING',
        SPEAKING: 'SPEAKING',
        EXECUTING: 'EXECUTING'
    },

    // Visual configuration
    visuals: {
        primaryColor: '#00f0ff', // Cyan
        secondaryColor: '#ff00aa', // Magenta
        accentColor: '#00ff88', // Green
        warningColor: '#ffaa00', // Orange
        dangerColor: '#ff3366', // Red
        backgroundColor: '#0a0a0f',
        surfaceColor: 'rgba(20, 20, 30, 0.8)',
        textColor: '#e0e0e0'
    },

    // System info (placeholders for Part 2+)
    system: {
        version: '0.1.0',
        codename: 'ALPHA',
        buildDate: '2026-08-30'
    },

    // Interface placeholders for future features
    interfaces: {
        speechRecognition: null, // Part 2: Web Speech API
        textToSpeech: null, // Part 2: Web Speech API
        aiBrain: null, // Part 3: AI backend
        memory: null, // Part 4: Memory system
        tools: null // Part 5: Tool execution
    }
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.states);
Object.freeze(CONFIG.visuals);
Object.freeze(CONFIG.system);
