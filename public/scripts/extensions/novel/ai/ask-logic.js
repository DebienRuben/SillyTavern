/**
 * "Ask the story" and continuity checking. Pure functions only.
 */

import { chapterLabel } from './prompt.js';

/** Previous questions and answers kept in the conversation. */
const HISTORY_TURNS = 4;

export const ASK_MAX_TOKENS = 1200;
export const CONTINUITY_MAX_TOKENS = 2500;

/**
 * @typedef {object} Passage
 * @property {string} sceneId
 * @property {number} chapterNumber
 * @property {string} chapterTitle
 * @property {string} sceneTitle
 * @property {string} text
 */

/**
 * Numbers passages for citation.
 * @param {Passage[]} passages Passages
 * @returns {string}
 */
function numberedPassages(passages) {
    return passages
        .map((passage, index) => `[${index + 1}] ${chapterLabel(passage.chapterNumber, passage.chapterTitle)} · ${passage.sceneTitle || 'Untitled scene'}\n${passage.text.trim()}`)
        .join('\n\n');
}

/**
 * Builds the messages for answering a question about the manuscript.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {string} input.question The author's question
 * @param {{ question: string, answer: string }[]} input.history Earlier questions and answers, oldest first
 * @param {Passage[]} input.passages Search results for the question, numbered for citation
 * @param {string} input.synopsis Book synopsis
 * @param {string[]} input.codex Formatted codex entries mentioned in the question
 * @returns {{ role: 'system' | 'user' | 'assistant', content: string }[]}
 */
export function buildAskMessages({ project, question, history, passages, synopsis, codex }) {
    const system = [
        `You answer the author's questions about their novel in progress, "${project.title}".`,
        'Answer only from the material provided: the numbered manuscript passages, the codex and the synopsis. Cite passages with their numbers in square brackets, like [2].',
        'If the material does not answer the question, say so plainly and suggest what to search for; never guess or invent story facts.',
        'Be concise and specific.',
    ].join('\n');

    const context = [
        synopsis.trim() ? `<book_synopsis>\n${synopsis.trim()}\n</book_synopsis>` : '',
        codex.length ? `<codex>\n${codex.join('\n\n')}\n</codex>` : '',
        `<passages>\n${passages.length ? numberedPassages(passages) : '(No matching passages found.)'}\n</passages>`,
    ].filter(Boolean).join('\n\n');

    const messages = [{ role: /** @type {const} */ ('system'), content: system }];
    for (const turn of history.slice(-HISTORY_TURNS)) {
        messages.push({ role: 'user', content: turn.question });
        messages.push({ role: 'assistant', content: turn.answer });
    }
    messages.push({ role: 'user', content: `${context}\n\n<question>\n${question.trim()}\n</question>` });
    return messages;
}

/**
 * Builds a search query for a question, adding the previous question so follow-ups
 * ("and after that?") still find the right passages.
 * @param {string} question Current question
 * @param {{ question: string }[]} history Earlier turns
 * @returns {string}
 */
export function askSearchQuery(question, history) {
    const previous = history.at(-1)?.question ?? '';
    return question.trim().length < 60 && previous ? `${question}\n${previous}` : question;
}

/**
 * Splits an answer into text and citation parts, keeping only citations of real passages.
 * @param {string} answer Model answer
 * @param {number} passageCount Number of passages that were provided
 * @returns {({ text: string } | { citation: number })[]}
 */
export function splitCitations(answer, passageCount) {
    const parts = [];
    let last = 0;
    for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
        const numbers = match[1].split(',').map(n => Number(n.trim())).filter(n => n >= 1 && n <= passageCount);
        if (numbers.length === 0) {
            continue;
        }
        if (match.index > last) {
            parts.push({ text: answer.slice(last, match.index) });
        }
        for (const number of numbers) {
            parts.push({ citation: number });
        }
        last = match.index + match[0].length;
    }
    if (last < answer.length) {
        parts.push({ text: answer.slice(last) });
    }
    return parts;
}

