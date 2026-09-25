/**
 * Splits an imported Markdown or plain-text manuscript into chapters and scenes.
 * Pure functions only, so the splitting can be unit tested.
 */

/** Lines that start a chapter: Markdown headings, or "Chapter 12", "Prologue" and similar on their own line. */
const CHAPTER_LINE = /^(?:chapter|hoofdstuk|chapitre|kapitel|cap[ií]tulo|capitolo)\s+[\p{L}\p{N}]+\b.*$|^(?:prologue|epilogue|proloog|epiloog|prolog|epilog|interlude)\b.*$|^part\s+[\p{L}\p{N}]+\b.*$/iu;
/** Lines that are only a scene break: *** or * * *, ---, #, ~~~, or a single ornament. */
const SCENE_BREAK_LINE = /^\s*(?:(?:\*\s*){3,}|-{3,}|#|~{3,}|§|◊|⁂|\* \* \*)\s*$/u;
/** Longest line that still counts as a chapter heading in plain text. */
const MAX_HEADING_LENGTH = 80;
const MAX_HEADING_WORDS = 10;

/**
 * @typedef {object} ImportedScene
 * @property {string} title
 * @property {string} content Markdown
 */

/**
 * @typedef {object} ImportedChapter
 * @property {string} title
 * @property {ImportedScene[]} scenes
 */

/**
 * Counts words in a text.
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
    return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Plain-text files often put each paragraph on one line without blank lines between them.
 * Such text gets blank lines added so every line becomes a paragraph.
 * @param {string} text Normalized text
 * @returns {string}
 */
function normalizeParagraphs(text) {
    const lines = text.split('\n');
    const nonEmpty = lines.filter(line => line.trim()).length;
    const blank = lines.length - nonEmpty;
    if (nonEmpty > 10 && blank < nonEmpty * 0.1) {
        return lines.filter(line => line.trim()).join('\n\n');
    }
    return text;
}

/**
 * Splits a manuscript into chapters and scenes.
 * - Chapters start at Markdown headings (# or ##) or lines like "Chapter 3" or "Prologue".
 *   A single top-level heading above second-level ones is taken as the book title.
 * - Scenes are separated by scene-break lines (***, * * *, ---, #, ~~~).
 * - Text before the first chapter heading becomes its own chapter.
 * @param {string} input File contents
 * @param {string} [fileName] File name, used as the title when the text has none
 * @returns {{ title: string, chapters: ImportedChapter[], wordCount: number }}
 */
export function splitManuscript(input, fileName = '') {
    const text = normalizeParagraphs(input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
    const lines = text.split('\n');

    const h1 = lines.filter(line => /^#\s+\S/.test(line));
    const h2 = lines.filter(line => /^##\s+\S/.test(line));
    // "# Book title" followed by "## Chapter" headings: the first level is the title
    const titleFromH1 = h1.length === 1 && h2.length > 0;
    let title = titleFromH1 ? h1[0].replace(/^#\s+/, '').trim() : '';

    const isChapterHeading = (/** @type {string} */ line, /** @type {number} */ index) => {
        if (titleFromH1 && /^#\s+\S/.test(line)) {
            return false;
        }
        if (/^#{1,2}\s+\S/.test(line)) {
            return true;
        }
        // Plain-text headings stand alone (blank line or start before them), are short,
        // and do not read like a sentence ("Chapter one was long." is prose, not a heading)
        const trimmed = line.trim();
        const standalone = (index === 0 || !lines[index - 1].trim()) && trimmed.length <= MAX_HEADING_LENGTH;
        const headingLike = !/[.!?,;]$/.test(trimmed) && trimmed.split(/\s+/).length <= MAX_HEADING_WORDS;
        return standalone && headingLike && CHAPTER_LINE.test(trimmed);
    };

    /** @type {{ title: string, lines: string[] }[]} */
    const rawChapters = [];
    let current = { title: '', lines: /** @type {string[]} */ ([]) };
    lines.forEach((line, index) => {
        if (titleFromH1 && /^#\s+\S/.test(line)) {
            return;
        }
        if (isChapterHeading(line, index)) {
            if (current.title || current.lines.some(l => l.trim())) {
                rawChapters.push(current);
            }
            current = { title: line.replace(/^#{1,2}\s+/, '').trim(), lines: [] };
            return;
        }
        current.lines.push(line);
    });
    if (current.title || current.lines.some(l => l.trim())) {
        rawChapters.push(current);
    }

    // Plain text often starts with the book title on a line of its own, before the first chapter
    const opening = rawChapters[0];
    const openingLines = opening && !opening.title ? opening.lines.filter(l => l.trim()) : [];
    if (!title && rawChapters.length > 1 && openingLines.length === 1) {
        const line = openingLines[0].trim();
        if (line.length <= MAX_HEADING_LENGTH && line.split(/\s+/).length <= MAX_HEADING_WORDS && !/[.!?,;:]$/.test(line)) {
            title = line;
            rawChapters.shift();
        }
    }

    const chapters = rawChapters
        .map((chapter, index) => {
            const scenes = [];
            let sceneLines = [];
            const pushScene = () => {
                const content = sceneLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
                if (content) {
                    scenes.push({ title: `Scene ${scenes.length + 1}`, content });
                }
                sceneLines = [];
            };
            for (const line of chapter.lines) {
                if (SCENE_BREAK_LINE.test(line)) {
                    pushScene();
                } else {
                    sceneLines.push(line);
                }
            }
            pushScene();
            return { title: chapter.title || (index === 0 ? 'Opening' : `Chapter ${index + 1}`), scenes };
        })
        .filter(chapter => chapter.scenes.length > 0);

    if (!title) {
        title = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported novel';
    }
    const wordCount = chapters.reduce((sum, chapter) => sum + chapter.scenes.reduce((s, scene) => s + countWords(scene.content), 0), 0);
    return { title, chapters, wordCount };
}
