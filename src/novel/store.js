import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import git from 'isomorphic-git';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { tryParse } from '../util.js';

export const SCENE_STATUSES = Object.freeze(['outline', 'draft', 'revised', 'final']);

const FORMAT_VERSION = 1;
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const GIT_AUTHOR = Object.freeze({ name: 'Novel Studio', email: 'novel-studio@localhost' });
const TRASH_DIR = '.trash';

/** Limits for free-text fields, in characters. */
const LIMITS = Object.freeze({
    title: 300,
    short: 500,
    long: 20000,
    scene: 5_000_000,
});

/** Project fields the client may set, with their maximum lengths. */
const PROJECT_TEXT_FIELDS = Object.freeze({
    title: LIMITS.title,
    author: LIMITS.short,
    genre: LIMITS.short,
    pov: LIMITS.short,
    tense: LIMITS.short,
    styleGuide: LIMITS.long,
});

/**
 * Error with an HTTP status code, thrown for invalid requests.
 */
export class NovelError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} message Error message
     */
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * Serializes async operations per key, so concurrent writes to one project
 * (scene autosaves, structure saves, git snapshots) never interleave.
 */
const locks = new Map();

/**
 * Runs a function while holding the lock for the given key.
 * @template T
 * @param {string} key Lock key
 * @param {() => Promise<T>} fn Function to run
 * @returns {Promise<T>}
 */
export async function withLock(key, fn) {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => { }).then(fn);
    const tail = current.catch(() => { });
    locks.set(key, tail);
    try {
        return await current;
    } finally {
        if (locks.get(key) === tail) {
            locks.delete(key);
        }
    }
}

/**
 * Generates a new random identifier.
 * @param {string} prefix Identifier prefix
 * @returns {string}
 */
export function newId(prefix) {
    return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Checks that an identifier is safe to use as a path segment.
 * @param {unknown} id Identifier to check
 * @param {string} what Name of the identifier, for error messages
 * @returns {string} The identifier
 */
export function assertId(id, what) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new NovelError(400, `Invalid ${what}`);
    }
    return id;
}

/**
 * Coerces a value to a trimmed string of limited length.
 * @param {unknown} value Value to coerce
 * @param {number} maxLength Maximum length
 * @returns {string}
 */
