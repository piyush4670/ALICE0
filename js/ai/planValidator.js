/**
 * ALICE Plan Validator (Phase 6.2)
 * ------------------------------------------------------------------
 * Validates AI-generated plans strictly BEFORE execution.
 *
 * Enforces:
 *   - Schema conformity (goal, steps array, step properties)
 *   - Step ID format and uniqueness (no duplicate IDs)
 *   - Dependency validity (all dependsOn refer to declared steps, no self-refs)
 *   - Dependency cycles (graph must be a Directed Acyclic Graph / DAG)
 *   - Step limits (strictly enforces CONFIG.agent.maxSteps)
 *   - Skill validity (skill must be registered or 'core')
 *   - Enabled status (disabled skills are rejected)
 *   - Safety (executable code injection, script tags, eval, prototype tampering)
 *   - Operation validity (core operations like 'summarize')
 */
import { CONFIG } from '../config.js';
import { skillManager } from '../skillManager.js';
import { validateBasicSchema, containsExecutableCode, PLAN_SCHEMA } from './planSchema.js';

class PlanValidator {
    /**
     * Get maximum allowed steps for a plan.
     */
    _getMaxSteps() {
        const aiLimit = CONFIG.ai && CONFIG.ai.maxSteps;
        const agentLimit = CONFIG.agent && CONFIG.agent.maxSteps;
        const limit = Number.isFinite(aiLimit) ? aiLimit : (Number.isFinite(agentLimit) ? agentLimit : 8);
        return Math.max(1, Math.floor(limit));
    }

    /**
     * Validate an AI-generated plan.
     * @param {Object} plan - The plan to validate
     * @param {Object} [options]
     * @returns {{ valid: boolean, errors: string[], normalizedPlan?: Object[] }}
     */
    validate(plan, options = {}) {
        const errors = [];

        // 1. Basic Schema Validation
        const basicCheck = validateBasicSchema(plan);
        if (!basicCheck.valid) {
            return { valid: false, errors: basicCheck.errors };
        }

        // 2. Maximum Step Limit Enforcement
        const maxSteps = this._getMaxSteps();
        if (plan.steps.length > maxSteps) {
            errors.push(`Step count (${plan.steps.length}) exceeds maximum limit of ${maxSteps}`);
        }

        // 3. Executable Code & Dangerous Pattern Injection Check across entire plan
        const codeCheck = containsExecutableCode(plan);
        if (codeCheck.found) {
            errors.push(`Executable code or unsafe injection detected in plan at "${codeCheck.path}" (pattern: ${codeCheck.pattern})`);
        }

        // 4. Per-Step Validations
        const seenIds = new Set();
        const stepIdList = [];

        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const stepPrefix = `Step ${i + 1}`;

            if (!step || typeof step !== 'object' || Array.isArray(step)) {
                errors.push(`${stepPrefix} is not a valid object`);
                continue;
            }

            // Step ID validation
            if (typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id)) {
                errors.push(`${stepPrefix} has invalid or missing ID (must be 1-64 alphanumeric/dash/underscore chars)`);
            } else {
                if (seenIds.has(step.id)) {
                    errors.push(`Duplicate step ID: "${step.id}" in ${stepPrefix}`);
                } else {
                    seenIds.add(step.id);
                    stepIdList.push(step.id);
                }
            }

            // Skill validation
            if (typeof step.skill !== 'string' || step.skill.trim().length === 0) {
                errors.push(`${stepPrefix} is missing a skill name`);
            } else {
                const skillName = step.skill.trim();
                const isCore = skillName.toLowerCase() === 'core';
                let matchedSkill = skillManager.getSkill(skillName);
                if (!matchedSkill) {
                    for (const s of skillManager.getSkills()) {
                        if (s.name.toLowerCase() === skillName.toLowerCase()) {
                            matchedSkill = s;
                            break;
                        }
                    }
                }

                if (!isCore && !matchedSkill) {
                    errors.push(`Unknown skill: "${step.skill}" in ${stepPrefix}`);
                } else if (!isCore && matchedSkill) {
                    // Check if skill is enabled
                    if (!skillManager.isEnabled(matchedSkill.name)) {
                        errors.push(`Skill "${step.skill}" in ${stepPrefix} is currently disabled`);
                    }
                }

                // If core skill, validate operation
                if (isCore) {
                    const validCoreOps = ['summarize'];
                    const op = step.operation || step.action;
                    if (!op || !validCoreOps.includes(op)) {
                        errors.push(`Unsupported core operation: "${op || 'unspecified'}" in ${stepPrefix}`);
                    }
                }
            }

            // Input validation
            if (step.input !== undefined && step.input !== null) {
                if (typeof step.input !== 'string' && typeof step.input !== 'object') {
                    errors.push(`${stepPrefix} has invalid input type (must be string or object)`);
                } else if (typeof step.input === 'string' && step.input.length > 50000) {
                    errors.push(`${stepPrefix} input exceeds maximum size limit (50,000 characters)`);
                }
            }

