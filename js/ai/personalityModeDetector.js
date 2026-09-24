/**
 * ALICE Part 7E — Deterministic Personality Mode Detection v1.
 *
 * Detects ONLY an explicitly requested communication mode. It never infers a
 * mode from emotion, intent, response depth, topic, history, punctuation,
 * capitalization, difficulty or sentiment.
 *
 * Pure, deterministic, zero imports, no network, no I/O, no state, no
 * LLM/embeddings/ML, no scoring. Never throws.
 *
 * Matching: whole-phrase matching on word boundaries after normalization
 * (lowercase, trim, curly apostrophes → ', non-word characters → space,
 * whitespace collapsed). "playfully" does NOT match "playful"; "teacher" does
 * not match arbitrary words containing "teach".
 *
 * PRECEDENCE (when several explicit cues appear):
 *   guardian → focus → teacher → analyst → soft → playful → no mode
 */

const MODE_CUES = [
    ['guardian', ['guardian mode', 'keep me safe', 'help me stay safe', 'be protective',
        'protective mode', 'what should i be careful about', 'is this safe']],
    ['focus', ['help me focus', 'focus mode', 'keep me focused', 'stay focused',
        'be focused', "don't distract me", 'dont distract me', 'no distractions']],
    ['teacher', ['teach me', 'teacher mode', 'teach me this', 'teach me from the basics',
        'explain like a teacher', 'be my teacher', 'teaching mode', 'help me learn']],
    ['analyst', ['analyze this', 'analysis mode', 'be analytical', 'analyze it',
        'give me an analysis', 'break this down logically', 'think analytically']],
    ['soft', ['be gentle', 'gentle mode', 'be kind', 'be comforting', 'comfort me',
        'talk gently', 'be soft', 'soft mode']],
    ['playful', ['be playful', 'playful mode', 'make it fun', 'have some fun', 'be funny',
        'make me laugh', 'joke around', 'lighten the mood']]
];

function normalize(request) {
    return request
        .toLowerCase()
        .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function detectPersonalityMode(request) {
    try {
        if (typeof request !== 'string') return Object.freeze({ mode: null, confidence: 'low' });
        const text = normalize(request);
        if (!text) return Object.freeze({ mode: null, confidence: 'low' });
        const padded = ` ${text} `;
        for (const [mode, phrases] of MODE_CUES) {
            for (const phrase of phrases) {
                if (padded.includes(` ${phrase} `)) return Object.freeze({ mode, confidence: 'high' });
            }
        }
    } catch { /* never throw */ }
    return Object.freeze({ mode: null, confidence: 'low' });
}