export function text(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/**
 * Hashes scene content, used to detect conflicting edits.
 * @param {string} content Scene content
 * @returns {string}
 */
export function hashContent(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Counts the words in a Markdown text. Markdown syntax characters are not words.
 * @param {string} markdown Markdown text
 * @returns {number}
 */
export function countWords(markdown) {
    return markdown.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Resolves the paths of a project.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function projectPaths(directories, projectId) {
    const root = path.join(directories.novels, assertId(projectId, 'project ID'));
    return {
        root,
        project: path.join(root, 'project.json'),
        structure: path.join(root, 'structure.json'),
        scenes: path.join(root, 'scenes'),
        trash: path.join(root, 'trash'),
        codex: path.join(root, 'codex'),
        index: path.join(root, 'index'),
        summaries: path.join(root, 'memory', 'summaries.json'),
        suggestions: path.join(root, 'suggestions.json'),
        threads: path.join(root, 'threads.json'),
        /** @param {string} sceneId */
        scene: (sceneId) => path.join(root, 'scenes', `${assertId(sceneId, 'scene ID')}.md`),
    };
}

/**
 * Reads a JSON file.
 * @param {string} filePath File path
 * @returns {any} Parsed contents, or null if the file is missing or invalid
 */
export function readJson(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return tryParse(fs.readFileSync(filePath, 'utf8')) ?? null;
}

/**
 * Writes a JSON file atomically.
 * @param {string} filePath File path
 * @param {any} data Data to write
 */
export function writeJson(filePath, data) {
    writeFileAtomicSync(filePath, JSON.stringify(data, null, 4) + '\n', 'utf8');
}

/**
 * Reads a project's metadata and structure.
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @returns {{ project: object, structure: object }}
 */
export function readProjectFiles(paths) {
    const project = readJson(paths.project);
    if (!project) {
        throw new NovelError(404, 'Project not found');
    }
    const structure = readJson(paths.structure) ?? { version: FORMAT_VERSION, chapters: [] };
    return { project, structure };
}

/**
 * Keeps the valid, unique IDs of a list.
 * @param {unknown} list List from the client
 * @returns {string[]}
 */
function idList(list) {
    const ids = (Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && ID_PATTERN.test(id));
    return [...new Set(ids)].slice(0, 100);
}

/**
 * Validates a structure sent by the client. Word counts are always taken from
 * the previous structure, because only the server computes them.
 * @param {any} input Structure from the client
 * @param {any} previous Current structure on disk
 * @returns {object} Normalized structure
 */
function normalizeStructure(input, previous) {
    if (!input || !Array.isArray(input.chapters)) {
        throw new NovelError(400, 'Invalid structure');
    }

    const previousWordCounts = new Map();
    for (const chapter of previous?.chapters ?? []) {
        for (const scene of chapter.scenes ?? []) {
            previousWordCounts.set(scene.id, scene.wordCount ?? 0);
        }
    }

    const seenIds = new Set();
    const uniqueId = (/** @type {unknown} */ id, /** @type {string} */ what) => {
        assertId(id, what);
        if (seenIds.has(id)) {
            throw new NovelError(400, `Duplicate ${what}`);
        }
        seenIds.add(id);
        return /** @type {string} */ (id);
    };

    return {
        version: FORMAT_VERSION,
        chapters: input.chapters.map((/** @type {any} */ chapter) => ({
            id: uniqueId(chapter?.id, 'chapter ID'),
            title: text(chapter.title, LIMITS.title),
            synopsis: text(chapter.synopsis, LIMITS.long),
            scenes: (Array.isArray(chapter.scenes) ? chapter.scenes : []).map((/** @type {any} */ scene) => {
                const id = uniqueId(scene?.id, 'scene ID');
                return {
                    id,
                    title: text(scene.title, LIMITS.title),
                    status: SCENE_STATUSES.includes(scene.status) ? scene.status : SCENE_STATUSES[0],
                    pov: text(scene.pov, LIMITS.short),
                    location: text(scene.location, LIMITS.short),
                    storyTime: text(scene.storyTime, LIMITS.short),
                    beats: text(scene.beats, LIMITS.long),
                    // Codex entries the author pinned to this scene, or left out of it
                    cast: idList(scene.cast),
                    excludedCast: idList(scene.excludedCast),
                    wordCount: previousWordCounts.get(id) ?? 0,
                };
            }),
        })),
    };
}

/**
 * Finds a scene in a structure.
 * @param {any} structure Project structure
 * @param {string} sceneId Scene ID
 * @returns {any} The scene, or undefined
 */
function findScene(structure, sceneId) {
    for (const chapter of structure.chapters) {
        const scene = chapter.scenes.find((/** @type {any} */ s) => s.id === sceneId);
        if (scene) {
            return scene;
        }
    }
    return undefined;
}

/**
 * Sums the word counts of all scenes.
 * @param {any} structure Project structure
 * @returns {number}
 */
function totalWords(structure) {
    return structure.chapters.reduce((sum, /** @type {any} */ chapter) =>
        sum + chapter.scenes.reduce((s, /** @type {any} */ scene) => s + (scene.wordCount ?? 0), 0), 0);
}

/**
 * Updates the project's modification time.
 * @param {ReturnType<typeof projectPaths>} paths Project paths
 * @param {any} project Project metadata
 */
function touchProject(paths, project) {
    project.updatedAt = Date.now();
    writeJson(paths.project, project);
}

/**
 * Initializes the git repository of a project if it doesn't exist.
 * @param {string} dir Project root
 */
async function ensureRepo(dir) {
    if (fs.existsSync(path.join(dir, '.git'))) {
        return;
    }
    await git.init({ fs, dir, defaultBranch: 'main' });
}

/** Folders that are never snapshotted: deleted scenes and the rebuildable search index. */
const GIT_IGNORED = Object.freeze(['trash/', 'index/']);

/**
 * Makes sure the project's .gitignore lists every ignored folder, also in older projects.
 * @param {string} dir Project root
 */
function ensureGitignore(dir) {
    const filePath = path.join(dir, '.gitignore');
    const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split('\n').map(line => line.trim()) : [];
    const missing = GIT_IGNORED.filter(entry => !lines.includes(entry));
    if (missing.length > 0) {
        fs.writeFileSync(filePath, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');
    }
}

/**
 * Commits all changes in a project. Must be called while holding the project lock.
 * @param {string} dir Project root
 * @param {string} message Commit message
 * @returns {Promise<string|null>} Commit ID, or null if nothing changed
 */
async function commitAll(dir, message) {
    await ensureRepo(dir);
    ensureGitignore(dir);
    const matrix = await git.statusMatrix({ fs, dir });
    let changed = false;

    for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 1 && workdir === 1 && stage === 1) {
            continue;
        }
        changed = true;
        if (workdir === 0) {
            await git.remove({ fs, dir, filepath });
        } else {
            await git.add({ fs, dir, filepath });
        }
    }

    if (!changed) {
        return null;
    }
    return git.commit({ fs, dir, message, author: GIT_AUTHOR });
}

/**
 * Gets the time of the latest commit.
 * @param {string} dir Project root
 * @returns {Promise<number>} Timestamp in milliseconds, or 0 if there are no commits
 */
async function lastCommitTime(dir) {
    try {
        const [latest] = await git.log({ fs, dir, depth: 1 });
        return latest ? latest.commit.author.timestamp * 1000 : 0;
    } catch {
        return 0;
    }
}

/**
 * Lists all projects of a user, most recently updated first.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 */
export async function listProjects(directories) {
    const entries = await fs.promises.readdir(directories.novels, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
            continue;
        }
        try {
            const paths = projectPaths(directories, entry.name);
            const { project, structure } = readProjectFiles(paths);
            projects.push({
                ...project,
                chapterCount: structure.chapters.length,
                wordCount: totalWords(structure),
            });
        } catch (error) {
            console.warn(`Skipping unreadable novel project ${entry.name}:`, error.message);
        }
    }

    return projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Applies client-supplied fields to project metadata.
 * @param {any} project Project metadata to update
 * @param {any} fields Fields from the client
 */
function applyProjectFields(project, fields) {
    for (const [key, maxLength] of Object.entries(PROJECT_TEXT_FIELDS)) {
        if (typeof fields?.[key] === 'string') {
            project[key] = text(fields[key], maxLength);
        }
    }
    if (fields?.targetWords !== undefined) {
        const target = Number(fields.targetWords);
        project.targetWords = Number.isFinite(target) && target > 0 ? Math.round(target) : 0;
    }
}

/**
 * Creates a project with one empty chapter and scene.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {any} fields Initial project fields
 */
export async function createProject(directories, fields) {
    const id = newId('novel');
    const paths = projectPaths(directories, id);
    const now = Date.now();

    const project = {
        version: FORMAT_VERSION,
        id,
        title: 'Untitled novel',
        author: '',
        genre: '',
        pov: '',
        tense: '',
        styleGuide: '',
        targetWords: 0,
        createdAt: now,
        updatedAt: now,
    };
    applyProjectFields(project, fields);
    if (!project.title.trim()) {
        project.title = 'Untitled novel';
    }

    const sceneId = newId('scene');
    const structure = normalizeStructure({
        chapters: [{ id: newId('chapter'), title: 'Chapter 1', scenes: [{ id: sceneId, title: 'Scene 1' }] }],
    }, null);

    fs.mkdirSync(paths.scenes, { recursive: true });
    writeJson(paths.project, project);
    writeJson(paths.structure, structure);
    fs.writeFileSync(paths.scene(sceneId), '', 'utf8');

    await withLock(id, () => commitAll(paths.root, 'Create project'));
    return { project, structure };
}

/** Upper limits for imported manuscripts. */
const IMPORT_LIMITS = Object.freeze({ chapters: 1000, scenes: 5000 });

/**
 * Creates a project from an imported manuscript that the client already split into
 * chapters and scenes.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {any} input { title, author, chapters: [{ title, scenes: [{ title, content }] }] }
 */
export async function importProject(directories, input) {
    const chapters = Array.isArray(input?.chapters) ? input.chapters : [];
    const sceneCount = chapters.reduce((sum, chapter) => sum + (Array.isArray(chapter?.scenes) ? chapter.scenes.length : 0), 0);
    if (chapters.length === 0 || sceneCount === 0) {
        throw new NovelError(400, 'The manuscript has no chapters to import');
    }
    if (chapters.length > IMPORT_LIMITS.chapters || sceneCount > IMPORT_LIMITS.scenes) {
        throw new NovelError(400, 'The manuscript has too many chapters or scenes');
    }

    const { project } = await createProject(directories, { title: input.title, author: input.author });
    const paths = projectPaths(directories, project.id);
    return withLock(project.id, async () => {
        // Replace the starter chapter that createProject made
        for (const file of fs.readdirSync(paths.scenes)) {
            fs.rmSync(path.join(paths.scenes, file));
        }
        const draft = {
            chapters: chapters.map((/** @type {any} */ chapter, index) => ({
                id: newId('chapter'),
                title: text(chapter.title, LIMITS.title) || `Chapter ${index + 1}`,
                scenes: (Array.isArray(chapter.scenes) ? chapter.scenes : []).map((/** @type {any} */ scene, sceneIndex) => ({
                    id: newId('scene'),
                    title: text(scene?.title, LIMITS.title) || `Scene ${sceneIndex + 1}`,
                    status: 'draft',
                    content: typeof scene?.content === 'string' ? scene.content.slice(0, LIMITS.scene) : '',
                })),
            })),
        };
        const structure = normalizeStructure(draft, null);
        draft.chapters.forEach((chapter, chapterIndex) => {
            chapter.scenes.forEach((scene, sceneIndex) => {
                fs.writeFileSync(paths.scene(scene.id), scene.content, 'utf8');
                structure.chapters[chapterIndex].scenes[sceneIndex].wordCount = countWords(scene.content);
            });
        });
        writeJson(paths.structure, structure);
        touchProject(paths, project);
        await commitAll(paths.root, 'Import manuscript');
        return { project, structure };
    });
}

/**
 * Gets a project's metadata and structure.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export function getProject(directories, projectId) {
    return readProjectFiles(projectPaths(directories, projectId));
}

/**
 * Updates a project's metadata.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {any} fields Fields to update
 */
export async function updateProject(directories, projectId, fields) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        const { project } = readProjectFiles(paths);
        applyProjectFields(project, fields);
        if (!project.title.trim()) {
            project.title = 'Untitled novel';
        }
        touchProject(paths, project);
        return project;
    });
}

