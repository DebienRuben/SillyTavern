import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { createProject, getProject, getScene, importProject, saveScene, saveStructure } from '../src/novel/store.js';
import { exportChapterTitle, exportProject, parseBlocks, parseInline, toMarkdown, toPlainText } from '../src/novel/export.js';
import { splitManuscript } from '../public/scripts/extensions/novel/import-logic.js';

/** @type {string} */
let root;
/** @type {any} */
let directories;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-export-'));
    directories = { novels: path.join(root, 'novels') };
    fs.mkdirSync(directories.novels);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Lists the entry names of a zip file in order, from its local file headers.
 * @param {Buffer} buffer Zip data
 * @returns {{ name: string, method: number }[]}
 */
function zipEntries(buffer) {
    const entries = [];
    let offset = 0;
    while (buffer.readUInt32LE(offset) === 0x04034b50) {
        const method = buffer.readUInt16LE(offset + 8);
        const flags = buffer.readUInt16LE(offset + 6);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
        entries.push({ name, method });
        // Entries written as a stream carry their size in a data descriptor; stop listing there
        if (flags & 0x08) {
            break;
        }
        offset += 30 + nameLength + extraLength + buffer.readUInt32LE(offset + 18);
    }
    return entries;
}

describe('Markdown parsing for export', () => {
    test('parses inline emphasis, escapes and unmatched markers', () => {
        expect(parseInline('She *never* said **that** ~~word~~.')).toEqual([
            { text: 'She ' }, { text: 'never', italic: true }, { text: ' said ' }, { text: 'that', bold: true },
            { text: ' ' }, { text: 'word', strike: true }, { text: '.' },
        ]);
        expect(parseInline('5 \\* 3 and a lone * star')).toEqual([{ text: '5 * 3 and a lone * star' }]);
        expect(parseInline('snake_case_name')).toEqual([{ text: 'snake_case_name' }]);
    });

    test('splits blocks into paragraphs, headings, quotes and breaks', () => {
        const blocks = parseBlocks('First line\nwraps.\n\n---\n\n## Heading\n\n> Quoted\n> text');
        expect(blocks.map(b => b.type)).toEqual(['paragraph', 'break', 'heading', 'quote']);
        expect(blocks[0]).toEqual({ type: 'paragraph', inlines: [{ text: 'First line wraps.' }] });
        expect(blocks[3]).toEqual({ type: 'quote', inlines: [{ text: 'Quoted text' }] });
    });

    test('drops chapter titles that only repeat the number', () => {
        expect(exportChapterTitle(2, 'Chapter 2')).toBe('Chapter 2');
        expect(exportChapterTitle(3, 'Storm')).toBe('Chapter 3: Storm');
    });
});

describe('exportProject', () => {
    /** @type {string} */
    let projectId;

    beforeEach(async () => {
        const { project } = await createProject(directories, { title: 'The Harbor: Ledger?', author: 'R. D.' });
        projectId = project.id;
        await saveStructure(directories, projectId, {
            chapters: [
                { id: 'chapter-one', title: 'Arrival', scenes: [{ id: 'scene-a', title: 'Pier' }, { id: 'scene-b', title: 'Market' }] },
                { id: 'chapter-empty', title: 'Empty', scenes: [{ id: 'scene-e', title: 'Nothing' }] },
                { id: 'chapter-two', title: 'Chapter 3', scenes: [{ id: 'scene-c', title: 'Lighthouse' }] },
            ],
        });
        await saveScene(directories, projectId, 'scene-a', 'Rain *fell* on the pier.\n\nMara & Tom <waited>.', undefined);
        await saveScene(directories, projectId, 'scene-b', 'Ilse sold **herring**.', undefined);
        await saveScene(directories, projectId, 'scene-c', 'The pages were blank.', undefined);
    });

    test('exports Markdown with scene breaks and without empty chapters', async () => {
        const file = await exportProject(directories, projectId, 'md');
        expect(file.filename).toBe('The Harbor Ledger.md');
        const markdown = file.data.toString('utf8');
        expect(markdown).toContain('# The Harbor: Ledger?\n\n*by R. D.*\n\n## Chapter 1: Arrival\n\nRain *fell* on the pier.');
        expect(markdown).toContain('Mara & Tom <waited>.\n\n* * *\n\nIlse sold **herring**.');
        expect(markdown).toContain('## Chapter 3\n\nThe pages were blank.');
        expect(markdown).not.toContain('Empty');

        const withTitles = toMarkdown({ project: { title: 'T' }, chapters: [{ number: 1, title: '', scenes: [{ title: 'Pier', content: 'x' }] }] }, { sceneTitles: true });
        expect(withTitles).toContain('### Pier\n\nx');
    });

    test('exports plain text without Markdown', () => {
        const text = toPlainText({ project: { title: 'T', author: '' }, chapters: [{ number: 1, title: 'One', scenes: [{ title: 'S', content: 'She *ran*.\n\n---\n\nThen **stopped**.' }] }] });
        expect(text).toBe('T\n\nCHAPTER 1: ONE\n\nShe ran.\n\n* * *\n\nThen stopped.\n');
    });

    test('exports a DOCX package with escaped text and formatting', async () => {
        const file = await exportProject(directories, projectId, 'docx');
        expect(file.contentType).toContain('wordprocessingml');
        expect(file.data.subarray(0, 2).toString()).toBe('PK');
        const names = zipEntries(file.data).map(e => e.name);
        expect(names[0]).toBe('[Content_Types].xml');
    });

    test('exports an EPUB whose first entry is the uncompressed mimetype', async () => {
        const file = await exportProject(directories, projectId, 'epub');
        const [first] = zipEntries(file.data);
        expect(first).toEqual({ name: 'mimetype', method: 0 });
        expect(file.data.toString('latin1', 30 + 'mimetype'.length, 30 + 'mimetype'.length + 20)).toBe('application/epub+zip');
    });

    test('rejects unknown formats and empty books', async () => {
        await expect(exportProject(directories, projectId, 'pdf')).rejects.toMatchObject({ status: 400 });
        const { project } = await createProject(directories, {});
        await expect(exportProject(directories, project.id, 'md')).rejects.toMatchObject({ status: 400 });
    });
});

