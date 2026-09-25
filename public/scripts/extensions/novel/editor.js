import { tiptap } from '../../../lib.js';
import { novelApi, NovelApiError } from './api.js';
import { findQuote } from './ai/ask-logic.js';

const AUTOSAVE_DELAY_MS = 1500;

/**
 * @typedef {'saved' | 'dirty' | 'saving' | 'error' | 'conflict'} SaveStatus
 */

/**
 * @typedef {object} SceneEditorCallbacks
 * @property {(status: SaveStatus) => void} onStatus Called when the save status changes
 * @property {(words: number) => void} onWordCount Called with the live word count while typing
 * @property {(sceneId: string, wordCount: number) => void} onSaved Called with the server word count after a save
 * @property {(sceneId: string) => Promise<'overwrite' | 'reload'>} onConflict Asks how to resolve a conflicting edit
 * @property {(hasSelection: boolean) => void} onSelectionChange Called when the selection becomes empty or non-empty
 */

/**
 * @typedef {object} CursorContext
 * @property {number} from Start of the selection (equal to `to` for a cursor)
 * @property {number} to End of the selection
 * @property {string} before Plain text of the scene before the selection
 * @property {string} selection Plain text of the selection
 * @property {string} after Plain text of the scene after the selection
 */

/** Blocks are separated by blank lines, like Markdown paragraphs. */
const BLOCK_SEPARATOR = '\n\n';

/**
 * TipTap editor for one scene at a time, with debounced autosave.
 * Scene prose is stored as Markdown.
 */
export class SceneEditor {
    /** @type {HTMLElement} */
    #element;
    /** @type {SceneEditorCallbacks} */
    #callbacks;
    /** @type {any} */
    #editor = null;
    /** @type {{ projectId: string, sceneId: string, baseHash: string } | null} */
    #scene = null;
    /** Incremented on every edit, to tell whether an edit happened during a save. */
    #version = 0;
    #savedVersion = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    #timer = null;
    /** @type {Promise<void> | null} */
    #saving = null;

    /**
     * @param {HTMLElement} element Element to mount the editor in
     * @param {SceneEditorCallbacks} callbacks Callbacks
     */
    constructor(element, callbacks) {
        this.#element = element;
        this.#callbacks = callbacks;
    }

    /** The underlying TipTap editor, or null if no scene is open. */
    get editor() {
        return this.#editor;
    }

    /** The ID of the open scene, or null. */
    get sceneId() {
        return this.#scene?.sceneId ?? null;
    }

    /** Whether there are edits that are not saved yet. */
    get isDirty() {
        return this.#version !== this.#savedVersion;
    }

