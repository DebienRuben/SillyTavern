/**
 * Builds writing prompts for Novel Studio. Pure functions only (no browser APIs),
 * so the prompt logic can be unit tested.
 */

export const DEFAULT_WRITER_INSTRUCTIONS = `You are an accomplished novelist co-writing a book with its author. You write the prose; the author directs.

- Match the manuscript's established voice, point of view, tense and style exactly. Your text must read as if the author wrote it.
- Show, don't tell. Prefer concrete sensory detail, subtext and specific verbs over abstraction and summary.
- Keep characters consistent with how they have acted and spoken so far.
- Follow the scene's beats in order. Do not jump ahead to later events, resolve conflicts early, or end the scene unless asked.
- Avoid clichés, purple prose, and stock phrases. Vary sentence length and rhythm.`;

/** Target lengths for generated passages, in words. */
export const LENGTHS = Object.freeze({
    short: { label: 'Short', words: 150 },
    medium: { label: 'Medium', words: 400 },
    long: { label: 'Long', words: 900 },
    scene: { label: 'Full scene', words: 1800 },
});

/** Share of the flexible budget codex entries may use. They come before the prose in priority. */
const CODEX_SHARE = 0.25;
/** Share of the flexible budget the current scene's text before the cursor may use. */
const BEFORE_CURSOR_SHARE = 0.6;
/** Share of the flexible budget the text after the cursor may use. */
const AFTER_CURSOR_SHARE = 0.1;
/** Rough characters-per-token ratio; errs towards overestimating tokens. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimates the token count of a text. Tokenizers differ per model, so this is
 * deliberately conservative rather than exact.
 * @param {string} text Text to measure
 * @returns {number}
 */