/**
 * Moves a project into the user's novel trash folder.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 */
export async function deleteProject(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        readProjectFiles(paths);
        const trashRoot = path.join(directories.novels, TRASH_DIR);
        fs.mkdirSync(trashRoot, { recursive: true });
        fs.renameSync(paths.root, path.join(trashRoot, `${projectId}-${Date.now()}`));
    });
}

/**
 * Saves a project's structure. Scene files that are no longer referenced are
 * moved to the project's trash folder; new scenes get an empty file.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {any} input Structure from the client
 */
export async function saveStructure(directories, projectId, input) {
    const paths = projectPaths(directories, projectId);
    return withLock(projectId, async () => {
        const { project, structure: previous } = readProjectFiles(paths);
        const structure = normalizeStructure(input, previous);

        const sceneIds = new Set(structure.chapters.flatMap(c => c.scenes.map(s => s.id)));
        fs.mkdirSync(paths.scenes, { recursive: true });

        for (const file of fs.readdirSync(paths.scenes)) {
            const sceneId = path.parse(file).name;
            if (file.endsWith('.md') && !sceneIds.has(sceneId)) {
                fs.mkdirSync(paths.trash, { recursive: true });
                fs.renameSync(path.join(paths.scenes, file), path.join(paths.trash, `${sceneId}-${Date.now()}.md`));
            }
        }
        for (const sceneId of sceneIds) {
            if (!fs.existsSync(paths.scene(sceneId))) {
                fs.writeFileSync(paths.scene(sceneId), '', 'utf8');
            }
        }

        writeJson(paths.structure, structure);
        touchProject(paths, project);
        return structure;
    });
}

