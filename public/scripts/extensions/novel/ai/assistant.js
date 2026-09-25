import { DOMPurify, showdown } from '../../../../lib.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { novelApi } from '../api.js';
import { describeError, streamCompletion } from './generate.js';
import { buildWritingPrompt, cleanOutput, countWords, LENGTHS, tokensToChars } from './prompt.js';

const MODULE = 'novel';
/** How much prose around the cursor is scanned for codex mentions. */
const CODEX_SCAN_CHARS = 6000;

const TASK_TEXT = Object.freeze({
    continue: { running: 'Writing…', done: 'Continuation', accept: 'Insert' },
    draft: { running: 'Drafting…', done: 'Draft', accept: 'Insert' },
    rewrite: { running: 'Rewriting…', done: 'Rewrite', accept: 'Replace selection' },
});

/**
 * @typedef {object} WritingRequest
 * @property {'continue' | 'draft' | 'rewrite'} kind What the author asked for
 * @property {{ from: number, to: number }} range Where the result goes
 * @property {import('../editor.js').CursorContext} context Text around the cursor when the request was made
 * @property {string} [instruction] Rewrite instruction
 * @property {number} targetWords Target length
 * @property {string} sceneId Scene the request belongs to
 */

/**
 * Runs AI writing requests for the open scene and shows the result for review.
 * While a result is pending the editor is read-only, so the insertion point stays valid.
 */
export class WritingAssistant {
    /** @type {import('../studio.js').NovelStudio} */
    #studio;
    /** @type {JQuery<HTMLElement>} */
    #panel;
    /** @type {WritingRequest | null} */
    #request = null;
    /** @type {AbortController | null} */
    #abort = null;
    #raw = '';
    #running = false;
    /** @type {ReturnType<typeof buildWritingPrompt> | null} */
    #lastPrompt = null;
    #converter = new showdown.Converter();

    /**
     * @param {import('../studio.js').NovelStudio} studio Studio that owns the editor
     */
    constructor(studio) {
        this.#studio = studio;
        this.#panel = studio.$root.find('.ns-proposal');
        this.#panel.on('click', '.ns-proposal-stop', () => this.stop());
        this.#panel.on('click', '.ns-proposal-accept', () => this.accept());
        this.#panel.on('click', '.ns-proposal-retry', () => this.#run());
        this.#panel.on('click', '.ns-proposal-discard', () => this.discard());
        this.#panel.on('click', '.ns-proposal-prompt', () => this.#showPrompt());
    }

    get settings() {
        return extensionSettings().ai;
    }

    /** Whether a result is being generated or waiting for review. */
    get isActive() {
        return this.#request !== null;
    }

