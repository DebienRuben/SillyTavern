import fs from 'node:fs';
import path from 'node:path';

import {
    ID_PATTERN,
    NovelError,
    assertId,
    newId,
    projectPaths,
    readJson,
    readProjectFiles,
    text,
    withLock,
    writeJson,
} from './store.js';

export const ENTITY_TYPES = Object.freeze(['character', 'location', 'item', 'faction', 'lore']);

/** Facets of an entity that can change during the story. */
export const STATE_FIELDS = Object.freeze(['location', 'condition', 'goals', 'relationships', 'possessions', 'knowledge']);

export const THREAD_STATUSES = Object.freeze(['open', 'resolved']);

const FORMAT_VERSION = 1;
const MAX_ALIASES = 20;
const MAX_SUGGESTIONS = 500;
const MAX_THREAD_NOTES = 200;
const LIMITS = Object.freeze({
    title: 200,
    note: 2000,
    name: 200,
    alias: 100,
    description: 20000,
    state: 2000,
    evidence: 1000,
});

/**
 * Coerces a list of aliases: trimmed, unique (case-insensitive), not equal to the name.
 * @param {unknown} aliases Aliases from the client
 * @param {string} name Entity name
 * @returns {string[]}
 */
function normalizeAliases(aliases, name) {
    const seen = new Set([name.trim().toLowerCase()]);
    const result = [];
    for (const alias of Array.isArray(aliases) ? aliases : []) {
        const value = text(alias, LIMITS.alias).trim();
        if (value && !seen.has(value.toLowerCase())) {
            seen.add(value.toLowerCase());
            result.push(value);
        }
    }
    return result.slice(0, MAX_ALIASES);
}

/**
 * Picks the non-empty state fields from an object.
 * @param {any} input Object with state fields
 * @returns {Record<string, string>}
 */
function pickStateChanges(input) {
    /** @type {Record<string, string>} */
    const changes = {};
    for (const field of STATE_FIELDS) {
        const value = text(input?.[field], LIMITS.state).trim();
        if (value) {
            changes[field] = value;
        }
    }
    return changes;
}

/**
 * Validates an entity from the client.
 * @param {any} input Entity from the client
 * @param {any} [previous] Stored entity, when updating
 * @returns {object} Normalized entity
 */
function normalizeEntity(input, previous) {
    const name = text(input?.name, LIMITS.name).trim();
    if (!name) {
        throw new NovelError(400, 'A codex entry needs a name');
    }
    const now = Date.now();

    const stateByScene = new Map();
    for (const entry of Array.isArray(input.state) ? input.state : []) {
        if (typeof entry?.sceneId !== 'string' || !ID_PATTERN.test(entry.sceneId)) {
            continue;
        }
        const changes = pickStateChanges(entry);
        if (Object.keys(changes).length > 0) {
            stateByScene.set(entry.sceneId, { sceneId: entry.sceneId, ...changes, updatedAt: Number(entry.updatedAt) || now });
        }
    }

    return {
        version: FORMAT_VERSION,
        id: previous?.id ?? newId('ent'),
        type: ENTITY_TYPES.includes(input.type) ? input.type : 'character',
        name,
        aliases: normalizeAliases(input.aliases, name),
        description: text(input.description, LIMITS.description),
        notes: text(input.notes, LIMITS.description),
        state: [...stateByScene.values()],
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    };
}

/**
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @param {string} entityId Entity ID
 */
function entityPath(paths, entityId) {
    return path.join(paths.codex, `${assertId(entityId, 'codex entry ID')}.json`);
}

/**
 * Reads all entities of a project.
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @returns {any[]}
 */
function readEntities(paths) {
    if (!fs.existsSync(paths.codex)) {
        return [];
    }
    return fs.readdirSync(paths.codex)
        .filter(file => file.endsWith('.json') && ID_PATTERN.test(path.parse(file).name))
        .map(file => readJson(path.join(paths.codex, file)))
        .filter(Boolean);
}

/**
 * Finds an entity whose name or alias matches a name, ignoring case.
 * @param {any[]} entities Entities to search
 * @param {string} name Name to look for
 * @param {string} [exceptId] Entity to ignore
 */
