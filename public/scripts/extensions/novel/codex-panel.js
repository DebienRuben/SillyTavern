import { renderExtensionTemplateAsync } from '../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { novelApi } from './api.js';
import {
    buildExtractionMessages,
    ENTITY_TYPES,
    EXTRACTION_SCHEMA,
    extractionToSuggestions,
    formatEntityForPrompt,
    sceneOrder,
    selectRelevantEntities,
    STATE_FIELDS,
    stateAsOf,
} from './ai/codex-logic.js';
import { describeError, requestJson } from './ai/generate.js';

const MODULE = 'novel';
const EXTRACTION_MAX_TOKENS = 4000;
/** Scene statuses that mean "this scene is finished enough to update the codex". */
const ANALYZE_ON_STATUS = new Set(['revised', 'final']);

const REASON_LABELS = Object.freeze({
    pinned: 'pinned',
    pov: 'point of view',
    location: 'location',
    mentioned: 'mentioned',
});

/**
 * The codex tab, the suggestions review queue, and the "In this scene" list.
 */
export class CodexPanel {
    /** @type {any[]} */
    entities = [];
    /** @type {any[]} */
    suggestions = [];
    /** @type {import('./studio.js').NovelStudio} */
    #studio;
    /** @type {JQuery<HTMLElement>} */
    #root;
    #analyzingSceneId = null;

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

