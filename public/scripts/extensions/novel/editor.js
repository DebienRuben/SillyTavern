import { tiptap } from '../../../lib.js';
import { novelApi, NovelApiError } from './api.js';

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
 */

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