function findByName(entities, name, exceptId) {
    const needle = name.trim().toLowerCase();
    return entities.find(entity => entity.id !== exceptId
        && [entity.name, ...entity.aliases].some(n => n.toLowerCase() === needle));
}

/**
 * Lists the codex of a project, sorted by type and name.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function listEntities(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    return readEntities(paths).sort((a, b) =>
        ENTITY_TYPES.indexOf(a.type) - ENTITY_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));
}

/**
 * Creates or updates a codex entry.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {any} input Entity from the client; without an ID a new entry is created
 */
export async function saveEntity(directories, projectId, input) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const entities = readEntities(paths);
        let previous;
        if (input?.id) {
            previous = readJson(entityPath(paths, input.id));
            if (!previous) {
                throw new NovelError(404, 'Codex entry not found');
            }
        }
        const entity = normalizeEntity(input, previous);
        const clash = findByName(entities, entity.name, entity.id);
        if (clash) {
            throw new NovelError(409, `"${clash.name}" already uses this name`);
        }
        fs.mkdirSync(paths.codex, { recursive: true });
        writeJson(entityPath(paths, entity.id), entity);
        return entity;
    });
}

/**
 * Deletes a codex entry and its pending suggestions.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} entityId Entity ID
 */
export async function deleteEntity(directories, projectId, entityId) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const filePath = entityPath(paths, entityId);
        if (!fs.existsSync(filePath)) {
            throw new NovelError(404, 'Codex entry not found');
        }
        fs.rmSync(filePath);
        const suggestions = readSuggestions(paths);
        suggestions.items = suggestions.items.filter((/** @type {any} */ item) => item.entityId !== entityId);
        writeJson(paths.suggestions, suggestions);
    });
}

/**
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @returns {{ version: number, items: any[] }}
 */
function readSuggestions(paths) {
    const data = readJson(paths.suggestions);
    return { version: FORMAT_VERSION, items: Array.isArray(data?.items) ? data.items : [] };
}

/**
 * Validates a suggestion from the client.
 * @param {any} input Suggestion from the client
 * @param {string} sceneId Scene the suggestion comes from
 * @param {any[]} entities Existing entities
 * @param {any[]} threads Existing plot threads
 * @returns {object | null} Normalized suggestion, or null if it is unusable
 */
function normalizeSuggestion(input, sceneId, entities, threads) {
    const changes = pickStateChanges(input?.changes);
    const evidence = text(input?.evidence, LIMITS.evidence).trim();

    if (input?.kind === 'update') {
        if (!entities.some(entity => entity.id === input.entityId) || Object.keys(changes).length === 0) {
            return null;
        }
        return { id: newId('sug'), kind: 'update', sceneId, entityId: input.entityId, changes, evidence, createdAt: Date.now() };
    }
    if (input?.kind === 'thread-open') {
        const title = text(input.thread?.title, LIMITS.title).trim();
        if (!title || findThreadByTitle(threads, title)) {
            return null;
        }
        return {
            id: newId('sug'),
            kind: 'thread-open',
            sceneId,
            thread: { title, description: text(input.thread.description, LIMITS.description).trim() },
            evidence,
            createdAt: Date.now(),
        };
    }
    if (input?.kind === 'thread-update') {
        const note = text(input.note, LIMITS.note).trim();
        const status = THREAD_STATUSES.includes(input.status) ? input.status : 'open';
        const thread = threads.find(t => t.id === input.threadId);
        if (!thread || (!note && status === thread.status)) {
            return null;
        }
        return { id: newId('sug'), kind: 'thread-update', sceneId, threadId: thread.id, status, note, evidence, createdAt: Date.now() };
    }
    if (input?.kind === 'create') {
        const name = text(input.entity?.name, LIMITS.name).trim();
        if (!name || findByName(entities, name)) {
            return null;
        }
        return {
            id: newId('sug'),
            kind: 'create',
            sceneId,
            entity: {
                type: ENTITY_TYPES.includes(input.entity.type) ? input.entity.type : 'character',
                name,
                aliases: normalizeAliases(input.entity.aliases, name),
                description: text(input.entity.description, LIMITS.description),
            },
            changes,
            evidence,
            createdAt: Date.now(),
        };
    }
    return null;
}