/** Strict JSON schema for continuity issues. */
export const CONTINUITY_SCHEMA = Object.freeze({
    name: 'continuity_issues',
    description: 'Contradictions between a scene and the established story',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        required: ['issues'],
        properties: {
            issues: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['quote', 'problem', 'reference', 'severity'],
                    properties: {
                        quote: { type: 'string' },
                        problem: { type: 'string' },
                        reference: { type: 'string' },
                        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                    },
                },
            },
        },
    },
});

/**
 * Builds the messages for checking a scene against the established story.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {any} input.scene Scene metadata
 * @param {string} input.sceneText Scene prose
 * @param {string[]} input.codex Formatted codex entries, with state as the scene begins
 * @param {string} input.summaries Summaries of the story before the scene
 * @param {Passage[]} input.passages Earlier passages related to the scene
 * @param {boolean} [input.jsonInstructions] Also describe the JSON format in the prompt
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
export function buildContinuityMessages({ project, scene, sceneText, codex, summaries, passages, jsonInstructions = false }) {
    const system = [
        `You are a meticulous continuity editor for the novel "${project.title}".`,
        'Find places where the scene contradicts what the story has already established: facts about characters (appearance, names, knowledge, relationships), where people and things are, injuries and conditions, timeline and order of events, and rules of the world.',
        'Report only real contradictions with the material given. Do not report style issues, plot suggestions, or things that are merely new information.',
    ].join('\n');
    const instructions = [
        'For each contradiction give:',
        '- "quote": the exact words from the scene that contradict (copy them exactly, a few words to one sentence);',
        '- "problem": what is inconsistent, in one or two sentences;',
        '- "reference": where the conflicting fact was established (codex entry, summary, or passage);',
        '- "severity": "high" for clear factual errors, "medium" for likely errors, "low" for minor or arguable ones.',
        'If there are no contradictions, return an empty list.',
    ];
    if (jsonInstructions) {
        instructions.push('Respond with a single JSON object and nothing else: {"issues":[{"quote":"","problem":"","reference":"","severity":"high"}]}');
    }
    const user = [
        codex.length ? `<codex>\n${codex.join('\n\n')}\n</codex>` : '',
        summaries.trim() ? `<story_so_far>\n${summaries.trim()}\n</story_so_far>` : '',
        passages.length ? `<earlier_passages>\n${numberedPassages(passages)}\n</earlier_passages>` : '',
        `<scene>\nScene: ${scene.title || 'Untitled'}\n\n${sceneText.trim()}\n</scene>`,
        `<instructions>\n${instructions.join('\n')}\n</instructions>`,
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Cleans continuity issues from the model: known severities, non-empty problems, highest severity first.
 * @param {any} result Parsed model response
 * @returns {{ quote: string, problem: string, reference: string, severity: 'high' | 'medium' | 'low' }[]}
 */
export function normalizeIssues(result) {
    const rank = { high: 0, medium: 1, low: 2 };
    return (Array.isArray(result?.issues) ? result.issues : [])
        .map((/** @type {any} */ issue) => ({
            quote: String(issue?.quote ?? '').trim(),
            problem: String(issue?.problem ?? '').trim(),
            reference: String(issue?.reference ?? '').trim(),
            severity: Object.hasOwn(rank, issue?.severity) ? issue.severity : 'medium',
        }))
        .filter(issue => issue.problem)
        .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Finds a quote in plain text, tolerating differences in whitespace and quote marks.
 * @param {string} text Text to search
 * @param {string} quote Quote to find
 * @returns {{ start: number, end: number } | null} Character range in `text`
 */
export function findQuote(text, quote) {
    const normalize = (/** @type {string} */ value) => value.replace(/[“”]/g, '"').replace(/[‘’]/g, '\'');
    const needle = normalize(quote.trim());
    if (!needle) {
        return null;
    }
    const pattern = new RegExp(needle.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
    const match = pattern.exec(normalize(text));
    return match ? { start: match.index, end: match.index + match[0].length } : null;
}
