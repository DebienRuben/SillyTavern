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

/**
 * Downloads an export of a project as a file.
 * @param {string} id Project ID
 * @param {string} format Export format (md, txt, docx, epub)
 * @param {{ sceneTitles?: boolean }} options Export options
 */
async function downloadExport(id, format, options) {
    const response = await fetch('/api/novel/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id, format, options }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new NovelApiError(response.status, data.error || response.statusText);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    const filename = encoded ? decodeURIComponent(encoded) : `novel.${format}`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
}

export const novelApi = {
    downloadExport,
    /** @param {{ title: string, author?: string, chapters: object[] }} manuscript */
    importProject: (manuscript) => call('import', manuscript),
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
    /** @param {string} id @returns {Promise<any>} Summary state with staleness per scene, chapter and the book */
    getSummaryState: (id) => call('summaries/state', { id }),
    /**
     * @param {string} id @param {'scene' | 'chapter' | 'book'} level @param {string | null} key
     * @param {string} text @param {string} sourceHash Hash of the source the summary was written from
     */
    saveSummary: (id, level, key, text, sourceHash) => call('summaries/save', { id, level, key, text, sourceHash }),
    /**
     * @param {string} id
     * @param {{ query: string, limit?: number, beforeSceneId?: string, excludeSceneIds?: string[], embedding?: { source: string, model?: string } }} options
     * @returns {Promise<import('./ai/ask-logic.js').Passage[]>}
     */
    search: (id, options) => call('search', { id, ...options }),
    /** @param {string} id @returns {Promise<any[]>} */
    listThreads: (id) => call('threads/list', { id }),
    /** @param {string} id @param {object} thread */
    saveThread: (id, thread) => call('threads/save', { id, thread }),
    /** @param {string} id @param {string} threadId */
    deleteThread: (id, threadId) => call('threads/delete', { id, threadId }),
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