            // Dependencies format validation
            if (step.dependsOn !== undefined && step.dependsOn !== null) {
                if (!Array.isArray(step.dependsOn)) {
                    errors.push(`${stepPrefix} "dependsOn" must be an array of step IDs`);
                } else {
                    for (const depId of step.dependsOn) {
                        if (typeof depId !== 'string') {
                            errors.push(`${stepPrefix} dependency "${depId}" is not a string`);
                        } else if (depId === step.id) {
                            errors.push(`${stepPrefix} ("${step.id}") cannot depend on itself`);
                        }
                    }
                }
            }
        }

        // 5. Cross-Step Dependency References & Cycle Detection
        if (errors.length === 0) {
            // Check that all dependsOn refer to declared IDs
            for (const step of plan.steps) {
                const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
                for (const depId of deps) {
                    if (!seenIds.has(depId)) {
                        errors.push(`Step "${step.id}" depends on unknown step "${depId}"`);
                    }
                }
            }

            // Cycle detection (Topological Sort / Kahn's algorithm)
            if (errors.length === 0) {
                const cycleError = this._detectCycles(plan.steps);
                if (cycleError) {
                    errors.push(cycleError);
                }
            }
        }

        if (errors.length > 0) {
            return {
                valid: false,
                errors
            };
        }

        // 6. Normalization: produce sanitized plan compatible with Agent
        const normalizedPlan = this._normalizePlan(plan);

        return {
            valid: true,
            errors: [],
            normalizedPlan
        };
    }

    /**
     * Detect dependency cycles in step graph using Kahn's algorithm.
     * @param {Array<Object>} steps
     * @returns {string|null} Cycle error message or null if acyclic
     */
    _detectCycles(steps) {
        const inDegree = new Map();
        const adjList = new Map();

        // Initialize graph
        for (const s of steps) {
            inDegree.set(s.id, 0);
            adjList.set(s.id, []);
        }

        for (const s of steps) {
            const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
            // In graph: dep -> s (dep must happen before s)
            inDegree.set(s.id, deps.length);
            for (const depId of deps) {
                if (adjList.has(depId)) {
                    adjList.get(depId).push(s.id);
                }
            }
        }

        // Find all nodes with inDegree 0
        const queue = [];
        for (const [id, deg] of inDegree.entries()) {
            if (deg === 0) {
                queue.push(id);
            }
        }

        let visitedCount = 0;
        while (queue.length > 0) {
            const current = queue.shift();
            visitedCount++;

            for (const neighbor of adjList.get(current) || []) {
                const newDeg = inDegree.get(neighbor) - 1;
                inDegree.set(neighbor, newDeg);
                if (newDeg === 0) {
                    queue.push(neighbor);
                }
            }
        }

        if (visitedCount < steps.length) {
            const unvisited = [];
            for (const [id, deg] of inDegree.entries()) {
                if (deg > 0) unvisited.push(id);
            }
            return `Circular dependency detected involving steps: ${unvisited.join(', ')}`;
        }

        return null;
    }

    /**
     * Normalize plan into sanitized Agent-ready step structures.
     */
    _normalizePlan(plan) {
        return plan.steps.map((step, i) => {
            const rawSkillName = step.skill.trim();
            const isCore = rawSkillName.toLowerCase() === 'core';
            let matchedSkill = skillManager.getSkill(rawSkillName);
            if (!matchedSkill && !isCore) {
                for (const s of skillManager.getSkills()) {
                    if (s.name.toLowerCase() === rawSkillName.toLowerCase()) {
                        matchedSkill = s;
                        break;
                    }
                }
            }
            const skillName = isCore ? 'core' : (matchedSkill ? matchedSkill.name : rawSkillName);
            const defaultRisk = skillName === 'core' ? 'safe' : (matchedSkill?.risk || 'safe');
            const declaredRisk = (step.risk && ['safe', 'medium', 'sensitive'].includes(step.risk))
                ? step.risk
                : defaultRisk;

            // Resolve input source from dependsOn if not explicitly set
            let inputSource = step.inputSource || null;
            if (!inputSource && Array.isArray(step.dependsOn) && step.dependsOn.length > 0) {
                const depStep = plan.steps.find(s => s.id === step.dependsOn[0]);
                inputSource = depStep?.contextKey || depStep?.id || step.dependsOn[0];
            }

            const label = step.label || (typeof step.input === 'string' && step.input.trim()
                ? `${skillName}: ${step.input.slice(0, 40)}`
                : `${skillName} step ${i + 1}`);

            return {
                id: step.id,
                label: String(label).slice(0, 200),
                skill: skillName,
                operation: step.operation || (skillName === 'core' ? (step.action || 'summarize') : null),
                action: step.action || (skillName === 'files' ? 'create' : (skillName === 'websearch' ? 'search' : null)),
                input: step.input !== undefined && step.input !== null ? step.input : '',
                inputSource,
                contextKey: step.contextKey || step.id,
                risk: declaredRisk,
                retries: Number.isFinite(step.retries) ? Math.max(0, Math.min(step.retries, 3)) : 1,
                alternatives: Array.isArray(step.alternatives)
                    ? step.alternatives.filter(a => typeof a === 'string' && skillManager.hasSkill(a))
                    : [],
                filename: typeof step.filename === 'string' ? step.filename : null,
                dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : []
            };
        });
    }
}

// Singleton instance
export const planValidator = new PlanValidator();
