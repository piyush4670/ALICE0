/**
 * ALICE HUD Module — Visual Reconstruction 1B
 * Premium AI Assistant Interface
 * 
 * Renders the assistant-focused UI: orb, state, conversation,
 * task progress, and controls. All visual updates observe state;
 * the HUD never decides lifecycle on its own.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { VOICE_STATUS } from './voiceStatus.js';
import { audioManager } from './audio.js';
import { formatTime, escapeHtml } from './utils.js';
import { permissions } from './permissions.js';
import { notifications } from './notifications.js';
import { settings } from './settings.js';
import { skillManager } from './skillManager.js';
import { memory } from './memory.js';

class ALICEHUD {
    constructor() {
        this._animationFrame = null;
        this._waveformData = [];
        this._hudElement = null;
        this._conversationRendered = false;
        this._promptVisible = false;
    }

    init(hudElement) {
        this._hudElement = hudElement;
        this._setupOrb();
        this._setupWaveform();
        this._setupStateSubscription();
        this._setupVoiceUI();
        this._setupConversation();
        this._setupTaskInline();
        this._setupConfirmationModal();
        this._setupNotifications();
        this._setupSettingsModal();
        this._setupMemoryModal();
        this._setupQuickActions();
        this._startRenderLoop();
        
        // Update time display
        this._updateTimeDisplay();
        setInterval(() => this._updateTimeDisplay(), 1000);
        
        // Start metrics simulation (rendered to debug panel only)
        state.startMetricsSimulation();
        state.subscribe('systemMetrics', () => this._updateDebugMetrics());
        
        // Subscribe to voice transcript
        state.subscribe('voice.currentTranscript', (text) => {
            this._updateTranscriptOverlay(text);
        });
        
        // Subscribe to conversation changes
        state.subscribe('conversation', () => {
            this._renderConversation();
        });

        // Subscribe to task changes
        state.subscribe('task', () => {
            this._renderTaskInline();
        });

        // Subscribe to activity log (debug panel only)
        state.subscribe('activityLog', () => {
            this._updateDebugActivityLog();
        });
        
        // Show initial prompt
        this._showPrompt('What can I do for you?');
        
        state.logActivity('HUD initialized and ready', 'success');
    }

    // ------------------------------------------------------------------
    // Orb
    // ------------------------------------------------------------------

    _setupOrb() {
        // No particle setup needed — orb uses pure CSS animations now
        // that are state-driven via class changes
    }

    // ------------------------------------------------------------------
    // Waveform (truthful)
    // ------------------------------------------------------------------

    _setupWaveform() {
        const canvas = this._hudElement?.querySelector('.waveform-canvas');
        if (!canvas) return;

        this._waveformData = new Array(48).fill(0);
        
        // Setup canvas with proper sizing
        const container = canvas.parentElement;
        const rect = container.getBoundingClientRect();
        canvas.width = rect.width * 2;
        canvas.height = rect.height * 2;
        
        this._waveformCtx = canvas.getContext('2d');
        this._waveformCtx.scale(2, 2);
    }

    _updateWaveform() {
        if (!this._waveformCtx) return;
        
        const canvas = this._hudElement?.querySelector('.waveform-canvas');
        const container = this._hudElement?.querySelector('.waveform-container');
        if (!canvas || !container) return;

        const ctx = this._waveformCtx;
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;
        
        // Truthful waveform: ONLY show when real audio analyser data exists.
        // If the audio manager is not actively capturing, there is no real
        // audio to visualize — hide the waveform entirely rather than
        // displaying synthetic/random data that could be mistaken for
        // real microphone or speaker activity.
        const isCapturing = audioManager.isCapturing();
        
        if (!isCapturing) {
            container.classList.remove('visible');
            ctx.clearRect(0, 0, width, height);
            // Reset data so stale bars don't appear if capture resumes
            this._waveformData.fill(0);
            return;
        }
        
        container.classList.add('visible');
        
        // Read real audio level from the analyser (returns 0-1)
        const audioLevel = audioManager.getAudioLevel();
        
        // Shift data left and append the real level
        for (let i = 0; i < this._waveformData.length - 1; i++) {
            this._waveformData[i] = this._waveformData[i + 1];
        }
        this._waveformData[this._waveformData.length - 1] = audioLevel * 2;

        // Clear and draw
        ctx.clearRect(0, 0, width, height);
        
        const barCount = this._waveformData.length;
        const barWidth = width / barCount;
        const centerY = height / 2;
        
        // Color reflects the current state (blue for listening, teal for speaking)
        const aliceState = state.get('aliceState');
        const color = (aliceState === 'SPEAKING')
            ? CONFIG.visuals.accentColor
            : CONFIG.visuals.primaryColor;
        ctx.fillStyle = color;

        for (let i = 0; i < barCount; i++) {
            const val = Math.abs(this._waveformData[i]);
            const barHeight = Math.max(2, val * height * 0.85);
            const x = i * barWidth;
            const bw = Math.max(1, barWidth - 2);
            const by = centerY - barHeight / 2;
            
            // Draw bar (with rounded corners if supported)
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(x + 1, by, bw, barHeight, 1);
                ctx.fill();
            } else {
                ctx.fillRect(x + 1, by, bw, barHeight);
            }
        }
    }

    // ------------------------------------------------------------------
    // State subscription
    // ------------------------------------------------------------------

    _setupStateSubscription() {
        state.subscribe('aliceState', (newState, oldState) => {
            this._transitionState(oldState, newState);
        });
    }

    // ------------------------------------------------------------------
    // Voice UI
    // ------------------------------------------------------------------

    _setupVoiceUI() {
        state.subscribe('voice', (voiceState) => {
            this._updateVoiceButtons(voiceState);
        });

        // Render initial state
        this._updateVoiceButtons(state.getVoiceState());
    }

    _updateVoiceButtons(voiceState) {
        const micBtn = this._hudElement?.querySelector('#mic-toggle');
        if (!micBtn) return;

        const status = voiceState.status || VOICE_STATUS.OFF;
        const isActive = voiceState.isActive;
        
        // Remove all state classes
        micBtn.classList.remove('active', 'listening');
        
        if (isActive) {
            micBtn.classList.add('active');
            micBtn.setAttribute('aria-label', 'Disable microphone');
            if (status === VOICE_STATUS.LISTENING) {
                micBtn.classList.add('listening');
            }
        } else {
            micBtn.setAttribute('aria-label', 'Enable microphone');
        }
    }

    // ------------------------------------------------------------------
    // Conversation
    // ------------------------------------------------------------------

    _setupConversation() {
        this._renderConversation();
    }

    _renderConversation() {
        const container = this._hudElement?.querySelector('#conversation-scroll');
        if (!container) return;

        const messages = state.getConversation();
        
        if (messages.length === 0) {
            container.innerHTML = `
                <div class="conversation-empty">
                    <span class="conversation-empty-text">Your conversation will appear here</span>
                </div>
            `;
            return;
        }

        // Build conversation HTML
        let html = '';
        for (const msg of messages) {
            const roleClass = msg.role === 'user' ? 'user' : 'assistant';
            const roleLabel = msg.role === 'user' ? 'You' : 'ALICE';
            const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }) : '';
            
            html += `
                <div class="conversation-msg ${roleClass}">
                    <div class="conversation-msg-header">
                        <span class="conversation-msg-role">${roleLabel}</span>
                        <span class="conversation-msg-time">${time}</span>
                    </div>
                    <div class="conversation-msg-body">${escapeHtml(msg.text)}</div>
                </div>
            `;
        }
        
        container.innerHTML = html;
        
        // Auto-scroll to bottom
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }

    // ------------------------------------------------------------------
    // Task inline display
    // ------------------------------------------------------------------

    _setupTaskInline() {
        this._renderTaskInline();
    }

    _renderTaskInline() {
        const container = this._hudElement?.querySelector('#task-inline');
        if (!container) return;

        const task = state.getTask();
        
        // Only show when there's an active task
        if (!task.active && task.status === 'idle') {
            container.hidden = true;
            return;
        }

        container.hidden = false;

        // Update goal
        const goalEl = container.querySelector('[data-task="goal"]');
        if (goalEl) goalEl.textContent = task.goal || 'Working...';

        // Update status badge
        const statusEl = container.querySelector('[data-task="status"]');
        if (statusEl) {
            const statusLabels = {
                planning: 'Planning',
                running: 'Running',
                waiting_confirmation: 'Awaiting confirmation',
                completed: 'Complete',
                failed: 'Failed',
                cancelled: 'Cancelled'
            };
            statusEl.textContent = statusLabels[task.status] || task.status;
            statusEl.className = `task-inline-status ${task.status}`;
        }

        // Update steps
        const stepsEl = container.querySelector('[data-task="steps"]');
        if (stepsEl) {
            const stepIcons = {
                pending: '○',
                running: '●',
                completed: '✓',
                failed: '✕',
                cancelled: '⊘'
            };

            const steps = task.plan || [];
            stepsEl.innerHTML = steps.map(step => `
                <div class="task-step-compact ${step.status}">
                    <span class="task-step-compact-icon">${stepIcons[step.status] || '○'}</span>
                    <span class="task-step-compact-label">${escapeHtml(step.label)}</span>
                </div>
            `).join('');
        }

        // Update progress
        const progressEl = container.querySelector('[data-task="progress-fill"]');
        if (progressEl) {
            progressEl.style.width = `${task.progress || 0}%`;
        }
    }

    // ------------------------------------------------------------------
    // Confirmation modal
    // ------------------------------------------------------------------

    _setupConfirmationModal() {
        const modal = document.getElementById('confirmation-modal');
        if (modal) {
            permissions.attachModal(modal);
        }
    }

    // ------------------------------------------------------------------
    // Notifications
    // ------------------------------------------------------------------

    _setupNotifications() {
        const center = document.getElementById('notification-center');
        notifications.init(center);
    }

    // ------------------------------------------------------------------
    // Settings modal
    // ------------------------------------------------------------------

    _setupSettingsModal() {
        this._settingsModal = document.getElementById('settings-modal');
        if (!this._settingsModal) return;

        state.subscribe('settings', () => this._renderSettings());
        this._renderSettings();

        this._settingsModal.querySelectorAll('[data-close="settings"]').forEach(b =>
            b.addEventListener('click', () => this._closeSettings()));
        this._settingsModal.addEventListener('click', (e) => {
            if (e.target === this._settingsModal) this._closeSettings();
        });
    }

    openSettings() {
        if (this._settingsModal) {
            this._settingsModal.classList.add('visible');
            this._settingsModal.setAttribute('aria-hidden', 'false');
        }
    }

    _closeSettings() {
        if (this._settingsModal) {
            this._settingsModal.classList.remove('visible');
            this._settingsModal.setAttribute('aria-hidden', 'true');
        }
    }

    _renderSettings() {
        const body = this._settingsModal?.querySelector('#settings-body');
        if (!body) return;

        const s = state.getSettings();
        const skills = skillManager.getSkills();

        const pro = s.proactive;
        const feats = s.features;

        body.innerHTML = `
            <section class="settings-group">
                <h4 class="settings-group-title">Proactive Assistance</h4>
                <label class="settings-row">
                    <span>Enabled</span>
                    <input type="checkbox" data-set="proactive" data-key="enabled" ${pro.enabled ? 'checked' : ''}>
                </label>
                <label class="settings-row">
                    <span>Frequency</span>
                    <select data-set="proactive" data-key="level">
                        ${['off', 'low', 'moderate', 'high'].map(l =>
                            `<option value="${l}" ${pro.level === l ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </label>
            </section>

            <section class="settings-group">
                <h4 class="settings-group-title">Features</h4>
                ${Object.keys(feats).map(f => `
                    <label class="settings-row">
                        <span>${f}</span>
                        <input type="checkbox" data-set="features" data-key="${f}" ${feats[f] ? 'checked' : ''}>
                    </label>`).join('')}
            </section>

            <section class="settings-group">
                <h4 class="settings-group-title">Skills</h4>
                ${skills.map(sk => `
                    <label class="settings-row">
                        <span>${escapeHtml(sk.name)}</span>
                        <input type="checkbox" data-skill="${escapeHtml(sk.name)}" ${skillManager.isEnabled(sk.name) ? 'checked' : ''}>
                    </label>`).join('')}
            </section>

            <div class="settings-footer">
                <button class="confirm-btn cancel" id="settings-reset" type="button">Reset to defaults</button>
            </div>
        `;

        // Wire events
        body.querySelectorAll('[data-set]').forEach(el => {
            const apply = () => {
                const group = el.dataset.set;
                const key = el.dataset.key;
                const value = el.type === 'checkbox' ? el.checked : el.value;
                settings.set(group, key, value);
            };
            el.addEventListener('change', apply);
        });

        body.querySelectorAll('[data-skill]').forEach(el => {
            el.addEventListener('change', () => {
                settings.setSkillEnabled(el.dataset.skill, el.checked);
            });
        });

        body.querySelector('#settings-reset')?.addEventListener('click', () => {
            settings.resetAll();
        });
    }

    // ------------------------------------------------------------------
    // Memory modal
    // ------------------------------------------------------------------

    _setupMemoryModal() {
        this._memoryModal = document.getElementById('memory-modal');
        if (!this._memoryModal) return;

        state.subscribe('memory', () => this._renderMemory());
        this._memoryModal.querySelectorAll('[data-close="memory"]').forEach(b =>
            b.addEventListener('click', () => this._closeMemory()));
        this._memoryModal.addEventListener('click', (e) => {
            if (e.target === this._memoryModal) this._closeMemory();
        });
    }

    openMemory() {
        if (this._memoryModal) {
            this._renderMemory();
            this._memoryModal.classList.add('visible');
            this._memoryModal.setAttribute('aria-hidden', 'false');
        }
    }

    _closeMemory() {
        if (this._memoryModal) {
            this._memoryModal.classList.remove('visible');
            this._memoryModal.setAttribute('aria-hidden', 'true');
        }
    }

    _renderMemory() {
        const body = this._memoryModal?.querySelector('#memory-body');
        if (!body) return;

        const memories = memory.getAllMemories();
        const prefs = memory.getAllPreferences();
        const facts = memory.getPinnedFacts();
        const history = memory.getTaskHistory(10);

        const memoryRows = memories.length
            ? memories.map(m => `
                <div class="memory-row" data-kind="memory" data-key="${escapeHtml(m.key)}">
                    <div class="memory-row-text">
                        <strong>${escapeHtml(m.key)}</strong> — ${escapeHtml(m.value)}
                    </div>
                    <button class="memory-row-delete" data-delete="memory" data-key="${escapeHtml(m.key)}" type="button">&times;</button>
                </div>`).join('')
            : '<p class="memory-empty">No saved memories.</p>';

        const prefRows = Object.keys(prefs).length
            ? Object.entries(prefs).map(([k, v]) => `
                <div class="memory-row">
                    <div class="memory-row-text"><strong>pref:${escapeHtml(k)}</strong> — ${escapeHtml(v)}</div>
                    <button class="memory-row-delete" data-delete="preference" data-key="${escapeHtml(k)}" type="button">&times;</button>
                </div>`).join('')
            : '<p class="memory-empty">No preferences.</p>';

        const factRows = facts.length
            ? facts.map(f => `
                <div class="memory-row">
                    <div class="memory-row-text">${escapeHtml(f.text)}</div>
                    <button class="memory-row-delete" data-delete="fact" data-key="${escapeHtml(f.id)}" type="button">&times;</button>
                </div>`).join('')
            : '<p class="memory-empty">No pinned facts.</p>';

        const historyRows = history.length
            ? history.map(h => `
                <div class="memory-row">
                    <div class="memory-row-text">
                        <span class="memory-tag ${h.status}">${escapeHtml(h.status)}</span> ${escapeHtml(h.goal)}
                    </div>
                </div>`).join('')
            : '<p class="memory-empty">No task history.</p>';

        body.innerHTML = `
            <div class="memory-sections">
                <section class="settings-group">
                    <h4 class="settings-group-title">Memories</h4>
                    ${memoryRows}
                </section>
                <section class="settings-group">
                    <h4 class="settings-group-title">Preferences</h4>
                    ${prefRows}
                </section>
                <section class="settings-group">
                    <h4 class="settings-group-title">Pinned Facts</h4>
                    ${factRows}
                </section>
                <section class="settings-group">
                    <h4 class="settings-group-title">Task History</h4>
                    ${historyRows}
                </section>
            </div>
            <div class="settings-footer">
                <button class="confirm-btn cancel" id="memory-clear-all" type="button">Clear all memory</button>
            </div>
        `;

        body.querySelectorAll('[data-delete]').forEach(btn => {
            btn.addEventListener('click', () => {
                const kind = btn.dataset.delete;
                const key = btn.dataset.key;
                if (kind === 'memory') memory.forget(key);
                else if (kind === 'preference') memory.deletePreference(key);
                else if (kind === 'fact') memory.unpinFact(key);
                this._renderMemory();
            });
        });

        body.querySelector('#memory-clear-all')?.addEventListener('click', () => {
            permissions.requestConfirmation({
                title: 'Clear all memory',
                message: 'This permanently deletes all memories, preferences, facts, notes, and task history.',
                action: 'Clear all memory'
            }).then(approved => {
                if (approved) {
                    memory.clearAllMemory();
                    state.notify('All memory cleared', 'warning');
                }
                this._renderMemory();
            });
        });
    }

    // ------------------------------------------------------------------
    // Quick actions (secondary actions in footer)
    // ------------------------------------------------------------------

    _setupQuickActions() {
        const actions = {
            help: () => {
                state.notify('Type a command or enable voice to interact with ALICE.', 'info', { duration: 8000 });
            },
            settings: () => this.openSettings(),
            skills: () => this.openSettings(),
            memory: () => this.openMemory()
        };

        this._hudElement?.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (actions[action]) actions[action]();
            });
        });
    }

    // ------------------------------------------------------------------
    // State transition
    // ------------------------------------------------------------------

    _transitionState(from, to) {
        const hud = this._hudElement;
        if (!hud) return;

        // Update state indicator
        const stateIndicator = hud.querySelector('.state-indicator');
        const stateText = hud.querySelector('.state-text');
        const statusBadge = hud.querySelector('.status-badge');
        const orb = hud.querySelector('.alice-orb');
        
        if (stateIndicator) {
            stateIndicator.className = `state-indicator ${to.toLowerCase()}`;
        }
        
        if (stateText) {
            stateText.textContent = this._getStateLabel(to);
        }
        
        if (statusBadge) {
            statusBadge.className = `hud-status-badge ${to.toLowerCase()} status-badge`;
            statusBadge.textContent = this._getStateLabel(to);
        }

        if (orb) {
            orb.className = `alice-orb ${to.toLowerCase()}`;
        }

        // Update prompt text based on state
        this._updatePromptForState(to);

        // Update voice buttons
        this._updateVoiceButtons(state.getVoiceState());

        state.logActivity(`State: ${from} → ${to}`, 'info');
    }

    _getStateLabel(aliceState) {
        const labels = {
            IDLE: 'Ready',
            LISTENING: 'Listening',
            PROCESSING: 'Understanding',
            SPEAKING: 'Speaking',
            EXECUTING: 'Executing',
            UNDERSTANDING: 'Understanding',
            SELECTING_TOOL: 'Working',
            COMPLETING: 'Completing',
            PLANNING: 'Planning',
            WAITING: 'Awaiting input'
        };
        return labels[aliceState] || aliceState;
    }

    _updatePromptForState(aliceState) {
        const prompts = {
            IDLE: 'What can I do for you?',
            LISTENING: 'I\'m listening...',
            PROCESSING: 'Let me think about that...',
            SPEAKING: '',
            EXECUTING: 'Working on it...',
            UNDERSTANDING: 'Understanding your request...',
            SELECTING_TOOL: 'Finding the right tool...',
            COMPLETING: 'Almost done...',
            PLANNING: 'Planning the steps...',
            WAITING: 'Waiting for your response...'
        };

        const prompt = prompts[aliceState];
        if (prompt) {
            this._showPrompt(prompt);
        } else {
            this._hidePrompt();
        }
    }

    _showPrompt(text) {
        const promptEl = this._hudElement?.querySelector('.alice-prompt');
        const textEl = this._hudElement?.querySelector('.alice-prompt-text');
        if (!promptEl || !textEl) return;
        
        textEl.textContent = text;
        promptEl.classList.add('visible');
        this._promptVisible = true;
    }

    _hidePrompt() {
        const promptEl = this._hudElement?.querySelector('.alice-prompt');
        if (!promptEl) return;
        promptEl.classList.remove('visible');
        this._promptVisible = false;
    }

    // ------------------------------------------------------------------
    // Transcript overlay (shows current speech input)
    // ------------------------------------------------------------------

    _updateTranscriptOverlay(text) {
        const overlay = this._hudElement?.querySelector('#transcript-overlay');
        const textEl = this._hudElement?.querySelector('#transcript-text');
        if (!overlay || !textEl) return;

        if (text && text.length > 0) {
            textEl.textContent = text;
            overlay.classList.add('visible');
        } else {
            overlay.classList.remove('visible');
        }
    }

    // ------------------------------------------------------------------
    // Render loop
    // ------------------------------------------------------------------

    _startRenderLoop() {
        const render = () => {
            this._updateWaveform();
            this._animationFrame = requestAnimationFrame(render);
        };
        render();
    }

    // ------------------------------------------------------------------
    // Time display
    // ------------------------------------------------------------------

    _updateTimeDisplay() {
        const timeEl = this._hudElement?.querySelector('.time-display');
        const currentTime = state.get('currentTime');
        
        if (timeEl) {
            timeEl.textContent = formatTime(currentTime).replace(/:00$/, '');
        }
    }

    // ------------------------------------------------------------------
    // Debug panel updates
    // ------------------------------------------------------------------

    _updateDebugMetrics() {
        const metrics = state.get('systemMetrics');
        
        const cpuEl = document.querySelector('.debug-cpu');
        const memEl = document.querySelector('.debug-mem');
        const netEl = document.querySelector('.debug-net');
        
        if (cpuEl) cpuEl.textContent = `${Math.round(metrics.cpu)}%`;
        if (memEl) memEl.textContent = `${Math.round(metrics.memory)}%`;
        if (netEl) netEl.textContent = `${Math.round(metrics.network)}%`;
    }

    _updateDebugActivityLog() {
        const container = document.getElementById('debug-activity-log');
        if (!container) return;

        const logs = state.get('activityLog');
        const html = logs.slice(0, 15).map(log => {
            const time = log.timestamp.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
            });
            return `<div style="padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.03);">
                <span style="color:var(--text-faint);">${time}</span> 
                <span style="color:${log.type === 'success' ? 'var(--accent)' : log.type === 'warning' ? 'var(--warning)' : log.type === 'danger' ? 'var(--danger)' : 'var(--text-dim)'};">${escapeHtml(log.message)}</span>
            </div>`;
        }).join('');

        container.innerHTML = html || '<div style="color:var(--text-faint);">No activity</div>';
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    setState(newState) {
        state.set('aliceState', newState);
    }

    getCurrentState() {
        return state.get('aliceState');
    }

    destroy() {
        if (this._animationFrame) {
            cancelAnimationFrame(this._animationFrame);
        }
    }
}

// Singleton instance
export const hud = new ALICEHUD();
