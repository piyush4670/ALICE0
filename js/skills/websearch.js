/**
 * Web Search Skill
 * Handles web search queries using free APIs
 */
import { state } from '../state.js';

export const websearch = {
    name: 'websearch',
    description: 'Searches the web for information',
    patterns: [
        /search\s+(?:the\s+)?web\s+(?:for\s+)?/i,
        /search\s+for\s+/i,
        /look\s+up\s+/i,
        /google\s+/i,
        /what\s+is\s+(?:a\s+)?/i,
        /who\s+is\s+/i,
        /where\s+is\s+/i,
        /when\s+(?:was|did|do)/i,
        /why\s+(?:is|do|are)/i,
        /how\s+(?:do|does|to|can)/i,
        /latest\s+(?:news|info|information)/i
    ],

    /**
     * Execute a web search
     */
    async execute(input) {
        const text = input.toLowerCase();
        
        // Extract search query
        let query = text
            .replace(/search\s+(?:the\s+)?web\s+(?:for\s+)?/i, '')
            .replace(/search\s+for\s+/i, '')
            .replace(/look\s+up\s+/i, '')
            .replace(/google\s+/i, '')
            .replace(/what\s+is\s+(?:a\s+)?/i, '')
            .replace(/who\s+is\s+/i, '')
            .replace(/where\s+is\s+/i, '')
            .replace(/when\s+(?:was|did|do)/i, '')
            .replace(/why\s+(?:is|do|are)/i, '')
            .replace(/how\s+(?:do|does|to|can)/i, '')
            .replace(/latest\s+(?:news|info|information)\s+/i, '')
            .trim();

        if (!query || query.length < 2) {
            return {
                success: false,
                error: 'No search query found'
            };
        }

        state.logActivity(`Searching web for: "${query}"`, 'info');

        try {
            // Use DuckDuckGo Instant Answer API (free, no API key)
            const response = await fetch(
                `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
            );

            if (!response.ok) {
                throw new Error('Search request failed');
            }

            const data = await response.json();

            // Extract relevant answer
            if (data.AbstractText) {
                return {
                    success: true,
                    result: data.AbstractText,
                    source: data.AbstractURL || 'DuckDuckGo',
                    topic: data.Heading || query
                };
            }

            if (data.Answer) {
                return {
                    success: true,
                    result: data.Answer,
                    source: data.AnswerType || 'DuckDuckGo'
                };
            }

            // Check related topics
            if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                const firstResult = data.RelatedTopics.find(t => t.Text);
                if (firstResult) {
                    // Clean HTML from text
                    const cleanText = firstResult.Text.replace(/<[^>]*>/g, '');
                    return {
                        success: true,
                        result: cleanText,
                        source: 'DuckDuckGo'
                    };
                }
            }

            // Fallback to Wikipedia if available
            if (data.Results && data.Results.length > 0) {
                return {
                    success: true,
                    result: `I found some results for "${query}". Here's one: ${data.Results[0].Text || data.Results[0].FirstURL}`,
                    source: 'DuckDuckGo'
                };
            }

            // Try to extract from Definition
            if (data.Definition) {
                return {
                    success: true,
                    result: data.Definition,
                    source: data.DefinitionSource || 'Dictionary'
                };
            }

            // No results found
            return {
                success: false,
                error: `I couldn't find specific information about "${query}". Would you like me to try a different search?`,
                query: query
            };

        } catch (e) {
            state.logActivity(`Search error: ${e.message}`, 'warning');
            
            // Fallback: provide search instructions
            return {
                success: false,
                error: `I couldn't complete the web search right now. You can search for "${query}" manually at google.com or duckduckgo.com.`,
                query: query
            };
        }
    },

    /**
     * Check if query is a simple factual question
     */
    isFactualQuery(text) {
        const factualPatterns = [
            /^(?:what|who|where|when|why|how)\s/i,
            /^(?:define|definition|meaning of)/i
        ];
        return factualPatterns.some(p => p.test(text.trim()));
    }
};
