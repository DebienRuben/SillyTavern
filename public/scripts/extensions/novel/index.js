import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { NovelStudio } from './studio.js';

const MODULE = 'novel';

const DEFAULT_SETTINGS = Object.freeze({
    openOnStartup: false,
    /** @type {string|null} */
    lastProjectId: null,
    /** @type {Record<string, string>} */
    lastSceneByProject: {},
});

/** @type {NovelStudio|null} */
let studio = null;

async function toggleStudio() {
    if (!studio) {
        return;
    }
    try {
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
    $('#novel_open_studio').on('click', () => studio?.isOpen || toggleStudio());
}

export async function init() {
    extension_settings[MODULE] = { ...structuredClone(DEFAULT_SETTINGS), ...(extension_settings[MODULE] ?? {}) };

    studio = await NovelStudio.create();
    addTopBarButton();
    await addSettingsPanel();

    eventSource.once(event_types.APP_READY, () => {
        if (extension_settings[MODULE].openOnStartup) {
            toggleStudio();
        }
    });
}