/**
 * Reads a scene's prose.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} sceneId Scene ID
 */
export function getScene(directories, projectId, sceneId) {
    const paths = projectPaths(directories, projectId);
    const { structure } = readProjectFiles(paths);
    if (!findScene(structure, sceneId)) {
        throw new NovelError(404, 'Scene not found');
    }
    const filePath = paths.scene(sceneId);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    return { content, hash: hashContent(content) };
}

/**
 * Saves a scene's prose and updates its word count. Takes an automatic
 * snapshot if the last one is older than the auto-snapshot interval.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} sceneId Scene ID
 * @param {unknown} content New scene content (Markdown)
 * @param {unknown} baseHash Hash of the content the edit was based on
 */
export async function saveScene(directories, projectId, sceneId, content, baseHash) {
    if (typeof content !== 'string' || content.length > LIMITS.scene) {
        throw new NovelError(400, 'Invalid scene content');
    }
    const paths = projectPaths(directories, projectId);

    return withLock(projectId, async () => {
        const { project, structure } = readProjectFiles(paths);
        const scene = findScene(structure, sceneId);
        if (!scene) {
            throw new NovelError(404, 'Scene not found');
        }

        const filePath = paths.scene(sceneId);
        const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        if (typeof baseHash === 'string' && baseHash !== hashContent(current)) {
            throw new NovelError(409, 'The scene was changed elsewhere since it was opened');
        }

        writeFileAtomicSync(filePath, content, 'utf8');
        scene.wordCount = countWords(content);
        writeJson(paths.structure, structure);
        touchProject(paths, project);

        if (Date.now() - await lastCommitTime(paths.root) > AUTO_SNAPSHOT_INTERVAL_MS) {
            await commitAll(paths.root, 'Autosave');
        }

        return { hash: hashContent(content), wordCount: scene.wordCount };
    });
}

