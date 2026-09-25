import { DOMPurify, moment, showdown } from '../../../lib.js';
import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { novelApi } from './api.js';
import { SceneEditor } from './editor.js';
import { WritingAssistant } from './ai/assistant.js';
import { DEFAULT_WRITER_INSTRUCTIONS, LENGTHS } from './ai/prompt.js';
import { getProfiles } from './ai/generate.js';

const MODULE = 'novel';
const STRUCTURE_SAVE_DELAY_MS = 800;
const NARROW_LAYOUT = '(max-width: 1000px)';

const SAVE_STATUS_TEXT = Object.freeze({
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Save failed, retrying',
    conflict: 'Edited elsewhere',
});

/**
 * Generates a client-side ID that the server accepts.
 * @param {string} prefix ID prefix
 * @returns {string}
 */
function newId(prefix) {
    return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
    return Number(value || 0).toLocaleString();
}

/**
 * The Novel Studio workspace: project list, chapter/scene tree, editor and scene panel.
 */
export class NovelStudio {
    /** @type {JQuery<HTMLElement>} */
    $root;
    /** @type {SceneEditor} */
    editor;
    /** @type {WritingAssistant} */
    assistant;
    /** @type {any} */
    project = null;
    /** @type {any} */
    structure = null;
    /** Chain of structure saves, so they reach the server in order. */
    #structureSave = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | null} */
    #structureTimer = null;
    #onBeforeUnload = () => {
        this.editor.flush({ keepalive: true });
        if (this.#structureTimer && this.project) {
            novelApi.saveStructure(this.project.id, this.structure, { keepalive: true });
        }
    };

    /**
     * Creates the studio and mounts it in the page, hidden.
     * @returns {Promise<NovelStudio>}
     */
    static async create() {
        const studio = new NovelStudio();
        const html = await renderExtensionTemplateAsync(MODULE, 'studio');
        studio.$root = $(html);
        studio.$root.hide();
        $('body').append(studio.$root);
        studio.#bindEvents();
        return studio;
    }

    get settings() {
        return extension_settings[MODULE];
    }

    get isOpen() {
        return this.$root.is(':visible');
    }

    /** Shows the studio and reopens the last project, if any. */
    async open() {
        this.$root.show();
        window.addEventListener('beforeunload', this.#onBeforeUnload);
        if (window.matchMedia(NARROW_LAYOUT).matches) {
            this.$root.addClass('ns-hide-left ns-hide-right');
        }
        if (this.project) {
            return;
        }
        const lastProjectId = this.settings.lastProjectId;
        if (lastProjectId) {
            try {
                await this.openProject(lastProjectId);
                return;
            } catch (error) {
                console.warn('Novel Studio: could not reopen the last project', error);
            }
        }
        await this.showProjects();
    }

    /** Saves pending work, takes a snapshot and hides the studio. */
    async close() {
        if (!await this.#leaveProject('Closed Novel Studio')) {
            return;
        }
        window.removeEventListener('beforeunload', this.#onBeforeUnload);
        this.$root.hide();
    }

    /** Shows the list of projects. */
    async showProjects() {
        if (!await this.#leaveProject('Switched project')) {
            return;
        }
        this.project = null;
        this.structure = null;
        this.editor.close();
        this.$root.attr('data-view', 'projects');
        this.$root.find('.ns-project-title').text('');
        this.$root.find('.ns-stats').text('');
        await this.#renderProjectList();
    }

    /**
     * Opens a project in the workspace.
     * @param {string} projectId Project ID
     */
    async openProject(projectId) {
        const { project, structure } = await novelApi.getProject(projectId);
        this.project = project;
        this.structure = structure;
        this.settings.lastProjectId = project.id;
        saveSettingsDebounced();

        this.$root.attr('data-view', 'workspace');
        this.$root.find('.ns-project-title').text(project.title);
        this.renderTree();

        const lastSceneId = this.settings.lastSceneByProject?.[project.id];
        const sceneId = this.#findScene(lastSceneId) ? lastSceneId : this.structure.chapters[0]?.scenes[0]?.id;
        if (sceneId) {
            await this.openScene(sceneId);
        } else {
            this.#showEditor(false);
            this.#renderStats();
        }
    }

    /**
     * Opens a scene in the editor, saving the current one first.
     * @param {string} sceneId Scene ID
     */
    async openScene(sceneId) {
        this.assistant.discard();
        if (!await this.#flushEditor()) {
            return;
        }
        const { content, hash } = await novelApi.getScene(this.project.id, sceneId);
        this.editor.open(this.project.id, sceneId, content, hash);

        this.settings.lastSceneByProject ??= {};
        this.settings.lastSceneByProject[this.project.id] = sceneId;
        saveSettingsDebounced();

        this.#showEditor(true);
        this.#renderSceneMeta();
        this.#highlightCurrentScene();
        this.#renderStats();
        if (this.$root.find('.ns-tab[data-tab="history"]').hasClass('active')) {
            await this.#renderHistory();
        }
        if (window.matchMedia(NARROW_LAYOUT).matches) {
            this.$root.addClass('ns-hide-left');
        }
    }

    /** Saves the structure right away, after any saves already in flight. */
    saveStructureNow() {
        clearTimeout(this.#structureTimer);
        this.#structureTimer = null;
        if (!this.project) {
            return this.#structureSave;
        }
        const projectId = this.project.id;
        this.#structureSave = this.#structureSave
            .catch(() => { })
            .then(async () => {
                // Send the latest state, even if it changed while the previous save was running
                const saved = await novelApi.saveStructure(projectId, this.structure);
                if (this.project?.id === projectId) {
                    this.#mergeWordCounts(saved);
                }
            })
            .catch((error) => {
                console.error('Novel Studio: failed to save structure', error);
                toastr.error(`Could not save the chapter list: ${error.message}`, 'Novel Studio');
            });
        return this.#structureSave;
    }

    /**
     * Saves pending edits in the editor.
     * @returns {Promise<boolean>} False if edits could not be saved
     */
    async #flushEditor() {
        await this.editor.flush();
        if (this.editor.isDirty) {
            toastr.error('The current scene could not be saved. Check the connection to the server and try again.', 'Novel Studio');
            return false;
        }
        return true;
    }

    /**
     * Saves everything and snapshots the open project before leaving it.
     * @param {string} message Snapshot message
     * @returns {Promise<boolean>} False if pending edits could not be saved
     */
    async #leaveProject(message) {
        if (!this.project) {
            return true;
        }
        this.assistant.discard();
        if (!await this.#flushEditor()) {
            return false;
        }
        await this.saveStructureNow();
        try {
            await novelApi.snapshot(this.project.id, message);
        } catch (error) {
            console.warn('Novel Studio: snapshot failed', error);
        }
        return true;
    }

    /**
     * Copies server-computed word counts into the local structure.
     * @param {any} saved Structure returned by the server
     */
    #mergeWordCounts(saved) {
        const counts = new Map(saved.chapters.flatMap(c => c.scenes.map(s => [s.id, s.wordCount])));
        for (const chapter of this.structure.chapters) {
            for (const scene of chapter.scenes) {
                if (counts.has(scene.id) && scene.id !== this.editor.sceneId) {
                    scene.wordCount = counts.get(scene.id);
                }
            }
        }
    }

    /**
     * @param {string} sceneId
     * @returns {{ chapter: any, scene: any } | null}
     */
    #findScene(sceneId) {
        for (const chapter of this.structure?.chapters ?? []) {
            const scene = chapter.scenes.find(s => s.id === sceneId);
            if (scene) {
                return { chapter, scene };
            }
        }
        return null;
    }

    /** @param {string} chapterId */
    #findChapter(chapterId) {
        return this.structure.chapters.find(c => c.id === chapterId);
    }

    #currentScene() {
        return this.editor.sceneId ? this.#findScene(this.editor.sceneId) : null;
    }

    /**
     * Gets the open scene with its chapter.
     * @returns {{ chapter: any, chapterNumber: number, scene: any } | null}
     */
    getCurrentScene() {
        const current = this.#currentScene();
        if (!current) {
            return null;
        }
        return { ...current, chapterNumber: this.structure.chapters.indexOf(current.chapter) + 1 };
    }

    /** Marks the structure as changed and schedules a save. */
    #structureChanged() {
        clearTimeout(this.#structureTimer);
        this.#structureTimer = setTimeout(() => this.saveStructureNow(), STRUCTURE_SAVE_DELAY_MS);
    }

    // ---- Rendering ----

    async #renderProjectList() {
        const $list = this.$root.find('.ns-project-list').empty().append('<div class="ns-hint">Loading…</div>');
        let projects;
        try {
            projects = await novelApi.listProjects();
        } catch (error) {
            $list.empty().append($('<div class="ns-hint">').text(`Could not load projects: ${error.message}`));
            return;
        }
        $list.empty();
        if (projects.length === 0) {
            $list.append('<div class="ns-hint">No novels yet. Create one to get started.</div>');
            return;
        }
        for (const project of projects) {
            const target = project.targetWords ? ` / ${formatNumber(project.targetWords)}` : '';
            const $card = $('<div class="ns-project-card" tabindex="0">').attr('data-id', project.id);
            $card.append($('<div class="ns-project-card-title">').text(project.title));
            if (project.genre) {
                $card.append($('<div class="ns-project-card-genre">').text(project.genre));
            }
            $card.append($('<div class="ns-project-card-stats">').text(
                `${formatNumber(project.wordCount)}${target} words · ${project.chapterCount} chapters · edited ${moment(project.updatedAt).fromNow()}`));
            $card.append($('<button type="button" class="ns-icon-button ns-delete-project fa-solid fa-trash-can" title="Delete novel">'));
            $list.append($card);
        }
    }

    /** Renders the chapter and scene tree. */
    renderTree() {
        const $tree = this.$root.find('.ns-tree').empty();
        const $chapters = $('<ol class="ns-chapters">');

        for (const chapter of this.structure.chapters) {
            const chapterWords = chapter.scenes.reduce((sum, s) => sum + (s.wordCount || 0), 0);
            const $chapter = $('<li class="ns-chapter">').attr('data-id', chapter.id);
            const $row = $('<div class="ns-chapter-row">');
            $row.append('<i class="fa-solid fa-grip-vertical ns-drag-handle" title="Drag to reorder"></i>');
            $row.append($('<span class="ns-chapter-title">').text(chapter.title || 'Untitled chapter'));
            $row.append($('<span class="ns-count">').text(formatNumber(chapterWords)));
            $row.append('<button type="button" class="ns-icon-button ns-add-scene fa-solid fa-plus" title="Add scene"></button>');
            $row.append('<button type="button" class="ns-icon-button ns-delete-chapter fa-solid fa-trash-can" title="Delete chapter"></button>');
            $chapter.append($row);

            const $scenes = $('<ol class="ns-scenes">');
            for (const scene of chapter.scenes) {
                const $scene = $('<li class="ns-scene" tabindex="0">').attr('data-id', scene.id);
                $scene.append('<i class="fa-solid fa-grip-vertical ns-drag-handle" title="Drag to reorder"></i>');
                $scene.append($('<span class="ns-status-dot">').attr('data-status', scene.status).attr('title', scene.status));
                $scene.append($('<span class="ns-scene-name">').text(scene.title || 'Untitled scene'));
                $scene.append($('<span class="ns-count">').text(formatNumber(scene.wordCount)));
                $scene.append('<button type="button" class="ns-icon-button ns-delete-scene fa-solid fa-trash-can" title="Delete scene"></button>');
                $scenes.append($scene);
            }
            $chapter.append($scenes);
            $chapters.append($chapter);
        }
        $tree.append($chapters);

        $chapters.sortable({
            handle: '.ns-chapter-row > .ns-drag-handle',
            axis: 'y',
            stop: () => this.#applyTreeOrder(),
        });
        $chapters.find('.ns-scenes').sortable({
            handle: '.ns-drag-handle',
            connectWith: '.ns-scenes',
            stop: () => this.#applyTreeOrder(),
        });
        this.#highlightCurrentScene();
    }

    /** Reorders the structure to match the tree after a drag. */
    #applyTreeOrder() {
        const scenesById = new Map(this.structure.chapters.flatMap(c => c.scenes.map(s => [s.id, s])));
        const chaptersById = new Map(this.structure.chapters.map(c => [c.id, c]));

        this.structure.chapters = this.$root.find('.ns-chapter').toArray().map((element) => {
            const chapter = chaptersById.get(element.dataset.id);
            chapter.scenes = $(element).find('.ns-scene').toArray().map(s => scenesById.get(s.dataset.id));
            return chapter;
        });
        this.renderTree();
        this.#renderStats();
        this.#structureChanged();
    }

    #highlightCurrentScene() {
        this.$root.find('.ns-scene').removeClass('active');
        if (this.editor.sceneId) {
            this.$root.find(`.ns-scene[data-id="${this.editor.sceneId}"]`).addClass('active');
        }
    }

    /** @param {boolean} visible */
    #showEditor(visible) {
        this.$root.find('.ns-editor-wrap').toggle(visible);
        this.$root.find('.ns-empty').toggle(!visible);
        this.$root.find('.ns-right .ns-tab-panel[data-panel="scene"] > div').toggle(visible);
    }

    #renderSceneMeta() {
        const current = this.#currentScene();
        if (!current) {
            return;
        }
        const { chapter, scene } = current;
        this.$root.find('.ns-scene-title').val(scene.title);
        this.$root.find('[data-field]').each((_, element) => {
            $(element).val(scene[element.dataset.field] ?? '');
        });
        this.$root.find('[data-chapter-field]').each((_, element) => {
            $(element).val(chapter[element.dataset.chapterField] ?? '');
        });
    }

    #renderStats() {
        if (!this.structure) {
            return;
        }
        const current = this.#currentScene();
        const liveWords = this.editor.wordCount();
        const sceneWords = (/** @type {any} */ scene) => scene.id === this.editor.sceneId ? liveWords : (scene.wordCount || 0);
        const chapterWords = current ? current.chapter.scenes.reduce((sum, s) => sum + sceneWords(s), 0) : 0;
        const bookWords = this.structure.chapters.reduce((sum, c) => sum + c.scenes.reduce((s, sc) => s + sceneWords(sc), 0), 0);
        const target = this.project?.targetWords ? ` / ${formatNumber(this.project.targetWords)}` : '';
        const parts = current
            ? [`${formatNumber(liveWords)} scene`, `${formatNumber(chapterWords)} chapter`, `${formatNumber(bookWords)}${target} book`]
            : [`${formatNumber(bookWords)}${target} book`];
        this.$root.find('.ns-stats').text(parts.join(' · '));
    }

    async #renderHistory() {
        const $history = this.$root.find('.ns-history').empty();
        const sceneId = this.editor.sceneId;
        if (!this.project || !sceneId) {
            return;
        }
        $history.append('<div class="ns-hint">Loading…</div>');
        let entries;
        try {
            entries = await novelApi.getHistory(this.project.id, sceneId);
        } catch (error) {
            $history.empty().append($('<div class="ns-hint">').text(`Could not load history: ${error.message}`));
            return;
        }
        if (this.editor.sceneId !== sceneId) {
            return;
        }
        $history.empty();
        if (entries.length === 0) {
            $history.append('<div class="ns-hint">No snapshots of this scene yet.</div>');
            return;
        }
        for (const entry of entries) {
            const $entry = $('<div class="ns-history-entry">').attr('data-oid', entry.oid);
            $entry.append($('<div class="ns-history-message">').text(entry.message));
            $entry.append($('<div class="ns-history-time">').text(moment(entry.timestamp).format('LLL')).attr('title', moment(entry.timestamp).fromNow()));
            $entry.append('<button type="button" class="menu_button ns-history-view">View</button>');
            $history.append($entry);
        }
    }

    // ---- Actions ----

    /**
     * Shows the project settings form.
     * @param {any} [project] Project to edit; omit to create a new one
     * @returns {Promise<object|null>} Entered fields, or null if cancelled
     */
    async #projectForm(project) {
        const $form = $(await renderExtensionTemplateAsync(MODULE, 'project-form'));
        const values = project ?? {};
        $form.find('[data-name]').each((_, element) => {
            $(element).val(values[element.dataset.name] ?? '');
        });
        const result = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '', {
            okButton: project ? 'Save' : 'Create',
            cancelButton: 'Cancel',
            wide: true,
            allowVerticalScrolling: true,
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }
        const fields = {};
        $form.find('[data-name]').each((_, element) => {
            fields[element.dataset.name] = String($(element).val());
        });
        return fields;
    }

    async #createProject() {
        const fields = await this.#projectForm();
        if (!fields) {
            return;
        }
        try {
            const { project } = await novelApi.createProject(fields);
            await this.openProject(project.id);
        } catch (error) {
            toastr.error(`Could not create the novel: ${error.message}`, 'Novel Studio');
        }
    }

    async #editProject() {
        if (!this.project) {
            return;
        }
        const fields = await this.#projectForm(this.project);
        if (!fields) {
            return;
        }
        try {
            this.project = await novelApi.updateProject(this.project.id, fields);
            this.$root.find('.ns-project-title').text(this.project.title);
            this.#renderStats();
        } catch (error) {
            toastr.error(`Could not save project settings: ${error.message}`, 'Novel Studio');
        }
    }

    /** @param {string} projectId */
    async #deleteProject(projectId) {
        const confirmed = await callGenericPopup(
            'Delete this novel? It is moved to the "novels/.trash" folder in your user data, so it can still be recovered from disk.',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        try {
            await novelApi.deleteProject(projectId);
            if (this.settings.lastProjectId === projectId) {
                this.settings.lastProjectId = null;
            }
            delete this.settings.lastSceneByProject?.[projectId];
            saveSettingsDebounced();
            await this.#renderProjectList();
        } catch (error) {
            toastr.error(`Could not delete the novel: ${error.message}`, 'Novel Studio');
        }
    }

    async #addChapter() {
        const number = this.structure.chapters.length + 1;
        const scene = { id: newId('scene'), title: 'Scene 1', status: 'outline', pov: '', location: '', storyTime: '', beats: '', wordCount: 0 };
        this.structure.chapters.push({ id: newId('chapter'), title: `Chapter ${number}`, synopsis: '', scenes: [scene] });
        this.renderTree();
        await this.saveStructureNow();
        await this.openScene(scene.id);
    }

    /** @param {string} chapterId */
    async #addScene(chapterId) {
        const chapter = this.#findChapter(chapterId);
        const scene = { id: newId('scene'), title: `Scene ${chapter.scenes.length + 1}`, status: 'outline', pov: '', location: '', storyTime: '', beats: '', wordCount: 0 };
        chapter.scenes.push(scene);
        this.renderTree();
        await this.saveStructureNow();
        await this.openScene(scene.id);
    }

    /** @param {string} chapterId */
    async #deleteChapter(chapterId) {
        const chapter = this.#findChapter(chapterId);
        const words = chapter.scenes.reduce((sum, s) => sum + (s.wordCount || 0), 0);
        const confirmed = await callGenericPopup(
            `Delete "${chapter.title || 'Untitled chapter'}" and its ${chapter.scenes.length} scene(s) (${formatNumber(words)} words)? Earlier versions stay in the snapshot history.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        const containsOpenScene = chapter.scenes.some(s => s.id === this.editor.sceneId);
        if (containsOpenScene) {
            this.assistant.discard();
            await this.editor.flush();
            this.editor.close();
        }
        this.structure.chapters = this.structure.chapters.filter(c => c.id !== chapterId);
        this.renderTree();
        await this.saveStructureNow();
        if (containsOpenScene) {
            await this.#openFirstSceneOrEmpty();
        }
        this.#renderStats();
    }

    /** @param {string} sceneId */
    async #deleteScene(sceneId) {
        const found = this.#findScene(sceneId);
        if (!found) {
            return;
        }
        const confirmed = await callGenericPopup(
            `Delete "${found.scene.title || 'Untitled scene'}" (${formatNumber(found.scene.wordCount)} words)? Earlier versions stay in the snapshot history.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        const isOpen = sceneId === this.editor.sceneId;
        if (isOpen) {
            this.assistant.discard();
            await this.editor.flush();
            this.editor.close();
        }
        found.chapter.scenes = found.chapter.scenes.filter(s => s.id !== sceneId);
        this.renderTree();
        await this.saveStructureNow();
        if (isOpen) {
            await this.#openFirstSceneOrEmpty();
        }
        this.#renderStats();
    }

    async #openFirstSceneOrEmpty() {
        const first = this.structure.chapters.find(c => c.scenes.length > 0)?.scenes[0];
        if (first) {
            await this.openScene(first.id);
        } else {
            this.#showEditor(false);
            this.#renderStats();
        }
    }

    async #takeSnapshot() {
        if (!this.project) {
            return;
        }
        const message = await callGenericPopup('Describe this snapshot (optional):', POPUP_TYPE.INPUT, '', {
            okButton: 'Save snapshot',
            cancelButton: 'Cancel',
        });
        if (message === null || message === false) {
            return;
        }
        if (!await this.#flushEditor()) {
            return;
        }
        await this.saveStructureNow();
        try {
            const { oid } = await novelApi.snapshot(this.project.id, String(message || 'Snapshot'));
            toastr.success(oid ? 'Snapshot saved.' : 'Nothing changed since the last snapshot.', 'Novel Studio');
            if (this.$root.find('.ns-tab[data-tab="history"]').hasClass('active')) {
                await this.#renderHistory();
            }
        } catch (error) {
            toastr.error(`Could not save the snapshot: ${error.message}`, 'Novel Studio');
        }
    }

    /** @param {string} oid Snapshot commit ID */
    async #viewSnapshot(oid) {
        const sceneId = this.editor.sceneId;
        if (!this.project || !sceneId) {
            return;
        }
        let content;
        try {
            ({ content } = await novelApi.getSceneVersion(this.project.id, sceneId, oid));
        } catch (error) {
            toastr.error(`Could not load this version: ${error.message}`, 'Novel Studio');
            return;
        }
        const $preview = $('<div class="ns-snapshot-preview novel-prose">');
        if (content.trim()) {
            $preview.html(DOMPurify.sanitize(new showdown.Converter().makeHtml(content)));
        } else {
            $preview.append('<p class="ns-hint">This scene was empty in this snapshot.</p>');
        }
        const result = await callGenericPopup($preview, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Restore this version',
            cancelButton: 'Close',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
        if (result === POPUP_RESULT.AFFIRMATIVE && this.editor.sceneId === sceneId) {
            // Restoring is a normal edit: it can be undone and the current text stays in history
            this.editor.replaceContent(content);
            toastr.info('Version restored. Use Undo to go back.', 'Novel Studio');
        }
    }

    async #editAiSettings() {
        const ai = this.settings.ai;
        const $form = $(await renderExtensionTemplateAsync(MODULE, 'ai-settings'));
        const profiles = getProfiles();

        for (const name of ['writerProfileId', 'backgroundProfileId']) {
            const $select = $form.find(`[data-name="${name}"]`);
            $select.append($('<option>').val('').text(profiles.length ? '— Choose a profile —' : '— No connection profiles yet —'));
            for (const profile of profiles) {
                $select.append($('<option>').val(profile.id).text(profile.name));
            }
            $select.val(profiles.some(p => p.id === ai[name]) ? ai[name] : '');
        }
        $form.find('[data-name="contextBudget"]').val(ai.contextBudget);
        const $instructions = $form.find('[data-name="instructions"]');
        $instructions.val(ai.instructions || DEFAULT_WRITER_INSTRUCTIONS);
        $form.on('click', '.ns-reset-instructions', () => $instructions.val(DEFAULT_WRITER_INSTRUCTIONS));

        const result = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Save',
            cancelButton: 'Cancel',
            wide: true,
            allowVerticalScrolling: true,
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        ai.writerProfileId = String($form.find('[data-name="writerProfileId"]').val()) || null;
        ai.backgroundProfileId = String($form.find('[data-name="backgroundProfileId"]').val()) || null;
        const budget = Number($form.find('[data-name="contextBudget"]').val());
        ai.contextBudget = Number.isFinite(budget) ? Math.min(1_000_000, Math.max(2000, Math.round(budget))) : ai.contextBudget;
        const instructions = String($instructions.val()).trim();
        // Store an empty string for the default, so improvements to the default reach existing users
        ai.instructions = instructions === DEFAULT_WRITER_INSTRUCTIONS ? '' : instructions;
        saveSettingsDebounced();
    }

    /** @param {string} command Toolbar command */
    #runToolbarCommand(command) {
        const editor = this.editor.editor;
        if (!editor) {
            return;
        }
        const chain = editor.chain().focus();
        const commands = {
            bold: () => chain.toggleBold(),
            italic: () => chain.toggleItalic(),
            strike: () => chain.toggleStrike(),
            h2: () => chain.toggleHeading({ level: 2 }),
            h3: () => chain.toggleHeading({ level: 3 }),
            blockquote: () => chain.toggleBlockquote(),
            hr: () => chain.setHorizontalRule(),
            undo: () => chain.undo(),
            redo: () => chain.redo(),
        };
        commands[command]?.().run();
    }

    // ---- Events ----

    #bindEvents() {
        const $root = this.$root;

        this.editor = new SceneEditor($root.find('.ns-editor')[0], {
            onStatus: (status) => {
                $root.find('.ns-save-status').attr('data-status', status).text(SAVE_STATUS_TEXT[status]);
            },
            onWordCount: (words) => {
                this.#renderStats();
                $root.find('.ns-ai-continue span').text(words > 0 ? 'Continue' : 'Draft');
            },
            onSelectionChange: (hasSelection) => {
                $root.find('.ns-ai-rewrite').prop('disabled', !hasSelection);
            },
            onSaved: (sceneId, wordCount) => {
                const found = this.#findScene(sceneId);
                if (found) {
                    found.scene.wordCount = wordCount;
                    $root.find(`.ns-scene[data-id="${sceneId}"] .ns-count`).text(formatNumber(wordCount));
                    const chapterWords = found.chapter.scenes.reduce((sum, s) => sum + (s.wordCount || 0), 0);
                    $root.find(`.ns-chapter[data-id="${found.chapter.id}"] > .ns-chapter-row .ns-count`).text(formatNumber(chapterWords));
                }
            },
            onConflict: async () => {
                const result = await callGenericPopup(
                    'This scene was changed in another window since you opened it. Keep your version and overwrite the other one, or reload the other version and lose your recent edits?',
                    POPUP_TYPE.CONFIRM, '', { okButton: 'Keep mine', cancelButton: 'Reload theirs' });
                return result === POPUP_RESULT.AFFIRMATIVE ? 'overwrite' : 'reload';
            },
        });

        this.assistant = new WritingAssistant(this);

        // Keep SillyTavern's chat shortcuts (swipes, message editing) from firing while writing
        $root.on('keydown', (event) => event.stopPropagation());
        $root.on('keydown', '.ns-editor', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                this.assistant.continueScene();
            }
        });

        const $length = $root.find('.ns-length');
        for (const [value, { label, words }] of Object.entries(LENGTHS)) {
            $length.append($('<option>').val(value).text(`${label} (~${words} words)`));
        }
        $length.val(this.settings.ai.length).on('change', () => {
            this.settings.ai.length = String($length.val());
            saveSettingsDebounced();
        });
        $root.on('click', '.ns-ai-continue', () => this.assistant.continueScene());
        $root.on('click', '.ns-ai-rewrite', () => this.assistant.rewriteSelection());
        $root.on('click', '.ns-ai-settings', () => this.#editAiSettings());

        $root.on('click', '.ns-close', () => this.close());
        $root.on('click', '.ns-show-projects', () => this.showProjects());
        $root.on('click', '.ns-project-settings', () => this.#editProject());
        $root.on('click', '.ns-snapshot', () => this.#takeSnapshot());
        $root.on('click', '.ns-toggle-left', () => $root.toggleClass('ns-hide-left'));
        $root.on('click', '.ns-toggle-right', () => $root.toggleClass('ns-hide-right'));
        $root.on('click', '.ns-new-project', () => this.#createProject());

        $root.on('click', '.ns-project-card', (event) => {
            if ($(event.target).closest('.ns-delete-project').length) {
                return;
            }
            this.openProject($(event.currentTarget).attr('data-id')).catch((error) => {
                toastr.error(`Could not open the novel: ${error.message}`, 'Novel Studio');
            });
        });
        $root.on('keydown', '.ns-project-card, .ns-scene', (event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
                $(event.currentTarget).trigger('click');
            }
        });
        $root.on('click', '.ns-delete-project', (event) => {
            this.#deleteProject($(event.currentTarget).closest('.ns-project-card').attr('data-id'));
        });

        $root.on('click', '.ns-add-chapter', () => this.#addChapter());
        $root.on('click', '.ns-add-scene', (event) => this.#addScene($(event.currentTarget).closest('.ns-chapter').attr('data-id')));
        $root.on('click', '.ns-delete-chapter', (event) => this.#deleteChapter($(event.currentTarget).closest('.ns-chapter').attr('data-id')));
        $root.on('click', '.ns-delete-scene', (event) => {
            event.stopPropagation();
            this.#deleteScene($(event.currentTarget).closest('.ns-scene').attr('data-id'));
        });
        $root.on('click', '.ns-scene', (event) => {
            const sceneId = $(event.currentTarget).attr('data-id');
            if (sceneId !== this.editor.sceneId) {
                this.openScene(sceneId).catch((error) => toastr.error(`Could not open the scene: ${error.message}`, 'Novel Studio'));
            }
        });
        $root.on('click', '.ns-chapter-title', (event) => {
            $(event.currentTarget).closest('.ns-chapter').toggleClass('collapsed');
        });

        $root.on('click', '.ns-toolbar button', (event) => this.#runToolbarCommand(event.currentTarget.dataset.cmd));

        $root.on('input', '.ns-scene-title', (event) => {
            const current = this.#currentScene();
            if (!current) {
                return;
            }
            current.scene.title = String($(event.currentTarget).val());
            $root.find(`.ns-scene[data-id="${current.scene.id}"] .ns-scene-name`).text(current.scene.title || 'Untitled scene');
            this.#structureChanged();
        });
        $root.on('input change', '[data-field]', (event) => {
            const current = this.#currentScene();
            if (!current) {
                return;
            }
            const field = event.currentTarget.dataset.field;
            current.scene[field] = String($(event.currentTarget).val());
            if (field === 'status') {
                $root.find(`.ns-scene[data-id="${current.scene.id}"] .ns-status-dot`).attr('data-status', current.scene.status).attr('title', current.scene.status);
            }
            this.#structureChanged();
        });
        $root.on('input', '[data-chapter-field]', (event) => {
            const current = this.#currentScene();
            if (!current) {
                return;
            }
            const field = event.currentTarget.dataset.chapterField;
            current.chapter[field] = String($(event.currentTarget).val());
            if (field === 'title') {
                $root.find(`.ns-chapter[data-id="${current.chapter.id}"] .ns-chapter-title`).text(current.chapter.title || 'Untitled chapter');
            }
            this.#structureChanged();
        });

        $root.on('click', '.ns-tab', (event) => {
            const tab = event.currentTarget.dataset.tab;
            $root.find('.ns-tab').removeClass('active');
            $(event.currentTarget).addClass('active');
            $root.find('.ns-tab-panel').each((_, panel) => { panel.hidden = panel.dataset.panel !== tab; });
            if (tab === 'history') {
                this.#renderHistory();
            }
        });
        $root.on('click', '.ns-history-view', (event) => this.#viewSnapshot($(event.currentTarget).closest('.ns-history-entry').attr('data-oid')));
    }
}