/**
 * Lists pending codex suggestions.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function listSuggestions(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    return readSuggestions(paths).items;
}

/**
 * Replaces the pending suggestions for a scene, e.g. after analyzing it again.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} sceneId Scene the suggestions come from
 * @param {unknown} items Suggestions from the client
 */
export async function replaceSceneSuggestions(directories, projectId, sceneId, items) {
    assertId(sceneId, 'scene ID');
    if (!Array.isArray(items)) {
        throw new NovelError(400, 'Invalid suggestions');
    }
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const entities = readEntities(paths);
        const threads = readThreads(paths).items;
        const suggestions = readSuggestions(paths);
        const fresh = items.map(item => normalizeSuggestion(item, sceneId, entities, threads)).filter(Boolean);
        suggestions.items = [...suggestions.items.filter(item => item.sceneId !== sceneId), ...fresh].slice(-MAX_SUGGESTIONS);
        writeJson(paths.suggestions, suggestions);
        return suggestions.items;
    });
}

/**
 * Accepts or rejects a suggestion. Accepting merges the changes into the entity's
 * state for the suggestion's scene, or creates the suggested entity.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} suggestionId Suggestion ID
 * @param {'accept' | 'reject'} action What to do
 * @param {any} [edits] Author's edits to the suggestion ({ changes, entity })
 * @returns {Promise<{ entity: any | null, thread?: any | null }>} The created or updated entity or thread when accepted
 */
export async function resolveSuggestion(directories, projectId, suggestionId, action, edits) {
    if (action !== 'accept' && action !== 'reject') {
        throw new NovelError(400, 'Invalid action');
    }
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const suggestions = readSuggestions(paths);
        const suggestion = suggestions.items.find(item => item.id === suggestionId);
        if (!suggestion) {
            throw new NovelError(404, 'Suggestion not found');
        }

        let entity = null;
        let thread = null;
        if (action === 'accept' && suggestion.kind.startsWith('thread-')) {
            thread = acceptThreadSuggestion(paths, suggestion, edits);
        } else if (action === 'accept') {
            const entities = readEntities(paths);
            const changes = edits?.changes ? pickStateChanges(edits.changes) : suggestion.changes;
            const now = Date.now();

            if (suggestion.kind === 'update') {
                entity = entities.find(e => e.id === suggestion.entityId);
                if (!entity) {
                    throw new NovelError(404, 'The codex entry of this suggestion no longer exists');
                }
            } else {
                const proposed = { ...suggestion.entity, ...(edits?.entity ?? {}) };
                const name = text(proposed.name, LIMITS.name).trim();
                const clash = name && findByName(entities, name);
                if (clash) {
                    throw new NovelError(409, `"${clash.name}" already exists in the codex`);
                }
                entity = normalizeEntity({ ...proposed, state: [] });
            }

            if (Object.keys(changes).length > 0) {
                const existing = entity.state.find((/** @type {any} */ entry) => entry.sceneId === suggestion.sceneId);
                if (existing) {
                    Object.assign(existing, changes, { updatedAt: now });
                } else {
                    entity.state.push({ sceneId: suggestion.sceneId, ...changes, updatedAt: now });
                }
            }
            entity.updatedAt = now;
            fs.mkdirSync(paths.codex, { recursive: true });
            writeJson(entityPath(paths, entity.id), entity);
        }

        suggestions.items = suggestions.items.filter(item => item.id !== suggestionId);
        writeJson(paths.suggestions, suggestions);
        return { entity, thread };
    });
}

// ---- Plot threads ----

/**
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @returns {{ version: number, items: any[] }}
 */
function readThreads(paths) {
    const data = readJson(paths.threads);
    return { version: FORMAT_VERSION, items: Array.isArray(data?.items) ? data.items : [] };
}

/**
 * @param {any[]} threads
 * @param {string} title
 * @param {string} [exceptId]
 */
function findThreadByTitle(threads, title, exceptId) {
    const needle = title.trim().toLowerCase();
    return threads.find(thread => thread.id !== exceptId && thread.title.toLowerCase() === needle);
}

