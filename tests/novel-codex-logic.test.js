import { describe, expect, test } from '@jest/globals';

import {
    buildExtractionMessages,
    detectMentions,
    extractionToSuggestions,
    formatEntityForPrompt,
    formatThreadForPrompt,
    openThreadsAt,
    parseJsonResponse,
    sceneOrder,
    selectRelevantEntities,
    stateAsOf,
} from '../public/scripts/extensions/novel/ai/codex-logic.js';
import { buildWritingPrompt } from '../public/scripts/extensions/novel/ai/prompt.js';

const structure = {
    chapters: [
        { id: 'c1', scenes: [{ id: 's1' }, { id: 's2' }] },
        { id: 'c2', scenes: [{ id: 's3' }] },
    ],
};

const mara = {
    id: 'ent-mara', type: 'character', name: 'Mara Voss', aliases: ['Mara', 'the captain'], description: 'Harbor pilot.',
    state: [
        // Stored out of order on purpose; manuscript order decides
        { sceneId: 's3', condition: 'Broken wrist' },
        { sceneId: 's1', location: 'Harbor', condition: 'Soaked', goals: 'Sell the ledger' },
        { sceneId: 'deleted-scene', goals: 'Ignored' },
    ],
};
const tom = { id: 'ent-tom', type: 'character', name: 'Tom Reyes', aliases: ['Tom'], description: '', state: [] };
const harbor = { id: 'ent-harbor', type: 'location', name: 'The Harbor', aliases: [], description: 'Grey water.', state: [] };
const entities = [mara, tom, harbor];

describe('stateAsOf', () => {
    const order = sceneOrder(structure);

    test('applies entries in manuscript order up to the scene', () => {
        expect(stateAsOf(mara, order, 's2')).toEqual({ location: 'Harbor', condition: 'Soaked', goals: 'Sell the ledger' });
        expect(stateAsOf(mara, order, 's3')).toEqual({ location: 'Harbor', condition: 'Broken wrist', goals: 'Sell the ledger' });
        expect(stateAsOf(mara, order, null).condition).toBe('Broken wrist');
    });

    test('can exclude the scene itself, for "state before this scene"', () => {
        expect(stateAsOf(mara, order, 's1', { includeScene: false })).toEqual({});
        expect(stateAsOf(mara, order, 's3', { includeScene: false }).condition).toBe('Soaked');
        expect(stateAsOf(mara, order, 'unknown')).toEqual({});
    });
});

describe('detectMentions / selectRelevantEntities', () => {
    test('matches names and aliases as whole words, ignoring case', () => {
        expect(detectMentions('THE CAPTAIN nodded to tom.', entities)).toEqual(new Set(['ent-mara', 'ent-tom']));
        expect(detectMentions('Tomorrow, Maraschino cherries.', entities)).toEqual(new Set());
        expect(detectMentions('Mara\nVoss left the harbor', entities)).toEqual(new Set(['ent-mara', 'ent-harbor']));
    });

    test('ranks pinned, point of view, location, then mentions', () => {
        const scene = { cast: ['ent-tom', 'ent-missing'], pov: 'Mara', location: 'The Harbor', beats: '' };
        const picked = selectRelevantEntities({ entities, scene, texts: ['Tom and Mara argue.'] });
        expect(picked.map(p => [p.entity.id, p.reason])).toEqual([
            ['ent-tom', 'pinned'],
            ['ent-mara', 'pov'],
            ['ent-harbor', 'location'],
        ]);
    });
});

describe('formatEntityForPrompt', () => {
    test('includes aliases, description and current state', () => {
        const text = formatEntityForPrompt(mara, { location: 'Harbor', condition: 'Soaked' });
        expect(text).toBe('## Mara Voss (character)\nAlso called: Mara, the captain\nHarbor pilot.\nCurrent state:\n- Location: Harbor\n- Condition: Soaked');
    });
});

