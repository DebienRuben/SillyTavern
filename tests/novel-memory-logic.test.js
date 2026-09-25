import { describe, expect, test } from '@jest/globals';

import {
    buildChapterSummaryMessages,
    buildSceneSummaryMessages,
    buildSynopsisMessages,
    collectStoryMemory,
    listStaleSummaries,
} from '../public/scripts/extensions/novel/ai/memory-logic.js';
import { buildWritingPrompt, estimateTokens } from '../public/scripts/extensions/novel/ai/prompt.js';

const structure = {
    chapters: [
        { id: 'c1', title: 'One', scenes: [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }] },
        { id: 'c2', title: 'Two', scenes: [{ id: 's3', title: 'S3' }] },
        { id: 'c3', title: 'Three', scenes: [{ id: 's4', title: 'S4' }, { id: 's5', title: 'S5' }] },
        { id: 'c4', title: 'Four', scenes: [{ id: 's6', title: 'S6' }] },
    ],
};

const state = {
    scenes: {
        s1: { text: 'Mara arrives.', stale: false, empty: false },
        s2: { text: '', stale: false, empty: true },
        s3: { text: 'Tom lies.', stale: true, empty: false },
        s4: { text: 'Storm hits.', stale: false, empty: false },
        s5: { text: 'Ilse helps.', stale: false, empty: false },
        s6: { text: '', stale: true, empty: false },
    },
    chapters: {
        c1: { text: 'Chapter one summary.', stale: false, empty: false },
        c2: { text: '', stale: true, empty: false },
        c3: { text: 'Chapter three summary.', stale: false, empty: false },
        c4: { text: '', stale: true, empty: false },
    },
    book: { text: 'The synopsis.', stale: true, empty: false },
};

describe('summary prompts', () => {
    test('scene, chapter and synopsis prompts carry their sources and length targets', () => {
        const project = { title: 'The Harbor Ledger', genre: 'Mystery' };
        const scene = buildSceneSummaryMessages({ project, chapter: { title: 'Chapter 2' }, chapterNumber: 2, scene: { title: 'Pier', pov: 'Mara' }, sceneText: ' Rain. ' });
        expect(scene[1].content).toContain('<scene>\nNovel: The Harbor Ledger\nChapter 2\nScene: Pier\nPoint of view: Mara\n\nRain.\n</scene>');
        expect(scene[1].content).toContain('60 to 150 words');

        const chapter = buildChapterSummaryMessages({ project, chapter: { title: 'Arrival', synopsis: 'Plan' }, chapterNumber: 1, scenes: [{ title: 'Pier', text: 'Mara arrives.' }] });
        expect(chapter[1].content).toContain('Chapter 1: Arrival\nAuthor\'s synopsis: Plan\n\n### Pier\nMara arrives.');

        const synopsis = buildSynopsisMessages({ project, chapters: [{ number: 1, title: 'Arrival', text: 'Mara arrives.' }] });
        expect(synopsis[1].content).toContain('Genre: Mystery');
        expect(synopsis[1].content).toContain('## Chapter 1: Arrival\nMara arrives.');
    });
});

describe('collectStoryMemory / listStaleSummaries', () => {
    test('collects summaries before the scene, skipping empty scenes', () => {
        const memory = collectStoryMemory(structure, state, 's5');
        expect(memory.synopsis).toBe('The synopsis.');
        expect(memory.priorScenes.map(s => [s.sceneId, s.chapterNumber, s.summary])).toEqual([
            ['s1', 1, 'Mara arrives.'], ['s3', 2, 'Tom lies.'], ['s4', 3, 'Storm hits.'],
        ]);
        expect(memory.priorChapters.map(c => c.chapterId)).toEqual(['c1', 'c2']);
    });

    test('knows whether written text follows the scene', () => {
        expect(collectStoryMemory(structure, state, 's5').laterTextExists).toBe(true);
        expect(collectStoryMemory(structure, state, 's6').laterTextExists).toBe(false);
    });

    test('warns the writer when the synopsis covers events after the scene', () => {
        const base = { task: 'continue', project: { title: 'T' }, chapter: { title: '' }, chapterNumber: 3, scene: { title: 'S5' }, beforeCursor: 'Now.', afterCursor: '', preceding: { hasMore: false, scenes: [] }, budgetTokens: 8000 };
        const early = buildWritingPrompt({ ...base, memory: collectStoryMemory(structure, state, 's5') }).messages[1].content;
        expect(early).toContain('including events after the current scene');
        const latest = buildWritingPrompt({ ...base, memory: collectStoryMemory(structure, state, 's6') }).messages[1].content;
        expect(latest).not.toContain('including events after the current scene');
    });

    test('orders stale work bottom-up', () => {
        expect(listStaleSummaries(structure, state)).toEqual([
            { level: 'scene', key: 's3' }, { level: 'scene', key: 's6' },
            { level: 'chapter', key: 'c2' }, { level: 'chapter', key: 'c4' },
            { level: 'book', key: null },
        ]);
    });
});

