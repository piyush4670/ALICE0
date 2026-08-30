/**
 * ALICE Configuration
 * Central configuration for the ALICE interface
 * Part 4: Agentic Intelligence (Task Planner + Execution Loop)
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

    // Application states (including skill execution + agent states)
    states: {
        IDLE: 'IDLE',
        LISTENING: 'LISTENING',
        PROCESSING: 'PROCESSING',
        SPEAKING: 'SPEAKING',
        EXECUTING: 'EXECUTING',
        UNDERSTANDING: 'UNDERSTANDING',
        SELECTING_TOOL: 'SELECTING_TOOL',
        COMPLETING: 'COMPLETING',
        PLANNING: 'PLANNING',
        WAITING: 'WAITING'
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

    // Agent / Task Planner configuration (Part 4)
    agent: {
        enabled: true,
        // Maximum number of retries for a failed tool before giving up
        maxRetries: 1,
        // Visual pacing between steps (ms) so the HUD stays legible
        stepDelay: 550,
        // Pause before a retry attempt (ms)
        retryDelay: 800,
        // Maximum number of steps allowed in a single generated plan
        maxSteps: 8,
        // High-level task progress is spoken; internal reasoning is never exposed
        speakProgress: true
    },

    // Permission system (Part 4)
    permissions: {
        enabled: true,
        // Actions that must pause for explicit user confirmation
        requireConfirmation: true
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
        version: '0.4.0',
        codename: 'DELTA',
        buildDate: '2026-08-30'
    },

    // Interface placeholders for future features
    interfaces: {
        speechRecognition: 'Web Speech API', // Part 2: Implemented
        textToSpeech: 'Web Speech API', // Part 2: Implemented
        aiBrain: null, // Part 4: Task Planner (deterministic, no hidden reasoning)
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
Object.freeze(CONFIG.agent);
Object.freeze(CONFIG.permissions);
