/**
 * Browser Assistance Skill (Part 5)
 * ------------------------------------------------------------------
 * Where technically and safely possible in a sandboxed browser:
 *   - open a website (requires confirmation — navigation away from ALICE)
 *   - read the *current* page's visible text and title
 *   - search the current page for a term
 *
 * Full multi-tab automation (clicking through arbitrary sites) is NOT
 * possible from a client-side page without a browser extension and would
 * exceed the "no unrestricted system access" rule, so it is intentionally
 * scoped to the safe, confirmable subset above. A dedicated companion
 * extension is the documented extension path (see manifest.permissions).
 */
import { state } from '../state.js';
import { permissions } from '../permissions.js';

export const browserSkill = {
    name: 'browser',
    description: 'Opens websites and reads visible page information',
    risk: 'medium',
    permissions: ['browser.navigate', 'browser.read-page'],
    inputs: [
        { name: 'url', type: 'string', description: 'Website to open' }
    ],
    actions: ['open', 'read', 'search-page'],
    patterns: [
        /open\s+(?:the\s+)?(?:website|site|webpage|page|url)\s+(?:for\s+)?/i,
        /open\s+https?:\/\//i,
        /(?:go\s+to|visit|navigate\s+to)\s+(?:the\s+)?(?:website|site|page)?\s*/i,
        /read\s+(?:the\s+)?(?:current\s+)?(?:page|webpage|website|screen)/i,
        /what\s+(?:is|does)\s+(?:this|the)\s+(?:page|site|webpage)\s+(?:say|contain|show)/i,
        /search\s+(?:the\s+|this\s+)?page\s+for\s+/i
    ],

    async execute(input, context = {}) {
        const text = input.toLowerCase();

        if (text.includes('read') || /what\s+(?:is|does)\s+(?:this|the)\s+(?:page|site)/i.test(text)) {
            return this._readPage();
        }

        if (text.includes('search') && text.includes('page')) {
            return this._searchPage(input);
        }

        return this._openSite(input);
    },

    /**
     * Open a website in a new tab. Requires explicit confirmation because it
     * navigates away from ALICE.
     */
    async _openSite(input) {
        let url = (input.match(/https?:\/\/[^\s]+/) || [null])[0];
        if (!url) {
            const m = input.replace(/open\s+(?:the\s+)?(?:website|site|webpage|page|url)\s+(?:for\s+)?/i, '')
                .replace(/go\s+to\s+(?:the\s+)?(?:website|site|page)?/i, '')
                .replace(/visit\s+(?:the\s+)?(?:website|site|page)?/i, '')
                .replace(/navigate\s+to\s+(?:the\s+)?(?:website|site|page)?/i, '')
                .trim();
            if (!m) return { success: false, error: 'Which website would you like me to open?' };
            url = m;
        }

        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const displayHost = url.replace(/^https?:\/\//i, '');

        const approved = await permissions.requestConfirmation({
            title: 'Open website',
            message: `This will open "${displayHost}" in a new tab.`,
            action: `Open ${url}`
        });

        if (!approved) {
            return { success: false, error: 'Cancelled — no website was opened.' };
        }

        window.open(url, '_blank', 'noopener');
        state.logActivity(`Opened website: ${displayHost}`, 'success');
        return {
            success: true,
            result: `Opened "${displayHost}" in a new tab.`
        };
    },

    /**
     * Read the visible text of the current page.
     */
    _readPage() {
        const title = document.title || 'Untitled page';
        // Best-effort visible text extraction
        const bodyText = (document.body && document.body.innerText
            ? document.body.innerText
            : '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 800);

        if (!bodyText) {
            return {
                success: false,
                error: "I can't see any visible text on this page."
            };
        }

        return {
            success: true,
            result: `Page title: "${title}". Visible text: ${bodyText}${document.body.innerText.length > 800 ? '…' : ''}`
        };
    },

    /**
     * Search the current page text for a term.
     */
    _searchPage(input) {
        const term = input.replace(/search\s+(?:the\s+|this\s+)?page\s+for\s+/i, '').trim();
        if (!term) return { success: false, error: 'What would you like me to search for on this page?' };

        const bodyText = (document.body && document.body.innerText ? document.body.innerText : '');
        const lower = bodyText.toLowerCase();
        const idx = lower.indexOf(term.toLowerCase());

        if (idx === -1) {
            return { success: true, result: `I didn't find "${term}" on this page.` };
        }

        const context = bodyText.substring(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, ' ').trim();
        return {
            success: true,
            result: `Found "${term}" on this page: "...${context}..."`
        };
    },

    onError(input, result) {
        return {
            success: false,
            error: `${result.error || 'Browser action failed'}. Opening sites requires confirmation, and reading is limited to the current tab.`
        };
    }
};
