import { DOMPurify, showdown } from '../../../lib.js';
import { Popup, POPUP_TYPE } from '../../popup.js';
import {
    ASK_MAX_TOKENS,
    askSearchQuery,
    buildAskMessages,
    buildContinuityMessages,
    CONTINUITY_MAX_TOKENS,
    CONTINUITY_SCHEMA,
    normalizeIssues,
    splitCitations,
} from './ai/ask-logic.js';
import { detectMentions, formatEntityForPrompt, sceneOrder, stateAsOf } from './ai/codex-logic.js';
import { describeError, requestJson, requestText } from './ai/generate.js';
import { chapterLabel } from './ai/prompt.js';

const ASK_PASSAGES = 8;
const CONTINUITY_PASSAGES = 8;
/** How much of the story before a scene the continuity check reads as summaries. */
const CONTINUITY_SUMMARY_CHARS = 8000;
const SEVERITY_LABELS = Object.freeze({ high: 'Likely error', medium: 'Possible error', low: 'Minor' });

/**
 * "Ask the story" and continuity checking.
 */
export class StoryTools {
    /** @type {import('./studio.js').NovelStudio} */
    #studio;
    /** @type {JQuery<HTMLElement>} */
    #root;
    /** @type {{ question: string, answer: string, passages: any[] }[]} */
    #history = [];
    #asking = false;
    #checking = false;
    #converter = new showdown.Converter();

    /**
     * @param {import('./studio.js').NovelStudio} studio Studio that owns the tools
     */
    constructor(studio) {
        this.#studio = studio;
        this.#root = studio.$root;
        this.#bindEvents();
    }

