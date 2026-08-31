/**
 * ALICE Tool & Skill Discovery (Phase 6.2)
 * ------------------------------------------------------------------
 * Provides safe metadata describing available skills for AI context.
 *
 * Security guarantees:
 *   - NEVER exposes internal executable functions (`execute`, `onError`)
 *   - NEVER exposes regular expressions or raw internal pattern arrays
 *   - NEVER exposes secrets, system tokens, or internal credentials
 *   - Accurately reports risk level and confirmation requirements
 */
import { skillManager } from '../skillManager.js';

class ToolDiscovery {
    /**
     * Get safe tool definitions for model context.
     * @param {Object} options
     * @param {boolean} [options.includeDisabled=false] - Whether to include disabled skills
     * @returns {Array<Object>} List of safe tool descriptors
     */
    getToolDefinitions({ includeDisabled = false } = {}) {
        const skills = includeDisabled
            ? skillManager.getSkills()
            : skillManager.getEnabledSkills();

        const tools = skills.map(skill => this._formatSkillDescriptor(skill));

        // Include built-in core tool for internal multi-step operations (e.g. summarization)
        tools.push(this._getCoreToolDescriptor());

        return tools;
    }

    /**
     * Get a safe descriptor for a single skill by name.
     * @param {string} name
     * @returns {Object|null}
     */
    getTool(name) {
        if (name === 'core') {
            return this._getCoreToolDescriptor();
        }

        const skill = skillManager.getSkill(name);
        if (!skill) return null;

        return this._formatSkillDescriptor(skill);
    }

    /**
     * Check if a tool is known and safe.
     * @param {string} name
     * @returns {boolean}
     */
    hasTool(name) {
        return name === 'core' || skillManager.hasSkill(name);
    }

    /**
     * Check if a tool is currently enabled.
     * @param {string} name
     * @returns {boolean}
     */
    isToolEnabled(name) {
        if (name === 'core') return true;
        return skillManager.hasSkill(name) && skillManager.isEnabled(name);
    }

    /**
     * Format available tools into a compact text summary for prompt context.
     * @param {Object} [options]
     * @returns {string}
     */
    formatToolsForPrompt(options = {}) {
        const tools = this.getToolDefinitions(options);
        return tools.map(t => {
            const inputsStr = t.inputs.map(i => `${i.name} (${i.type}): ${i.description}`).join(', ');
            return `- ${t.name}: ${t.description} [Inputs: ${inputsStr || 'text'}] [Risk: ${t.risk}]${t.requiresConfirmation ? ' [Requires User Confirmation]' : ''}`;
        }).join('\n');
    }

    // ------------------------------------------------------------------
    // Safe formatting helpers (strips all executable/private properties)
    // ------------------------------------------------------------------

    _formatSkillDescriptor(skill) {
        const isEnabled = skillManager.isEnabled(skill.name);
        const requiresConfirmation = skill.risk === 'sensitive' ||
            (Array.isArray(skill.sensitiveActions) && skill.sensitiveActions.length > 0);

        // Normalize inputs declaration safely
        const inputs = Array.isArray(skill.inputs)
            ? skill.inputs.map(inp => ({
                name: typeof inp === 'string' ? inp : String(inp.name || 'input'),
                type: typeof inp === 'object' && inp.type ? String(inp.type) : 'string',
                description: typeof inp === 'object' && inp.description ? String(inp.description) : 'Input parameter'
            }))
            : [{ name: 'input', type: 'string', description: 'Input text command or query for the skill' }];

        return {
            name: String(skill.name),
            description: String(skill.description || ''),
            inputs,
            risk: skill.risk || 'safe',
            requiresConfirmation,
            enabled: isEnabled
        };
    }

    _getCoreToolDescriptor() {
        return {
            name: 'core',
            description: 'Internal core processing operations such as text summarization',
            inputs: [
                {
                    name: 'operation',
                    type: 'string',
                    description: 'Supported core operation ("summarize")'
                },
                {
                    name: 'inputSource',
                    type: 'string',
                    description: 'Blackboard key containing source text to process'
                }
            ],
            risk: 'safe',
            requiresConfirmation: false,
            enabled: true
        };
    }
}

// Singleton instance
export const toolDiscovery = new ToolDiscovery();