    /**
     * Opens a scene, replacing the current one. Call flush() first to keep pending edits.
     * @param {string} projectId Project ID
     * @param {string} sceneId Scene ID
     * @param {string} content Scene Markdown
     * @param {string} hash Hash of the content, for conflict detection
     */
    open(projectId, sceneId, content, hash) {
        this.close();
        this.#scene = { projectId, sceneId, baseHash: hash };
        // A fresh editor per scene keeps undo history from leaking between scenes
        this.#editor = new tiptap.Editor({
            element: this.#element,
            extensions: [
                tiptap.StarterKit.configure({
                    heading: { levels: [2, 3] },
                    code: false,
                    codeBlock: false,
                    link: false,
                    underline: false,
                }),
                tiptap.Placeholder.configure({ placeholder: 'Start writing…' }),
                tiptap.CharacterCount,
                tiptap.Markdown,
            ],
            content,
            contentType: 'markdown',
            editorProps: {
                attributes: { class: 'novel-prose', spellcheck: 'true' },
            },
            onUpdate: () => this.#onEdit(),
            onSelectionUpdate: ({ editor }) => this.#callbacks.onSelectionChange(!editor.state.selection.empty),
        });
        this.#callbacks.onWordCount(this.wordCount());
        this.#callbacks.onStatus('saved');
    }

    /** Closes the open scene without saving. */
    close() {
        this.#clearTimer();
        this.#editor?.destroy();
        this.#editor = null;
        this.#scene = null;
        this.#version = 0;
        this.#savedVersion = 0;
    }

    /**
     * Gets the text around the cursor or selection, for writing prompts.
     * @returns {CursorContext | null}
     */
    getCursorContext() {
        if (!this.#editor) {
            return null;
        }
        const { doc, selection } = this.#editor.state;
        const { from, to } = selection;
        return {
            from,
            to,
            before: doc.textBetween(0, from, BLOCK_SEPARATOR, ' '),
            selection: doc.textBetween(from, to, BLOCK_SEPARATOR, ' '),
            after: doc.textBetween(to, doc.content.size, BLOCK_SEPARATOR, ' '),
        };
    }

    /**
     * Allows or blocks editing, e.g. while generated text is being reviewed.
     * @param {boolean} editable Whether the scene can be edited
     */
    setEditable(editable) {
        this.#editor?.setEditable(editable);
    }

    /**
     * Inserts generated Markdown as a single undoable edit, replacing the range if it
     * is not empty. At a cursor, starts a new paragraph when the model did, or when
     * the cursor ends a finished paragraph; otherwise joins the text with a space.
     * @param {{ from: number, to: number }} range Range to insert at or replace
     * @param {string} markdown Generated Markdown
     * @param {boolean} startsNewParagraph Whether the raw output began with a line break
     */
    insertGenerated(range, markdown, startsNewParagraph) {
        const editor = this.#editor;
        if (!editor || !markdown.trim()) {
            return;
        }
        const { state, schema } = editor;
        const { doc } = state;
        const parsed = editor.markdown.parse(markdown.trim());
        const blocks = parsed.content ?? [];
        if (blocks.length === 0) {
            return;
        }

        const $from = doc.resolve(range.from);
        const $to = doc.resolve(range.to);
        const atBlockStart = $from.parentOffset === 0;
        const atBlockEnd = $to.parentOffset === $to.parent.content.size;
        const isCursor = range.from === range.to;
        const endsSentence = /[.!?…"'”’)\]]\s*$/.test($from.parent.textContent);
        const startsLowercase = /^\p{Ll}/u.test(markdown.trimStart());
        const asNewBlocks = isCursor && atBlockEnd && !atBlockStart
            && (startsNewParagraph || (endsSentence && !startsLowercase));

        const tr = state.tr;
        let end;
        if (asNewBlocks) {
            // Whole paragraphs after the current one
            const after = $from.after();
            tr.insert(after, schema.nodeFromJSON(parsed).content);
            end = tr.mapping.map(after, 1) - 1;
        } else {
            // Merge the first paragraph into the text before the range and the last one into the text after it
            const first = blocks[0];
            const last = blocks[blocks.length - 1];
            const textBefore = doc.textBetween(Math.max($from.start(), range.from - 1), range.from);
            const textAfter = doc.textBetween(range.to, Math.min($to.end(), range.to + 1));
            if (!atBlockStart && textBefore && !/\s/.test(textBefore) && !/^[\s.,;:!?…)\]'"”’—-]/.test(markdown)) {
                first.content = [{ type: 'text', text: ' ' }, ...(first.content ?? [])];
            }
            if (!atBlockEnd && textAfter && !/[\s.,;:!?…)\]'"”’—-]/.test(textAfter) && !/\s$/.test(markdown)) {
                last.content = [...(last.content ?? []), { type: 'text', text: ' ' }];
            }
            const node = schema.nodeFromJSON(parsed);
            // Positions 1 and size-1 are inside the first and last paragraph, so both ends of the slice are open
            tr.replace(range.from, range.to, node.slice(1, node.content.size - 1));
            end = tr.mapping.map(range.to, 1);
        }
        editor.view.dispatch(tr.scrollIntoView());
        editor.commands.focus(end);
    }

    /**
     * Selects a quote in the scene and scrolls to it, tolerating whitespace and quote-mark differences.
     * @param {string} quote Text to find
     * @returns {boolean} Whether the quote was found
     */
    selectQuote(quote) {
        const editor = this.#editor;
        if (!editor) {
            return false;
        }
        // Build the scene's plain text with a document position for every character
        let text = '';
        /** @type {number[]} */
        const positions = [];
        editor.state.doc.descendants((/** @type {any} */ node, /** @type {number} */ pos) => {
            if (node.isTextblock && text) {
                text += BLOCK_SEPARATOR;
                positions.push(-1, -1);
            }
            if (node.isText) {
                for (let i = 0; i < node.text.length; i++) {
                    positions.push(pos + i);
                }
                text += node.text;
            }
        });
        const range = findQuote(text, quote);
        if (!range) {
            return false;
        }
        const from = positions.slice(range.start).find(p => p >= 0);
        const to = positions.slice(0, range.end).reverse().find(p => p >= 0) + 1;
        editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
        return true;
    }

    /** @returns {number} Live word count of the open scene */
    wordCount() {
        return this.#editor?.storage.characterCount.words() ?? 0;
    }

    /**
     * Replaces the scene content as an undoable edit, e.g. to restore a snapshot.
     * @param {string} markdown New content
     */
    replaceContent(markdown) {
        this.#editor?.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: true });
    }

    /**
     * Saves pending edits immediately.
     * @param {{ keepalive?: boolean }} [options] Use keepalive when the page is unloading
     */
    async flush(options = {}) {
        this.#clearTimer();
        // Wait for a save in progress, then save anything edited meanwhile
        while (this.#saving) {
            await this.#saving;
        }
        if (this.isDirty) {
            this.#saving = this.#save(options).finally(() => { this.#saving = null; });
            await this.#saving;
        }
    }

    #onEdit() {
        this.#version++;
        this.#callbacks.onWordCount(this.wordCount());
        this.#callbacks.onStatus('dirty');
        this.#clearTimer();
        this.#timer = setTimeout(() => this.flush(), AUTOSAVE_DELAY_MS);
    }

    #clearTimer() {
        if (this.#timer) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
    }

    /**
     * @param {{ keepalive?: boolean }} options
     * @param {boolean} [force] Skip the conflict check
     */
    async #save(options, force = false) {
        const scene = this.#scene;
        if (!scene || !this.#editor) {
            return;
        }
        const version = this.#version;
        const content = this.#editor.getMarkdown();
        this.#callbacks.onStatus('saving');

        try {
            const result = await novelApi.saveScene(scene.projectId, scene.sceneId, content, force ? undefined : scene.baseHash, options);
            scene.baseHash = result.hash;
            if (this.#scene === scene) {
                this.#savedVersion = version;
                this.#callbacks.onStatus(this.isDirty ? 'dirty' : 'saved');
            }
            this.#callbacks.onSaved(scene.sceneId, result.wordCount);
        } catch (error) {
            if (error instanceof NovelApiError && error.status === 409 && this.#scene === scene) {
                this.#callbacks.onStatus('conflict');
                const choice = await this.#callbacks.onConflict(scene.sceneId);
                if (choice === 'overwrite') {
                    return this.#save(options, true);
                }
                const fresh = await novelApi.getScene(scene.projectId, scene.sceneId);
                this.open(scene.projectId, scene.sceneId, fresh.content, fresh.hash);
                return;
            }
            console.error('Novel Studio: failed to save scene', error);
            if (this.#scene === scene) {
                this.#callbacks.onStatus('error');
                // Retry later; edits stay in the editor meanwhile
                this.#clearTimer();
                this.#timer = setTimeout(() => this.flush(), AUTOSAVE_DELAY_MS * 4);
            }
        }
    }
}