    get #backgroundProfileId() {
        return this.#studio.settings.ai.backgroundProfileId;
    }

    /** Forgets the conversation, e.g. when another project opens. */
    clear() {
        this.#history = [];
        this.#root.find('.ns-ask-messages .ns-ask-turn').remove();
        this.#root.find('.ns-ask-empty').show();
    }

    // ---- Ask ----

    async ask() {
        const $input = this.#root.find('.ns-ask-input');
        const question = String($input.val()).trim();
        if (!question || this.#asking || !this.#studio.project) {
            return;
        }
        const studio = this.#studio;
        const projectId = studio.project.id;
        const before = this.#root.find('.ns-ask-scope').val() === 'before' ? studio.editor.sceneId : null;

        this.#asking = true;
        $input.val('');
        this.#root.find('.ns-ask-empty').hide();
        const $turn = $('<div class="ns-ask-turn">');
        $turn.append($('<div class="ns-ask-question">').text(question));
        const $answer = $('<div class="ns-ask-answer" data-status="running">').text('Searching the manuscript…');
        $turn.append($answer);
        this.#root.find('.ns-ask-messages').append($turn);
        this.#scrollToEnd();
        this.#root.find('.ns-ask-send').prop('disabled', true);

        try {
            const passages = await studio.search({
                query: askSearchQuery(question, this.#history),
                limit: ASK_PASSAGES,
                beforeSceneId: before ?? undefined,
            });
            $answer.text('Thinking…');
            const order = sceneOrder(studio.structure);
            const mentioned = detectMentions(question, studio.codex.entities);
            const codex = studio.codex.entities
                .filter(entity => mentioned.has(entity.id))
                .map(entity => formatEntityForPrompt(entity, stateAsOf(entity, order, before)));
            // The synopsis covers the whole book, so it is left out when asking about the story up to a scene
            const synopsis = before ? '' : (studio.memory.state?.book?.text ?? '');

            const answer = await requestText({
                profileId: this.#backgroundProfileId,
                role: 'background',
                messages: buildAskMessages({ project: studio.project, question, history: this.#history, passages, synopsis, codex }),
                maxTokens: ASK_MAX_TOKENS,
            });
            if (studio.project?.id !== projectId) {
                return;
            }
            this.#history.push({ question, answer, passages });
            this.#renderAnswer($answer, answer, passages);
        } catch (error) {
            console.error('Novel Studio: ask failed', error);
            $answer.attr('data-status', 'error').text(`Could not answer: ${describeError(error)}`);
        } finally {
            this.#asking = false;
            this.#root.find('.ns-ask-send').prop('disabled', false);
            this.#scrollToEnd();
        }
    }

    /**
     * Shows an answer with clickable citations and the list of sources.
     * @param {JQuery<HTMLElement>} $answer
     * @param {string} answer
     * @param {any[]} passages
     */
    #renderAnswer($answer, answer, passages) {
        $answer.attr('data-status', 'done').empty();
        // Citations become placeholders first, so Markdown rendering cannot mangle them
        const parts = splitCitations(answer, passages.length);
        const markdown = parts.map(part => 'citation' in part ? `@@CITE${part.citation}@@` : part.text).join('');
        const html = DOMPurify.sanitize(this.#converter.makeHtml(markdown))
            .replace(/@@CITE(\d+)@@/g, (_, n) => `<button type="button" class="ns-citation" data-index="${Number(n) - 1}">${Number(n)}</button>`);
        $answer.html(html);

        const cited = new Set(parts.filter(part => 'citation' in part).map(part => /** @type {any} */ (part).citation - 1));
        if (cited.size > 0) {
            const $sources = $('<div class="ns-ask-sources">');
            for (const index of [...cited].sort((a, b) => a - b)) {
                const passage = passages[index];
                $sources.append($('<button type="button" class="ns-citation-source">').attr('data-index', index)
                    .text(`${index + 1}. ${chapterLabel(passage.chapterNumber, passage.chapterTitle)} · ${passage.sceneTitle || 'Untitled scene'}`));
            }
            $answer.append($sources);
        }
        $answer.data('passages', passages);
    }

    /**
     * Opens the scene of a cited passage and highlights the passage.
     * @param {any} passage
     */
    async #openPassage(passage) {
        const studio = this.#studio;
        if (studio.editor.sceneId !== passage.sceneId) {
            await studio.openScene(passage.sceneId);
        }
        // Highlight the start of the passage; a long quote is more likely to differ slightly
        const firstSentence = passage.text.split(/(?<=[.!?…])\s/)[0].slice(0, 200);
        if (!studio.editor.selectQuote(firstSentence)) {
            toastr.info('The passage has changed since it was found.', 'Novel Studio');
        }
    }

    #scrollToEnd() {
        const $messages = this.#root.find('.ns-ask-messages');
        $messages.scrollTop($messages.prop('scrollHeight'));
    }

    // ---- Continuity ----

    /** Checks the open scene for contradictions with the codex and the story so far. */
    async checkContinuity() {
        const studio = this.#studio;
        const current = studio.getCurrentScene();
        if (!current || this.#checking) {
            return;
        }
        const $button = this.#root.find('.ns-check-continuity');
        this.#checking = true;
        $button.prop('disabled', true).find('span').text('Checking…');

        try {
            await studio.editor.flush();
            const sceneText = studio.editor.editor?.getMarkdown() ?? '';
            if (!sceneText.trim()) {
                toastr.info('This scene has no text to check yet.', 'Novel Studio');
                return;
            }
            const codexEntries = studio.codex.entriesForPrompt(current.scene, [sceneText]);
            const names = codexEntries.map(entry => entry.name).join(', ');
            const passages = await studio.search({
                query: [names, current.scene.beats ?? '', sceneText.slice(0, 1500)].join('\n'),
                limit: CONTINUITY_PASSAGES,
                beforeSceneId: current.scene.id,
            }).catch(() => []);
            const input = {
                project: studio.project,
                scene: current.scene,
                sceneText,
                codex: codexEntries.map(entry => entry.text),
                summaries: this.#storySoFar(current.scene.id),
                passages,
            };
            const result = await requestJson({
                profileId: this.#backgroundProfileId,
                role: 'background',
                messages: buildContinuityMessages(input),
                fallbackMessages: buildContinuityMessages({ ...input, jsonInstructions: true }),
                schema: CONTINUITY_SCHEMA,
                maxTokens: CONTINUITY_MAX_TOKENS,
            });
            await this.#showIssues(normalizeIssues(result), current.scene.id);
        } catch (error) {
            console.error('Novel Studio: continuity check failed', error);
            toastr.error(`Could not check continuity: ${describeError(error)}`, 'Novel Studio');
        } finally {
            this.#checking = false;
            $button.prop('disabled', false).find('span').text('Check continuity');
        }
    }

    /**
     * Summarizes the story before a scene from the synopsis and the latest summaries.
     * @param {string} sceneId
     * @returns {string}
     */
    #storySoFar(sceneId) {
        const memory = this.#studio.memory.memoryForPrompt(sceneId);
        const recent = memory.priorScenes.filter(scene => scene.summary).slice(-12)
            .map(scene => `${chapterLabel(scene.chapterNumber, scene.chapterTitle)} · ${scene.title}: ${scene.summary}`);
        const text = [memory.laterTextExists ? '' : memory.synopsis, ...recent].filter(Boolean).join('\n\n');
        return text.length > CONTINUITY_SUMMARY_CHARS ? text.slice(text.length - CONTINUITY_SUMMARY_CHARS) : text;
    }

    /**
     * Lists continuity issues; clicking a quote highlights it in the scene.
     * @param {ReturnType<typeof normalizeIssues>} issues
     * @param {string} sceneId
     */
    async #showIssues(issues, sceneId) {
        if (issues.length === 0) {
            toastr.success('No contradictions found with the codex and earlier scenes.', 'Novel Studio');
            return;
        }
        const $view = $('<div class="ns-issues">');
        $view.append($('<h3>').text(`${issues.length} possible continuity issue(s)`));
        for (const issue of issues) {
            const $issue = $('<div class="ns-issue">').attr('data-severity', issue.severity);
            $issue.append($('<span class="ns-issue-severity">').text(SEVERITY_LABELS[issue.severity]));
            $issue.append($('<p class="ns-issue-problem">').text(issue.problem));
            if (issue.quote) {
                $issue.append($('<button type="button" class="ns-issue-quote">').text(`“${issue.quote}”`).attr('title', 'Show in the scene'));
            }
            if (issue.reference) {
                $issue.append($('<p class="ns-issue-reference">').text(`Established in: ${issue.reference}`));
            }
            $view.append($issue);
        }
        const popup = new Popup($view, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        $view.on('click', '.ns-issue-quote', async (event) => {
            const quote = $(event.currentTarget).text().replace(/^“|”$/g, '');
            // Close the list first: the modal popup would cover the highlighted text
            await popup.completeCancelled();
            if (this.#studio.editor.sceneId === sceneId && !this.#studio.editor.selectQuote(quote)) {
                toastr.info('That text was not found in the scene; it may have changed.', 'Novel Studio');
            }
        });
        await popup.show();
    }

    // ---- Events ----

    #bindEvents() {
        const $root = this.#root;
        $root.on('submit', '.ns-ask-form', (event) => {
            event.preventDefault();
            this.ask();
        });
        $root.on('keydown', '.ns-ask-input', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.ask();
            }
        });
        $root.on('click', '.ns-ask-clear', () => this.clear());
        $root.on('click', '.ns-citation, .ns-citation-source', (event) => {
            const passages = $(event.currentTarget).closest('.ns-ask-answer').data('passages') ?? [];
            const passage = passages[Number(event.currentTarget.dataset.index)];
            if (passage) {
                this.#openPassage(passage);
            }
        });
        $root.on('click', '.ns-check-continuity', () => this.checkContinuity());
    }
}