describe('tiered writing prompt', () => {
    const base = {
        task: 'continue',
        project: { title: 'T' },
        chapter: { title: 'Four' },
        chapterNumber: 4,
        scene: { title: 'S6', beats: '' },
        beforeCursor: 'Now.',
        afterCursor: '',
    };
    const memory = collectStoryMemory(structure, state, 's6');

    test('summarizes old chapters per chapter, recent ones per scene, and puts the synopsis first', () => {
        const preceding = { hasMore: false, scenes: [] };
        const { messages, sections } = buildWritingPrompt({ ...base, preceding, memory, budgetTokens: 8000 });
        const user = messages[1].content;

        expect(user.indexOf('<book_synopsis>')).toBeLessThan(user.indexOf('<story_summary>'));
        // Chapter 1 is old enough for its chapter summary; chapter 3 is the previous chapter, so per scene
        expect(user).toContain('## Chapter 1: One (summary)\nChapter one summary.');
        expect(user).not.toContain('Mara arrives.');
        // Chapter 2 has no chapter summary, so its scene summary is used instead
        expect(user).toContain('## Chapter 2: Two\n### S3 (summary)\nTom lies.');
        expect(user).toContain('### S4 (summary)\nStorm hits.');
        expect(sections.map(s => s.name)).toEqual(expect.arrayContaining(['Book synopsis', 'Summaries (4)']));
    });

    test('does not summarize scenes that are included word for word', () => {
        const preceding = {
            hasMore: false,
            scenes: [
                { sceneId: 's5', chapterNumber: 3, chapterTitle: 'Three', title: 'S5', content: 'Ilse helped them.', truncated: false },
                { sceneId: 's4', chapterNumber: 3, chapterTitle: 'Three', title: 'S4', content: 'The storm hit.', truncated: false },
            ],
        };
        const user = buildWritingPrompt({ ...base, preceding, memory, budgetTokens: 8000 }).messages[1].content;
        expect(user).toContain('<story_so_far>\n## Chapter 3: Three');
        expect(user).not.toContain('Ilse helps.');
        expect(user).not.toContain('Storm hits.');
        expect(user).toContain('Tom lies.');
    });

    test('points to the summaries when the word-for-word story is cut, and stays within budget', () => {
        const long = 'word '.repeat(5000).trim();
        const preceding = {
            hasMore: true,
            scenes: [{ sceneId: 's5', chapterNumber: 3, chapterTitle: 'Three', title: 'S5', content: long, truncated: false }],
        };
        const budgetTokens = 3000;
        const { messages } = buildWritingPrompt({ ...base, preceding, memory, budgetTokens });
        const user = messages[1].content;
        expect(user).toContain('[Earlier parts are summarized in <story_summary>.]');
        // S5 was cut, so its summary still appears
        expect(user).toContain('Ilse helps.');
        const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        expect(total).toBeLessThanOrEqual(budgetTokens + 100);
    });

    test('gives an unused summary reserve back to the word-for-word story', () => {
        const long = 'word '.repeat(5000).trim();
        const preceding = { hasMore: false, scenes: [{ sceneId: 'sX', chapterNumber: 3, chapterTitle: 'Three', title: 'X', content: long, truncated: false }] };
        const tiny = { synopsis: '', priorScenes: [{ sceneId: 's1', chapterId: 'c1', chapterNumber: 3, chapterTitle: 'Three', title: 'S1', summary: 'Short.' }], priorChapters: [] };
        const withReserve = buildWritingPrompt({ ...base, preceding, memory: tiny, budgetTokens: 4000 });
        const story = (/** @type {any} */ result) => result.sections.find((/** @type {any} */ s) => s.name.startsWith('Earlier scenes')).tokens;
        const withoutMemory = buildWritingPrompt({ ...base, preceding, budgetTokens: 4000 });
        // Nearly the whole reserve flows back; only the small summary itself is kept out
        expect(story(withReserve)).toBeGreaterThan(story(withoutMemory) - 50);
    });
});

