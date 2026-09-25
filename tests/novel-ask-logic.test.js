import { describe, expect, test } from '@jest/globals';

import {
    askSearchQuery,
    buildAskMessages,
    buildContinuityMessages,
    findQuote,
    normalizeIssues,
    splitCitations,
} from '../public/scripts/extensions/novel/ai/ask-logic.js';

const passages = [
    { sceneId: 's1', chapterNumber: 1, chapterTitle: 'Arrival', sceneTitle: 'Pier', text: 'Mara had green eyes.' },
    { sceneId: 's2', chapterNumber: 2, chapterTitle: 'Chapter 2', sceneTitle: 'Market', text: 'Ilse sold herring.' },
];

describe('ask the story', () => {
    test('numbers passages, keeps recent history and asks for citations', () => {
        const history = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }));
        const messages = buildAskMessages({ project: { title: 'T' }, question: 'What colour are Mara\'s eyes?', history, passages, synopsis: 'Syn.', codex: ['## Mara'] });
        expect(messages[0].content).toContain('Cite passages with their numbers');
        // Only the last four turns are kept
        expect(messages.slice(1, -1).map(m => m.content)).toEqual(['Q2', 'A2', 'Q3', 'A3', 'Q4', 'A4', 'Q5', 'A5']);
        const last = messages.at(-1).content;
        expect(last).toContain('[1] Chapter 1: Arrival · Pier\nMara had green eyes.');
        expect(last).toContain('[2] Chapter 2 · Market');
        expect(last).toContain('<question>\nWhat colour are Mara\'s eyes?\n</question>');
    });

    test('adds the previous question to short follow-up searches', () => {
        expect(askSearchQuery('And then?', [{ question: 'When does Tom lie?' }])).toBe('And then?\nWhen does Tom lie?');
        expect(askSearchQuery('And then?', [])).toBe('And then?');
    });

    test('splits citations and drops numbers that match no passage', () => {
        expect(splitCitations('Green [1]. Also [2, 7] and [9].', 2)).toEqual([
            { text: 'Green ' }, { citation: 1 }, { text: '. Also ' }, { citation: 2 }, { text: ' and [9].' },
        ]);
    });
});

describe('continuity check', () => {
    test('builds a prompt from codex, summaries, passages and the scene', () => {
        const [system, user] = buildContinuityMessages({
            project: { title: 'T' }, scene: { title: 'Pier' }, sceneText: 'Mara\'s blue eyes.', codex: ['## Mara\nGreen eyes.'], summaries: 'Earlier.', passages, jsonInstructions: true,
        });
        expect(system.content).toContain('continuity editor');
        expect(user.content.indexOf('<codex>')).toBeLessThan(user.content.indexOf('<scene>'));
        expect(user.content).toContain('<earlier_passages>\n[1] Chapter 1: Arrival · Pier');
        expect(user.content).toContain('{"issues":[');
    });

    test('normalizes issues and sorts by severity', () => {
        expect(normalizeIssues({
            issues: [
                { quote: 'q1', problem: 'minor', reference: 'r', severity: 'low' },
                { quote: 'q2', problem: '', reference: 'r', severity: 'high' },
                { quote: 'q3', problem: 'major', reference: 'r', severity: 'high' },
                { quote: 'q4', problem: 'odd', reference: 'r', severity: 'extreme' },
            ],
        }).map(i => [i.quote, i.severity])).toEqual([['q3', 'high'], ['q4', 'medium'], ['q1', 'low']]);
        expect(normalizeIssues(null)).toEqual([]);
    });

    test('finds quotes despite whitespace and quote-mark differences', () => {
        const text = 'She said, “I never\n\nlie,” and left.';
        expect(findQuote(text, '"I never lie,"')).toEqual({ start: 10, end: 25 });
        expect(findQuote(text, 'not there')).toBeNull();
        expect(findQuote(text, '  ')).toBeNull();
    });
});
