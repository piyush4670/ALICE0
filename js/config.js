/**
 * ALICE Configuration
 * Central configuration for the ALICE interface
 * Part 3: Memory, Tools & Skills integrated
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
        sequenceDuration: 4000, // Total boot animation duration
        itemDelay: 450, // Delay between each boot item
        progressSpeed: 100 // Update frequency for progress bar
    },

    // Application states (including skill execution states)
    states: {
        IDLE: 'IDLE',
        LISTENING: 'LISTENING',
        PROCESSING: 'PROCESSING',
        SPEAKING: 'SPEAKING',
        EXECUTING: 'EXECUTING',
        UNDERSTANDING: 'UNDERSTANDING',
        SELECTING_TOOL: 'SELECTING_TOOL',
        COMPLETING: 'COMPLETING'
    },

    // Voice configuration
    voice: {
        wakeWordEnabled: true,
        autoWakeAfterSpeaking: true,
        wakeWordCooldown: 3000, // ms between wake detections
        speechTimeout: 10000, // ms before stopping if no speech
        // TTS settings
        ttsRate: 0.95,
        ttsPitch: 1.0,
        ttsVolume: 1.0
    },

    // Skills configuration
    skills: {
        enabled: true,
        // Risk levels for permission system
        riskLevels: {
            low: ['datetime', 'calculator', 'notes', 'reminders', 'memory'],
            medium: ['websearch', 'files', 'reader'],
            high: [] // Would require confirmation
        }
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

    // System info
    system: {
        version: '0.3.0',
        codename: 'GAMMA',
        buildDate: '2026-08-30'
    },

    // Interface placeholders for future features
    interfaces: {
        speechRecognition: 'Web Speech API', // Part 2: Implemented
        textToSpeech: 'Web Speech API', // Part 2: Implemented
        aiBrain: null, // Part 3: Skills system
        memory: 'localStorage', // Part 3: Implemented
        tools: 'Skill System' // Part 3: Implemented
    }
};

// Freeze config to prevent accidental modifications
Object.freeze(CONFIG);
Object.freeze(CONFIG.states);
Object.freeze(CONFIG.visuals);
Object.freeze(CONFIG.system);
Object.freeze(CONFIG.voice);
Object.freeze(CONFIG.skills);
