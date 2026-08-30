/**
 * ALICE Integrations Layer (Part 5)
 * ------------------------------------------------------------------
 * A provider-agnostic registry for external devices/APIs. A "provider"
 * exposes devices, each of which declares its capabilities. ALICE's IoT
 * skill talks to this layer only — never to a specific vendor SDK — so
 * real ecosystems (lights, sensors, displays) can be added as new providers
 * without changing the agent or the IoT skill.
 *
 * A bundled `mock` provider supplies virtual devices so the layer is
 * demonstrable and testable with zero hardware.
 *
 * Device interface:
 *   { id, name, type, provider, state }        — identity
 *   capability methods: on(), off(), setLevel(), getValue(), toggle()
 */
import { CONFIG } from './config.js';
import { state } from './state.js';

// Simple mock devices (virtual, no hardware, no network)
function createMockDevices() {
    return [
        {
            id: 'light-1', name: 'Desk Lamp', type: 'light',
            state: { on: false, level: 100 },
            on() { this.state.on = true; return { success: true, result: `${this.name} turned on` }; },
            off() { this.state.on = false; return { success: true, result: `${this.name} turned off` }; },
            setLevel(v) { this.state.level = Math.max(0, Math.min(100, v)); return { success: true, result: `${this.name} set to ${this.state.level}%` }; },
            toggle() { return this.state.on ? this.off() : this.on(); }
        },
        {
            id: 'light-2', name: 'Room Light', type: 'light',
            state: { on: false, level: 100 },
            on() { this.state.on = true; return { success: true, result: `${this.name} turned on` }; },
            off() { this.state.on = false; return { success: true, result: `${this.name} turned off` }; },
            setLevel(v) { this.state.level = Math.max(0, Math.min(100, v)); return { success: true, result: `${this.name} set to ${this.state.level}%` }; },
            toggle() { return this.state.on ? this.off() : this.on(); }
        },
        {
            id: 'sensor-1', name: 'Room Temperature', type: 'sensor',
            state: { value: 22.5, unit: '°C' },
            getValue() { return { success: true, result: `${this.name}: ${this.state.value}${this.state.unit}` }; }
        }
    ];
}

class IntegrationsRegistry {
    constructor() {
        this._providers = new Map();
        this._devices = new Map();

        // Register bundled providers
        this.registerProvider({
            name: 'mock',
            listDevices: () => createMockDevices()
        });

        // Load devices from providers
        this._refresh();
    }

    registerProvider(provider) {
        if (!provider || !provider.name || typeof provider.listDevices !== 'function') {
            state.logActivity('Rejected invalid integration provider', 'danger');
            return false;
        }
        this._providers.set(provider.name, provider);
        this._refresh();
        state.logActivity(`Integration provider registered: ${provider.name}`, 'info');
        return true;
    }

    getProviders() {
        return Array.from(this._providers.keys());
    }

    _refresh() {
        this._devices.clear();
        for (const provider of this._providers.values()) {
            try {
                const devices = provider.listDevices() || [];
                for (const d of devices) {
                    d.provider = provider.name;
                    this._devices.set(d.id, d);
                }
            } catch (e) {
                state.logActivity(`Provider "${provider.name}" failed: ${e.message}`, 'danger');
            }
        }
    }

    listDevices() {
        return Array.from(this._devices.values());
    }

    getDevice(id) {
        return this._devices.get(id);
    }

    findDevices(typeOrName) {
        const q = String(typeOrName || '').toLowerCase();
        return this.listDevices().filter(d =>
            d.type === q || d.name.toLowerCase().includes(q) || d.id.toLowerCase() === q
        );
    }

    /**
     * Invoke a capability method on a device. Returns a normalized result.
     */
    async invoke(deviceId, method, ...args) {
        const device = this._devices.get(deviceId);
        if (!device) {
            return { success: false, error: `Device "${deviceId}" not found` };
        }
        if (typeof device[method] !== 'function') {
            return { success: false, error: `Device "${device.name}" does not support "${method}"` };
        }
        try {
            const result = await device[method](...args);
            state.logActivity(`Device action: ${device.name}.${method}()`, 'info');
            return result;
        } catch (e) {
            return { success: false, error: e.message || 'device action failed' };
        }
    }
}

// Singleton instance
export const integrations = new IntegrationsRegistry();