export function estimateTokens(text) {
    return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

/**
 * Converts a token budget to a character budget.
 * @param {number} tokens Token budget
 * @returns {number}
 */
export function tokensToChars(tokens) {
    return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/**
 * Keeps the end of a text within a character budget, starting at a word boundary.
 * @param {string} text Text to cut
 * @param {number} maxChars Character budget
 * @returns {{ text: string, truncated: boolean }}
 */
export function keepTail(text, maxChars) {
    if (text.length <= maxChars) {
        return { text, truncated: false };
    }
    if (maxChars <= 0) {
        return { text: '', truncated: text.length > 0 };
    }
    let cut = text.slice(text.length - maxChars);
    const boundary = cut.search(/\s/);
    if (boundary !== -1 && boundary < cut.length - 1) {
        cut = cut.slice(boundary + 1);
    }
    return { text: cut, truncated: true };
}

/**
 * Keeps the start of a text within a character budget, ending at a word boundary.
 * @param {string} text Text to cut
 * @param {number} maxChars Character budget
 * @returns {{ text: string, truncated: boolean }}
 */
export function keepHead(text, maxChars) {
    if (text.length <= maxChars) {
        return { text, truncated: false };
    }
    if (maxChars <= 0) {
        return { text: '', truncated: text.length > 0 };
    }
    let cut = text.slice(0, maxChars);
    const boundary = cut.search(/\s\S*$/);
    if (boundary > 0) {
        cut = cut.slice(0, boundary);
    }
    return { text: cut, truncated: true };
}

/**
 * Names a chapter, leaving out titles that only repeat the number (e.g. "Chapter 3").
 * @param {number} number 1-based chapter number
 * @param {string} [title] Chapter title
 * @returns {string}
 */
export function chapterLabel(number, title) {
    const trimmed = title?.trim() ?? '';
    return trimmed && !/^chapter\s+\d+$/i.test(trimmed) ? `Chapter ${number}: ${trimmed}` : `Chapter ${number}`;
}

/**
 * Formats labelled lines, leaving out empty values.
 * @param {[string, string | undefined][]} pairs Label/value pairs
 * @returns {string}
 */
function labelled(pairs) {
    return pairs
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([label, value]) => `${label}: ${value.trim()}`)
        .join('\n');
}

/**
 * Wraps content in a tag, or returns an empty string if there is no content.
 * @param {string} tag Tag name
 * @param {string} content Content
 * @returns {string}
 */
function tagged(tag, content) {
    return content.trim() ? `<${tag}>\n${content.trim()}\n</${tag}>` : '';
}

/**
 * @typedef {object} PrecedingScene
 * @property {number} chapterNumber
 * @property {string} chapterTitle
 * @property {string} title
 * @property {string} content
 * @property {boolean} truncated
 */

/**
 * @typedef {object} WritingPromptInput
 * @property {'continue' | 'rewrite'} task What to write
 * @property {string} [instructions] Writer instructions; defaults to DEFAULT_WRITER_INSTRUCTIONS
 * @property {any} project Project metadata (title, genre, pov, tense, styleGuide)
 * @property {any} chapter Current chapter (title, synopsis)
 * @property {number} chapterNumber 1-based number of the current chapter
 * @property {any} scene Current scene metadata (title, pov, location, storyTime, beats)
 * @property {string} beforeCursor Scene text before the cursor or selection
 * @property {string} afterCursor Scene text after the cursor or selection
 * @property {string} [selection] Passage to rewrite
 * @property {string} [instruction] How to rewrite the passage
 * @property {number} [targetWords] Target length for continuations
 * @property {{ scenes: PrecedingScene[], hasMore: boolean }} preceding Earlier scenes, newest first
 * @property {{ name: string, text: string }[]} [codex] Formatted codex entries, most important first
 * @property {number} budgetTokens Maximum prompt size in tokens
 */

/**
 * @typedef {object} PromptSection
 * @property {string} name Human-readable section name
 * @property {number} tokens Estimated tokens
 * @property {boolean} truncated Whether the section was cut to fit the budget
 */

/**
 * Builds the messages for a writing request, fitting the context into the token budget.
 * Priority: instructions, task and scene brief (always) > codex > scene text around the cursor > earlier scenes.
 * @param {WritingPromptInput} input Prompt input
 * @returns {{ messages: { role: 'system' | 'user', content: string }[], sections: PromptSection[], maxTokens: number }}
 */
export function buildWritingPrompt(input) {
    const { project, chapter, scene } = input;
    /** @type {PromptSection[]} */
    const sections = [];

    const projectFacts = labelled([
        ['Title', project.title],
        ['Genre', project.genre],
        ['Point of view', project.pov],
        ['Tense', project.tense],
    ]);
    const styleGuide = project.styleGuide?.trim() ? `Style guide from the author:\n${project.styleGuide.trim()}` : '';
    const system = [input.instructions?.trim() || DEFAULT_WRITER_INSTRUCTIONS, projectFacts && `About the novel:\n${projectFacts}`, styleGuide]
        .filter(Boolean)
        .join('\n\n');
    sections.push({ name: 'Instructions and style guide', tokens: estimateTokens(system), truncated: false });

    const chapterBrief = tagged('current_chapter', [
        chapterLabel(input.chapterNumber, chapter.title),
        labelled([['Synopsis', chapter.synopsis]]),
    ].filter(Boolean).join('\n'));
    const sceneBrief = tagged('current_scene', [
        labelled([
            ['Scene', scene.title],
            ['Point of view', scene.pov],
            ['Location', scene.location],
            ['Story time', scene.storyTime],
        ]),
        scene.beats?.trim() ? `Beats:\n${scene.beats.trim()}` : '',
    ].filter(Boolean).join('\n'));
    const task = buildTask(input);
    const selectionBlock = input.task === 'rewrite' ? tagged('passage_to_rewrite', input.selection ?? '') : '';
    sections.push({ name: 'Chapter and scene brief', tokens: estimateTokens(chapterBrief + sceneBrief), truncated: false });
    sections.push({ name: 'Task', tokens: estimateTokens(task + selectionBlock), truncated: false });

    const fixedTokens = estimateTokens(system + chapterBrief + sceneBrief + task + selectionBlock);
    let flexibleChars = tokensToChars(input.budgetTokens - fixedTokens);

    const codex = fitCodex(input.codex ?? [], Math.floor(flexibleChars * CODEX_SHARE));
    flexibleChars -= codex.text.length;
    if (codex.text) {
        const names = codex.included.join(', ');
        sections.push({ name: `Codex: ${names}`, tokens: estimateTokens(codex.text), truncated: codex.omitted > 0 });
    }

    const before = keepTail(input.beforeCursor.trim(), Math.floor(flexibleChars * BEFORE_CURSOR_SHARE));
    flexibleChars -= before.text.length;
    const after = keepHead(input.afterCursor.trim(), Math.floor(flexibleChars * (AFTER_CURSOR_SHARE / (1 - BEFORE_CURSOR_SHARE))));
    flexibleChars -= after.text.length;

    const beforeTag = input.task === 'rewrite' ? 'text_before' : 'scene_text';
    const beforeBlock = tagged(beforeTag, (before.truncated ? '[…]\n' : '') + before.text);
    const afterBlock = tagged('text_after', after.text + (after.truncated ? '\n[…]' : ''));
    if (before.text) {
        sections.push({ name: 'Scene text before', tokens: estimateTokens(beforeBlock), truncated: before.truncated });
    }
    if (after.text) {
        sections.push({ name: 'Scene text after', tokens: estimateTokens(afterBlock), truncated: after.truncated });
    }

    const story = buildStorySoFar(input.preceding, flexibleChars);
    if (story.text) {
        sections.push({ name: `Earlier scenes (${story.sceneCount})`, tokens: estimateTokens(story.text), truncated: story.truncated });
    }

    const user = [story.text, chapterBrief, sceneBrief, codex.text, beforeBlock, selectionBlock, afterBlock, task]
        .filter(Boolean)
        .join('\n\n');

    const outputWords = input.task === 'rewrite'
        ? Math.max(100, Math.round(countWords(input.selection ?? '') * 1.5))
        : (input.targetWords ?? LENGTHS.medium.words);

    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        sections,
        // Room for the target length plus slack, since tokens per word vary by model and language
        maxTokens: Math.ceil(outputWords * 2) + 400,
    };
}