    /**
     * Continues the scene at the cursor, or drafts its opening if it is empty.
     */
    async continueScene() {
        const context = this.#studio.editor.getCursorContext();
        if (!context || this.isActive) {
            return;
        }
        // With a selection, continue after it rather than replacing it
        const range = { from: context.to, to: context.to };
        const kind = context.before.trim() || context.selection.trim() ? 'continue' : 'draft';
        await this.#start({
            kind,
            range,
            context: { ...context, from: context.to, before: context.before + context.selection, selection: '' },
            targetWords: LENGTHS[this.settings.length]?.words ?? LENGTHS.medium.words,
            sceneId: this.#studio.editor.sceneId,
        });
    }

    /** Asks how to rewrite the selection, then rewrites it. */
    async rewriteSelection() {
        const context = this.#studio.editor.getCursorContext();
        if (!context || this.isActive) {
            return;
        }
        if (!context.selection.trim()) {
            toastr.info('Select the passage you want to rewrite first.', 'Novel Studio');
            return;
        }
        const instruction = await this.#askRewriteInstruction();
        if (instruction === null) {
            return;
        }
        await this.#start({
            kind: 'rewrite',
            range: { from: context.from, to: context.to },
            context,
            instruction,
            targetWords: countWords(context.selection),
            sceneId: this.#studio.editor.sceneId,
        });
    }

    /** Stops a running request, keeping what was written so far. */
    stop() {
        this.#abort?.abort();
    }

    /** Inserts the result into the scene. */
    accept() {
        if (!this.#request || this.#running) {
            return;
        }
        const request = this.#request;
        const output = cleanOutput(this.#raw);
        this.#close();
        if (request.sceneId === this.#studio.editor.sceneId) {
            this.#studio.editor.insertGenerated(request.range, output, /^\s*\n/.test(this.#raw));
        }
    }

    /** Drops the result and stops any running request. */
    discard() {
        this.#abort?.abort();
        this.#close();
    }

    /** @param {WritingRequest} request */
    async #start(request) {
        this.#request = request;
        await this.#run();
    }

    async #run() {
        const request = this.#request;
        if (!request || this.#running) {
            return;
        }
        const studio = this.#studio;
        const current = studio.getCurrentScene();
        if (!current || current.scene.id !== request.sceneId) {
            this.#close();
            return;
        }

        this.#running = true;
        this.#raw = '';
        this.#abort = new AbortController();
        studio.editor.setEditable(false);
        this.#render({ status: 'running' });

        try {
            const budget = this.settings.contextBudget;
            const preceding = await novelApi.getPrecedingScenes(studio.project.id, request.sceneId, tokensToChars(budget));
            const prompt = buildWritingPrompt({
                task: request.kind === 'rewrite' ? 'rewrite' : 'continue',
                instructions: this.settings.instructions,
                project: studio.project,
                chapter: current.chapter,
                chapterNumber: current.chapterNumber,
                scene: current.scene,
                beforeCursor: request.context.before,
                afterCursor: request.context.after,
                selection: request.context.selection,
                instruction: request.instruction,
                targetWords: request.targetWords,
                preceding,
                budgetTokens: budget,
                codex: studio.codex.entriesForPrompt(current.scene, [
                    request.context.before.slice(-CODEX_SCAN_CHARS),
                    request.context.selection,
                    request.context.after.slice(0, CODEX_SCAN_CHARS / 4),
                ]),
            });
            this.#lastPrompt = prompt;

            await streamCompletion({
                profileId: this.settings.writerProfileId,
                role: 'writer',
                messages: prompt.messages,
                maxTokens: prompt.maxTokens,
                signal: this.#abort.signal,
                onText: (text) => {
                    if (this.#request === request) {
                        this.#raw = text;
                        this.#render({ status: 'running' });
                    }
                },
            });
            this.#running = false;
            if (this.#request === request) {
                this.#render({ status: cleanOutput(this.#raw).trim() ? 'done' : 'empty' });
            }
        } catch (error) {
            this.#running = false;
            if (this.#request !== request) {
                return;
            }
            if (this.#abort?.signal.aborted) {
                this.#render({ status: cleanOutput(this.#raw).trim() ? 'stopped' : 'empty' });
            } else {
                console.error('Novel Studio: writing request failed', error);
                this.#render({ status: 'error', error: describeError(error) });
            }
        } finally {
            this.#abort = null;
        }
    }

    /**
     * Updates the review panel.
     * @param {{ status: 'running' | 'done' | 'stopped' | 'empty' | 'error', error?: string }} state
     */
    #render({ status, error }) {
        const request = this.#request;
        if (!request) {
            return;
        }
        const text = TASK_TEXT[request.kind];
        const output = cleanOutput(this.#raw);
        const titles = {
            running: text.running,
            done: text.done,
            stopped: `${text.done} (stopped)`,
            empty: 'The model returned no text',
            error: 'Request failed',
        };

        this.#panel.prop('hidden', false).attr('data-status', status);
        this.#panel.find('.ns-proposal-title').text(titles[status]);
        this.#panel.find('.ns-proposal-meta').text(output ? `${countWords(output)} words` : '');

        const $body = this.#panel.find('.ns-proposal-text');
        if (status === 'error') {
            $body.empty().append($('<p class="ns-proposal-error">').text(error));
        } else if (output) {
            $body.html(DOMPurify.sanitize(this.#converter.makeHtml(output)));
        } else {
            $body.empty();
        }
        if (status === 'running') {
            $body.scrollTop($body.prop('scrollHeight'));
        }

        const hasOutput = Boolean(output.trim());
        this.#panel.find('.ns-proposal-stop').toggle(status === 'running');
        this.#panel.find('.ns-proposal-accept').text(text.accept).toggle(status !== 'running' && hasOutput && status !== 'error');
        this.#panel.find('.ns-proposal-retry').toggle(status !== 'running');
        this.#panel.find('.ns-proposal-prompt').toggle(this.#lastPrompt !== null && status !== 'running');
    }

    #close() {
        this.#request = null;
        this.#raw = '';
        this.#running = false;
        this.#panel.prop('hidden', true);
        this.#studio.editor.setEditable(true);
    }

    /** @returns {Promise<string|null>} The instruction, or null if cancelled */
    async #askRewriteInstruction() {
        const $form = $(await renderExtensionTemplateAsync(MODULE, 'rewrite'));
        const $input = $form.find('[data-name="instruction"]');
        $input.val(this.settings.lastRewriteInstruction ?? '');
        $form.on('click', '.ns-chip', (event) => {
            $input.val(event.currentTarget.dataset.instruction).trigger('focus');
        });
        const result = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Rewrite',
            cancelButton: 'Cancel',
            wide: true,
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }
        const instruction = String($input.val()).trim();
        this.settings.lastRewriteInstruction = instruction;
        SillyTavern.getContext().saveSettingsDebounced();
        return instruction;
    }

    /** Shows exactly what was sent to the model, with estimated sizes per section. */
    async #showPrompt() {
        const prompt = this.#lastPrompt;
        if (!prompt) {
            return;
        }
        const $view = $('<div class="ns-prompt-view">');
        const total = prompt.sections.reduce((sum, section) => sum + section.tokens, 0);
        const $table = $('<table class="ns-prompt-sections">');
        $table.append('<tr><th>Section</th><th>≈ Tokens</th><th></th></tr>');
        for (const section of prompt.sections) {
            $table.append($('<tr>')
                .append($('<td>').text(section.name))
                .append($('<td>').text(section.tokens.toLocaleString()))
                .append($('<td>').text(section.truncated ? 'shortened to fit' : '')));
        }
        $table.append($('<tr class="ns-prompt-total">')
            .append('<td>Total</td>')
            .append($('<td>').text(`${total.toLocaleString()} of ${this.settings.contextBudget.toLocaleString()}`))
            .append($('<td>').text(`max ${prompt.maxTokens.toLocaleString()} response tokens`)));
        $view.append($table);
        for (const message of prompt.messages) {
            $view.append($('<h4>').text(message.role === 'system' ? 'System message' : 'User message'));
            $view.append($('<pre>').text(message.content));
        }
        await callGenericPopup($view, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    }
}

/** @returns {any} The Novel Studio extension settings */
function extensionSettings() {
    return SillyTavern.getContext().extensionSettings[MODULE];
}
