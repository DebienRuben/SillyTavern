import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_WRITER_INSTRUCTIONS,
    buildWritingPrompt,
    chapterLabel,
    cleanOutput,
    estimateTokens,
    keepHead,
    keepTail,
} from '../public/scripts/extensions/novel/ai/prompt.js';

/**
 * Creates prompt input with sensible defaults.
 * @param {object} overrides Fields to override
 */
function input(overrides = {}) {
    return {
        task: 'continue',
        project: { title: 'The Harbor Ledger', genre: 'Mystery', pov: 'Close third', tense: 'Past', styleGuide: 'Spare prose.' },
        chapter: { title: 'Arrival', synopsis: 'Mara reaches the harbor.' },
        chapterNumber: 3,
        scene: { title: 'The Pier', pov: 'Mara', location: 'Harbor', storyTime: 'Dusk', beats: 'Mara meets Tom.' },
        beforeCursor: 'Rain came in off the harbor.',
        afterCursor: '',
        targetWords: 400,
        preceding: { scenes: [], hasMore: false },
        budgetTokens: 8000,
        ...overrides,
    };
}

describe('keepTail / keepHead', () => {
    test('cut at word boundaries and report truncation', () => {
        expect(keepTail('one two three four', 100)).toEqual({ text: 'one two three four', truncated: false });
        expect(keepTail('one two three four', 9)).toEqual({ text: 'four', truncated: true });
        expect(keepHead('one two three four', 9)).toEqual({ text: 'one two', truncated: true });
        expect(keepTail('abc', 0)).toEqual({ text: '', truncated: true });
    });
});

describe('buildWritingPrompt', () => {
    test('puts instructions, project facts and style guide in the system message', () => {
        const { messages } = buildWritingPrompt(input());
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain(DEFAULT_WRITER_INSTRUCTIONS);
        expect(messages[0].content).toContain('Tense: Past');
        expect(messages[0].content).toContain('Spare prose.');

        const custom = buildWritingPrompt(input({ instructions: 'Write like Hemingway.' }));
        expect(custom.messages[0].content.startsWith('Write like Hemingway.')).toBe(true);
    });

    test('continues after the scene text and includes the scene brief', () => {
        const { messages, maxTokens } = buildWritingPrompt(input());
        const user = messages[1].content;
        expect(user).toContain('<scene_text>\nRain came in off the harbor.\n</scene_text>');
        expect(user).toContain('<current_chapter>\nChapter 3: Arrival\nSynopsis: Mara reaches the harbor.');
        expect(user).toContain('Beats:\nMara meets Tom.');
        expect(user).toContain('Continue the scene exactly where <scene_text> ends');
        expect(user).toContain('about 400 words');
        expect(user).not.toContain('<text_after>');
        expect(maxTokens).toBe(1200);
    });

    test('asks for an opening when the scene is empty, and for a lead-in when text follows', () => {
        const opening = buildWritingPrompt(input({ beforeCursor: '  ' })).messages[1].content;
        expect(opening).toContain('Write the opening of this scene');
        expect(opening).not.toContain('<scene_text>');

        const middle = buildWritingPrompt(input({ afterCursor: 'Tom was waiting.' })).messages[1].content;
        expect(middle).toContain('<text_after>\nTom was waiting.\n</text_after>');
        expect(middle).toContain('Lead naturally into it');
    });

    test('builds rewrite prompts around the selected passage', () => {
        const { messages, maxTokens } = buildWritingPrompt(input({
            task: 'rewrite',
            beforeCursor: 'Before.',
            selection: 'He walked slowly to the door.',
            afterCursor: 'After.',
            instruction: 'Make it tense.',
        }));
        const user = messages[1].content;
        expect(user).toContain('<text_before>\nBefore.\n</text_before>');
        expect(user).toContain('<passage_to_rewrite>\nHe walked slowly to the door.\n</passage_to_rewrite>');
        expect(user).toContain('Instruction: Make it tense.');
        // Short passages still get room for a meaningful rewrite
        expect(maxTokens).toBe(600);
    });

    test('lists earlier scenes in reading order with chapter headings', () => {
        const preceding = {
            hasMore: false,
            scenes: [
                { chapterNumber: 2, chapterTitle: 'Two', title: 'B', content: 'Bravo text.', truncated: false },
                { chapterNumber: 1, chapterTitle: 'One', title: 'A', content: 'Alpha text.', truncated: false },
            ],
        };
        const { messages, sections } = buildWritingPrompt(input({ preceding }));
        const user = messages[1].content;
        expect(user.indexOf('## Chapter 1: One')).toBeLessThan(user.indexOf('## Chapter 2: Two'));
        expect(user.indexOf('Alpha text.')).toBeLessThan(user.indexOf('Bravo text.'));
        expect(user).not.toContain('omitted');
        expect(sections.find(s => s.name.startsWith('Earlier scenes'))).toMatchObject({ name: 'Earlier scenes (2)', truncated: false });
    });

    test('stays within the budget by cutting the oldest story first', () => {
        const longScene = 'word '.repeat(4000).trim();
        const preceding = {
            hasMore: true,
            scenes: [
                { chapterNumber: 1, chapterTitle: '', title: 'Newest', content: longScene, truncated: false },
                { chapterNumber: 1, chapterTitle: '', title: 'Oldest', content: 'Never included.', truncated: false },
            ],
        };
        const budgetTokens = 3000;
        const { messages, sections } = buildWritingPrompt(input({ preceding, beforeCursor: longScene, budgetTokens }));
        const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

        // Small overhead for tags and headings is allowed on top of the budgeted content
        expect(total).toBeLessThanOrEqual(budgetTokens + 100);
        expect(messages[1].content).toContain('[Earlier parts of the manuscript are omitted.]');
        expect(messages[1].content).not.toContain('Never included.');
        expect(sections.find(s => s.name === 'Scene text before').truncated).toBe(true);
    });
});

describe('chapterLabel', () => {
    test('drops titles that only repeat the chapter number', () => {
        expect(chapterLabel(1, 'Chapter 1')).toBe('Chapter 1');
        expect(chapterLabel(2, '  ')).toBe('Chapter 2');
        expect(chapterLabel(3, 'Arrival')).toBe('Chapter 3: Arrival');
    });
});

describe('cleanOutput', () => {
    test('removes fences, echoed tags and preambles but keeps prose', () => {
        expect(cleanOutput('```markdown\nShe ran.\n```')).toBe('She ran.');
        expect(cleanOutput('<scene_text>She ran.</scene_text>')).toBe('She ran.');
        expect(cleanOutput('Here is the continuation:\n\nShe ran.')).toBe('She ran.');
        expect(cleanOutput('\n\nShe ran.\n\nHe followed.\n')).toBe('She ran.\n\nHe followed.');
        expect(cleanOutput('Here she comes, she said.')).toBe('Here she comes, she said.');
    });
});