/**
 * Includes whole codex entries in priority order while they fit the budget.
 * @param {{ name: string, text: string }[]} entries Formatted entries, most important first
 * @param {number} maxChars Character budget
 * @returns {{ text: string, included: string[], omitted: number }}
 */
function fitCodex(entries, maxChars) {
    const included = [];
    const parts = [];
    let used = 0;
    for (const entry of entries) {
        const length = entry.text.length + 2;
        if (used + length > maxChars) {
            continue;
        }
        parts.push(entry.text);
        included.push(entry.name);
        used += length;
    }
    return { text: tagged('codex', parts.join('\n\n')), included, omitted: entries.length - included.length };
}

/**
 * Formats earlier scenes in reading order within a character budget.
 * @param {{ scenes: PrecedingScene[], hasMore: boolean }} preceding Earlier scenes, newest first
 * @param {number} maxChars Character budget
 * @returns {{ text: string, truncated: boolean, sceneCount: number }}
 */
function buildStorySoFar(preceding, maxChars) {
    const included = [];
    let remaining = maxChars;
    let truncated = preceding.hasMore;

    for (const scene of preceding.scenes) {
        if (remaining <= 0) {
            truncated = true;
            break;
        }
        const cut = keepTail(scene.content.trim(), remaining);
        if (!cut.text) {
            truncated = true;
            break;
        }
        included.push({ ...scene, content: cut.text, truncated: scene.truncated || cut.truncated });
        remaining -= cut.text.length;
        if (cut.truncated) {
            truncated = true;
            break;
        }
    }
    if (included.length === 0) {
        return { text: '', truncated: false, sceneCount: 0 };
    }

    const parts = [];
    let lastChapter = null;
    for (const scene of included.reverse()) {
        if (scene.chapterNumber !== lastChapter) {
            parts.push(`## ${chapterLabel(scene.chapterNumber, scene.chapterTitle)}`);
            lastChapter = scene.chapterNumber;
        }
        parts.push(`### ${scene.title || 'Untitled scene'}\n${scene.truncated ? '[…]\n' : ''}${scene.content}`);
    }
    const intro = truncated ? '[Earlier parts of the manuscript are omitted.]\n\n' : '';
    return { text: tagged('story_so_far', intro + parts.join('\n\n')), truncated, sceneCount: included.length };
}

/**
 * Writes the task instruction for a request.
 * @param {WritingPromptInput} input Prompt input
 * @returns {string}
 */
function buildTask(input) {
    const format = 'Respond with the prose only: no title, headings, notes or commentary, and no quotation marks around it. Use Markdown only for *italics* and **bold**.';
    const codexRule = input.codex?.length ? 'Treat <codex> as the source of truth for facts about characters, places and things, and their current state.' : '';

    if (input.task === 'rewrite') {
        return tagged('task', [
            `Rewrite the passage in <passage_to_rewrite>. Instruction: ${input.instruction?.trim() || 'Improve the prose while keeping its meaning.'}`,
            'It must still fit seamlessly between <text_before> and <text_after>. Do not include that surrounding text.',
            codexRule,
            format,
        ].filter(Boolean).join('\n'));
    }

    const words = input.targetWords ?? LENGTHS.medium.words;
    const lines = input.beforeCursor.trim()
        ? [`Continue the scene exactly where <scene_text> ends. Do not repeat, recap or rephrase what is already written. Write about ${words} words.`]
        : [`Write the opening of this scene. Write about ${words} words.`];
    if (input.afterCursor.trim()) {
        lines.push('Your text is inserted before <text_after>, which already exists. Lead naturally into it and do not write it again.');
    }
    if (input.scene.beats?.trim()) {
        lines.push('Stay within the scene\'s beats and follow them in order.');
    }
    if (codexRule) {
        lines.push(codexRule);
    }
    lines.push(format);
    return tagged('task', lines.join('\n'));
}

/**
 * Counts words in a text.
 * @param {string} text Text to count
 * @returns {number}
 */
export function countWords(text) {
    return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

const PROMPT_TAGS = ['story_so_far', 'current_chapter', 'current_scene', 'codex', 'scene_text', 'text_before', 'text_after', 'passage_to_rewrite', 'task'];

/**
 * Cleans model output: removes code fences, echoed prompt tags and a leading "Here is…" line.
 * @param {string} text Raw model output
 * @returns {string}
 */
export function cleanOutput(text) {
    let output = text.replace(/\r\n/g, '\n');
    output = output.replace(/^\s*```[a-z]*\n([\s\S]*?)\n?```\s*$/i, '$1');
    const tagPattern = new RegExp(`</?(?:${PROMPT_TAGS.join('|')})>`, 'g');
    output = output.replace(tagPattern, '');
    output = output.replace(/^\s*(?:here(?:'s| is)|sure[,!])[^\n]{0,120}:\s*\n+/i, '');
    return output.replace(/^\s*\n/, '').trimEnd();
}