/**
 * Gets the prose of the scenes before a scene, newest first, across chapter
 * boundaries, until a character budget is used up. The oldest returned scene
 * is cut from its start if it does not fit whole.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} sceneId Scene ID
 * @param {unknown} maxChars Character budget
 */
export function getPrecedingScenes(directories, projectId, sceneId, maxChars) {
    const budget = Number(maxChars);
    if (!Number.isFinite(budget) || budget < 0) {
        throw new NovelError(400, 'Invalid character budget');
    }
    const paths = projectPaths(directories, projectId);
    const { structure } = readProjectFiles(paths);

    const ordered = structure.chapters.flatMap((/** @type {any} */ chapter, chapterIndex) =>
        chapter.scenes.map((/** @type {any} */ scene) => ({ chapter, chapterIndex, scene })));
    const index = ordered.findIndex(entry => entry.scene.id === sceneId);
    if (index === -1) {
        throw new NovelError(404, 'Scene not found');
    }

    const scenes = [];
    let remaining = budget;
    let i = index - 1;
    for (; i >= 0 && remaining > 0; i--) {
        const { chapter, chapterIndex, scene } = ordered[i];
        const filePath = paths.scene(scene.id);
        const content = (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '').trim();
        if (!content) {
            continue;
        }
        const truncated = content.length > remaining;
        scenes.push({
            chapterId: chapter.id,
            chapterNumber: chapterIndex + 1,
            chapterTitle: chapter.title,
            sceneId: scene.id,
            title: scene.title,
            content: truncated ? content.slice(content.length - remaining) : content,
            truncated,
        });
        remaining -= Math.min(content.length, remaining);
    }

    // More story exists before what was returned if a scene was cut or scenes were left unread
    const hasMore = scenes.at(-1)?.truncated === true || ordered.slice(0, i + 1).some(entry => {
        const filePath = paths.scene(entry.scene.id);
        return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    });
    return { scenes, hasMore };
}

/**
 * Commits all changes in a project.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {unknown} message Commit message
 * @returns {Promise<string|null>} Commit ID, or null if nothing changed
 */
export async function snapshot(directories, projectId, message) {
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    const commitMessage = text(message, LIMITS.short).trim() || 'Snapshot';
    return withLock(projectId, () => commitAll(paths.root, commitMessage));
}

/**
 * Lists the snapshots of a project, or of one scene, newest first.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} [sceneId] Scene ID; if set, only snapshots that changed this scene
 */
export async function getHistory(directories, projectId, sceneId) {
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    if (!fs.existsSync(path.join(paths.root, '.git'))) {
        return [];
    }
    const filepath = sceneId ? `scenes/${assertId(sceneId, 'scene ID')}.md` : undefined;
    try {
        const commits = await git.log({ fs, dir: paths.root, depth: 100, filepath });
        return commits.map(entry => ({
            oid: entry.oid,
            message: entry.commit.message.trim(),
            timestamp: entry.commit.author.timestamp * 1000,
        }));
    } catch (error) {
        // isomorphic-git throws when a file has no history yet
        if (error?.code === 'NotFoundError') {
            return [];
        }
        throw error;
    }
}

/**
 * Reads a scene's prose as it was in a snapshot.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {string} sceneId Scene ID
 * @param {unknown} oid Commit ID
 */
export async function getSceneVersion(directories, projectId, sceneId, oid) {
    if (typeof oid !== 'string' || !/^[0-9a-f]{40}$/.test(oid)) {
        throw new NovelError(400, 'Invalid snapshot ID');
    }
    const paths = projectPaths(directories, projectId);
    readProjectFiles(paths);
    try {
        const { blob } = await git.readBlob({ fs, dir: paths.root, oid, filepath: `scenes/${assertId(sceneId, 'scene ID')}.md` });
        return { content: Buffer.from(blob).toString('utf8') };
    } catch (error) {
        if (error?.code === 'NotFoundError') {
            throw new NovelError(404, 'The scene does not exist in this snapshot');
        }
        throw error;
    }
}
