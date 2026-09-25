import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { NovelError, createProject, saveScene, saveStructure } from '../src/novel/store.js';
import { getSummaryState, saveSummary } from '../src/novel/memory.js';

/** @type {string} */
let root;
/** @type {any} */
let directories;
/** @type {string} */
let projectId;

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-memory-'));
    directories = { novels: path.join(root, 'novels') };
    fs.mkdirSync(directories.novels);
    const { project } = await createProject(directories, {});
    projectId = project.id;
    await saveStructure(directories, projectId, {
        chapters: [
            { id: 'chapter-one', title: 'One', scenes: [{ id: 'scene-a', title: 'A' }, { id: 'scene-empty', title: 'Empty' }] },
            { id: 'chapter-two', title: 'Two', scenes: [{ id: 'scene-b', title: 'B' }] },
            { id: 'chapter-blank', title: 'Blank', scenes: [] },
        ],
    });
    await saveScene(directories, projectId, 'scene-a', 'Mara arrives.', undefined);
    await saveScene(directories, projectId, 'scene-b', 'Tom lies.', undefined);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('summary state', () => {
    test('marks missing summaries as out of date and empty scenes as needing none', () => {
        const state = getSummaryState(directories, projectId);
        expect(state.scenes['scene-a']).toMatchObject({ stale: true, empty: false, text: '' });
        expect(state.scenes['scene-empty']).toMatchObject({ stale: false, empty: true });
        expect(state.chapters['chapter-one'].stale).toBe(true);
        expect(state.chapters['chapter-blank']).toMatchObject({ stale: false, empty: true });
        expect(state.book.stale).toBe(true);
    });

    test('tracks freshness bottom-up: scene text, then scene summaries, then chapter summaries', async () => {
        let state = getSummaryState(directories, projectId);
        await saveSummary(directories, projectId, 'scene', 'scene-a', 'Mara arrives at the harbor.', state.scenes['scene-a'].sourceHash);
        await saveSummary(directories, projectId, 'scene', 'scene-b', 'Tom lies about the ledger.', state.scenes['scene-b'].sourceHash);

        state = getSummaryState(directories, projectId);
        expect(state.scenes['scene-a'].stale).toBe(false);
        // The chapter's source (its scene summaries) changed since the state was first read
        expect(state.chapters['chapter-one'].stale).toBe(true);
        await saveSummary(directories, projectId, 'chapter', 'chapter-one', 'Mara arrives.', state.chapters['chapter-one'].sourceHash);
        await saveSummary(directories, projectId, 'chapter', 'chapter-two', 'Tom lies.', state.chapters['chapter-two'].sourceHash);

        state = getSummaryState(directories, projectId);
        await saveSummary(directories, projectId, 'book', null, 'So far: Mara arrives; Tom lies.', state.book.sourceHash);
        state = getSummaryState(directories, projectId);
        expect(state.chapters['chapter-one'].stale).toBe(false);
        expect(state.book).toMatchObject({ stale: false, text: 'So far: Mara arrives; Tom lies.' });

        // Editing a scene makes its summary stale; the chapter and book follow once that summary changes
        await saveScene(directories, projectId, 'scene-a', 'Mara arrives, soaked.', undefined);
        state = getSummaryState(directories, projectId);
        expect(state.scenes['scene-a'].stale).toBe(true);
        expect(state.chapters['chapter-one'].stale).toBe(false);

        await saveSummary(directories, projectId, 'scene', 'scene-a', 'Mara arrives soaked.', state.scenes['scene-a'].sourceHash);
        state = getSummaryState(directories, projectId);
        expect(state.chapters['chapter-one'].stale).toBe(true);
        expect(state.chapters['chapter-two'].stale).toBe(false);
    });

    test('a chapter summary goes out of date when its chapter moves', async () => {
        let state = getSummaryState(directories, projectId);
        await saveSummary(directories, projectId, 'chapter', 'chapter-two', 'Tom lies.', state.chapters['chapter-two'].sourceHash);
        expect(getSummaryState(directories, projectId).chapters['chapter-two'].stale).toBe(false);

        // A new chapter inserted before it changes its number
        await saveStructure(directories, projectId, {
            chapters: [
                { id: 'chapter-new', title: 'New', scenes: [] },
                { id: 'chapter-one', title: 'One', scenes: [{ id: 'scene-a', title: 'A' }, { id: 'scene-empty', title: 'Empty' }] },
                { id: 'chapter-two', title: 'Two', scenes: [{ id: 'scene-b', title: 'B' }] },
                { id: 'chapter-blank', title: 'Blank', scenes: [] },
            ],
        });
        state = getSummaryState(directories, projectId);
        expect(state.chapters['chapter-two'].stale).toBe(true);
        await saveSummary(directories, projectId, 'chapter', 'chapter-two', 'Tom lies again.', state.chapters['chapter-two'].sourceHash);
        expect(getSummaryState(directories, projectId).chapters['chapter-two'].stale).toBe(false);
    });

    test('a summary saved with an outdated source hash stays out of date', async () => {
        const before = getSummaryState(directories, projectId);
        await saveScene(directories, projectId, 'scene-a', 'Changed while the summary was being written.', undefined);
        await saveSummary(directories, projectId, 'scene', 'scene-a', 'Old summary.', before.scenes['scene-a'].sourceHash);
        expect(getSummaryState(directories, projectId).scenes['scene-a']).toMatchObject({ stale: true, text: 'Old summary.' });
    });

    test('rejects invalid input and forgets summaries of deleted scenes', async () => {
        const state = getSummaryState(directories, projectId);
        const hash = state.scenes['scene-a'].sourceHash;
        await expect(saveSummary(directories, projectId, 'scene', 'scene-missing', 'x', hash)).rejects.toMatchObject({ status: 404 });
        await expect(saveSummary(directories, projectId, 'part', 'x', 'x', hash)).rejects.toBeInstanceOf(NovelError);
        await expect(saveSummary(directories, projectId, 'scene', 'scene-a', 'x', 'nothex')).rejects.toMatchObject({ status: 400 });

        await saveSummary(directories, projectId, 'scene', 'scene-b', 'Tom lies.', state.scenes['scene-b'].sourceHash);
        await saveStructure(directories, projectId, { chapters: [{ id: 'chapter-one', title: 'One', scenes: [{ id: 'scene-a', title: 'A' }] }] });
        await saveSummary(directories, projectId, 'scene', 'scene-a', 'Mara arrives.', hash);
        const stored = JSON.parse(fs.readFileSync(path.join(directories.novels, projectId, 'memory', 'summaries.json'), 'utf8'));
        expect(Object.keys(stored.scenes)).toEqual(['scene-a']);
        expect(Object.keys(stored.chapters)).toEqual([]);
    });
});