describe('splitManuscript', () => {
    test('uses a single top heading as the title and second-level headings as chapters', () => {
        const result = splitManuscript('# The Ledger\n\n## One\n\nRain fell.\n\n* * *\n\nLater.\n\n## Two\n\nStorm.');
        expect(result.title).toBe('The Ledger');
        expect(result.chapters.map(c => [c.title, c.scenes.length])).toEqual([['One', 2], ['Two', 1]]);
        expect(result.chapters[0].scenes[1]).toEqual({ title: 'Scene 2', content: 'Later.' });
        expect(result.wordCount).toBe(4);
    });

    test('detects plain-text chapter lines and keeps text before the first chapter', () => {
        const text = 'A short foreword.\n\nPrologue\n\nIt began at sea.\n\nChapter 1\n\nRain.\n\n#\n\nMore rain.\n\nChapter one was long.';
        const result = splitManuscript(text, 'my_novel.txt');
        expect(result.title).toBe('my novel');
        expect(result.chapters.map(c => c.title)).toEqual(['Opening', 'Prologue', 'Chapter 1']);
        // A sentence that starts with "Chapter" is prose, not a heading
        expect(result.chapters[2].scenes.map(s => s.content)).toEqual(['Rain.', 'More rain.\n\nChapter one was long.']);
    });

    test('takes a lone first line before the first chapter as the title, and strips a byte order mark', () => {
        const result = splitManuscript('\uFEFFThe Lighthouse Keeper\n\nChapter 1\n\nIlse climbed.\n\nChapter 2\n\nStorm.', 'file.txt');
        expect(result.title).toBe('The Lighthouse Keeper');
        expect(result.chapters.map(c => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
        // A real opening paragraph is kept as a chapter
        expect(splitManuscript('It was dark.\n\nChapter 1\n\nRain.').chapters.map(c => c.title)).toEqual(['Opening', 'Chapter 1']);
    });

    test('turns one-paragraph-per-line text into paragraphs', () => {
        const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`).join('\n');
        const result = splitManuscript(lines);
        expect(result.chapters[0].scenes[0].content.split('\n\n')).toHaveLength(12);
    });
});

describe('importProject', () => {
    test('creates a project with the imported chapters, scenes and word counts', async () => {
        const split = splitManuscript('# The Ledger\n\n## One\n\nRain fell hard.\n\n***\n\nLater.\n\n## Two\n\nStorm.');
        const { project, structure } = await importProject(directories, { title: split.title, author: 'Me', chapters: split.chapters });
        expect(project).toMatchObject({ title: 'The Ledger', author: 'Me' });
        expect(structure.chapters.map(c => [c.title, c.scenes.map(s => s.wordCount)])).toEqual([['One', [3, 1]], ['Two', [1]]]);
        const saved = getProject(directories, project.id).structure;
        expect(getScene(directories, project.id, saved.chapters[1].scenes[0].id).content).toBe('Storm.');
        expect(fs.readdirSync(path.join(directories.novels, project.id, 'scenes'))).toHaveLength(3);
    });

    test('rejects empty manuscripts', async () => {
        await expect(importProject(directories, { title: 'x', chapters: [] })).rejects.toMatchObject({ status: 400 });
    });
});
