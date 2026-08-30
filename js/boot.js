/**
 * ALICE Boot Sequence Module
 * Cinematic system initialization
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { delay } from './utils.js';

class BootSequence {
    constructor() {
        this._bootItems = [
            { id: 'core', name: 'ALICE CORE', status: 'pending', icon: '◆' },
            { id: 'interface', name: 'Interface Systems', status: 'pending', icon: '◈' },
            { id: 'audio', name: 'Audio System', status: 'pending', icon: '◇' },
            { id: 'voice', name: 'Voice Recognition', status: 'pending', icon: '◉' },
            { id: 'tts', name: 'Speech Synthesis', status: 'pending', icon: '◎' },
            { id: 'memory', name: 'Memory System', status: 'pending', icon: '◐' },
            { id: 'skills', name: 'Skill Engine', status: 'pending', icon: '⬡' },
            { id: 'planner', name: 'Task Planner', status: 'pending', icon: '▣' },
            { id: 'agent', name: 'Agent Core', status: 'pending', icon: '◈' },
            { id: 'intelligence', name: 'Intelligence Engine', status: 'pending', icon: '◑' },
            { id: 'security', name: 'Security Protocols', status: 'pending', icon: '◔' },
            { id: 'network', name: 'Network Interface', status: 'pending', icon: '◕' }
        ];
        this._currentIndex = 0;
        this._isRunning = false;
    }

    get bootItems() {
        return this._bootItems;
    }

    async start(bootScreen) {
        if (this._isRunning) return;
        this._isRunning = true;
        
        state.set('isBooting', true);
        state.logActivity('Initiating boot sequence', 'info');

        const progressBar = bootScreen.querySelector('.boot-progress-fill');
        const statusText = bootScreen.querySelector('.boot-status-text');
        const itemsContainer = bootScreen.querySelector('.boot-items');

        // Reset state
        this._currentIndex = 0;
        this._bootItems.forEach(item => item.status = 'pending');
        state.set('bootItems', [...this._bootItems]);

        // Total animation duration
        const totalDuration = CONFIG.boot.sequenceDuration;
        const itemDuration = totalDuration / this._bootItems.length;

        // Animate progress bar
        let progress = 0;
        const progressInterval = setInterval(() => {
            progress += 100 / (totalDuration / CONFIG.boot.progressSpeed);
            if (progress > 98) progress = 98; // Save last 2% for completion
            if (progressBar) progressBar.style.width = `${progress}%`;
            state.set('bootProgress', progress);
        }, CONFIG.boot.progressSpeed);

        // Initialize each system
        for (let i = 0; i < this._bootItems.length; i++) {
            const item = this._bootItems[i];
            
            // Update status text
            if (statusText) {
                statusText.textContent = `Initializing ${item.name}...`;
            }

            // Animate item appearance
            if (itemsContainer) {
                const itemEl = itemsContainer.querySelector(`[data-item-id="${item.id}"]`);
                if (itemEl) {
                    itemEl.classList.add('initializing');
                    
                    // Simulate initialization work
                    await delay(itemDuration * 0.6);
                    
                    itemEl.classList.remove('initializing');
                    itemEl.classList.add('complete');
                    item.status = 'complete';
                    
                    // Update status text in item
                    const statusEl = itemEl.querySelector('.boot-item-status');
                    if (statusEl) {
                        statusEl.textContent = 'Online';
                    }
                    
                    // Flash animation
                    const iconEl = itemEl.querySelector('.boot-item-icon');
                    if (iconEl) {
                        iconEl.classList.add('flash');
                        setTimeout(() => iconEl.classList.remove('flash'), 300);
                    }
                }
            }

            this._currentIndex = i + 1;
            state.set('bootItems', [...this._bootItems]);
            
            // Small delay between items
            await delay(itemDuration * 0.4);
        }

        // Complete progress bar
        clearInterval(progressInterval);
        if (progressBar) {
            progressBar.style.width = '100%';
        }
        
        // Update final status
        if (statusText) {
            statusText.textContent = 'All systems online';
            statusText.classList.add('complete');
        }

        // Show completion message
        await delay(800);

        state.logActivity('Boot sequence completed successfully', 'success');
        
        return true;
    }

    reset() {
        this._isRunning = false;
        this._currentIndex = 0;
        this._bootItems.forEach(item => item.status = 'pending');
    }
}

// Singleton instance
export const bootSequence = new BootSequence();
