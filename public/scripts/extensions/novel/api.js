import { getRequestHeaders } from '../../../script.js';

/**
 * Error returned by the novel API, with the HTTP status.
 */
export class NovelApiError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} message Error message
     */
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * Calls a novel API endpoint.
 * @param {string} endpoint Endpoint path under /api/novel
 * @param {object} [body] Request body
 * @param {{ keepalive?: boolean }} [options] Fetch options
 * @returns {Promise<any>}
 */
async function call(endpoint, body = {}, { keepalive = false } = {}) {
    const response = await fetch(`/api/novel/${endpoint}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        keepalive,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new NovelApiError(response.status, data.error || response.statusText);
    }
    return data;
}

export const novelApi = {
    /** @returns {Promise<any[]>} */
    listProjects: () => call('list'),
    /** @param {object} fields */
    createProject: (fields) => call('create', fields),
    /** @param {string} id */
    getProject: (id) => call('get', { id }),
    /** @param {string} id @param {object} fields */
    updateProject: (id, fields) => call('update', { id, fields }),
    /** @param {string} id */
    deleteProject: (id) => call('delete', { id }),
    /** @param {string} id @param {object} structure @param {{ keepalive?: boolean }} [options] */
    saveStructure: (id, structure, options) => call('structure/save', { id, structure }, options),
    /** @param {string} id @param {string} sceneId @returns {Promise<{content: string, hash: string}>} */
    getScene: (id, sceneId) => call('scene/get', { id, sceneId }),
    /**
     * @param {string} id @param {string} sceneId @param {string} content @param {string} baseHash
     * @param {{ keepalive?: boolean }} [options]
     * @returns {Promise<{hash: string, wordCount: number}>}
     */
    saveScene: (id, sceneId, content, baseHash, options) => call('scene/save', { id, sceneId, content, baseHash }, options),
    /**
     * @param {string} id @param {string} sceneId @param {number} maxChars
     * @returns {Promise<{scenes: import('./ai/prompt.js').PrecedingScene[], hasMore: boolean}>}
     */
    getPrecedingScenes: (id, sceneId, maxChars) => call('scenes/preceding', { id, sceneId, maxChars }),
    /** @param {string} id @param {string} sceneId @param {string} oid @returns {Promise<{content: string}>} */
    getSceneVersion: (id, sceneId, oid) => call('scene/version', { id, sceneId, oid }),
    /**
     * @param {string} id @param {string} message
     * @param {{ keepalive?: boolean }} [options]
     * @returns {Promise<{oid: string|null}>}
     */
    snapshot: (id, message, options) => call('snapshot', { id, message }, options),
    /** @param {string} id @returns {Promise<any[]>} */
    listCodex: (id) => call('codex/list', { id }),
    /** @param {string} id @param {object} entity */
    saveEntity: (id, entity) => call('codex/save', { id, entity }),
    /** @param {string} id @param {string} entityId */
    deleteEntity: (id, entityId) => call('codex/delete', { id, entityId }),
    /** @param {string} id @returns {Promise<any[]>} */
    listSuggestions: (id) => call('suggestions/list', { id }),
    /** @param {string} id @param {string} sceneId @param {object[]} items @returns {Promise<any[]>} */
    replaceSuggestions: (id, sceneId, items) => call('suggestions/replace', { id, sceneId, items }),
    /**
     * @param {string} id @param {string} suggestionId @param {'accept' | 'reject'} action @param {object} [edits]
     * @returns {Promise<{entity: any | null}>}
     */
    resolveSuggestion: (id, suggestionId, action, edits) => call('suggestions/resolve', { id, suggestionId, action, edits }),
    /** @param {string} id @param {string} [sceneId] @returns {Promise<{oid: string, message: string, timestamp: number}[]>} */
    getHistory: (id, sceneId) => call('history', { id, sceneId }),
};
