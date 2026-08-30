/**
 * ALICE HUD Module
 * Main Heads-Up Display for the AI interface
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { formatTime, formatDate, animateNumber } from './utils.js';

class ALICEHUD {
    constructor() {
        this._animationFrame = null;
        this._orbParticles = [];
        this._waveformData = [];
        this._hudElement = null;
    }

    init(hudElement) {
        this._hudElement = hudElement;
        this._setupOrb();
        this._setupWaveform();
        this._setupStateSubscription();
        this._startRenderLoop();
        
        // Update time and date
        this._updateTimeDisplay();
        setInterval(() => this._updateTimeDisplay(), 1000);
        
        // Start metrics simulation
        state.startMetricsSimulation();
        this._updateMetricsDisplay();
        state.subscribe('systemMetrics', () => this._updateMetricsDisplay());
        
        state.logActivity('HUD initialized and ready', 'success');
    }

    _setupOrb() {
        const orb = this._hudElement?.querySelector('.alice-orb');
        if (!orb) return;

        // Create particles for orb effect
        const particleCount = 30;
        const orbContainer = orb.querySelector('.orb-particles');
        
        if (orbContainer) {
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
        
        // Update data based on state
        const intensity = {
            IDLE: 0.2,
            LISTENING: 0.8,
            PROCESSING: 0.6,
            SPEAKING: 1.0,
            EXECUTING: 0.7
        }[aliceState] || 0.2;

        // Shift data and add new values
        for (let i = 0; i < this._waveformData.length - 1; i++) {
            this._waveformData[i] = this._waveformData[i + 1];
        }
        
        // Generate new value based on state
        let newValue;
        if (aliceState === 'IDLE') {
            newValue = Math.sin(Date.now() / 1000) * 0.1;
        } else if (aliceState === 'SPEAKING') {
            newValue = (Math.random() - 0.5) * intensity;
        } else if (aliceState === 'LISTENING') {
            newValue = (Math.sin(Date.now() / 100) + Math.sin(Date.now() / 50)) * 0.2 * intensity;
        } else {
            newValue = (Math.random() - 0.5) * intensity;
        }
        
        this._waveformData[this._waveformData.length - 1] = newValue;

        // Clear and draw
        ctx.clearRect(0, 0, width, height);
        
        const barWidth = width / this._waveformData.length;
        const centerY = height / 2;
        
        ctx.fillStyle = CONFIG.visuals.primaryColor;
        ctx.shadowBlur = 10;
        ctx.shadowColor = CONFIG.visuals.primaryColor;

        for (let i = 0; i < this._waveformData.length; i++) {
            const barHeight = Math.abs(this._waveformData[i]) * height * 0.8;
            const x = i * barWidth;
            
            ctx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight);
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

        state.logActivity(`State changed: ${from} → ${to}`, 'info');
    }

    _getStateLabel(state) {
        const labels = {
            IDLE: 'Ready',
            LISTENING: 'Listening',
            PROCESSING: 'Processing',
            SPEAKING: 'Speaking',
            EXECUTING: 'Executing'
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

    // Public methods for state simulation (Part 2 will control this)
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