describe('extraction', () => {
    const known = [
        { entity: mara, state: { location: 'Harbor', condition: 'Soaked' } },
        { entity: tom, state: {} },
    ];

    test('builds a prompt with the codex before the scene and the scene text', () => {
        const [system, user] = buildExtractionMessages({
            project: { title: 'The Harbor Ledger' }, chapter: { title: 'Arrival' }, chapterNumber: 1,
            scene: { title: 'The Pier', pov: 'Mara' }, sceneText: 'Rain fell.', known, jsonInstructions: true,
        });
        expect(system.content).toContain('Never invent facts');
        expect(user.content).toContain('<codex>\n- id: ent-mara');
        expect(user.content).toContain('  condition: Soaked');
        expect(user.content).toContain('Point of view: Mara\n\nRain fell.');
        expect(user.content).toContain('Respond with a single JSON object');
    });

    test('keeps only real changes, resolves names and merges duplicates', () => {
        const suggestions = extractionToSuggestions({
            updates: [
                { entityId: 'ent-mara', location: 'Harbor', condition: 'Soaked and shaking', goals: '', evidence: 'She shook.' },
                { entityId: 'Tom', location: 'Pier 4', evidence: 'Tom waited at Pier 4.' },
                { entityId: 'ent-unknown', location: 'Nowhere' },
                { entityId: 'ent-mara', location: 'Harbor', condition: 'Soaked' },
            ],
            newEntities: [
                { type: 'character', name: 'Ilse', aliases: ['Ilse', 'the widow'], description: 'Fishmonger.', location: 'Market', evidence: 'Ilse called out.' },
                { type: 'character', name: 'ilse', description: 'Duplicate.' },
                { type: 'character', name: 'the captain', knowledge: 'Knows Tom lied' },
                { type: 'spaceship', name: 'The Gull' },
            ],
        }, known);

        expect(suggestions).toEqual([
            { kind: 'update', entityId: 'ent-mara', changes: { condition: 'Soaked and shaking', knowledge: 'Knows Tom lied' }, evidence: 'She shook.' },
            { kind: 'update', entityId: 'ent-tom', changes: { location: 'Pier 4' }, evidence: 'Tom waited at Pier 4.' },
            {
                kind: 'create',
                entity: { type: 'character', name: 'Ilse', aliases: ['the widow'], description: 'Fishmonger.' },
                changes: { location: 'Market' },
                evidence: 'Ilse called out.',
            },
            { kind: 'create', entity: { type: 'character', name: 'The Gull', aliases: [], description: '' }, changes: {}, evidence: '' },
        ]);
    });

    test('parses JSON from objects, fenced text and chatty text', () => {
        expect(parseJsonResponse({ updates: [] })).toEqual({ updates: [] });
        expect(parseJsonResponse('```json\n{"updates":[]}\n```')).toEqual({ updates: [] });
        expect(parseJsonResponse('Sure! {"newEntities":[]} Hope this helps.')).toEqual({ newEntities: [] });
        expect(() => parseJsonResponse('no json here')).toThrow('did not return valid JSON');
    });
});

describe('codex in writing prompts', () => {
    const base = {
        task: 'continue',
        project: { title: 'T' },
        chapter: { title: '' },
        chapterNumber: 1,
        scene: { title: 'S', beats: '' },
        beforeCursor: 'Text.',
        afterCursor: '',
        preceding: { scenes: [], hasMore: false },
    };

    test('adds whole entries in priority order and states the codex rule', () => {
        const { messages, sections } = buildWritingPrompt({
            ...base,
            budgetTokens: 8000,
            codex: [{ name: 'Mara Voss', text: '## Mara Voss (character)\nPilot.' }, { name: 'Tom', text: '## Tom (character)' }],
        });
        const user = messages[1].content;
        expect(user).toContain('<codex>\n## Mara Voss (character)\nPilot.\n\n## Tom (character)\n</codex>');
        expect(user.indexOf('<codex>')).toBeLessThan(user.indexOf('<scene_text>'));
        expect(user).toContain('Treat <codex> as the source of truth');
        expect(sections.find(s => s.name.startsWith('Codex'))).toMatchObject({ name: 'Codex: Mara Voss, Tom', truncated: false });
    });

    test('skips entries that do not fit instead of cutting them', () => {
        const big = { name: 'Big', text: 'x'.repeat(5000) };
        const small = { name: 'Small', text: '## Small' };
        const { messages, sections } = buildWritingPrompt({ ...base, budgetTokens: 1500, codex: [big, small] });
        expect(messages[1].content).toContain('## Small');
        expect(messages[1].content).not.toContain('xxxxx');
        expect(sections.find(s => s.name.startsWith('Codex'))).toMatchObject({ name: 'Codex: Small', truncated: true });
    });

    test('leaves the codex out entirely when there is none', () => {
        const { messages } = buildWritingPrompt({ ...base, budgetTokens: 8000 });
        expect(messages[1].content).not.toContain('<codex>');
        expect(messages[1].content).not.toContain('source of truth');
    });
});