/**
 * Validates a plot thread from the client.
 * @param {any} input Thread from the client
 * @param {any} [previous] Stored thread, when updating
 */
function normalizeThread(input, previous) {
    const title = text(input?.title, LIMITS.title).trim();
    if (!title) {
        throw new NovelError(400, 'A plot thread needs a title');
    }
    const sceneIdOrNull = (/** @type {unknown} */ id) => typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
    const status = THREAD_STATUSES.includes(input.status) ? input.status : 'open';
    const now = Date.now();
    return {
        id: previous?.id ?? newId('thr'),
        title,
        description: text(input.description, LIMITS.description).trim(),
        status,
        openedIn: sceneIdOrNull(input.openedIn),
        resolvedIn: status === 'resolved' ? sceneIdOrNull(input.resolvedIn) : null,
        notes: (Array.isArray(input.notes) ? input.notes : [])
            .map((/** @type {any} */ note) => ({ sceneId: sceneIdOrNull(note?.sceneId), text: text(note?.text, LIMITS.note).trim() }))
            .filter((/** @type {any} */ note) => note.text)
            .slice(-MAX_THREAD_NOTES),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    };
}

/**
 * Applies an accepted thread suggestion. Must be called while holding the project lock.
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @param {any} suggestion Thread suggestion
 * @param {any} [edits] Author's edits ({ thread } or { status, note })
 */
function acceptThreadSuggestion(paths, suggestion, edits) {
    const threads = readThreads(paths);
    let thread;
    if (suggestion.kind === 'thread-open') {
        const proposed = { ...suggestion.thread, ...(edits?.thread ?? {}) };
        const clash = findThreadByTitle(threads.items, text(proposed.title, LIMITS.title));
        if (clash) {
            throw new NovelError(409, `A plot thread called "${clash.title}" already exists`);
        }
        thread = normalizeThread({ ...proposed, status: 'open', openedIn: suggestion.sceneId, notes: [] });
        threads.items.push(thread);
    } else {
        thread = threads.items.find(t => t.id === suggestion.threadId);
        if (!thread) {
            throw new NovelError(404, 'The plot thread of this suggestion no longer exists');
        }
        const status = THREAD_STATUSES.includes(edits?.status) ? edits.status : suggestion.status;
        const note = text(edits?.note ?? suggestion.note, LIMITS.note).trim();
        if (note) {
            thread.notes = [...thread.notes, { sceneId: suggestion.sceneId, text: note }].slice(-MAX_THREAD_NOTES);
        }
        thread.status = status;
        thread.resolvedIn = status === 'resolved' ? suggestion.sceneId : null;
        thread.updatedAt = Date.now();
    }
    writeJson(paths.threads, threads);
    return thread;
}

/**
 * Lists the plot threads of a project.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function listThreads(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    return readThreads(paths).items;
}

/**
 * Creates or updates a plot thread.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {any} input Thread from the client; without an ID a new thread is created
 */
export async function saveThread(directories, projectId, input) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const threads = readThreads(paths);
        const index = input?.id ? threads.items.findIndex(t => t.id === input.id) : -1;
        if (input?.id && index === -1) {
            throw new NovelError(404, 'Plot thread not found');
        }
        const thread = normalizeThread(input, index === -1 ? undefined : threads.items[index]);
        const clash = findThreadByTitle(threads.items, thread.title, thread.id);
        if (clash) {
            throw new NovelError(409, `A plot thread called "${clash.title}" already exists`);
        }
        if (index === -1) {
            threads.items.push(thread);
        } else {
            threads.items[index] = thread;
        }
        writeJson(paths.threads, threads);
        return thread;
    });
}

/**
 * Deletes a plot thread and its pending suggestions.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} threadId Thread ID
 */
export async function deleteThread(directories, projectId, threadId) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const threads = readThreads(paths);
        if (!threads.items.some(t => t.id === threadId)) {
            throw new NovelError(404, 'Plot thread not found');
        }
        threads.items = threads.items.filter(t => t.id !== threadId);
        writeJson(paths.threads, threads);
        const suggestions = readSuggestions(paths);
        suggestions.items = suggestions.items.filter(item => item.threadId !== threadId);
        writeJson(paths.suggestions, suggestions);
    });
}
