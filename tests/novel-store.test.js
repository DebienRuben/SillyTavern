import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    NovelError,
    countWords,
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
} from '../src/novel/store.js';

/** @type {string} */
let root;
/** @type {any} */
let directories;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-store-'));
    directories = { novels: path.join(root, 'novels') };
    fs.mkdirSync(directories.novels);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Asserts that a promise rejects with a NovelError of the given status.
 * @param {Promise<any> | (() => any)} action Promise or function to run
 * @param {number} status Expected HTTP status
 */
async function expectNovelError(action, status) {
    try {
        await (typeof action === 'function' ? action() : action);
    } catch (error) {
        expect(error).toBeInstanceOf(NovelError);
        expect(error.status).toBe(status);
        return;
    }
    throw new Error('Expected a NovelError');
}

describe('countWords', () => {
    test('ignores Markdown syntax and keeps hyphenated words and contractions whole', () => {
        expect(countWords('# Chapter One\n\n*She* didn\'t   see the well-known **door**.')).toBe(8);
        expect(countWords('')).toBe(0);
        expect(countWords('Café naïve — über 42')).toBe(4);
    });
});

describe('novel store', () => {
    test('creates a project with one chapter and an empty scene, and lists it', async () => {
        const { project, structure } = await createProject(directories, { title: 'The Ledger', genre: 'Mystery' });

        expect(project.title).toBe('The Ledger');
        expect(structure.chapters).toHaveLength(1);
        expect(structure.chapters[0].scenes).toHaveLength(1);

        const [listed] = await listProjects(directories);
        expect(listed.id).toBe(project.id);
        expect(listed.wordCount).toBe(0);

        const history = await getHistory(directories, project.id);
        expect(history.map(h => h.message)).toEqual(['Create project']);
    });

    test('saves scene prose, updates word counts and detects conflicting edits', async () => {
        const { project, structure } = await createProject(directories, {});
        const sceneId = structure.chapters[0].scenes[0].id;

        const opened = getScene(directories, project.id, sceneId);
        const saved = await saveScene(directories, project.id, sceneId, 'Rain fell on the harbor.', opened.hash);
        expect(saved.wordCount).toBe(5);

        expect(getScene(directories, project.id, sceneId).content).toBe('Rain fell on the harbor.');
        expect(getProject(directories, project.id).structure.chapters[0].scenes[0].wordCount).toBe(5);

        // A second editor still holding the original hash must not overwrite the newer text
        await expectNovelError(saveScene(directories, project.id, sceneId, 'Stale text', opened.hash), 409);
        await saveScene(directories, project.id, sceneId, 'Newer text.', saved.hash);
    });

    test('ignores client word counts and trashes scene files removed from the structure', async () => {
        const { project, structure } = await createProject(directories, {});
        const firstScene = structure.chapters[0].scenes[0].id;
        await saveScene(directories, project.id, firstScene, 'One two three.', undefined);

        const updated = await saveStructure(directories, project.id, {
            chapters: [{
                id: structure.chapters[0].id,
                title: 'Opening',
                scenes: [
                    { id: firstScene, title: 'Arrival', status: 'draft', wordCount: 9999 },
                    { id: 'scene-new', title: 'Second', status: 'bogus' },
                ],
            }],
        });
        expect(updated.chapters[0].scenes[0].wordCount).toBe(3);
        expect(updated.chapters[0].scenes[1].status).toBe('outline');
        expect(getScene(directories, project.id, 'scene-new').content).toBe('');

        await saveStructure(directories, project.id, {
            chapters: [{ id: structure.chapters[0].id, title: 'Opening', scenes: [{ id: 'scene-new', title: 'Second' }] }],
        });
        const trash = fs.readdirSync(path.join(directories.novels, project.id, 'trash'));
        expect(trash).toHaveLength(1);
        expect(trash[0].startsWith(firstScene)).toBe(true);
        await expectNovelError(() => getScene(directories, project.id, firstScene), 404);
    });

    test('rejects unsafe or duplicate identifiers', async () => {
        const { project, structure } = await createProject(directories, {});
        await expectNovelError(() => getProject(directories, '../etc'), 400);
        await expectNovelError(() => getScene(directories, project.id, '../../x'), 404);
        await expectNovelError(saveStructure(directories, project.id, {
            chapters: [{ id: 'chapter-a', scenes: [{ id: 'dup' }] }, { id: 'chapter-b', scenes: [{ id: 'dup' }] }],
        }), 400);
        await expectNovelError(saveStructure(directories, project.id, {
            chapters: [{ id: 'Bad/Id', scenes: [] }],
        }), 400);
        // Unchanged structure is still readable after the rejected saves
        expect(getProject(directories, project.id).structure).toEqual(structure);
    });

    test('snapshots changes and reads old scene versions back', async () => {
        const { project, structure } = await createProject(directories, {});
        const sceneId = structure.chapters[0].scenes[0].id;

        await saveScene(directories, project.id, sceneId, 'First draft.', undefined);
        const firstOid = await snapshot(directories, project.id, 'Draft one');
        expect(firstOid).toMatch(/^[0-9a-f]{40}$/);
        expect(await snapshot(directories, project.id, 'Nothing changed')).toBeNull();

        await saveScene(directories, project.id, sceneId, 'Second draft.', undefined);
        await snapshot(directories, project.id, 'Draft two');

        const sceneHistory = await getHistory(directories, project.id, sceneId);
        expect(sceneHistory.map(h => h.message)).toEqual(['Draft two', 'Draft one', 'Create project']);

        const old = await getSceneVersion(directories, project.id, sceneId, firstOid);
        expect(old.content).toBe('First draft.');
    });

    test('updates metadata and moves deleted projects to the trash', async () => {
        const { project } = await createProject(directories, {});
        const updated = await updateProject(directories, project.id, { title: '  ', targetWords: '90000', tense: 'past' });
        expect(updated.title).toBe('Untitled novel');
        expect(updated.targetWords).toBe(90000);
        expect(updated.tense).toBe('past');

        await deleteProject(directories, project.id);
        expect(await listProjects(directories)).toEqual([]);
        expect(fs.readdirSync(path.join(directories.novels, '.trash'))).toHaveLength(1);
    });
});
