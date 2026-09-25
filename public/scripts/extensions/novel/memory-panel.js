import { novelApi } from './api.js';
import {
    buildChapterSummaryMessages,
    buildSceneSummaryMessages,
    buildSynopsisMessages,
    collectStoryMemory,
    listStaleSummaries,
    SUMMARY_MAX_TOKENS,
} from './ai/memory-logic.js';
import { describeError, requestText } from './ai/generate.js';
import { chapterLabel } from './ai/prompt.js';

/** Scene statuses that mean "finished enough to summarize". */
const SUMMARIZE_ON_STATUS = new Set(['revised', 'final']);
const REFRESH_DELAY_MS = 2000;
const EDIT_SAVE_DELAY_MS = 1000;

/**
 * Scene and chapter summaries, the book synopsis, and keeping them up to date.
 */
export class MemoryPanel {
    /** Summary state from the server: text, source hash and staleness per scene, chapter and the book. */
    state = null;
    /** @type {import('./studio.js').NovelStudio} */
    #studio;
    /** @type {JQuery<HTMLElement>} */
    #root;
    /** @type {AbortController | null} */
    #run = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    #refreshTimer = null;
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    #editTimers = new Map();

    /**
     * @param {import('./studio.js').NovelStudio} studio Studio that owns the panel
     */
    constructor(studio) {
        this.#studio = studio;
        this.#root = studio.$root;
        this.#bindEvents();
    }

