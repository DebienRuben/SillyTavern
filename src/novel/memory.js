import fs from 'node:fs';
import path from 'node:path';

import {
    NovelError,
    assertId,
    hashContent,
    projectPaths,
    readJson,
    readProjectFiles,
    text,
    withLock,
    writeJson,
} from './store.js';

const FORMAT_VERSION = 1;
const MAX_SUMMARY_CHARS = 20000;

/**
 * @typedef {object} StoredSummary
 * @property {string} text Summary text
 * @property {string} sourceHash Hash of what the summary was written from
 * @property {number} updatedAt When the summary was saved
 */

/**
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @returns {{ version: number, scenes: Record<string, StoredSummary>, chapters: Record<string, StoredSummary>, book: StoredSummary | null }}
 */
function readSummaries(paths) {
    const data = readJson(paths.summaries);
    return {
        version: FORMAT_VERSION,
        scenes: data?.scenes && typeof data.scenes === 'object' ? data.scenes : {},
        chapters: data?.chapters && typeof data.chapters === 'object' ? data.chapters : {},
        book: data?.book?.text !== undefined ? data.book : null,
    };
}

/**
 * Hashes the summaries a higher-level summary is written from, in order.
 * @param {{ id: string, text: string }[]} parts Child summaries
 * @returns {string}
 */
function hashParts(parts) {
    return hashContent(JSON.stringify(parts.map(part => [part.id, part.text])));
}

/**
 * Works out the summary state of a project: every summary with the hash of its
 * current source and whether it is out of date.
 * - A scene summary is written from the scene's prose. Empty scenes need none.
 * - A chapter summary is written from its scenes' summaries.
 * - The book synopsis is written from the chapter summaries.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function getSummaryState(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    const { structure } = readProjectFiles(paths);
    const stored = readSummaries(paths);

    /** @type {Record<string, { text: string, sourceHash: string, empty: boolean, stale: boolean, updatedAt: number | null }>} */
    const scenes = {};
    /** @type {Record<string, { text: string, sourceHash: string, empty: boolean, stale: boolean, updatedAt: number | null }>} */
    const chapters = {};
    const chapterParts = [];

    for (const chapter of structure.chapters) {
        const sceneParts = [];
        let chapterEmpty = true;
        for (const scene of chapter.scenes) {
            const filePath = paths.scene(scene.id);
            const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
            const empty = !content.trim();
            const sourceHash = hashContent(content);
            const summary = stored.scenes[scene.id];
            scenes[scene.id] = {
                text: summary?.text ?? '',
                sourceHash,
                empty,
                stale: !empty && (!summary || summary.sourceHash !== sourceHash),
                updatedAt: summary?.updatedAt ?? null,
            };
            if (!empty) {
                chapterEmpty = false;
                sceneParts.push({ id: scene.id, text: summary?.text ?? '' });
            }
        }
        const sourceHash = hashParts(sceneParts);
        const summary = stored.chapters[chapter.id];
        chapters[chapter.id] = {
            text: summary?.text ?? '',
            sourceHash,
            empty: chapterEmpty,
            stale: !chapterEmpty && (!summary || summary.sourceHash !== sourceHash),
            updatedAt: summary?.updatedAt ?? null,
        };
        if (!chapterEmpty) {
            chapterParts.push({ id: chapter.id, text: summary?.text ?? '' });
        }
    }

    const bookHash = hashParts(chapterParts);
    const bookEmpty = chapterParts.length === 0;
    return {
        scenes,
        chapters,
        book: {
            text: stored.book?.text ?? '',
            sourceHash: bookHash,
            empty: bookEmpty,
            stale: !bookEmpty && (!stored.book || stored.book.sourceHash !== bookHash),
            updatedAt: stored.book?.updatedAt ?? null,
        },
    };
}

/**
 * Saves a summary. The client passes the source hash it read from
 * getSummaryState(), so a summary written from an older source stays marked out of date.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {unknown} level 'scene', 'chapter' or 'book'
 * @param {unknown} key Scene or chapter ID (ignored for the book)
 * @param {unknown} summaryText Summary text
 * @param {unknown} sourceHash Hash of the source the summary was written from
 */
export async function saveSummary(directories, projectId, level, key, summaryText, sourceHash) {
    if (typeof summaryText !== 'string' || typeof sourceHash !== 'string' || !/^[0-9a-f]{16}$/.test(sourceHash)) {
        throw new NovelError(400, 'Invalid summary');
    }
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        const { structure } = readProjectFiles(paths);
        const summaries = readSummaries(paths);
        const entry = { text: text(summaryText, MAX_SUMMARY_CHARS).trim(), sourceHash, updatedAt: Date.now() };

        if (level === 'scene') {
            const sceneId = assertId(key, 'scene ID');
            if (!structure.chapters.some((/** @type {any} */ c) => c.scenes.some((/** @type {any} */ s) => s.id === sceneId))) {
                throw new NovelError(404, 'Scene not found');
            }
            summaries.scenes[sceneId] = entry;
        } else if (level === 'chapter') {
            const chapterId = assertId(key, 'chapter ID');
            if (!structure.chapters.some((/** @type {any} */ c) => c.id === chapterId)) {
                throw new NovelError(404, 'Chapter not found');
            }
            summaries.chapters[chapterId] = entry;
        } else if (level === 'book') {
            summaries.book = entry;
        } else {
            throw new NovelError(400, 'Invalid summary level');
        }

        // Drop summaries of scenes and chapters that no longer exist
        const sceneIds = new Set(structure.chapters.flatMap((/** @type {any} */ c) => c.scenes.map((/** @type {any} */ s) => s.id)));
        const chapterIds = new Set(structure.chapters.map((/** @type {any} */ c) => c.id));
        summaries.scenes = Object.fromEntries(Object.entries(summaries.scenes).filter(([id]) => sceneIds.has(id)));
        summaries.chapters = Object.fromEntries(Object.entries(summaries.chapters).filter(([id]) => chapterIds.has(id)));

        fs.mkdirSync(path.dirname(paths.summaries), { recursive: true });
        writeJson(paths.summaries, summaries);
        return entry;
    });
}
