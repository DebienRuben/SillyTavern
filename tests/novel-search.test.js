import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { createProject, saveScene, saveStructure, snapshot } from '../src/novel/store.js';
import { chunkText, fuseRankings, rankBm25, searchManuscript, tokenize } from '../src/novel/search.js';

/** @type {string} */
let root;
/** @type {any} */
let directories;
/** @type {string} */
let projectId;

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-search-'));
    directories = { novels: path.join(root, 'novels') };
    fs.mkdirSync(directories.novels);
    const { project } = await createProject(directories, {});
    projectId = project.id;
    await saveStructure(directories, projectId, {
        chapters: [
            { id: 'chapter-one', title: 'Arrival', scenes: [{ id: 'scene-a', title: 'Pier' }, { id: 'scene-b', title: 'Market' }] },
            { id: 'chapter-two', title: 'Storm', scenes: [{ id: 'scene-c', title: 'Lighthouse' }] },
        ],
    });
    await saveScene(directories, projectId, 'scene-a', 'Rain fell on the pier. Mara hid the ledger under her coat.\n\nTom waited by the crane.', undefined);
    await saveScene(directories, projectId, 'scene-b', 'The market smelled of fish. Ilse sold herring and watched the harbor.', undefined);
    await saveScene(directories, projectId, 'scene-c', 'At the lighthouse, Mara finally opened the ledger. The pages were blank.', undefined);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('text processing', () => {
    test('chunks whole paragraphs and splits only very long ones', () => {
        const short = 'One.\n\nTwo.\n\n\nThree.';
        expect(chunkText(short)).toEqual(['One.\n\nTwo.\n\nThree.']);

        const paragraph = 'Word word word word. '.repeat(40).trim();
        const chunks = chunkText(`${paragraph}\n\n${paragraph}`);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every(chunk => chunk.length <= 1800)).toBe(true);

        const huge = 'A sentence that goes on. '.repeat(120).trim();
        expect(chunkText(huge).every(chunk => chunk.length <= 1800)).toBe(true);
        expect(chunkText('   ')).toEqual([]);
    });

    test('tokenizes without stopwords, possessives or Markdown', () => {
        expect(tokenize('Mara\'s *ledger* was in the harbor!')).toEqual(['mara', 'ledger', 'harbor']);
    });

    test('ranks with BM25 and fuses rankings', () => {
        const docs = [['ledger', 'ledger', 'mara'], ['fish', 'market'], ['mara', 'lighthouse']];
        expect(rankBm25(docs, ['ledger'])).toEqual([0]);
        expect(rankBm25(docs, ['mara', 'lighthouse'])[0]).toBe(2);
        expect(rankBm25(docs, [])).toEqual([]);
        expect(fuseRankings([[0, 1], [1, 2]])[0].index).toBe(1);
    });
});

describe('searchManuscript', () => {
    test('finds passages by keyword with scene and chapter details', async () => {
        const results = await searchManuscript(directories, projectId, { query: 'Who sells herring at the market?' });
        expect(results[0]).toMatchObject({ sceneId: 'scene-b', sceneTitle: 'Market', chapterNumber: 1, chapterTitle: 'Arrival' });
        expect(results[0].text).toContain('herring');
    });

    test('limits the scope to scenes before a scene, and excludes scenes', async () => {
        const all = await searchManuscript(directories, projectId, { query: 'ledger' });
        expect(all.map(r => r.sceneId)).toEqual(expect.arrayContaining(['scene-a', 'scene-c']));

        const before = await searchManuscript(directories, projectId, { query: 'ledger', beforeSceneId: 'scene-c' });
        expect(before.map(r => r.sceneId)).toEqual(['scene-a']);

        const excluded = await searchManuscript(directories, projectId, { query: 'ledger', excludeSceneIds: ['scene-a'] });
        expect(excluded.map(r => r.sceneId)).toEqual(['scene-c']);

        await expect(searchManuscript(directories, projectId, { query: '  ' })).rejects.toMatchObject({ status: 400 });
    });

    test('re-indexes only changed scenes, drops deleted ones, and keeps the index out of snapshots', async () => {
        await searchManuscript(directories, projectId, { query: 'ledger' });
        const indexDir = path.join(directories.novels, projectId, 'index');
        const before = fs.statSync(path.join(indexDir, 'scene-b.json')).mtimeMs;

        await saveScene(directories, projectId, 'scene-a', 'The pier was empty now. Only gulls remained.', undefined);
        expect((await searchManuscript(directories, projectId, { query: 'gulls' }))[0].sceneId).toBe('scene-a');
        expect(fs.statSync(path.join(indexDir, 'scene-b.json')).mtimeMs).toBe(before);

        await saveStructure(directories, projectId, { chapters: [{ id: 'chapter-one', title: 'Arrival', scenes: [{ id: 'scene-a', title: 'Pier' }] }] });
        await searchManuscript(directories, projectId, { query: 'gulls' });
        expect(fs.readdirSync(indexDir).sort()).toEqual(['scene-a.json']);

        await snapshot(directories, projectId, 'test');
        const gitignore = fs.readFileSync(path.join(directories.novels, projectId, '.gitignore'), 'utf8');
        expect(gitignore.split('\n')).toEqual(expect.arrayContaining(['trash/', 'index/']));
    });

    test('uses embeddings for semantic matches and re-embeds when the model changes', async () => {
        // A toy embedding: one dimension for "storm/weather" words, one for everything else
        const calls = [];
        const embedWith = (/** @type {string} */ key) => ({
            key,
            embed: async (/** @type {string[]} */ texts, /** @type {boolean} */ isQuery) => {
                calls.push({ key, count: texts.length, isQuery });
                return texts.map(text => /rain|weather|storm/i.test(text) ? [1, 0] : [0, 1]);
            },
        });

        // "weather" appears in no passage, so only the embedding can find the rainy pier
        const results = await searchManuscript(directories, projectId, { query: 'weather', embedding: embedWith('toy:v1') });
        expect(results[0].sceneId).toBe('scene-a');
        expect(calls.filter(c => !c.isQuery).reduce((sum, c) => sum + c.count, 0)).toBe(3);

        calls.length = 0;
        await searchManuscript(directories, projectId, { query: 'weather', embedding: embedWith('toy:v1') });
        expect(calls.filter(c => !c.isQuery)).toEqual([]);

        await searchManuscript(directories, projectId, { query: 'weather', embedding: embedWith('toy:v2') });
        expect(calls.filter(c => !c.isQuery).length).toBe(3);
    });
});