    get #project() {
        return this.#studio.project;
    }

    get isRunning() {
        return this.#run !== null;
    }

    /** Loads the summary state of the open project. */
    async load() {
        const projectId = this.#project?.id;
        if (!projectId) {
            return;
        }
        const state = await novelApi.getSummaryState(projectId);
        if (this.#project?.id === projectId) {
            this.state = state;
            this.render();
        }
    }

    /** Reloads the state shortly, e.g. after the scene text was saved. */
    scheduleRefresh() {
        clearTimeout(this.#refreshTimer);
        this.#refreshTimer = setTimeout(() => this.load().catch(error => console.warn('Novel Studio: could not refresh summaries', error)), REFRESH_DELAY_MS);
    }

    /** Forgets the state when a project is closed, stopping any running updates. */
    clear() {
        this.#run?.abort();
        clearTimeout(this.#refreshTimer);
        this.state = null;
        this.render();
    }

    /**
     * Collects the synopsis and summaries before a scene, for a writing prompt.
     * @param {string} sceneId Current scene
     * @returns {import('./ai/memory-logic.js').StoryMemory}
     */
    memoryForPrompt(sceneId) {
        return collectStoryMemory(this.#studio.structure, this.state, sceneId);
    }

    // ---- Rendering ----

    render() {
        const current = this.#studio.getCurrentScene();
        this.#renderBlock('scene', current?.scene.id ?? null);
        this.#renderBlock('chapter', current?.chapter.id ?? null);
        this.#renderBlock('book', null);
        this.#renderOverview();
    }

    /**
     * @param {'scene' | 'chapter' | 'book'} level
     * @param {string | null} key
     */
    #entry(level, key) {
        if (!this.state) {
            return null;
        }
        return level === 'book' ? this.state.book : this.state[`${level}s`]?.[key] ?? null;
    }

    /**
     * Shows one summary with its status. Leaves the text alone while the author is editing it.
     * @param {'scene' | 'chapter' | 'book'} level
     * @param {string | null} key
     */
    #renderBlock(level, key) {
        const $block = this.#root.find(`.ns-summary-block[data-level="${level}"]`);
        const entry = this.#entry(level, key);
        const $text = $block.find('.ns-summary-text');
        $block.attr('data-key', key ?? '');
        if (!$text.is(':focus')) {
            $text.val(entry?.text ?? '');
        }
        $text.prop('disabled', !entry || entry.empty);
        $block.find('.ns-summary-regenerate').prop('disabled', !entry || entry.empty || this.isRunning);

        let status = '';
        let tone = 'muted';
        if (!entry) {
            status = '';
        } else if (entry.empty) {
            status = level === 'scene' ? 'Scene is empty' : 'Nothing written yet';
        } else if (!entry.text) {
            status = 'Not written yet';
            tone = 'stale';
        } else if (entry.stale) {
            status = 'Out of date';
            tone = 'stale';
        } else {
            status = 'Up to date';
        }
        $block.find('.ns-summary-status').text(status).attr('data-tone', tone);
    }

    #renderOverview() {
        const $chapters = this.#root.find('.ns-memory-chapters').empty();
        const structure = this.#studio.structure;
        if (!this.state || !structure) {
            this.#root.find('.ns-memory-counts').text('');
            return;
        }
        const tasks = listStaleSummaries(structure, this.state);
        this.#root.find('.ns-memory-counts').text(tasks.length ? `${tasks.length} out of date` : 'All summaries are up to date.');
        this.#root.find('.ns-memory-update').prop('disabled', tasks.length === 0 || this.isRunning).toggle(!this.isRunning);
        this.#root.find('.ns-memory-stop').prop('hidden', !this.isRunning);
        if (!this.isRunning && tasks.length > 0 && this.#root.find('.ns-memory-progress').text() === 'Summaries are up to date.') {
            this.#progress('');
        }

        for (const [index, chapter] of structure.chapters.entries()) {
            const entry = this.state.chapters[chapter.id];
            const scenes = chapter.scenes.map(scene => this.state.scenes[scene.id]).filter(scene => scene && !scene.empty);
            const fresh = scenes.filter(scene => !scene.stale).length;
            const $row = $('<div class="ns-memory-chapter">');
            $row.append($('<span class="ns-memory-chapter-name">').text(chapterLabel(index + 1, chapter.title)));
            const chapterStatus = !entry || entry.empty ? 'empty' : entry.stale || !entry.text ? 'out of date' : 'up to date';
            $row.append($('<span class="ns-memory-chapter-status">').attr('data-tone', chapterStatus === 'out of date' ? 'stale' : 'muted')
                .text(scenes.length ? `${fresh}/${scenes.length} scenes · chapter ${chapterStatus}` : 'no text yet'));
            $chapters.append($row);
        }
    }

    // ---- Generation ----

    /**
     * Called when a scene's status changes: finished scenes get their scene, chapter and book summaries updated.
     * @param {string} sceneId Scene ID
     * @param {string} status New status
     */
    onStatusChanged(sceneId, status) {
        if (SUMMARIZE_ON_STATUS.has(status) && this.#studio.settings.ai.backgroundProfileId && !this.isRunning) {
            this.#execute(async (signal) => {
                await this.#writeScene(sceneId, signal);
                const chapter = this.#studio.structure.chapters.find(c => c.scenes.some(s => s.id === sceneId));
                if (chapter) {
                    await this.#writeChapter(chapter.id, signal, false);
                }
                await this.#writeBook(signal, false);
            }, { quiet: true });
        }
    }

    /** Writes every out-of-date summary, bottom-up. */
    updateAll() {
        return this.#execute(async (signal) => {
            let done = 0;
            // Each summary is tried at most once per run, so a scene that keeps changing cannot loop forever
            const attempted = new Set();
            // Re-read the state after every summary: writing a scene summary makes its chapter stale, and so on
            for (;;) {
                const state = await novelApi.getSummaryState(this.#project.id);
                const tasks = listStaleSummaries(this.#studio.structure, state).filter(t => !attempted.has(`${t.level}:${t.key}`));
                const [task] = tasks;
                if (!task || signal.aborted) {
                    break;
                }
                attempted.add(`${task.level}:${task.key}`);
                this.#progress(`Writing summary ${done + 1} of ${done + tasks.length}: ${this.#taskLabel(task)}…`);
                if (task.level === 'scene') {
                    await this.#writeScene(task.key, signal);
                } else if (task.level === 'chapter') {
                    await this.#writeChapter(task.key, signal, true);
                } else {
                    await this.#writeBook(signal, true);
                }
                done++;
            }
            return done;
        });
    }

    /**
     * Rewrites one summary on request, first updating what it is written from.
     * @param {'scene' | 'chapter' | 'book'} level
     * @param {string | null} key
     */
    regenerate(level, key) {
        return this.#execute(async (signal) => {
            if (level === 'scene') {
                await this.#writeScene(key, signal);
            } else if (level === 'chapter') {
                await this.#writeChapter(key, signal, true);
            } else {
                await this.#writeBook(signal, true);
            }
        });
    }

    /**
     * Runs one summary job at a time, with progress, stop and error reporting.
     * @param {(signal: AbortSignal) => Promise<any>} job
     * @param {{ quiet?: boolean }} [options] Quiet jobs only report errors
     */
    async #execute(job, { quiet = false } = {}) {
        if (this.isRunning || !this.#project) {
            return;
        }
        const projectId = this.#project.id;
        this.#run = new AbortController();
        const signal = this.#run.signal;
        this.render();
        try {
            await job(signal);
            if (!quiet && !signal.aborted) {
                this.#progress('Summaries are up to date.');
            }
        } catch (error) {
            if (signal.aborted) {
                this.#progress('Stopped.');
            } else {
                console.error('Novel Studio: summary update failed', error);
                this.#progress('');
                toastr.error(`Could not write the summary: ${describeError(error)}`, 'Novel Studio');
            }
        } finally {
            this.#run = null;
            if (this.#project?.id === projectId) {
                await this.load().catch(() => { });
            }
        }
    }

    /** @param {string} text */
    #progress(text) {
        this.#root.find('.ns-memory-progress').text(text);
    }

    /** @param {{ level: string, key: string | null }} task */
    #taskLabel(task) {
        const chapters = this.#studio.structure.chapters;
        if (task.level === 'book') {
            return 'book synopsis';
        }
        if (task.level === 'chapter') {
            const index = chapters.findIndex(c => c.id === task.key);
            return index === -1 ? 'chapter' : chapterLabel(index + 1, chapters[index].title);
        }
        for (const chapter of chapters) {
            const scene = chapter.scenes.find(s => s.id === task.key);
            if (scene) {
                return `scene "${scene.title || 'Untitled'}"`;
            }
        }
        return 'scene';
    }

    /**
     * Summarizes a scene from its saved prose.
     * @param {string} sceneId
     * @param {AbortSignal} signal
     */
    async #writeScene(sceneId, signal) {
        const studio = this.#studio;
        const found = this.#findScene(sceneId);
        if (!found) {
            return;
        }
        if (studio.editor.sceneId === sceneId) {
            await studio.editor.flush();
        }
        // The hash returned with the content is exactly what the summary is written from
        const { content, hash } = await novelApi.getScene(this.#project.id, sceneId);
        if (!content.trim()) {
            return;
        }
        const text = await requestText({
            profileId: studio.settings.ai.backgroundProfileId,
            role: 'background',
            messages: buildSceneSummaryMessages({ project: studio.project, ...found, sceneText: content }),
            maxTokens: SUMMARY_MAX_TOKENS.scene,
            signal,
        });
        await this.#save('scene', sceneId, text, hash);
    }

    /**
     * Summarizes a chapter from its scene summaries, writing missing scene summaries first.
     * @param {string} chapterId
     * @param {AbortSignal} signal
     * @param {boolean} force Rewrite even if the chapter summary is up to date
     */
    async #writeChapter(chapterId, signal, force) {
        const structure = this.#studio.structure;
        const index = structure.chapters.findIndex(c => c.id === chapterId);
        if (index === -1) {
            return;
        }
        const chapter = structure.chapters[index];
        let state = await novelApi.getSummaryState(this.#project.id);
        for (const scene of chapter.scenes) {
            if (state.scenes[scene.id]?.stale) {
                await this.#writeScene(scene.id, signal);
            }
        }
        state = await novelApi.getSummaryState(this.#project.id);
        const entry = state.chapters[chapterId];
        if (!entry || entry.empty || (!force && !entry.stale)) {
            return;
        }
        const scenes = chapter.scenes
            .filter(scene => state.scenes[scene.id] && !state.scenes[scene.id].empty)
            .map(scene => ({ title: scene.title, text: state.scenes[scene.id].text }));
        const text = await requestText({
            profileId: this.#studio.settings.ai.backgroundProfileId,
            role: 'background',
            messages: buildChapterSummaryMessages({ project: this.#studio.project, chapter, chapterNumber: index + 1, scenes }),
            maxTokens: SUMMARY_MAX_TOKENS.chapter,
            signal,
        });
        await this.#save('chapter', chapterId, text, entry.sourceHash);
    }

    /**
     * Writes the book synopsis from the chapter summaries.
     * @param {AbortSignal} signal
     * @param {boolean} force Rewrite even if the synopsis is up to date
     */
    async #writeBook(signal, force) {
        const state = await novelApi.getSummaryState(this.#project.id);
        if (state.book.empty || (!force && !state.book.stale)) {
            return;
        }
        const chapters = this.#studio.structure.chapters
            .map((chapter, index) => ({ number: index + 1, title: chapter.title, entry: state.chapters[chapter.id] }))
            .filter(chapter => chapter.entry && !chapter.entry.empty && chapter.entry.text)
            .map(({ number, title, entry }) => ({ number, title, text: entry.text }));
        if (chapters.length === 0) {
            return;
        }
        const text = await requestText({
            profileId: this.#studio.settings.ai.backgroundProfileId,
            role: 'background',
            messages: buildSynopsisMessages({ project: this.#studio.project, chapters }),
            maxTokens: SUMMARY_MAX_TOKENS.book,
            signal,
        });
        await this.#save('book', null, text, state.book.sourceHash);
    }

    /**
     * @param {'scene' | 'chapter' | 'book'} level
     * @param {string | null} key
     * @param {string} text
     * @param {string} sourceHash
     */
    async #save(level, key, text, sourceHash) {
        if (!text) {
            throw new Error('The background model returned an empty summary.');
        }
        await novelApi.saveSummary(this.#project.id, level, key, text, sourceHash);
    }

    /**
     * @param {string} sceneId
     * @returns {{ chapter: any, chapterNumber: number, scene: any } | null}
     */
    #findScene(sceneId) {
        for (const [index, chapter] of (this.#studio.structure?.chapters ?? []).entries()) {
            const scene = chapter.scenes.find(s => s.id === sceneId);
            if (scene) {
                return { chapter, chapterNumber: index + 1, scene };
            }
        }
        return null;
    }

    // ---- Events ----

    #bindEvents() {
        const $root = this.#root;
        $root.on('click', '.ns-memory-update', () => this.updateAll());
        $root.on('click', '.ns-memory-stop', () => this.#run?.abort());
        $root.on('click', '.ns-summary-regenerate', (event) => {
            const $block = $(event.currentTarget).closest('.ns-summary-block');
            const level = /** @type {'scene' | 'chapter' | 'book'} */ ($block.attr('data-level'));
            this.regenerate(level, $block.attr('data-key') || null);
        });

        // Summaries are editable; an edit counts as up to date with the current source
        $root.on('input', '.ns-summary-text', (event) => {
            const $block = $(event.currentTarget).closest('.ns-summary-block');
            const level = /** @type {'scene' | 'chapter' | 'book'} */ ($block.attr('data-level'));
            const key = $block.attr('data-key') || null;
            const timerKey = `${level}:${key}`;
            clearTimeout(this.#editTimers.get(timerKey));
            this.#editTimers.set(timerKey, setTimeout(async () => {
                this.#editTimers.delete(timerKey);
                const entry = this.#entry(level, key);
                if (!entry || !this.#project) {
                    return;
                }
                try {
                    await novelApi.saveSummary(this.#project.id, level, key, String($(event.currentTarget).val()), entry.sourceHash);
                    await this.load();
                } catch (error) {
                    toastr.error(`Could not save the summary: ${error.message}`, 'Novel Studio');
                }
            }, EDIT_SAVE_DELAY_MS));
        });
    }
}
