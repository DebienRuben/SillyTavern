import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { NovelError, createProject, getProject, saveStructure } from '../src/novel/store.js';
import {
    deleteEntity,
    listEntities,
    listSuggestions,
    replaceSceneSuggestions,
    resolveSuggestion,
    saveEntity,
} from '../src/novel/codex.js';

/** @type {string} */
let root;
/** @type {any} */
let directories;
/** @type {string} */
let projectId;
/** @type {string} */
let sceneId;

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-codex-'));
    directories = { novels: path.join(root, 'novels') };
    fs.mkdirSync(directories.novels);
    const { project, structure } = await createProject(directories, {});
    projectId = project.id;
    sceneId = structure.chapters[0].scenes[0].id;
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Asserts that a promise rejects with a NovelError of the given status.
 * @param {Promise<any>} promise Promise to check
 * @param {number} status Expected HTTP status
 */
async function expectNovelError(promise, status) {
    await expect(promise).rejects.toBeInstanceOf(NovelError);
    await expect(promise).rejects.toMatchObject({ status });
}

describe('codex entries', () => {
    test('creates, updates, lists and deletes entries', async () => {
        const mara = await saveEntity(directories, projectId, {
            type: 'character', name: ' Mara Voss ', aliases: ['Mara', 'mara', 'Mara Voss', 'the captain', ''], description: 'Harbor pilot.',
        });
        expect(mara.id).toMatch(/^ent-/);
        expect(mara.name).toBe('Mara Voss');
        expect(mara.aliases).toEqual(['Mara', 'the captain']);

        await saveEntity(directories, projectId, { type: 'location', name: 'The Harbor' });
        const updated = await saveEntity(directories, projectId, { ...mara, description: 'Harbor pilot, 34.', type: 'bogus' });
        expect(updated.id).toBe(mara.id);
        expect(updated.type).toBe('character');
        expect(updated.createdAt).toBe(mara.createdAt);

        expect((await listEntities(directories, projectId)).map(e => e.name)).toEqual(['Mara Voss', 'The Harbor']);

        await deleteEntity(directories, projectId, mara.id);
        expect((await listEntities(directories, projectId)).map(e => e.name)).toEqual(['The Harbor']);
    });

    test('rejects nameless entries and names or aliases already in use', async () => {
        await saveEntity(directories, projectId, { name: 'Mara Voss', aliases: ['the captain'] });
        await expectNovelError(saveEntity(directories, projectId, { name: '  ' }), 400);
        await expectNovelError(saveEntity(directories, projectId, { name: 'THE CAPTAIN' }), 409);
        await expectNovelError(saveEntity(directories, projectId, { id: 'ent-missing', name: 'Tom' }), 404);
        expect(await listEntities(directories, projectId)).toHaveLength(1);
    });

    test('keeps pinned cast on scenes', async () => {
        const { structure } = getProject(directories, projectId);
        structure.chapters[0].scenes[0].cast = ['ent-abc', '../bad', 7, 'ent-abc'];
        structure.chapters[0].scenes[0].excludedCast = ['ent-def'];
        const saved = await saveStructure(directories, projectId, structure);
        expect(saved.chapters[0].scenes[0].cast).toEqual(['ent-abc']);
        expect(saved.chapters[0].scenes[0].excludedCast).toEqual(['ent-def']);
    });
});

describe('codex suggestions', () => {
    test('stores valid suggestions per scene and replaces them on re-analysis', async () => {
        const mara = await saveEntity(directories, projectId, { name: 'Mara Voss' });
        await replaceSceneSuggestions(directories, projectId, sceneId, [
            { kind: 'update', entityId: mara.id, changes: { condition: 'Soaked', bogus: 'x' }, evidence: 'Rain…' },
            { kind: 'update', entityId: mara.id, changes: { condition: '  ' } },
            { kind: 'update', entityId: 'ent-unknown', changes: { condition: 'x' } },
            { kind: 'create', entity: { type: 'character', name: 'Tom Reyes', aliases: ['Tom'] }, changes: { location: 'Pier 4' } },
            { kind: 'create', entity: { name: 'mara voss' } },
        ]);
        let items = listSuggestions(directories, projectId);
        expect(items.map(i => i.kind)).toEqual(['update', 'create']);
        expect(items[0].changes).toEqual({ condition: 'Soaked' });

        await replaceSceneSuggestions(directories, projectId, sceneId, [
            { kind: 'update', entityId: mara.id, changes: { goals: 'Find the buyer' } },
        ]);
        items = listSuggestions(directories, projectId);
        expect(items).toHaveLength(1);
        expect(items[0].changes).toEqual({ goals: 'Find the buyer' });
    });

    test('accepting an update merges it into the state for that scene', async () => {
        const mara = await saveEntity(directories, projectId, { name: 'Mara Voss' });
        const [first] = await replaceSceneSuggestions(directories, projectId, sceneId, [
            { kind: 'update', entityId: mara.id, changes: { condition: 'Soaked', goals: 'Sell the ledger' } },
        ]);
        await resolveSuggestion(directories, projectId, first.id, 'accept');

        const [second] = await replaceSceneSuggestions(directories, projectId, sceneId, [
            { kind: 'update', entityId: mara.id, changes: { goals: 'Hide the ledger' } },
        ]);
        // The author edits the suggestion before accepting it
        const { entity } = await resolveSuggestion(directories, projectId, second.id, 'accept', { changes: { goals: 'Hide the ledger from Tom' } });

        expect(entity.state).toHaveLength(1);
        expect(entity.state[0]).toMatchObject({ sceneId, condition: 'Soaked', goals: 'Hide the ledger from Tom' });
        expect(listSuggestions(directories, projectId)).toEqual([]);
    });

    test('accepting a create adds the entity; rejecting drops the suggestion', async () => {
        const items = await replaceSceneSuggestions(directories, projectId, sceneId, [
            { kind: 'create', entity: { type: 'character', name: 'Tom Reyes', aliases: ['Tom'], description: 'Dock clerk.' }, changes: { location: 'Pier 4' } },
            { kind: 'create', entity: { type: 'item', name: 'The ledger' } },
        ]);
        const { entity } = await resolveSuggestion(directories, projectId, items[0].id, 'accept', { entity: { name: 'Tom Reyes', description: 'Dock clerk, nervous.' } });
        expect(entity).toMatchObject({ name: 'Tom Reyes', aliases: ['Tom'], description: 'Dock clerk, nervous.' });
        expect(entity.state[0]).toMatchObject({ sceneId, location: 'Pier 4' });

        await resolveSuggestion(directories, projectId, items[1].id, 'reject');
        expect((await listEntities(directories, projectId)).map(e => e.name)).toEqual(['Tom Reyes']);
        expect(listSuggestions(directories, projectId)).toEqual([]);
        await expectNovelError(resolveSuggestion(directories, projectId, items[1].id, 'accept'), 404);
    });

    test('deleting an entity removes its pending suggestions', async () => {
        const mara = await saveEntity(directories, projectId, { name: 'Mara Voss' });
        await replaceSceneSuggestions(directories, projectId, sceneId, [{ kind: 'update', entityId: mara.id, changes: { condition: 'Tired' } }]);
        await deleteEntity(directories, projectId, mara.id);
        expect(listSuggestions(directories, projectId)).toEqual([]);
    });
});
