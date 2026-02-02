// ============================================
// API TIMEOUT UTILITY
// ============================================
// Wraps fetch calls with automatic timeout
// Default: 15 seconds for recommendations, 10 seconds for chat

/**
 * Fetch with timeout protection
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 15000)
 * @returns {Promise} Fetch promise with timeout
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    return Promise.race([
        fetch(url, {
            ...options,
            signal: AbortSignal.timeout(timeoutMs)
        }),
        new Promise((_, reject) =>
            setTimeout(() => {
                reject(new Error('Request timeout'));
            }, timeoutMs)
        )
    ]);
}

/**
 * Short timeout for chat (10 seconds)
 */
function fetchChat(url, options = {}) {
    return fetchWithTimeout(url, options, 10000);
}

/**
 * Medium timeout for recommendations (15 seconds)
 */
function fetchRecommendations(url, options = {}) {
    return fetchWithTimeout(url, options, 15000);
}

/**
 * Long timeout for analysis (20 seconds)
 */
function fetchAnalysis(url, options = {}) {
    return fetchWithTimeout(url, options, 20000);
}

// Export for use in client-side code
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        fetchWithTimeout,
        fetchChat,
        fetchRecommendations,
        fetchAnalysis
    };
}
