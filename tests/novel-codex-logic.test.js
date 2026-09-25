import { describe, expect, test } from '@jest/globals';

import {
    buildExtractionMessages,
    detectMentions,
    extractionToSuggestions,
    formatEntityForPrompt,
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
