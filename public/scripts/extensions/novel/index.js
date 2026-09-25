import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { NovelStudio } from './studio.js';

const MODULE = 'novel';

const DEFAULT_SETTINGS = Object.freeze({
    openOnStartup: false,
    /** Hide SillyTavern's roleplay features and keep Novel Studio open. */
    novelOnly: false,
    /** @type {string|null} */
    lastProjectId: null,
    /** @type {Record<string, string>} */
    lastSceneByProject: {},
    ai: {
        /** @type {string|null} */
        writerProfileId: null,
        /** @type {string|null} */
        backgroundProfileId: null,
        contextBudget: 24000,
        length: 'medium',
        /** Custom writer instructions; empty means the built-in default. */
        instructions: '',
        lastRewriteInstruction: '',
        /** Semantic search: 'none' (keywords only), 'transformers' (local model) or 'openrouter'. */
        embeddingSource: 'none',
        embeddingModel: '',
    },
});

/** @type {NovelStudio|null} */
let studio = null;

async function toggleStudio() {
    if (!studio) {
        return;
    }
    try {
        // In novel-only mode the studio stays open
        if (studio.isOpen && extension_settings[MODULE].novelOnly) {
            return;
        }
        if (studio.isOpen) {
            await studio.close();
        } else {
            await studio.open();
        }
    } catch (error) {
        console.error('Novel Studio error', error);
        toastr.error(error.message, 'Novel Studio');
    }
}

function addTopBarButton() {
    const $button = $(`
        <div id="novel-studio-button" class="drawer">
            <div class="drawer-header">
                <div class="drawer-icon fa-solid fa-feather-pointed fa-fw closedIcon interactable" title="Novel Studio" tabindex="0" role="button"></div>
            </div>
        </div>`);
    $button.on('click keydown', (event) => {
        if (event.type === 'keydown' && event.key !== 'Enter') {
            return;
        }
        toggleStudio();
    });
    $('#top-settings-holder').prepend($button);
}

async function addSettingsPanel() {
    const html = await renderExtensionTemplateAsync(MODULE, 'settings');
    $('#extensions_settings2').append(html);
    $('#novel_open_on_startup')
        .prop('checked', extension_settings[MODULE].openOnStartup)
        .on('change', function () {
            extension_settings[MODULE].openOnStartup = !!$(this).prop('checked');
            saveSettingsDebounced();
        });
    $('#novel_novel_only')
        .prop('checked', extension_settings[MODULE].novelOnly)
        .on('change', function () {
            extension_settings[MODULE].novelOnly = !!$(this).prop('checked');
            saveSettingsDebounced();
            applyNovelOnly();
        });
    $('#novel_open_studio').on('click', () => studio?.isOpen || toggleStudio());
}

/** Applies novel-only mode: hides the roleplay parts of SillyTavern and keeps the studio open. */
function applyNovelOnly() {
    const enabled = extension_settings[MODULE].novelOnly;
    document.body.classList.toggle('novel-only', enabled);
    if (enabled && studio && !studio.isOpen) {
        toggleStudio();
    }
}

export async function init() {
    const saved = extension_settings[MODULE] ?? {};
    const defaults = structuredClone(DEFAULT_SETTINGS);
    extension_settings[MODULE] = { ...defaults, ...saved, ai: { ...defaults.ai, ...(saved.ai ?? {}) } };

    studio = await NovelStudio.create();
    addTopBarButton();
    await addSettingsPanel();

    eventSource.once(event_types.APP_READY, () => {
        if (extension_settings[MODULE].novelOnly) {
            applyNovelOnly();
        } else if (extension_settings[MODULE].openOnStartup) {
            toggleStudio();
        }
    });
}
