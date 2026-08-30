/**
 * ALICE Task Dashboard (Part 4)
 * ------------------------------------------------------------------
 * Renders the live task panel in the HUD: current goal, high-level plan,
 * per-step progress, current action, confirmation state, and final status.
 *
 * Shows only high-level task progress — never hidden reasoning.
 */
import { state } from './state.js';
import { escapeHtml } from './utils.js';

const STATUS_LABEL = {
    idle: 'Idle',
    planning: 'Planning',
    running: 'Running',
    waiting_confirmation: 'Awaiting confirmation',
    completed: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled'
};

const STEP_ICON = {
    pending: '○',
    running: '▸',
    completed: '✓',
    failed: '✕',
    cancelled: '⊘'
};

class TaskDashboard {
    constructor() {
        this._root = null;
        this._listEl = null;
    }

    init(root) {
        if (!root) return;
        this._root = root;

        // Build static shell once, then re-render the dynamic parts
        root.innerHTML = `
            <div class="task-dashboard">
                <div class="task-goal-row">
                    <span class="task-goal-label">Goal</span>
                    <span class="task-goal" data-task="goal">—</span>
                </div>
                <div class="task-status-row">
                    <span class="task-status-badge idle" data-task="status">Idle</span>
                    <span class="task-progress-text" data-task="progress">0%</span>
                </div>
                <div class="task-progress-track">
                    <div class="task-progress-fill" data-task="progress-fill"></div>
                </div>
                <div class="task-current-action" data-task="current">No active task</div>
                <ul class="task-steps" data-task="steps"></ul>
                <div class="task-result" data-task="result"></div>
            </div>
        `;

        this._listEl = root.querySelector('[data-task="steps"]');
        state.subscribe('task', () => this.render());
        this.render();
    }

    render() {
        if (!this._root) return;
        const task = state.getTask();
        const el = (name) => this._root.querySelector(`[data-task="${name}"]`);

        el('goal').textContent = task.goal || '—';

        const status = el('status');
        status.textContent = STATUS_LABEL[task.status] || task.status;
        status.className = `task-status-badge ${task.status}`;

        el('progress').textContent = `${Math.round(task.progress || 0)}%`;
        el('progress-fill').style.width = `${task.progress || 0}%`;

        const current = el('current');
        if (task.status === 'waiting_confirmation') {
            current.textContent = '⚠ Waiting for your confirmation';
            current.className = 'task-current-action waiting';
        } else if (task.currentAction) {
            current.textContent = `▸ ${task.currentAction}`;
            current.className = 'task-current-action active';
        } else {
            current.textContent = 'No active task';
            current.className = 'task-current-action';
        }

        // Steps
        const steps = task.plan || [];
        this._listEl.innerHTML = steps.map(step => `
            <li class="task-step ${step.status}">
                <span class="task-step-icon">${STEP_ICON[step.status] || '○'}</span>
                <span class="task-step-label">${escapeHtml(step.label)}</span>
                <span class="task-step-skill">${escapeHtml(step.skill === 'core' ? 'process' : step.skill || '')}</span>
            </li>
        `).join('') || '<li class="task-step-empty">No steps yet</li>';

        // Result / error
        const result = el('result');
        if (task.status === 'completed' && task.result) {
            result.textContent = task.result;
            result.className = 'task-result success';
        } else if (task.status === 'failed' && task.error) {
            result.textContent = `✕ ${task.error}`;
            result.className = 'task-result error';
        } else if (task.status === 'cancelled') {
            result.textContent = 'Task cancelled by user.';
            result.className = 'task-result error';
        } else {
            result.textContent = '';
            result.className = 'task-result';
        }
    }
}

// Singleton instance
export const taskDashboard = new TaskDashboard();
