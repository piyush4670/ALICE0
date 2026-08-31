/**
 * ALICE Configuration
 * Central configuration for the ALICE interface
 * Part 5: Advanced Capabilities & Final Integration
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

    // Proactive assistance (Part 5)
    proactive: {
        enabled: true,
        checkInterval: 30000, // ms between proactive suggestion checks
        // 'off' | 'low' | 'moderate' | 'high'
        level: 'moderate',
        maxSuggestionsPerSession: 20
    },

    // Settings (Part 5)
    settings: {
        storageKey: 'alice_settings',
        defaults: {
            proactive: { enabled: true, level: 'moderate' },
            features: { vision: true, browser: true, iot: true, dev: true },
            skills: {} // populated at runtime (all enabled by default)
        }
    },

    // IoT / External integrations (Part 5)
    integrations: {
        // Mock providers are bundled so the layer is demonstrable and testable
        // without any real hardware. Real adapters register the same interface.
        providers: ['mock'],
        defaultProvider: 'mock'
    },

    // Security (Part 5)
    security: {
        // Sensitive tokens redacted from all logs
        redactPatterns: [
            /\b(sk|pk|rk)-[A-Za-z0-9]{8,}\b/g,   // common API key formats
            /\b[0-9a-f]{32,}\b/g,                 // long hex tokens
            /Bearer\s+[A-Za-z0-9._-]+/gi,
            /api[_-]?key[=:\s]+[A-Za-z0-9._-]+/gi,
            /password[=:\s]+[^\s,;]+/gi,
            /token[=:\s]+[A-Za-z0-9._-]+/gi,
            /secret[=:\s]+[A-Za-z0-9._-]+/gi
        ]
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
        version: '0.5.0',
        codename: 'EPSILON',
        buildDate: '2026-08-30'
    },

    // AI Brain Architecture (Phase 6.2)
    ai: {
        enabled: true,
        provider: 'mock',          // 'mock' | provider identifier
        adapter: 'mock',           // 'mock' | adapter identifier
        timeout: 5000,             // ms before timing out model generation
        maxOutputSize: 10000,      // maximum characters in model output
        maxSteps: 8,               // maximum planning steps allowed
        fallbackEnabled: true,     // fall back to deterministic planner on model failure
        temperature: 0.2           // sampling temperature
    },

    // Interface placeholders for future features
    interfaces: {
        speechRecognition: 'Web Speech API', // Part 2: Implemented
        textToSpeech: 'Web Speech API', // Part 2: Implemented
        aiBrain: 'Model-Agnostic AI Brain', // Phase 6.2: Implemented
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
Object.freeze(CONFIG.proactive);
Object.freeze(CONFIG.settings);
Object.freeze(CONFIG.integrations);
Object.freeze(CONFIG.security);
Object.freeze(CONFIG.ai);
