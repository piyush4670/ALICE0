/**
 * ALICE Plan Schema (Phase 6.2)
 * ------------------------------------------------------------------
 * Strict schema definitions and validation constants for AI-generated plans.
 * A plan is purely declarative data representing goals and ordered steps.
 *
 * Executable code, script tags, eval expressions, prototype pollution,
 * and direct shell/system access attempts are strictly forbidden.
 */

export const PLAN_SCHEMA = {
    type: 'object',
    required: ['goal', 'steps'],
    properties: {
        goal: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description: 'The overall user goal or objective'
        },
        steps: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
                type: 'object',
                required: ['id', 'skill'],
                properties: {
                    id: {
                        type: 'string',
                        pattern: '^[a-zA-Z0-9_-]{1,64}$',
                        description: 'Unique identifier for the step'
                    },
                    skill: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 64,
                        description: 'Name of the registered skill or "core"'
                    },
                    input: {
                        type: ['string', 'object'],
                        description: 'Input parameter for the skill (declarative data only)'
                    },
                    dependsOn: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'List of step IDs that must complete before this step'
                    },
                    label: {
                        type: 'string',
                        maxLength: 200,
                        description: 'Human-readable description for UI / HUD'
                    },
                    action: {
                        type: 'string',
                        maxLength: 100,
                        description: 'Skill-specific action identifier'
                    },
                    operation: {
                        type: 'string',
                        maxLength: 100,
                        description: 'Operation identifier (for core tools)'
                    },
                    contextKey: {
                        type: 'string',
                        maxLength: 64,
                        description: 'Blackboard key to store this step output'
                    },
                    inputSource: {
                        type: 'string',
                        maxLength: 64,
                        description: 'Blackboard key to retrieve input from'
                    },
                    risk: {
                        type: 'string',
                        enum: ['safe', 'medium', 'sensitive'],
                        description: 'Declared risk level'
                    },
                    retries: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 3,
                        description: 'Number of retry attempts on transient failure'
                    },
                    alternatives: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Alternative skill names to try if primary fails'
                    },
                    filename: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Output filename for document/file operations'
                    }
                }
            }
        }
    }
};

/**
 * Patterns matching dangerous or executable constructs that must never
 * appear in an AI-generated plan.
 */
export const DANGEROUS_PATTERNS = [
    /<script\b[^>]*>/i,
    /<\/script>/i,
    /\bjavascript\s*:/i,
    /\bdata\s*:\s*text\/html/i,
    /\beval\s*\(/i,
    /\bFunction\s*\(/i,
    /\bsetTimeout\s*\(/i,
    /\bsetInterval\s*\(/i,
    /\bsetImmediate\s*\(/i,
    /\bprocess\s*\.\s*(?:env|exit|mainModule|binding)/i,
    /\bchild_process\b/i,
    /\brequire\s*\(/i,
    /\bimport\s*\(/i,
    /\b__proto__\b/i,
    /\bconstructor\s*\.\s*prototype\b/i,
    /\bObject\s*\.\s*(?:defineProperty|setPrototypeOf|freeze|assign)\b/i,
    /\bdocument\s*\.\s*(?:cookie|write|writeln|location)\b/i,
    /\blocalStorage\s*\.\s*(?:clear|setItem|removeItem)\b/i,
    /\bsessionStorage\s*\.\s*(?:clear|setItem|removeItem)\b/i,
    /\bwindow\s*\.\s*(?:location|eval|execScript|open)\b/i,
    /\b(?:fetch|XMLHttpRequest|axios)\s*\(/i,
    /\b(?:fs|path|os|net|http|https)\s*\.\b/i,
    /\b(?:sh|bash|cmd|powershell)\b/i,
    /\b(?:exec|spawn|fork)\s*\(/i
];

/**
 * Scan a value (string, object, array) recursively to detect any dangerous
 * code injection patterns, prototype tampering, or function instances.
 * Returns { found: boolean, pattern: string|null, path: string|null }.
 */
export function containsExecutableCode(value, currentPath = '') {
    if (value === null || value === undefined) {
        return { found: false, pattern: null, path: null };
    }

    // Function instances inside data are prohibited
    if (typeof value === 'function') {
        return {
            found: true,
            pattern: 'function_instance',
            path: currentPath || 'root'
        };
    }

    if (typeof value === 'string') {
        for (const pattern of DANGEROUS_PATTERNS) {
            if (pattern.test(value)) {
                return {
                    found: true,
                    pattern: pattern.toString(),
                    path: currentPath || 'string'
                };
            }
        }
        return { found: false, pattern: null, path: null };
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const check = containsExecutableCode(value[i], `${currentPath}[${i}]`);
            if (check.found) return check;
        }
        return { found: false, pattern: null, path: null };
    }

    if (typeof value === 'object') {
        // Disallow objects with altered prototypes (prototype tampering)
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
            return {
                found: true,
                pattern: 'tampered_prototype',
                path: currentPath || 'object'
            };
        }

        const forbiddenKeys = ['__proto__', 'constructor', 'prototype'];
        for (const key of Object.getOwnPropertyNames(value)) {
            if (forbiddenKeys.includes(key)) {
                return {
                    found: true,
                    pattern: `forbidden_key_${key}`,
                    path: `${currentPath}.${key}`
                };
            }
            const check = containsExecutableCode(value[key], currentPath ? `${currentPath}.${key}` : key);
            if (check.found) return check;
        }
        return { found: false, pattern: null, path: null };
    }

    return { found: false, pattern: null, path: null };
}

/**
 * Validates the basic object schema of a plan.
 * Returns { valid: boolean, errors: string[] }.
 */
export function validateBasicSchema(plan) {
    const errors = [];

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return { valid: false, errors: ['Plan must be a non-null object'] };
    }

    if (typeof plan.goal !== 'string' || plan.goal.trim().length === 0) {
        errors.push('Plan must contain a non-empty string "goal"');
    } else if (plan.goal.length > PLAN_SCHEMA.properties.goal.maxLength) {
        errors.push(`Goal exceeds maximum length of ${PLAN_SCHEMA.properties.goal.maxLength} characters`);
    }

    if (!Array.isArray(plan.steps)) {
        errors.push('Plan must contain an array of "steps"');
    } else if (plan.steps.length === 0) {
        errors.push('Plan "steps" array must not be empty');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}