    get #settings() {
        return this.#studio.settings.ai;
    }

    /** Loads the codex and suggestions of the open project. */
    async load() {
        const projectId = this.#project.id;
        const [entities, suggestions] = await Promise.all([
            novelApi.listCodex(projectId),
            novelApi.listSuggestions(projectId),
        ]);
        if (this.#project?.id !== projectId) {
            return;
        }
        this.entities = entities;
        this.suggestions = suggestions;
        this.renderAll();
    }

    /** Forgets the codex when a project is closed. */
    clear() {
        this.entities = [];
        this.suggestions = [];
        this.#analyzingSceneId = null;
        this.renderAll();
    }

    renderAll() {
        this.renderList();
        this.renderSuggestions();
        this.renderCast();
    }

    /**
     * Formats the codex entries relevant to a writing request, most important first.
     * States are as they stand when the scene begins; the prose so far shows changes within it.
     * @param {any} scene Scene being written
     * @param {string[]} texts Nearby prose to scan for mentions
     * @returns {{ name: string, text: string }[]}
     */
    entriesForPrompt(scene, texts) {
        const order = sceneOrder(this.#studio.structure);
        return selectRelevantEntities({ entities: this.entities, scene, texts })
            .filter(({ entity }) => !(scene.excludedCast ?? []).includes(entity.id))
            .map(({ entity }) => ({
                name: entity.name,
                text: formatEntityForPrompt(entity, stateAsOf(entity, order, scene.id, { includeScene: false })),
            }));
    }

    // ---- Codex list ----

    renderList() {
        const $list = this.#root.find('.ns-codex-list').empty();
        if (!this.#project) {
            return;
        }
        const query = String(this.#root.find('.ns-codex-search').val() ?? '').trim().toLowerCase();
        const order = sceneOrder(this.#studio.structure);
        const matches = this.entities.filter(entity => !query
            || [entity.name, ...entity.aliases, entity.description].some(value => value?.toLowerCase().includes(query)));

        if (this.entities.length === 0) {
            $list.append('<p class="ns-hint">The codex is empty. Add characters, places and things with New, or use "Update codex from this scene" in the Scene tab to let the background model suggest entries.</p>');
            return;
        }
        if (matches.length === 0) {
            $list.append('<p class="ns-hint">Nothing matches your search.</p>');
            return;
        }

        for (const [type, label] of Object.entries(ENTITY_TYPES)) {
            const ofType = matches.filter(entity => entity.type === type);
            if (ofType.length === 0) {
                continue;
            }
            $list.append($('<h5 class="ns-codex-group">').text(`${label}s`));
            for (const entity of ofType) {
                const state = stateAsOf(entity, order, null);
                const $item = $('<div class="ns-codex-item" tabindex="0">').attr('data-id', entity.id);
                $item.append($('<div class="ns-codex-name">').text(entity.name));
                if (entity.aliases.length) {
                    $item.append($('<div class="ns-codex-aliases">').text(entity.aliases.join(', ')));
                }
                const summary = Object.entries(STATE_FIELDS)
                    .filter(([field]) => state[field])
                    .slice(0, 2)
                    .map(([field, { label: fieldLabel }]) => `${fieldLabel}: ${state[field]}`)
                    .join(' · ');
                if (summary) {
                    $item.append($('<div class="ns-codex-state">').text(summary));
                }
                $list.append($item);
            }
        }
    }

    /**
     * Opens the editor for a codex entry.
     * @param {any} [entity] Entry to edit; omit to create one
     * @param {Partial<any>} [defaults] Initial values for a new entry
     */
    async editEntity(entity, defaults = {}) {
        const $form = $(await renderExtensionTemplateAsync(MODULE, 'entity-form'));
        const values = entity ?? { type: 'character', name: '', aliases: [], description: '', notes: '', state: [], ...defaults };
        const $type = $form.find('[data-name="type"]');
        for (const [value, label] of Object.entries(ENTITY_TYPES)) {
            $type.append($('<option>').val(value).text(label));
        }
        $form.find('.ns-entity-form-title').text(entity ? entity.name : 'New codex entry');
        $type.val(values.type);
        $form.find('[data-name="name"]').val(values.name);
        $form.find('[data-name="aliases"]').val(values.aliases.join(', '));
        $form.find('[data-name="description"]').val(values.description);
        $form.find('[data-name="notes"]').val(values.notes);
        this.#renderTimeline($form, values.state);

        const result = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Save',
            cancelButton: 'Cancel',
            wide: true,
            allowVerticalScrolling: true,
            customButtons: entity ? [{ text: 'Delete entry', result: POPUP_RESULT.CUSTOM1, classes: ['ns-danger'] }] : null,
        });

        if (result === POPUP_RESULT.CUSTOM1 && entity) {
            await this.#deleteEntity(entity);
            return;
        }
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const state = $form.find('.ns-timeline-entry').toArray()
            .filter(element => !element.classList.contains('removed'))
            .map((element) => {
                const entry = { sceneId: element.dataset.sceneId };
                $(element).find('[data-field]').each((_, input) => {
                    entry[input.dataset.field] = String($(input).val());
                });
                return entry;
            });
        const payload = {
            id: entity?.id,
            type: String($type.val()),
            name: String($form.find('[data-name="name"]').val()),
            aliases: String($form.find('[data-name="aliases"]').val()).split(',').map(alias => alias.trim()).filter(Boolean),
            description: String($form.find('[data-name="description"]').val()),
            notes: String($form.find('[data-name="notes"]').val()),
            state,
        };
        try {
            const saved = await novelApi.saveEntity(this.#project.id, payload);
            this.#upsertEntity(saved);
            this.renderAll();
        } catch (error) {
            toastr.error(`Could not save the codex entry: ${error.message}`, 'Novel Studio');
        }
    }

    /**
     * Shows an entry's state entries in manuscript order, editable.
     * @param {JQuery<HTMLElement>} $form Entry form
     * @param {any[]} stateEntries State entries
     */
    #renderTimeline($form, stateEntries) {
        const order = sceneOrder(this.#studio.structure);
        const $entries = $form.find('.ns-timeline-entries');
        const sorted = [...stateEntries].sort((a, b) => (order.get(a.sceneId) ?? Infinity) - (order.get(b.sceneId) ?? Infinity));
        $form.find('.ns-timeline-empty').toggle(sorted.length === 0);

        for (const entry of sorted) {
            const $entry = $('<div class="ns-timeline-entry">').attr('data-scene-id', entry.sceneId);
            const $header = $('<div class="ns-timeline-header">');
            $header.append($('<b>').text(this.#sceneLabel(entry.sceneId)));
            $header.append($('<button type="button" class="menu_button ns-timeline-remove">Remove</button>'));
            $entry.append($header);
            for (const [field, { label }] of Object.entries(STATE_FIELDS)) {
                if (entry[field]) {
                    $entry.append($('<label>').text(label).append($('<textarea class="text_pole" rows="2" maxlength="2000">').attr('data-field', field).val(entry[field])));
                }
            }
            $entries.append($entry);
        }
        $form.on('click', '.ns-timeline-remove', (event) => {
            const $entry = $(event.currentTarget).closest('.ns-timeline-entry');
            $entry.toggleClass('removed');
            $(event.currentTarget).text($entry.hasClass('removed') ? 'Undo remove' : 'Remove');
        });
    }

    /** @param {any} entity */
    async #deleteEntity(entity) {
        const confirmed = await callGenericPopup(
            `Delete "${entity.name}" from the codex? Its recorded state over the story is deleted too. Earlier versions stay in the snapshot history.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        try {
            await novelApi.deleteEntity(this.#project.id, entity.id);
            this.entities = this.entities.filter(e => e.id !== entity.id);
            this.suggestions = this.suggestions.filter(s => s.entityId !== entity.id);
            this.renderAll();
        } catch (error) {
            toastr.error(`Could not delete the codex entry: ${error.message}`, 'Novel Studio');
        }
    }

    /** @param {any} entity */
    #upsertEntity(entity) {
        const index = this.entities.findIndex(e => e.id === entity.id);
        if (index === -1) {
            this.entities.push(entity);
        } else {
            this.entities[index] = entity;
        }
        this.entities.sort((a, b) =>
            Object.keys(ENTITY_TYPES).indexOf(a.type) - Object.keys(ENTITY_TYPES).indexOf(b.type) || a.name.localeCompare(b.name));
    }

    /**
     * @param {string} sceneId
     * @returns {string}
     */
    #sceneLabel(sceneId) {
        const chapters = this.#studio.structure?.chapters ?? [];
        for (const [index, chapter] of chapters.entries()) {
            const scene = chapter.scenes.find(s => s.id === sceneId);
            if (scene) {
                return `Ch. ${index + 1} · ${scene.title || 'Untitled scene'}`;
            }
        }
        return 'Deleted scene';
    }

    // ---- In this scene ----

    /** Shows the codex entries relevant to the open scene, and pinning controls. */
    renderCast() {
        const $list = this.#root.find('.ns-cast-list').empty();
        const $add = this.#root.find('.ns-cast-add').empty();
        const current = this.#studio.getCurrentScene();
        this.#renderAnalyzeStatus();
        if (!current) {
            return;
        }
        const scene = current.scene;
        const context = this.#studio.editor.getCursorContext();
        const sceneText = context ? context.before + context.selection + context.after : '';
        const relevant = selectRelevantEntities({ entities: this.entities, scene, texts: [sceneText] });
        const excluded = new Set(scene.excludedCast ?? []);

        if (relevant.length === 0) {
            $list.append('<p class="ns-hint">No codex entries found in this scene yet.</p>');
        }
        for (const { entity, reason } of relevant) {
            const isExcluded = excluded.has(entity.id);
            const $chip = $('<span class="ns-cast-chip">').attr('data-id', entity.id).toggleClass('excluded', isExcluded).attr('data-reason', reason);
            $chip.append($('<button type="button" class="ns-cast-open">').text(entity.name).attr('title', 'Open codex entry'));
            $chip.append($('<small>').text(isExcluded ? 'left out' : REASON_LABELS[reason]));
            if (reason === 'pinned') {
                $chip.append('<button type="button" class="ns-cast-unpin fa-solid fa-xmark" title="Unpin"></button>');
            } else {
                $chip.append($('<button type="button" class="ns-cast-toggle fa-solid">')
                    .addClass(isExcluded ? 'fa-eye' : 'fa-eye-slash')
                    .attr('title', isExcluded ? 'Include when writing this scene' : 'Leave out when writing this scene'));
            }
            $list.append($chip);
        }

        $add.append($('<option>').val('').text(this.entities.length ? 'Pin a codex entry…' : 'The codex is empty'));
        const pinned = new Set(scene.cast ?? []);
        for (const entity of this.entities.filter(e => !pinned.has(e.id))) {
            $add.append($('<option>').val(entity.id).text(entity.name));
        }
    }

    #renderAnalyzeStatus() {
        const current = this.#studio.getCurrentScene();
        const $button = this.#root.find('.ns-analyze-scene');
        const $status = this.#root.find('.ns-analyze-status');
        const analyzing = current && this.#analyzingSceneId === current.scene.id;
        $button.prop('disabled', Boolean(this.#analyzingSceneId));
        $button.find('span').text(analyzing ? 'Analyzing scene…' : 'Update codex from this scene');
        const waiting = current ? this.suggestions.filter(s => s.sceneId === current.scene.id).length : 0;
        $status.text(waiting ? `${waiting} suggestion(s) from this scene are waiting in Suggestions.` : '');
    }

    // ---- Scene analysis ----

    /**
     * Called when a scene's status changes; finished scenes are analyzed automatically.
     * @param {string} sceneId Scene ID
     * @param {string} status New status
     */
    onStatusChanged(sceneId, status) {
        if (ANALYZE_ON_STATUS.has(status) && this.#settings.backgroundProfileId) {
            this.analyzeScene(sceneId, { automatic: true });
        }
    }

    /**
     * Asks the background model how a scene changes the codex, and queues the result as suggestions.
     * @param {string} sceneId Scene to analyze
     * @param {{ automatic?: boolean }} [options] Automatic runs report through toasts only
     */
    async analyzeScene(sceneId, { automatic = false } = {}) {
        if (this.#analyzingSceneId) {
            return;
        }
        const studio = this.#studio;
        const found = this.#findScene(sceneId);
        if (!found) {
            return;
        }
        const projectId = this.#project.id;
        this.#analyzingSceneId = sceneId;
        this.#renderAnalyzeStatus();

        try {
            let sceneText;
            if (studio.editor.sceneId === sceneId) {
                await studio.editor.flush();
                sceneText = studio.editor.editor?.getMarkdown() ?? '';
            } else {
                sceneText = (await novelApi.getScene(projectId, sceneId)).content;
            }
            if (!sceneText.trim()) {
                if (!automatic) {
                    toastr.info('This scene has no text to analyze yet.', 'Novel Studio');
                }
                return;
            }

            const order = sceneOrder(studio.structure);
            const known = this.entities.map(entity => ({ entity, state: stateAsOf(entity, order, sceneId) }));
            const input = { project: studio.project, chapter: found.chapter, chapterNumber: found.chapterNumber, scene: found.scene, sceneText, known };
            const result = await requestJson({
                profileId: this.#settings.backgroundProfileId,
                role: 'background',
                messages: buildExtractionMessages(input),
                fallbackMessages: buildExtractionMessages({ ...input, jsonInstructions: true }),
                schema: EXTRACTION_SCHEMA,
                maxTokens: EXTRACTION_MAX_TOKENS,
            });
            if (this.#project?.id !== projectId) {
                return;
            }
            const items = extractionToSuggestions(result, known);
            this.suggestions = await novelApi.replaceSuggestions(projectId, sceneId, items);
            this.renderSuggestions();

            const sceneName = found.scene.title || 'this scene';
            if (items.length === 0) {
                toastr.info(`No codex changes found in "${sceneName}".`, 'Novel Studio');
            } else {
                toastr.success(`${items.length} codex suggestion(s) from "${sceneName}" are ready for review.`, 'Novel Studio');
                if (!automatic) {
                    this.#root.find('.ns-tab[data-tab="suggestions"]').trigger('click');
                }
            }
        } catch (error) {
            console.error('Novel Studio: codex analysis failed', error);
            toastr.error(`Could not analyze the scene: ${describeError(error)}`, 'Novel Studio');
        } finally {
            this.#analyzingSceneId = null;
            this.#renderAnalyzeStatus();
        }
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

    // ---- Suggestions ----

    renderSuggestions() {
        const $list = this.#root.find('.ns-suggestions').empty();
        const count = this.suggestions.length;
        this.#root.find('.ns-badge').text(count).prop('hidden', count === 0);
        this.#root.find('.ns-suggestions-count').text(count ? `${count} waiting` : '');
        this.#root.find('.ns-accept-all, .ns-reject-all').toggle(count > 0);
        this.#renderAnalyzeStatus();

        if (count === 0) {
            $list.append('<p class="ns-hint">No suggestions waiting. Mark a scene as Revised or Final, or use "Update codex from this scene", and the background model proposes codex changes here for you to review.</p>');
            return;
        }

        const order = sceneOrder(this.#studio.structure);
        const sorted = [...this.suggestions].sort((a, b) => (order.get(a.sceneId) ?? Infinity) - (order.get(b.sceneId) ?? Infinity));
        for (const suggestion of sorted) {
            $list.append(this.#renderSuggestion(suggestion, order));
        }
    }

    /**
     * @param {any} suggestion
     * @param {Map<string, number>} order Scene order
     * @returns {JQuery<HTMLElement>}
     */
    #renderSuggestion(suggestion, order) {
        const $card = $('<div class="ns-suggestion">').attr('data-id', suggestion.id).attr('data-kind', suggestion.kind);
        const $header = $('<div class="ns-suggestion-header">');
        const entity = this.entities.find(e => e.id === suggestion.entityId);

        if (suggestion.kind === 'update') {
            $header.append($('<b>').text(entity?.name ?? 'Unknown entry'));
            $header.append($('<span>').text(' changes'));
        } else {
            $header.append($('<span>').text(`New ${ENTITY_TYPES[suggestion.entity.type]?.toLowerCase() ?? 'entry'}: `));
            $header.append($('<b>').text(suggestion.entity.name));
        }
        $card.append($header);
        $card.append($('<div class="ns-suggestion-scene">').text(this.#sceneLabel(suggestion.sceneId)));

        if (suggestion.kind === 'create') {
            const $type = $('<select class="text_pole" data-entity="type">');
            for (const [value, label] of Object.entries(ENTITY_TYPES)) {
                $type.append($('<option>').val(value).text(label));
            }
            $type.val(suggestion.entity.type);
            $card.append($('<label>').text('Name').append($('<input type="text" class="text_pole" data-entity="name" maxlength="200">').val(suggestion.entity.name)));
            $card.append($('<label>').text('Type').append($type));
            $card.append($('<label>').text('Other names').append($('<input type="text" class="text_pole" data-entity="aliases" maxlength="2000">').val(suggestion.entity.aliases.join(', '))));
            $card.append($('<label>').text('Description').append($('<textarea class="text_pole" rows="3" data-entity="description" maxlength="20000">').val(suggestion.entity.description)));
        }

        const previous = entity ? stateAsOf(entity, order, suggestion.sceneId) : {};
        for (const [field, value] of Object.entries(suggestion.changes)) {
            const $label = $('<label class="ns-suggestion-field">').text(STATE_FIELDS[field]?.label ?? field);
            if (previous[field]) {
                $label.append($('<span class="ns-suggestion-old">').text(previous[field]));
            }
            $label.append($('<textarea class="text_pole" rows="2" maxlength="2000">').attr('data-field', field).val(value));
            $card.append($label);
        }
        if (suggestion.evidence) {
            $card.append($('<blockquote class="ns-suggestion-evidence">').text(suggestion.evidence));
        }
        const $actions = $('<div class="ns-suggestion-actions">');
        $actions.append('<button type="button" class="menu_button ns-suggestion-accept">Accept</button>');
        $actions.append('<button type="button" class="menu_button ns-suggestion-reject">Reject</button>');
        $card.append($actions);
        return $card;
    }

    /**
     * Reads the author's edits from a suggestion card.
     * @param {JQuery<HTMLElement>} $card
     */
    #readEdits($card) {
        const changes = {};
        $card.find('[data-field]').each((_, input) => {
            changes[input.dataset.field] = String($(input).val());
        });
        const edits = { changes };
        if ($card.attr('data-kind') === 'create') {
            edits.entity = {
                name: String($card.find('[data-entity="name"]').val()),
                type: String($card.find('[data-entity="type"]').val()),
                aliases: String($card.find('[data-entity="aliases"]').val()).split(',').map(alias => alias.trim()).filter(Boolean),
                description: String($card.find('[data-entity="description"]').val()),
            };
        }
        return edits;
    }

    /**
     * Accepts or rejects one suggestion.
     * @param {string} suggestionId
     * @param {'accept' | 'reject'} action
     * @returns {Promise<boolean>} Whether it succeeded
     */
    async #resolve(suggestionId, action) {
        const $card = this.#root.find(`.ns-suggestion[data-id="${suggestionId}"]`);
        const edits = action === 'accept' ? this.#readEdits($card) : undefined;
        $card.find('button').prop('disabled', true);
        try {
            const { entity } = await novelApi.resolveSuggestion(this.#project.id, suggestionId, action, edits);
            if (entity) {
                this.#upsertEntity(entity);
            }
            this.suggestions = this.suggestions.filter(s => s.id !== suggestionId);
            return true;
        } catch (error) {
            $card.find('button').prop('disabled', false);
            toastr.error(`Could not ${action} the suggestion: ${error.message}`, 'Novel Studio');
            return false;
        }
    }

    /** @param {'accept' | 'reject'} action */
    async #resolveAll(action) {
        if (action === 'reject') {
            const confirmed = await callGenericPopup(`Reject all ${this.suggestions.length} suggestions?`, POPUP_TYPE.CONFIRM, '', { okButton: 'Reject all', cancelButton: 'Cancel' });
            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }
        }
        // New entries first, so updates that mention them apply after they exist
        const ordered = [...this.suggestions].sort((a, b) => (a.kind === 'create' ? 0 : 1) - (b.kind === 'create' ? 0 : 1));
        for (const suggestion of ordered) {
            await this.#resolve(suggestion.id, action);
        }
        this.renderAll();
    }

    // ---- Events ----

    #bindEvents() {
        const $root = this.#root;
        $root.on('input', '.ns-codex-search', () => this.renderList());
        $root.on('click', '.ns-codex-new', () => this.editEntity());
        $root.on('click keydown', '.ns-codex-item', (event) => {
            if (event.type === 'keydown' && event.key !== 'Enter') {
                return;
            }
            const entity = this.entities.find(e => e.id === event.currentTarget.dataset.id);
            if (entity) {
                this.editEntity(entity);
            }
        });

        $root.on('click', '.ns-suggestion-accept, .ns-suggestion-reject', async (event) => {
            const suggestionId = $(event.currentTarget).closest('.ns-suggestion').attr('data-id');
            const action = $(event.currentTarget).hasClass('ns-suggestion-accept') ? 'accept' : 'reject';
            if (await this.#resolve(suggestionId, action)) {
                this.renderAll();
            }
        });
        $root.on('click', '.ns-accept-all', () => this.#resolveAll('accept'));
        $root.on('click', '.ns-reject-all', () => this.#resolveAll('reject'));

        $root.on('click', '.ns-analyze-scene', () => {
            const sceneId = this.#studio.editor.sceneId;
            if (sceneId) {
                this.analyzeScene(sceneId);
            }
        });
        $root.on('click', '.ns-cast-open', (event) => {
            const entity = this.entities.find(e => e.id === $(event.currentTarget).closest('.ns-cast-chip').attr('data-id'));
            if (entity) {
                this.editEntity(entity);
            }
        });
        $root.on('change', '.ns-cast-add', (event) => {
            const entityId = String($(event.currentTarget).val());
            const current = this.#studio.getCurrentScene();
            if (!entityId || !current) {
                return;
            }
            current.scene.cast = [...new Set([...(current.scene.cast ?? []), entityId])];
            current.scene.excludedCast = (current.scene.excludedCast ?? []).filter(id => id !== entityId);
            this.#studio.scheduleStructureSave();
            this.renderCast();
        });
        $root.on('click', '.ns-cast-unpin', (event) => {
            const entityId = $(event.currentTarget).closest('.ns-cast-chip').attr('data-id');
            const current = this.#studio.getCurrentScene();
            if (current) {
                current.scene.cast = (current.scene.cast ?? []).filter(id => id !== entityId);
                this.#studio.scheduleStructureSave();
                this.renderCast();
            }
        });
        $root.on('click', '.ns-cast-toggle', (event) => {
            const entityId = $(event.currentTarget).closest('.ns-cast-chip').attr('data-id');
            const current = this.#studio.getCurrentScene();
            if (!current) {
                return;
            }
            const excluded = new Set(current.scene.excludedCast ?? []);
            if (excluded.has(entityId)) {
                excluded.delete(entityId);
            } else {
                excluded.add(entityId);
            }
            current.scene.excludedCast = [...excluded];
            this.#studio.scheduleStructureSave();
            this.renderCast();
        });
    }
}
