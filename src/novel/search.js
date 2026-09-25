import fs from 'node:fs';
import path from 'node:path';

import {
    ID_PATTERN,
    NovelError,
    hashContent,
    projectPaths,
    readJson,
    readProjectFiles,
    withLock,
    writeJson,
} from './store.js';

const INDEX_VERSION = 1;
/** Passages aim for this many characters; paragraphs are never split unless they are longer than the maximum. */
const TARGET_CHUNK_CHARS = 900;
const MAX_CHUNK_CHARS = 1800;
/** Reciprocal rank fusion constant; higher values flatten the influence of top ranks. */
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_RESULTS = 50;
const MAX_QUERY_CHARS = 4000;

const STOPWORDS = new Set(('a an and are as at be been but by did do does for from had has have he her hers him his how i if in into is it its '
    + 'me my no not of on or our she so than that the their them then there these they this those to up was we were what when where which '
    + 'who whom why will with would you your').split(' '));

/**
 * @typedef {(texts: string[], isQuery: boolean) => Promise<number[][]>} EmbedFunction
 */

/**
 * Splits scene prose into passages of whole paragraphs, around TARGET_CHUNK_CHARS each.
 * Paragraphs longer than MAX_CHUNK_CHARS are split at sentence ends.
 * @param {string} content Scene prose (Markdown)
 * @returns {string[]}
 */
export function chunkText(content) {
    const paragraphs = content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
        .flatMap(paragraph => paragraph.length <= MAX_CHUNK_CHARS ? [paragraph] : splitLongParagraph(paragraph));

    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        if (current && current.length + paragraph.length + 2 > TARGET_CHUNK_CHARS) {
            chunks.push(current);
            current = '';
        }
        current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
}

/**
 * @param {string} paragraph Paragraph longer than MAX_CHUNK_CHARS
 * @returns {string[]}
 */
