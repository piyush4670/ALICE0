/**
 * ALICE HUD Module
 * Main Heads-Up Display for the AI interface
 * Part 3: Integrated with skills and memory
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { audioManager } from './audio.js';
import { formatTime, formatDate } from './utils.js';

class ALICEHUD {
    constructor() {
        this._animationFrame = null;
        this._orbParticles = [];
        this._waveformData = [];
        this._hudElement = null;
        this._voiceIndicatorElement = null;
    }

    init(hudElement) {
        this._hudElement = hudElement;
        this._setupOrb();
        this._setupWaveform();
        this._setupStateSubscription();
        this._setupVoiceUI();
        this._setupSkillUI();
        this._startRenderLoop();
        
        // Update time and date
        this._updateTimeDisplay();
        setInterval(() => this._updateTimeDisplay(), 1000);
        
        // Start metrics simulation
        state.startMetricsSimulation();
        this._updateMetricsDisplay();
        state.subscribe('systemMetrics', () => this._updateMetricsDisplay());
        
        // Subscribe to voice state changes
        state.subscribe('voice.currentTranscript', (text) => {
            this._updateTranscriptDisplay(text);
        });
        
        state.subscribe('voice.lastAliceResponse', (text) => {
            this._updateResponseDisplay(text);
        });

        // Subscribe to skill state changes
        state.subscribe('skill', (skillState) => {
            this._updateSkillDisplay(skillState);
        });
        
        state.logActivity('HUD initialized and ready', 'success');
    }

    _setupOrb() {
        const orb = this._hudElement?.querySelector('.alice-orb');
        if (!orb) return;

        // Create particles for orb effect
        const particleCount = 30;
        const orbContainer = orb.querySelector('.orb-particles');
        
        if (orbContainer) {
            orbContainer.innerHTML = ''; // Clear existing
            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'orb-particle';
                particle.style.setProperty('--angle', `${(i / particleCount) * 360}deg`);
                particle.style.setProperty('--delay', `${Math.random() * 2}s`);
                particle.style.setProperty('--duration', `${3 + Math.random() * 2}s`);
                orbContainer.appendChild(particle);
            }
        }

        // Core glow pulse
        const coreGlow = orb.querySelector('.orb-core-glow');
        if (coreGlow) {
            this._animateOrbGlow(coreGlow);
        }
    }

    _animateOrbGlow(element) {
        let scale = 1;
        let growing = true;
        
        const animate = () => {
            if (growing) {
                scale += 0.005;
                if (scale >= 1.3) growing = false;
            } else {
                scale -= 0.005;
                if (scale <= 0.7) growing = true;
            }
            
            element.style.transform = `scale(${scale})`;
            element.style.opacity = 0.3 + (scale - 0.7) * 0.3;
            
            requestAnimationFrame(animate);
        };
        
        animate();
    }

    _setupWaveform() {
        const canvas = this._hudElement?.querySelector('.waveform-canvas');
        if (!canvas) return;

        // Initialize waveform data
        this._waveformData = new Array(64).fill(0);
        
        // Setup canvas
        canvas.width = canvas.offsetWidth * 2;
        canvas.height = canvas.offsetHeight * 2;
        
        this._waveformCtx = canvas.getContext('2d');
        this._waveformCtx.scale(2, 2);
    }

    _updateWaveform() {
        if (!this._waveformCtx) return;
        
        const canvas = this._hudElement?.querySelector('.waveform-canvas');
        if (!canvas) return;

        const ctx = this._waveformCtx;
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;
        const aliceState = state.get('aliceState');
        const voiceState = state.getVoiceState();
        
        // Determine intensity based on actual audio if capturing
        let intensity = {
            IDLE: 0.15,
            LISTENING: 0.8,
            PROCESSING: 0.5,
            SPEAKING: 1.0,
            EXECUTING: 0.7,
            UNDERSTANDING: 0.5,
            SELECTING_TOOL: 0.6,
            COMPLETING: 0.4
        }[aliceState] || 0.15;

        // Shift data and add new values
        for (let i = 0; i < this._waveformData.length - 1; i++) {
            this._waveformData[i] = this._waveformData[i + 1];
        }
        
        let newValue;
        
        // Use actual audio data if available and listening
        if (audioManager.isCapturing() && (aliceState === 'LISTENING' || aliceState === 'SPEAKING')) {
            const audioLevel = audioManager.getAudioLevel();
            
            // Calculate level from actual audio
            const actualLevel = audioLevel * intensity * 2;
            newValue = actualLevel + (Math.random() - 0.5) * 0.1;
        } else if (aliceState === 'SPEAKING') {
            // Simulate speech waveform
            newValue = (Math.random() - 0.5) * intensity;
        } else if (aliceState === 'LISTENING') {
            // Listening visualization - respond to ambient
            const ambientLevel = audioManager.getAudioLevel();
            newValue = (Math.random() - 0.5) * ambientLevel * 3;
        } else if (aliceState === 'IDLE') {
            // Subtle idle animation
            newValue = Math.sin(Date.now() / 1000) * 0.08;
        } else {
            newValue = (Math.random() - 0.5) * intensity * 0.5;
        }
        
        this._waveformData[this._waveformData.length - 1] = newValue;

        // Clear and draw
        ctx.clearRect(0, 0, width, height);
        
        const barWidth = width / this._waveformData.length;
        const centerY = height / 2;
        
        // Dynamic color based on state
        const colors = {
            IDLE: CONFIG.visuals.primaryColor,
            LISTENING: CONFIG.visuals.primaryColor,
            PROCESSING: CONFIG.visuals.warningColor,
            SPEAKING: CONFIG.visuals.accentColor,
            EXECUTING: CONFIG.visuals.secondaryColor,
            UNDERSTANDING: CONFIG.visuals.warningColor,
            SELECTING_TOOL: CONFIG.visuals.secondaryColor,
            COMPLETING: CONFIG.visuals.accentColor
        };
        
        ctx.fillStyle = colors[aliceState] || CONFIG.visuals.primaryColor;
        ctx.shadowBlur = 10;
        ctx.shadowColor = colors[aliceState] || CONFIG.visuals.primaryColor;

        for (let i = 0; i < this._waveformData.length; i++) {
            const barHeight = Math.abs(this._waveformData[i]) * height * 0.9;
            const x = i * barWidth;
            
            // Draw bar
            ctx.fillRect(x, centerY - barHeight / 2, barWidth - 1, Math.max(2, barHeight));
        }
    }

    _setupStateSubscription() {
        state.subscribe('aliceState', (newState, oldState) => {
            this._transitionState(oldState, newState);
        });
        
        state.subscribe('activityLog', () => {
            this._updateActivityLog();
        });
    }

    _setupVoiceUI() {
        // Voice status indicator
        const voiceStatus = this._hudElement?.querySelector('.voice-status');
        if (voiceStatus) {
            this._voiceIndicatorElement = voiceStatus;
        }
        
        // Update voice status based on state
        state.subscribe('voice', (voiceState) => {
            this._updateVoiceStatus(voiceState);
        });
    }

    _setupSkillUI() {
        // Skill panel elements
        const skillPanel = this._hudElement?.querySelector('.skill-status');
        if (skillPanel) {
            this._skillPanel = skillPanel;
        }
    }

    _updateVoiceStatus(voiceState) {
        const voiceStatus = this._hudElement?.querySelector('.voice-status');
        if (!voiceStatus) return;
        
        const micIcon = voiceStatus.querySelector('.mic-icon');
        const statusText = voiceStatus.querySelector('.voice-status-text');
        
        if (voiceState.isActive && voiceState.isMicrophonePermission) {
            if (voiceState.isListening) {
                statusText.textContent = 'Listening...';
                voiceStatus.className = 'voice-status listening';
                micIcon?.classList.add('active');
            } else if (state.get('aliceState') === 'SPEAKING') {
                statusText.textContent = 'Speaking...';
                voiceStatus.className = 'voice-status speaking';
                micIcon?.classList.remove('active');
            } else {
                statusText.textContent = 'Say "Hey Alice"';
                voiceStatus.className = 'voice-status ready';
                micIcon?.classList.remove('active');
            }
        } else if (!voiceState.isMicrophonePermission) {
            statusText.textContent = 'Mic denied';
            voiceStatus.className = 'voice-status error';
            micIcon?.classList.remove('active');
        } else {
            statusText.textContent = 'Voice off';
            voiceStatus.className = 'voice-status inactive';
            micIcon?.classList.remove('active');
        }
    }

    _updateSkillDisplay(skillState) {
        const skillStatus = this._hudElement?.querySelector('.skill-status');
        if (!skillStatus) return;

        const skillIcon = skillStatus.querySelector('.skill-icon');
        const skillName = skillStatus.querySelector('.skill-name');
        const skillProgress = skillStatus.querySelector('.skill-progress');
        
        const currentSkill = skillState.currentSkill;
        
        if (currentSkill) {
            skillIcon.textContent = this._getSkillIcon(currentSkill);
            skillName.textContent = currentSkill.charAt(0).toUpperCase() + currentSkill.slice(1);
            skillStatus.className = 'skill-status active';
            skillProgress.style.width = '100%';
        } else {
            skillIcon.textContent = '◆';
            skillName.textContent = 'Ready';
            skillStatus.className = 'skill-status';
            skillProgress.style.width = '0%';
        }
    }

    _getSkillIcon(skillName) {
        const icons = {
            calculator: '∑',
            websearch: '🔍',
            notes: '📝',
            reminders: '⏰',
            datetime: '🕐',
            files: '📁',
            reader: '📖',
            memory: '🧠'
        };
        return icons[skillName] || '◈';
    }

    _transitionState(from, to) {
        const hud = this._hudElement;
        if (!hud) return;

        // Update state indicator
        const stateIndicator = hud.querySelector('.state-indicator');
        const stateText = hud.querySelector('.state-text');
        const statusBadge = hud.querySelector('.status-badge');
        
        if (stateIndicator) {
            stateIndicator.className = `state-indicator ${to.toLowerCase()}`;
        }
        
        if (stateText) {
            stateText.textContent = to;
        }
        
        if (statusBadge) {
            statusBadge.className = `status-badge ${to.toLowerCase()}`;
            statusBadge.textContent = this._getStateLabel(to);
        }

        // Update orb state
        const orb = hud.querySelector('.alice-orb');
        if (orb) {
            orb.className = `alice-orb ${to.toLowerCase()}`;
        }
        
        // Update voice status
        this._updateVoiceStatus(state.getVoiceState());

        // Update skill display if transitioning to/from skill states
        if (to === 'UNDERSTANDING' || to === 'SELECTING_TOOL' || to === 'EXECUTING' || to === 'COMPLETING') {
            this._updateSkillDisplay(state.getSkillState());
        }

        state.logActivity(`State changed: ${from} → ${to}`, 'info');
    }

    _getStateLabel(state) {
        const labels = {
            IDLE: 'Ready',
            LISTENING: 'Listening',
            PROCESSING: 'Processing',
            SPEAKING: 'Speaking',
            EXECUTING: 'Executing',
            UNDERSTANDING: 'Understanding',
            SELECTING_TOOL: 'Selecting Tool',
            COMPLETING: 'Completing'
        };
        return labels[state] || state;
    }

    _startRenderLoop() {
        const render = () => {
            this._updateWaveform();
            this._animationFrame = requestAnimationFrame(render);
        };
        render();
    }

    _updateTimeDisplay() {
        const timeEl = this._hudElement?.querySelector('.time-display');
        const dateEl = this._hudElement?.querySelector('.date-display');
        const currentTime = state.get('currentTime');
        
        if (timeEl) timeEl.textContent = formatTime(currentTime);
        if (dateEl) dateEl.textContent = formatDate(currentTime);
    }

    _updateMetricsDisplay() {
        const metrics = state.get('systemMetrics');
        
        // Update CPU
        const cpuBar = this._hudElement?.querySelector('.metric-cpu .metric-bar');
        const cpuValue = this._hudElement?.querySelector('.metric-cpu .metric-value');
        if (cpuBar) cpuBar.style.width = `${metrics.cpu}%`;
        if (cpuValue) cpuValue.textContent = `${Math.round(metrics.cpu)}%`;

        // Update Memory
        const memBar = this._hudElement?.querySelector('.metric-memory .metric-bar');
        const memValue = this._hudElement?.querySelector('.metric-memory .metric-value');
        if (memBar) memBar.style.width = `${metrics.memory}%`;
        if (memValue) memValue.textContent = `${Math.round(metrics.memory)}%`;

        // Update Network
        const netBar = this._hudElement?.querySelector('.metric-network .metric-bar');
        const netValue = this._hudElement?.querySelector('.metric-network .metric-value');
        if (netBar) netBar.style.width = `${metrics.network}%`;
        if (netValue) netValue.textContent = `${Math.round(metrics.network)}%`;
    }

    _updateActivityLog() {
        const logContainer = this._hudElement?.querySelector('.activity-log-content');
        if (!logContainer) return;

        const logs = state.get('activityLog');
        const html = logs.slice(0, 10).map(log => {
            const time = log.timestamp.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
            });
            return `
                <div class="activity-item ${log.type}">
                    <span class="activity-time">${time}</span>
                    <span class="activity-message">${log.message}</span>
                </div>
            `;
        }).join('');

        logContainer.innerHTML = html || '<div class="activity-empty">No recent activity</div>';
    }

    _updateTranscriptDisplay(text) {
        const transcriptEl = this._hudElement?.querySelector('.transcript-display');
        if (transcriptEl) {
            transcriptEl.textContent = text || '';
            transcriptEl.classList.toggle('visible', text.length > 0);
        }
    }

    _updateResponseDisplay(text) {
        const responseEl = this._hudElement?.querySelector('.response-display');
        if (responseEl) {
            responseEl.textContent = text || '';
            responseEl.classList.toggle('visible', text.length > 0);
        }
    }

    // Public methods
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