describe('retrieved passages and plot threads in writing prompts', () => {
    const base = {
        task: 'continue',
        project: { title: 'T' },
        chapter: { title: 'Four' },
        chapterNumber: 4,
        scene: { title: 'S6', beats: '' },
        beforeCursor: 'Now.',
        afterCursor: '',
        budgetTokens: 8000,
    };
    const passages = [
        { sceneId: 's4', chapterNumber: 3, chapterTitle: 'Three', sceneTitle: 'S4', text: 'The ledger was blank.' },
        { sceneId: 's1', chapterNumber: 1, chapterTitle: 'One', sceneTitle: 'S1', text: 'Mara hid the ledger.' },
        { sceneId: 's5', chapterNumber: 3, chapterTitle: 'Three', sceneTitle: 'S5', text: 'Already word for word.' },
    ];
    const preceding = { hasMore: false, scenes: [{ sceneId: 's5', chapterNumber: 3, chapterTitle: 'Three', title: 'S5', content: 'Ilse helped them.', truncated: false }] };

    test('adds passages in reading order, skipping scenes already included word for word', () => {
        const { messages, sections } = buildWritingPrompt({ ...base, preceding, passages });
        const user = messages[1].content;
        expect(user).toContain('<relevant_passages>');
        expect(user.indexOf('Mara hid the ledger.')).toBeLessThan(user.indexOf('The ledger was blank.'));
        expect(user).toContain('### Chapter 1: One · S1 (excerpt)');
        expect(user).not.toContain('Already word for word.');
        expect(user.indexOf('</relevant_passages>')).toBeLessThan(user.indexOf('<story_so_far>'));
        expect(sections.find(s => s.name.startsWith('Relevant'))).toMatchObject({ name: 'Relevant earlier passages (2)', truncated: false });
    });

    test('lists open threads with a rule not to drop them', () => {
        const threads = [{ title: 'The blank ledger', text: 'The blank ledger: why are the pages empty?' }];
        const user = buildWritingPrompt({ ...base, preceding: { hasMore: false, scenes: [] }, threads }).messages[1].content;
        expect(user).toContain('<open_threads>\n- The blank ledger: why are the pages empty?\n</open_threads>');
        expect(user).toContain('Keep <open_threads> in mind');
        const without = buildWritingPrompt({ ...base, preceding: { hasMore: false, scenes: [] } }).messages[1].content;
        expect(without).not.toContain('open_threads');
    });

    test('stays within budget with every tier filled', () => {
        const long = 'word '.repeat(6000).trim();
        const bigPassages = Array.from({ length: 20 }, (_, i) => ({ sceneId: `p${i}`, chapterNumber: 1, chapterTitle: 'One', sceneTitle: `P${i}`, text: 'passage '.repeat(200) }));
        const threads = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, text: `Thread ${i}: ${'detail '.repeat(20)}` }));
        const budgetTokens = 4000;
        const { messages } = buildWritingPrompt({
            ...base,
            budgetTokens,
            beforeCursor: long,
            preceding: { hasMore: true, scenes: [{ sceneId: 's5', chapterNumber: 3, chapterTitle: 'Three', title: 'S5', content: long, truncated: false }] },
            memory: collectStoryMemory(structure, state, 's6'),
            passages: bigPassages,
            threads,
            codex: [{ name: 'Big', text: 'codex '.repeat(500) }],
        });
        const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        expect(total).toBeLessThanOrEqual(budgetTokens + 150);
    });
});
