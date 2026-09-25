/**
 * Summary ("memory") logic for Novel Studio: prompts for scene, chapter and book
 * summaries, and collecting summaries for writing prompts. Pure functions only.
 */

import { chapterLabel } from './prompt.js';

const SYSTEM = 'You write concise, factual summaries of a novel in progress. They serve as the author\'s reference and as the long-term memory of an AI co-writer, so accuracy and specific names matter more than style. Never invent anything.';

/** Maximum response tokens per summary level. */
export const SUMMARY_MAX_TOKENS = Object.freeze({ scene: 500, chapter: 800, book: 1500 });

/**
 * Builds the messages for summarizing one scene from its prose.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {any} input.chapter Chapter of the scene
 * @param {number} input.chapterNumber 1-based chapter number
 * @param {any} input.scene Scene metadata
 * @param {string} input.sceneText Scene prose
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
export function buildSceneSummaryMessages({ project, chapter, chapterNumber, scene, sceneText }) {
    const meta = [
        `Novel: ${project.title}`,
        chapterLabel(chapterNumber, chapter.title),
        `Scene: ${scene.title || 'Untitled'}`,
        scene.pov ? `Point of view: ${scene.pov}` : '',
    ].filter(Boolean).join('\n');
    const user = [
        `<scene>\n${meta}\n\n${sceneText.trim()}\n</scene>`,
        '<instructions>',
        'Summarize this scene in 60 to 150 words, longer for longer scenes. Cover, in order:',
        '- what happens, including decisions, reveals and turning points;',
        '- where the main characters end up and in what state;',
        '- any promise, clue, secret or open question the scene introduces.',
        'Write in past tense and third person, using names. No commentary, no headings, no quotations longer than a few words.',
        '</instructions>',
    ].join('\n');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

/**
 * Builds the messages for summarizing a chapter from its scene summaries.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {any} input.chapter Chapter metadata
 * @param {number} input.chapterNumber 1-based chapter number
 * @param {{ title: string, text: string }[]} input.scenes Scene summaries in order
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
export function buildChapterSummaryMessages({ project, chapter, chapterNumber, scenes }) {
    const sceneText = scenes.map(scene => `### ${scene.title || 'Untitled scene'}\n${scene.text.trim()}`).join('\n\n');
    const user = [
        `<chapter>\nNovel: ${project.title}\n${chapterLabel(chapterNumber, chapter.title)}${chapter.synopsis?.trim() ? `\nAuthor's synopsis: ${chapter.synopsis.trim()}` : ''}\n\n${sceneText}\n</chapter>`,
        '<instructions>',
        'Summarize this chapter in 120 to 300 words from its scene summaries: the events in order, how the chapter changes the story and the characters, and where things stand at its end.',
        'Write in past tense and third person, using names. No commentary or headings.',
        '</instructions>',
    ].join('\n');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

/**
 * Builds the messages for the book synopsis from the chapter summaries.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {{ number: number, title: string, text: string }[]} input.chapters Chapter summaries in order
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
export function buildSynopsisMessages({ project, chapters }) {
    const chapterText = chapters.map(chapter => `## ${chapterLabel(chapter.number, chapter.title)}\n${chapter.text.trim()}`).join('\n\n');
    const facts = [project.genre ? `Genre: ${project.genre}` : '', project.pov ? `Point of view: ${project.pov}` : ''].filter(Boolean).join('\n');
    const user = [
        `<manuscript_so_far>\nNovel: ${project.title}${facts ? `\n${facts}` : ''}\n\n${chapterText}\n</manuscript_so_far>`,
        '<instructions>',
        'Write a synopsis of the story so far in 250 to 700 words, based on the chapter summaries: the main plot in order, the central characters and how they have changed, the important secrets and open questions, and the situation at the end of the latest chapter.',
        'Write in present tense and third person. No commentary or headings.',
        '</instructions>',
    ].join('\n');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

/**
 * @typedef {object} PriorScene
 * @property {string} sceneId
 * @property {string} chapterId
 * @property {number} chapterNumber
 * @property {string} chapterTitle
 * @property {string} title
 * @property {string} summary Scene summary; empty if there is none
 */

/**
 * @typedef {object} PriorChapter
 * @property {string} chapterId
 * @property {number} chapterNumber
 * @property {string} title
 * @property {string} summary Chapter summary; empty if there is none
 */

/**
 * @typedef {object} StoryMemory
 * @property {string} synopsis Book synopsis
 * @property {PriorScene[]} priorScenes Non-empty scenes before the current one, in order
 * @property {PriorChapter[]} priorChapters Chapters before the current one, in order
 * @property {boolean} [laterTextExists] Whether written scenes follow the current one (the synopsis then covers them too)
 */

/**
 * Collects the summaries that come before a scene, for a writing prompt.
 * @param {any} structure Project structure
 * @param {any} state Summary state from the server
 * @param {string} sceneId Current scene
 * @returns {StoryMemory}
 */
export function collectStoryMemory(structure, state, sceneId) {
    /** @type {PriorScene[]} */
    const priorScenes = [];
    /** @type {PriorChapter[]} */
    const priorChapters = [];

    for (const [index, chapter] of structure.chapters.entries()) {
        const containsCurrent = chapter.scenes.some((/** @type {any} */ scene) => scene.id === sceneId);
        for (const scene of chapter.scenes) {
            if (scene.id === sceneId) {
                break;
            }
            const summary = state?.scenes?.[scene.id];
            if (summary && !summary.empty) {
                priorScenes.push({
                    sceneId: scene.id,
                    chapterId: chapter.id,
                    chapterNumber: index + 1,
                    chapterTitle: chapter.title,
                    title: scene.title,
                    summary: summary.text ?? '',
                });
            }
        }
        if (containsCurrent) {
            break;
        }
        priorChapters.push({ chapterId: chapter.id, chapterNumber: index + 1, title: chapter.title, summary: state?.chapters?.[chapter.id]?.text ?? '' });
    }

    const order = structure.chapters.flatMap((/** @type {any} */ chapter) => chapter.scenes.map((/** @type {any} */ scene) => scene.id));
    const laterTextExists = order.slice(order.indexOf(sceneId) + 1).some(id => state?.scenes?.[id] && !state.scenes[id].empty);
    return { synopsis: state?.book?.text ?? '', priorScenes, priorChapters, laterTextExists };
}

/**
 * Lists the summaries that are out of date, in the order they must be written:
 * scenes first, then chapters, then the book.
 * @param {any} structure Project structure
 * @param {any} state Summary state from the server
 * @returns {{ level: 'scene' | 'chapter' | 'book', key: string | null }[]}
 */
export function listStaleSummaries(structure, state) {
    const tasks = [];
    for (const chapter of structure.chapters) {
        for (const scene of chapter.scenes) {
            if (state?.scenes?.[scene.id]?.stale) {
                tasks.push({ level: /** @type {const} */ ('scene'), key: scene.id });
            }
        }
    }
    for (const chapter of structure.chapters) {
        if (state?.chapters?.[chapter.id]?.stale) {
            tasks.push({ level: /** @type {const} */ ('chapter'), key: chapter.id });
        }
    }
    if (state?.book?.stale) {
        tasks.push({ level: /** @type {const} */ ('book'), key: null });
    }
    return tasks;
}
