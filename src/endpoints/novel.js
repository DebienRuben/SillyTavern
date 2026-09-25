import express from 'express';

import {
    NovelError,
    createProject,
    deleteProject,
    getHistory,
    getProject,
    getScene,
    getSceneVersion,
    listProjects,
    saveScene,
    saveStructure,
    snapshot,
    updateProject,
} from '../novel/store.js';

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