describe('plot threads', () => {
    const order = sceneOrder(structure);
    const threads = [
        { id: 'thr-buyer', title: 'Who is the buyer?', description: 'Someone wants the ledger.', status: 'open', openedIn: 's1', resolvedIn: null, notes: [{ sceneId: 's2', text: 'Tom hints he knows.' }, { sceneId: 's3', text: 'Too late.' }] },
        { id: 'thr-map', title: 'The map', description: '', status: 'resolved', openedIn: 's1', resolvedIn: 's2', notes: [] },
        { id: 'thr-later', title: 'Later thread', description: '', status: 'open', openedIn: 's3', resolvedIn: null, notes: [] },
        { id: 'thr-loose', title: 'Loose', description: '', status: 'open', openedIn: null, resolvedIn: null, notes: [] },
    ];

    test('knows which threads are open when a scene begins', () => {
        expect(openThreadsAt(threads, order, 's2').map(t => t.id)).toEqual(['thr-buyer', 'thr-map', 'thr-loose']);
        expect(openThreadsAt(threads, order, 's3').map(t => t.id)).toEqual(['thr-buyer', 'thr-loose']);
        expect(openThreadsAt(threads, order, 's1').map(t => t.id)).toEqual(['thr-loose']);
    });

    test('formats a thread with its latest development before the scene', () => {
        expect(formatThreadForPrompt(threads[0], order, 's3').text).toBe('Who is the buyer?: Someone wants the ledger. (latest: Tom hints he knows.)');
        expect(formatThreadForPrompt(threads[0], order, 's2').text).toBe('Who is the buyer?: Someone wants the ledger.');
    });

    test('turns extracted threads into suggestions', () => {
        const suggestions = extractionToSuggestions({
            updates: [],
            newEntities: [],
            threads: [
                { action: 'open', threadId: '', title: 'The blank ledger', description: 'Pages are empty.', note: '', evidence: 'blank' },
                { action: 'open', threadId: '', title: 'who is the buyer?', description: '', note: 'Tom is nervous.', evidence: '' },
                { action: 'resolve', threadId: 'thr-later', title: '', description: '', note: 'Solved.', evidence: 'e' },
                { action: 'advance', threadId: 'thr-loose', title: '', description: '', note: '', evidence: '' },
                { action: 'advance', threadId: 'thr-unknown', title: 'Nope', description: '', note: 'x', evidence: '' },
            ],
        }, [], threads);
        expect(suggestions).toEqual([
            { kind: 'thread-open', thread: { title: 'The blank ledger', description: 'Pages are empty.' }, evidence: 'blank' },
            { kind: 'thread-update', threadId: 'thr-buyer', status: 'open', note: 'Tom is nervous.', evidence: '' },
            { kind: 'thread-update', threadId: 'thr-later', status: 'resolved', note: 'Solved.', evidence: 'e' },
        ]);
    });

    test('lists open threads in the extraction prompt', () => {
        const [, user] = buildExtractionMessages({
            project: { title: 'T' }, chapter: { title: '' }, chapterNumber: 1, scene: { title: 'S' }, sceneText: 'x', known: [], threads: threads.slice(0, 1),
        });
        expect(user.content).toContain('<open_threads>\n- id: thr-buyer\n  title: Who is the buyer?\n  description: Someone wants the ledger.\n</open_threads>');
        expect(user.content).toContain('"threads": plot threads');
    });
});
