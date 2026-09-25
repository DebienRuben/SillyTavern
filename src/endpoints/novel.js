import express from 'express';

import { getConfigValue } from '../util.js';
import { getBatchVector } from './vectors.js';

import {
    NovelError,
    createProject,
    deleteProject,
    getHistory,
    getPrecedingScenes,
    getProject,
    getScene,
    getSceneVersion,
    importProject,
    listProjects,
    saveScene,
    saveStructure,
    snapshot,
    updateProject,
} from '../novel/store.js';
import {
    deleteEntity,
    deleteThread,
    listEntities,
    listThreads,
    listSuggestions,
    replaceSceneSuggestions,
    resolveSuggestion,
    saveEntity,
    saveThread,
} from '../novel/codex.js';
import { getSummaryState, saveSummary } from '../novel/memory.js';
import { searchManuscript } from '../novel/search.js';
import { exportProject } from '../novel/export.js';

export const router = express.Router();

/**
 * Wraps a route handler with shared error handling.
 * @param {(request: import('express').Request) => Promise<any> | any} handler Returns the response body
 * @returns {import('express').RequestHandler}
 */
function handle(handler) {
    return async (request, response) => {
        try {
            const result = await handler(request);
            return response.send(result ?? {});
        } catch (error) {
            if (error instanceof NovelError) {
                return response.status(error.status).send({ error: error.message });
            }
            console.error('Novel endpoint error:', error);
            return response.status(500).send({ error: 'Internal server error' });
        }
    };
}

router.post('/list', handle(request => listProjects(request.user.directories)));

router.post('/create', handle(request => createProject(request.user.directories, request.body)));

router.post('/get', handle(request => getProject(request.user.directories, request.body?.id)));

router.post('/update', handle(request => updateProject(request.user.directories, request.body?.id, request.body?.fields)));

router.post('/delete', handle(request => deleteProject(request.user.directories, request.body?.id)));

router.post('/structure/save', handle(request => saveStructure(request.user.directories, request.body?.id, request.body?.structure)));

router.post('/scene/get', handle(request => getScene(request.user.directories, request.body?.id, request.body?.sceneId)));

router.post('/scene/save', handle(request => saveScene(
    request.user.directories,
    request.body?.id,
    request.body?.sceneId,
    request.body?.content,
    request.body?.baseHash,
)));

router.post('/scenes/preceding', handle(request => getPrecedingScenes(
    request.user.directories,
    request.body?.id,
    request.body?.sceneId,
    request.body?.maxChars,
)));

router.post('/scene/version', handle(request => getSceneVersion(
    request.user.directories,
    request.body?.id,
    request.body?.sceneId,
    request.body?.oid,
)));

router.post('/snapshot', handle(async request => ({
    oid: await snapshot(request.user.directories, request.body?.id, request.body?.message),
})));

router.post('/history', handle(request => getHistory(request.user.directories, request.body?.id, request.body?.sceneId)));

router.post('/codex/list', handle(request => listEntities(request.user.directories, request.body?.id)));

router.post('/codex/save', handle(request => saveEntity(request.user.directories, request.body?.id, request.body?.entity)));

router.post('/codex/delete', handle(request => deleteEntity(request.user.directories, request.body?.id, request.body?.entityId)));

router.post('/suggestions/list', handle(request => listSuggestions(request.user.directories, request.body?.id)));

router.post('/suggestions/replace', handle(request => replaceSceneSuggestions(
    request.user.directories,
    request.body?.id,
    request.body?.sceneId,
    request.body?.items,
)));

router.post('/suggestions/resolve', handle(request => resolveSuggestion(
    request.user.directories,
    request.body?.id,
    request.body?.suggestionId,
    request.body?.action,
    request.body?.edits,
)));

router.post('/summaries/state', handle(request => getSummaryState(request.user.directories, request.body?.id)));

router.post('/summaries/save', handle(request => saveSummary(
    request.user.directories,
    request.body?.id,
    request.body?.level,
    request.body?.key,
    request.body?.text,
    request.body?.sourceHash,
)));

/** Embedding sources Novel Studio offers, with their default models. */
const EMBEDDING_SOURCES = Object.freeze({
    transformers: '',
    openrouter: 'openai/text-embedding-3-small',
});

/**
 * Turns the client's embedding choice into an embed function, or null for keyword search only.
 * @param {import('express').Request} request Request with body.embedding = { source, model }
 * @returns {{ key: string, embed: import('../novel/search.js').EmbedFunction } | null}
 */
function resolveEmbedding(request) {
    const source = request.body?.embedding?.source;
    if (!source || source === 'none') {
        return null;
    }
    if (!Object.hasOwn(EMBEDDING_SOURCES, source)) {
        throw new NovelError(400, 'Unsupported embedding source');
    }
    const model = source === 'transformers'
        ? String(getConfigValue('extensions.models.embedding', 'default'))
        : String(request.body.embedding.model || EMBEDDING_SOURCES[source]).slice(0, 200);
    const settings = source === 'openrouter' ? { model } : {};
    return {
        // Stored with each indexed scene, so switching models re-embeds everything
        key: `${source}:${model}`,
        embed: (texts, isQuery) => getBatchVector(source, settings, texts, isQuery, request.user.directories),
    };
}

router.post('/search', handle(request => searchManuscript(request.user.directories, request.body?.id, {
    query: request.body?.query,
    limit: request.body?.limit,
    beforeSceneId: request.body?.beforeSceneId,
    excludeSceneIds: request.body?.excludeSceneIds,
    embedding: resolveEmbedding(request),
})));

router.post('/threads/list', handle(request => listThreads(request.user.directories, request.body?.id)));

router.post('/threads/save', handle(request => saveThread(request.user.directories, request.body?.id, request.body?.thread)));

router.post('/threads/delete', handle(request => deleteThread(request.user.directories, request.body?.id, request.body?.threadId)));

router.post('/import', handle(request => importProject(request.user.directories, request.body)));

router.post('/export', async (request, response) => {
    try {
        const file = await exportProject(request.user.directories, request.body?.id, request.body?.format, request.body?.options);
        response.setHeader('Content-Type', file.contentType);
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
        return response.send(file.data);
    } catch (error) {
        if (error instanceof NovelError) {
            return response.status(error.status).send({ error: error.message });
        }
        console.error('Novel export error:', error);
        return response.status(500).send({ error: 'Internal server error' });
    }
});