function splitLongParagraph(paragraph) {
    const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+["'”’)]*\s*|$)/g) ?? [paragraph];
    const parts = [];
    let current = '';
    for (const sentence of sentences) {
        if (current && current.length + sentence.length > TARGET_CHUNK_CHARS) {
            parts.push(current.trim());
            current = '';
        }
        current += sentence;
    }
    if (current.trim()) {
        parts.push(current.trim());
    }
    return parts;
}

/**
 * Splits text into lowercase search terms, without stopwords or Markdown.
 * @param {string} text Text to tokenize
 * @returns {string[]}
 */
export function tokenize(text) {
    return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [])
        .map(term => term.replace(/['’]s$/, ''))
        .filter(term => term.length > 1 && !STOPWORDS.has(term));
}

/**
 * Ranks passages for a query with BM25.
 * @param {string[][]} documents Tokenized passages
 * @param {string[]} queryTerms Tokenized query
 * @returns {number[]} Indexes of matching passages, best first
 */
export function rankBm25(documents, queryTerms) {
    const terms = [...new Set(queryTerms)];
    if (terms.length === 0 || documents.length === 0) {
        return [];
    }
    const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
    const documentFrequency = new Map(terms.map(term => [term, 0]));
    const termCounts = documents.map((doc) => {
        const counts = new Map();
        for (const term of doc) {
            if (documentFrequency.has(term)) {
                counts.set(term, (counts.get(term) ?? 0) + 1);
            }
        }
        for (const term of counts.keys()) {
            documentFrequency.set(term, documentFrequency.get(term) + 1);
        }
        return counts;
    });

    const scores = termCounts.map((counts, index) => {
        let score = 0;
        for (const term of terms) {
            const frequency = counts.get(term);
            if (!frequency) {
                continue;
            }
            const df = documentFrequency.get(term);
            const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
            const norm = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (documents[index].length / averageLength));
            score += idf * (frequency * (BM25_K1 + 1)) / norm;
        }
        return { index, score };
    });
    return scores.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).map(entry => entry.index);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/**
 * Merges rankings with reciprocal rank fusion.
 * @param {number[][]} rankings Lists of item indexes, best first
 * @returns {{ index: number, score: number }[]} Fused ranking, best first
 */
export function fuseRankings(rankings) {
    const scores = new Map();
    for (const ranking of rankings) {
        ranking.forEach((index, rank) => scores.set(index, (scores.get(index) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    return [...scores.entries()].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score);
}

/**
 * Brings a project's search index up to date: re-chunks (and re-embeds) scenes whose
 * text or embedding model changed, and removes entries of deleted scenes.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {{ key: string, embed: EmbedFunction } | null} embedding Embedding model, or null for keyword search only
 * @returns {Promise<{ structure: any, scenes: Map<string, { hash: string, chunks: { text: string, vector?: number[] }[] }> }>}
 */
export async function updateIndex(directories, projectId, embedding) {
    const paths = projectPaths(directories, projectId);
    // A separate lock from the project's, so indexing never blocks saving
    return withLock(`${projectId}:index`, async () => {
        const { structure } = readProjectFiles(paths);
        fs.mkdirSync(paths.index, { recursive: true });
        const sceneIds = new Set();
        const scenes = new Map();

        for (const chapter of structure.chapters) {
            for (const scene of chapter.scenes) {
                sceneIds.add(scene.id);
                const filePath = paths.scene(scene.id);
                const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
                const hash = hashContent(content);
                const indexPath = path.join(paths.index, `${scene.id}.json`);
                const cached = readJson(indexPath);
                const embeddingKey = embedding?.key ?? null;

                if (cached?.version === INDEX_VERSION && cached.hash === hash && (cached.embedding === embeddingKey)) {
                    scenes.set(scene.id, cached);
                    continue;
                }
                const texts = chunkText(content);
                const vectors = embedding && texts.length > 0 ? await embedding.embed(texts, false) : null;
                const entry = {
                    version: INDEX_VERSION,
                    hash,
                    embedding: embeddingKey,
                    chunks: texts.map((text, i) => (vectors ? { text, vector: vectors[i] } : { text })),
                };
                writeJson(indexPath, entry);
                scenes.set(scene.id, entry);
            }
        }

        for (const file of fs.readdirSync(paths.index)) {
            const id = path.parse(file).name;
            if (file.endsWith('.json') && !sceneIds.has(id)) {
                fs.rmSync(path.join(paths.index, file));
            }
        }
        return { structure, scenes };
    });
}

/**
 * Searches the manuscript for passages relevant to a query.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {object} options Search options
 * @param {unknown} options.query What to look for
 * @param {unknown} [options.limit] Maximum number of passages
 * @param {unknown} [options.beforeSceneId] Only search scenes before this one
 * @param {unknown} [options.excludeSceneIds] Scenes to leave out
 * @param {{ key: string, embed: EmbedFunction } | null} [options.embedding] Embedding model for semantic ranking
 */
export async function searchManuscript(directories, projectId, { query, limit, beforeSceneId, excludeSceneIds, embedding = null }) {
    if (typeof query !== 'string' || !query.trim()) {
        throw new NovelError(400, 'Empty search');
    }
    const text = query.slice(0, MAX_QUERY_CHARS);
    const max = Math.min(MAX_RESULTS, Math.max(1, Number(limit) || 8));
    const excluded = new Set(Array.isArray(excludeSceneIds) ? excludeSceneIds.filter(id => typeof id === 'string') : []);
    if (beforeSceneId !== undefined && beforeSceneId !== null && (typeof beforeSceneId !== 'string' || !ID_PATTERN.test(beforeSceneId))) {
        throw new NovelError(400, 'Invalid scene ID');
    }

    const { structure, scenes } = await updateIndex(directories, projectId, embedding);

    /** @type {{ sceneId: string, chapterId: string, chapterNumber: number, chapterTitle: string, sceneTitle: string, chunkIndex: number, text: string, vector?: number[] }[]} */
    const candidates = [];
    let reachedLimit = false;
    for (const [chapterIndex, chapter] of structure.chapters.entries()) {
        for (const scene of chapter.scenes) {
            if (scene.id === beforeSceneId) {
                reachedLimit = true;
                break;
            }
            if (excluded.has(scene.id)) {
                continue;
            }
            for (const [chunkIndex, chunk] of (scenes.get(scene.id)?.chunks ?? []).entries()) {
                candidates.push({
                    sceneId: scene.id,
                    chapterId: chapter.id,
                    chapterNumber: chapterIndex + 1,
                    chapterTitle: chapter.title,
                    sceneTitle: scene.title,
                    chunkIndex,
                    text: chunk.text,
                    vector: chunk.vector,
                });
            }
        }
        if (reachedLimit) {
            break;
        }
    }
    if (candidates.length === 0) {
        return [];
    }

    const rankings = [rankBm25(candidates.map(c => tokenize(c.text)), tokenize(text))];
    if (embedding && candidates.every(c => Array.isArray(c.vector))) {
        const [queryVector] = await embedding.embed([text], true);
        rankings.push(candidates
            .map((candidate, index) => ({ index, score: cosine(queryVector, candidate.vector) }))
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.index));
    }

    return fuseRankings(rankings).slice(0, max).map(({ index, score }) => {
        const passage = { ...candidates[index], score: Math.round(score * 10000) / 10000 };
        delete passage.vector;
        return passage;
    });
}
