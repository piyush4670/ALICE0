/**
 * ALICE Agent — Tool Execution Loop (Part 4)
 * ------------------------------------------------------------------
 * Implements a controlled loop:
 *
 *     PLAN → EXECUTE → OBSERVE RESULT → DECIDE NEXT STEP → COMPLETE
 *
 * The agent:
 *   - builds a high-level plan (via taskPlanner)
 *   - executes each step through the existing skill manager
 *   - observes results, retries on transient failure, falls back to an
 *     alternative tool when available, and reports clearly when it cannot
 *     continue
 *   - pauses for user confirmation before sensitive/irreversible steps
 *   - exposes only high-level progress to the HUD (no hidden reasoning)
 *
 * It runs fully asynchronously (await/yield between steps), so the UI
 * stays responsive during longer tasks.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { taskPlanner } from './taskPlanner.js';
import { skillManager } from './skillManager.js';
import { permissions } from './permissions.js';
import { memory } from './memory.js';
import { summarizeText, delay } from './utils.js';

class Agent {
    constructor() {
        this._context = null;   // shared "blackboard" holding step outputs
        this._goal = '';
        this._speak = null;
        this._cancelled = false;
    }

    /**
     * Attempt to handle `goal` as a multi-step task.
     * Returns `null` if the goal is not multi-step (caller should fall back
     * to the single-skill path). Otherwise returns { response, success }.
     */
    async process(goal, { speak = null } = {}) {
        if (!CONFIG.agent.enabled) return null;

        const analysis = taskPlanner.analyze(goal);
        if (!analysis.isMultiStep || analysis.plan.length === 0) {
            return null; // not a multi-step task — let the single-skill path handle it
        }

        this._goal = analysis.goal;
        this._speak = speak;
        this._cancelled = false;
        this._context = { _goal: analysis.goal };

        // ---- PLAN (visible to the user as the task list) ----
        const plan = analysis.plan.map((step, i) => ({
            ...step,
            index: i,
            status: 'pending'
        }));

        state.set('aliceState', CONFIG.states.PLANNING);
        state.setTask({
            active: true,
            goal: analysis.goal,
            status: 'planning',
            plan,
            currentStepIndex: -1,
            currentAction: 'Building task plan',
            progress: 0,
            result: null,
            error: null
        });

        state.logActivity(`Task planned: ${plan.map(s => s.label).join(' → ')}`, 'info');
        if (this._speak && CONFIG.agent.speakProgress) {
            this._speak(this._planAnnouncement(plan));
        }

        // ---- EXECUTE / OBSERVE / DECIDE ----
        for (let i = 0; i < plan.length; i++) {
            if (this._cancelled) break;

            const step = plan[i];
            state.set('aliceState', CONFIG.states.EXECUTING);
            state.setTask({
                currentStepIndex: i,
                currentAction: step.label,
                status: 'running',
                progress: Math.round((i / plan.length) * 100)
            });
            state.updateTaskStep(i, { status: 'running' });

            // Sensitive actions require explicit user confirmation
            const { requiresConfirmation, reason } = permissions.evaluateStep(step);
            if (requiresConfirmation) {
                const approved = await this._confirmStep(step, reason);
                if (!approved) {
                    return this._cancel(step);
                }
            }

            const result = await this._executeWithRecovery(step);

            if (!result.success) {
                // DECIDE: cannot continue — report clearly and stop
                return this._fail(step, result.error);
            }

            // OBSERVE: store result on the shared blackboard for later steps
            this._context[step.contextKey] = result;

            state.updateTaskStep(i, { status: 'completed', result: result.result || '' });
            state.setTask({ progress: Math.round(((i + 1) / plan.length) * 100) });

            state.logActivity(`Step complete: ${step.label}`, 'success');
            if (this._speak && CONFIG.agent.speakProgress && plan.length > 1) {
                this._speak(this._stepDoneAnnouncement(step));
            }

            // Yield to the event loop so the UI stays responsive
            await delay(CONFIG.agent.stepDelay);
        }

        // ---- COMPLETE ----
        return this._complete(plan);
    }

    // ------------------------------------------------------------------
    // Confirmation
    // ------------------------------------------------------------------
    async _confirmStep(step, reason) {
        state.set('aliceState', CONFIG.states.WAITING);
        state.setTask({ status: 'waiting_confirmation', currentAction: `Confirm: ${step.label}` });

        const message = `${step.label} — this is a ${reason}.`;

        const approved = await permissions.requestConfirmation({
            title: 'Confirmation required',
            message,
            action: step.label
        });

        state.set('aliceState', CONFIG.states.EXECUTING);
        state.setTask({ status: 'running', currentAction: step.label });
        return approved;
    }

    // ------------------------------------------------------------------
    // Execution with retry + alternative fallback
    // ------------------------------------------------------------------
    async _executeWithRecovery(step) {
        const maxAttempts = (step.retries || 0) + 1;
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt > 0) {
                state.logActivity(`Retrying "${step.label}" (attempt ${attempt + 1})`, 'warning');
                await delay(CONFIG.agent.retryDelay);
            }
            const result = await this._executeStep(step);
            if (result && result.success) return result;
            lastError = result?.error || 'step failed';
        }

        // Alternative approach when available
        for (const altSkill of (step.alternatives || [])) {
            state.logActivity(`Trying alternative approach: ${altSkill}`, 'info');
            try {
                const altStep = { ...step, skill: altSkill, alternatives: [] };
                const altResult = await this._executeStep(altStep);
                if (altResult && altResult.success) {
                    return { ...altResult, viaAlternative: true };
                }
            } catch (e) {
                // fall through to next alternative
            }
        }

        return { success: false, error: lastError };
    }

    async _executeStep(step) {
        // Internal "core" operations (no external skill)
        if (step.skill === 'core') {
            return this._executeCore(step);
        }

        // Resolve the input: either literal text or a prior step's output
        const rawInput = step.inputSource
            ? this._extractText(this._context[step.inputSource])
            : (step.input || '');

        // Build skill context for skills that consume prepared content
        let context = {};
        if (step.skill === 'files' && step.action === 'create') {
            context = {
                content: this._buildDocument(rawInput),
                filename: step.filename || 'alice-document.txt'
            };
        } else if (step.skill === 'notes' && step.action === 'create') {
            context = { action: 'create', content: rawInput };
        }

        return skillManager.executeByName(step.skill, rawInput, context);
    }

    _executeCore(step) {
        if (step.operation === 'summarize') {
            const source = step.inputSource ? this._extractText(this._context[step.inputSource]) : '';
            const summary = summarizeText(source, 4);
            if (!summary) {
                return { success: false, error: 'There was no information to process.' };
            }
            return { success: true, result: summary };
        }
        return { success: false, error: `Unknown operation: ${step.operation}` };
    }

    _extractText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'object') return value.result || value.text || value.content || '';
        return String(value);
    }

    _buildDocument(body) {
        const title = `ALICE Research — ${this._goal || 'Topic'}`;
        const meta = `Generated by ALICE on ${new Date().toLocaleString()}`;
        return `${title}\n${meta}\n\n${body}\n`;
    }

    // ------------------------------------------------------------------
    // Announcements (high-level only — no chain-of-thought)
    // ------------------------------------------------------------------
    _planAnnouncement(plan) {
        return `I'll handle this in ${plan.length} steps: ${plan.map(s => s.label).join(', ')}.`;
    }

    _stepDoneAnnouncement(step) {
        return `${step.label} — done.`;
    }

    // ------------------------------------------------------------------
    // Terminal outcomes
    // ------------------------------------------------------------------
    _cancel(step) {
        state.set('aliceState', CONFIG.states.IDLE);
        state.updateTaskStep(step.index, { status: 'cancelled' });
        state.setTask({
            active: false,
            status: 'cancelled',
            currentAction: 'Cancelled by user',
            error: `Cancelled at "${step.label}"`
        });
        state.logActivity('Task cancelled by user', 'warning');
        memory.recordTask(this._goal, 'cancelled');
        const msg = 'Understood — task cancelled. Nothing was changed.';
        return { response: msg, success: false };
    }

    _fail(step, error) {
        state.set('aliceState', CONFIG.states.IDLE);
        state.updateTaskStep(step.index, { status: 'failed' });
        state.setTask({
            active: false,
            status: 'failed',
            currentAction: 'Failed',
            error: `Step "${step.label}" failed: ${error}`
        });
        state.logActivity(`Task failed at "${step.label}": ${error}`, 'danger');
        memory.recordTask(this._goal, 'failed', `Failed at "${step.label}": ${error}`);
        const msg = `I had to stop. ${step.label} could not be completed: ${error || 'unknown error'}.`;
        return { response: msg, success: false };
    }

    _complete(plan) {
        const summary = this._extractText(this._context.summary);
        const doc = this._context.document;

        let report;
        if (summary && doc) {
            report = `Done. I researched the topic, summarized the key points, and created the document "${doc.filename || 'alice-research.txt'}".`;
        } else if (summary) {
            report = `Done. Here's what I found: ${summary}`;
        } else {
            report = `Done. I completed: ${plan.map(s => s.label).join(', ')}.`;
        }

        // Keep the spoken summary within a reasonable length for TTS
        if (report.length > 600) {
            report = report.substring(0, 597) + '...';
        }

        state.set('aliceState', CONFIG.states.COMPLETING);
        state.setTask({
            active: false,
            status: 'completed',
            progress: 100,
            currentAction: 'Complete',
            result: report
        });
        state.logActivity('Task completed successfully', 'success');
        memory.recordTask(this._goal, 'completed', report);
        return { response: report, success: true, context: this._context };
    }

    /**
     * True while a task is running (used to route confirmation answers).
     */
    isBusy() {
        return !!state.get('task').active;
    }
}

// Singleton instance
export const agent = new Agent();
