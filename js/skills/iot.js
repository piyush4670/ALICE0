/**
 * IoT / External Devices Skill (Part 5)
 * ------------------------------------------------------------------
 * Talks to the provider-agnostic Integrations Layer (integrations.js),
 * never to a specific hardware vendor. Lists devices, reads sensor values,
 * and controls lights.
 *
 * Permission enforcement is centralized: this skill declares itself
 * risk 'sensitive' and lists its read-only dispatches as safeActions, so
 * the permission gateway (skillManager.executeByName → permissions.gate)
 * confirms control operations (on/off/set) and lets reads through. The
 * skill itself never prompts.
 */
import { state } from '../state.js';
import { integrations } from '../integrations.js';

export const iot = {
    name: 'iot',
    description: 'Controls connected smart devices (lights, sensors, displays)',
    risk: 'sensitive',
    permissions: ['iot.control', 'iot.read'],
    inputs: [
        { name: 'device', type: 'string', description: 'Device to act on' }
    ],
    actions: ['list', 'read', 'on', 'off', 'set'],
    // Read-only exemptions from the sensitive-skill default: listing
    // devices / reading sensors does not act on the outside world.
    safeActions: [
        { pattern: /list|show|what\s+(?:devices|lights|sensors)/i, reason: 'lists connected devices' },
        { pattern: /read|check|temperature|reading/i, reason: 'reads a sensor value' }
    ],
    patterns: [
        /(?:list|show)\s+(?:my\s+)?(?:devices|smart\s+devices|lights|sensors)/i,
        /what\s+(?:devices|lights|sensors)\s+(?:do\s+i|are\s+there|are\s+available)/i,
        /turn\s+(?:on|off)\s+(?:the\s+)?/i,
        /switch\s+(?:on|off)\s+(?:the\s+)?/i,
        /(?:read|check)\s+(?:the\s+)?(?:sensor|temperature|reading)/i,
        /set\s+(?:the\s+)?(?:light|brightness)\s+(?:to\s+)?/i,
        /\biot\b/i,
        /\bsmart\s+home\b/i
    ],

    async execute(input, context = {}) {
        const text = input.toLowerCase();

        if (/list|show|what\s+(?:devices|lights|sensors)/i.test(text)) {
            return this._list();
        }

        if (/read|check|temperature|reading/i.test(text)) {
            return this._readSensor(text);
        }

        if (/set\s+(?:the\s+)?(?:light|brightness)/i.test(text)) {
            return this._setLevel(text);
        }

        // turn on / off
        const off = /turn\s+off|switch\s+off|\boff\b/.test(text) && !/turn\s+on/.test(text);
        return this._toggle(text, off);
    },

    _list() {
        const devices = integrations.listDevices();
        if (!devices.length) {
            return { success: true, result: 'No devices are connected yet. The integration layer is ready for providers.' };
        }
        const lines = devices.map(d => {
            if (d.type === 'light') return `${d.name} (light) — ${d.state.on ? 'on' : 'off'}`;
            if (d.type === 'sensor') return `${d.name} (sensor) — ${d.state.value}${d.state.unit || ''}`;
            return `${d.name} (${d.type})`;
        });
        return { success: true, result: `Connected devices:\n${lines.join('\n')}`, devices };
    },

    _readSensor(input) {
        const sensors = integrations.findDevices('sensor');
        const match = sensors.find(s => input.includes(s.name.toLowerCase())) || sensors[0];
        if (!match) return { success: true, result: 'No sensors are connected.' };
        return integrations.invoke(match.id, 'getValue');
    },

    _setLevel(input) {
        const levelMatch = input.match(/(\d{1,3})\s*(?:%|percent)?/);
        if (!levelMatch) return { success: false, error: 'What brightness level (e.g. 50%)?' };
        const level = parseInt(levelMatch[1], 10);

        const lights = integrations.findDevices('light');
        const target = lights.find(l => input.includes(l.name.toLowerCase())) || lights[0];
        if (!target) return { success: true, result: 'No lights are connected.' };

        return integrations.invoke(target.id, 'setLevel', level);
    },

    _toggle(input, off) {
        const lights = integrations.findDevices('light');
        const target = lights.find(l => input.includes(l.name.toLowerCase())) || lights[0];
        if (!target) return { success: true, result: 'No lights are connected.' };

        return integrations.invoke(target.id, off ? 'off' : 'on');
    },

    onError(input, result) {
        return {
            success: false,
            error: `${result.error || 'Device action failed'}. Use "list my devices" to see what is connected.`
        };
    }
};
