/**
 * Codex logic for Novel Studio: mention detection, state over time, prompt
 * formatting and extraction. Pure functions only, so it can be unit tested.
 */

export const ENTITY_TYPES = Object.freeze({
    character: 'Character',
    location: 'Location',
    item: 'Item',
    faction: 'Faction',
    lore: 'Lore',
});

/** State facets, in display order, with labels and what they mean for the extractor. */
export const STATE_FIELDS = Object.freeze({
    location: { label: 'Location', hint: 'where they are (or where an item is) at the end of the scene' },
    condition: { label: 'Condition', hint: 'physical and emotional state, injuries' },
    goals: { label: 'Goals', hint: 'what they currently want or intend' },
    relationships: { label: 'Relationships', hint: 'how they stand with other named characters' },
    possessions: { label: 'Possessions', hint: 'important things they carry or own' },
    knowledge: { label: 'Knowledge', hint: 'important things they know or have learned, including secrets' },
});

const MIN_ALIAS_LENGTH = 2;
const PROMPT_DESCRIPTION_CHARS = 1200;
const EXTRACTION_DESCRIPTION_CHARS = 600;

/**
 * Maps each scene ID to its position in the manuscript.
 * @param {any} structure Project structure
 * @returns {Map<string, number>}
 */
export function sceneOrder(structure) {
    const order = new Map();
    for (const chapter of structure?.chapters ?? []) {
        for (const scene of chapter.scenes) {
            order.set(scene.id, order.size);
        }
    }
    return order;
}

/**
 * Works out an entity's state at a point in the story by applying its state
 * entries in manuscript order. Entries for deleted scenes are ignored.
 * @param {any} entity Codex entity
 * @param {Map<string, number>} order Scene order from sceneOrder()
 * @param {string | null} sceneId Scene to look at; null for the end of the manuscript
 * @param {{ includeScene?: boolean }} [options] Whether the scene's own entry counts (default true)
 * @returns {Record<string, string>} Current value per state field
 */
export function stateAsOf(entity, order, sceneId, { includeScene = true } = {}) {
    const limit = sceneId === null ? Infinity : order.get(sceneId);
    if (limit === undefined) {
        return {};
    }
    const entries = (entity.state ?? [])
        .filter((/** @type {any} */ entry) => order.has(entry.sceneId))
        .map((/** @type {any} */ entry) => ({ entry, index: order.get(entry.sceneId) }))
        .filter(({ index }) => includeScene ? index <= limit : index < limit)
        .sort((a, b) => a.index - b.index);

    /** @type {Record<string, string>} */
    const state = {};
    for (const { entry } of entries) {
        for (const field of Object.keys(STATE_FIELDS)) {
            if (typeof entry[field] === 'string' && entry[field].trim()) {
                state[field] = entry[field].trim();
            }
        }
    }
    return state;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a matcher for an entity's name and aliases as whole words, ignoring case.
 * @param {any} entity Codex entity
 * @returns {RegExp | null}
 */
function nameMatcher(entity) {
    const names = [entity.name, ...(entity.aliases ?? [])]
        .map(name => name.trim())
        .filter(name => name.length >= MIN_ALIAS_LENGTH)
        // Longest first, so "Mara Voss" wins over "Mara"
        .sort((a, b) => b.length - a.length)
        .map(name => escapeRegex(name).replace(/\s+/g, '\\s+'));
    if (names.length === 0) {
        return null;
    }
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Finds the entities mentioned in a text by name or alias.
 * @param {string} text Text to search
 * @param {any[]} entities Codex entities
 * @returns {Set<string>} IDs of mentioned entities
 */
export function detectMentions(text, entities) {
    const found = new Set();
    if (!text?.trim()) {
        return found;
    }
    for (const entity of entities) {
        if (nameMatcher(entity)?.test(text)) {
            found.add(entity.id);
        }
    }
    return found;
}

/**
 * @typedef {'pinned' | 'pov' | 'location' | 'mentioned'} RelevanceReason
 */

/**
 * Picks the codex entries relevant to a writing request, most important first:
 * pinned to the scene, the point-of-view character, the scene's location, then anything mentioned.
 * @param {object} input
 * @param {any[]} input.entities All codex entities
 * @param {any} input.scene Scene metadata (cast, pov, location, beats)
 * @param {string[]} input.texts Texts to scan for mentions (e.g. nearby prose)
 * @returns {{ entity: any, reason: RelevanceReason }[]}
 */
export function selectRelevantEntities({ entities, scene, texts }) {
    /** @type {Map<string, RelevanceReason>} */
    const reasons = new Map();
    const add = (/** @type {string} */ id, /** @type {RelevanceReason} */ reason) => {
        if (!reasons.has(id)) {
            reasons.set(id, reason);
        }
    };

    const byId = new Map(entities.map(entity => [entity.id, entity]));
    for (const id of scene.cast ?? []) {
        if (byId.has(id)) {
            add(id, 'pinned');
        }
    }
    for (const id of detectMentions(scene.pov ?? '', entities)) {
        add(id, 'pov');
    }
    for (const id of detectMentions(scene.location ?? '', entities)) {
        add(id, 'location');
    }
    for (const id of detectMentions([scene.beats ?? '', ...texts].join('\n'), entities)) {
        add(id, 'mentioned');
    }
    return [...reasons.entries()].map(([id, reason]) => ({ entity: byId.get(id), reason }));
}

/**
 * Formats a codex entry for a writing prompt.
 * @param {any} entity Codex entity
 * @param {Record<string, string>} state Entity state at the current point of the story
 * @returns {string}
 */
export function formatEntityForPrompt(entity, state) {
    const lines = [`## ${entity.name} (${ENTITY_TYPES[entity.type]?.toLowerCase() ?? entity.type})`];
    if (entity.aliases?.length) {
        lines.push(`Also called: ${entity.aliases.join(', ')}`);
    }
    const description = entity.description?.trim();
    if (description) {
        lines.push(description.length > PROMPT_DESCRIPTION_CHARS ? `${description.slice(0, PROMPT_DESCRIPTION_CHARS)}…` : description);
    }
    const stateLines = Object.entries(STATE_FIELDS)
        .filter(([field]) => state[field])
        .map(([field, { label }]) => `- ${label}: ${state[field]}`);
    if (stateLines.length) {
        lines.push('Current state:', ...stateLines);
    }
    return lines.join('\n');
}

const STATE_PROPERTIES = Object.fromEntries(Object.keys(STATE_FIELDS).map(field => [field, { type: 'string' }]));

/** Strict JSON schema for codex extraction. Empty strings mean "no change". */
export const EXTRACTION_SCHEMA = Object.freeze({
    name: 'codex_update',
    description: 'Changes to the novel\'s codex caused by one scene',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        required: ['updates', 'newEntities', 'threads'],
        properties: {
            threads: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['action', 'threadId', 'title', 'description', 'note', 'evidence'],
                    properties: {
                        action: { type: 'string', enum: ['open', 'advance', 'resolve'] },
                        threadId: { type: 'string' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        note: { type: 'string' },
                        evidence: { type: 'string' },
                    },
                },
            },
            updates: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['entityId', ...Object.keys(STATE_FIELDS), 'evidence'],
                    properties: { entityId: { type: 'string' }, ...STATE_PROPERTIES, evidence: { type: 'string' } },
                },
            },
            newEntities: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'name', 'aliases', 'description', ...Object.keys(STATE_FIELDS), 'evidence'],
                    properties: {
                        type: { type: 'string', enum: Object.keys(ENTITY_TYPES) },
                        name: { type: 'string' },
                        aliases: { type: 'array', items: { type: 'string' } },
                        description: { type: 'string' },
                        ...STATE_PROPERTIES,
                        evidence: { type: 'string' },
                    },
                },
            },
        },
    },
});

/**
 * Builds the messages asking the background model how a scene changes the codex.
 * @param {object} input
 * @param {any} input.project Project metadata
 * @param {any} input.chapter Chapter of the scene
 * @param {number} input.chapterNumber 1-based chapter number
 * @param {any} input.scene Scene metadata
 * @param {string} input.sceneText Scene prose
 * @param {{ entity: any, state: Record<string, string> }[]} input.known Entities with their recorded state up to and including the scene
 * @param {any[]} [input.threads] Plot threads open at this scene
 * @param {boolean} [input.jsonInstructions] Also describe the JSON format in the prompt (for models without schema support)
 * @returns {{ role: 'system' | 'user', content: string }[]}
 */
export function buildExtractionMessages({ project, chapter, chapterNumber, scene, sceneText, known, threads = [], jsonInstructions = false }) {
    const system = [
        'You maintain the codex (story bible) of a novel: its characters, locations, items, factions and lore, and how their state changes over the story.',
        'Read the scene and report what it changes. Be precise and conservative: report only what the scene shows or clearly implies. Never invent facts.',
    ].join('\n');

    const knownText = known.length === 0
        ? '(The codex is empty.)'
        : known.map(({ entity, state }) => {
            const lines = [`- id: ${entity.id}`, `  type: ${entity.type}`, `  name: ${entity.name}`];
            if (entity.aliases?.length) {
                lines.push(`  aliases: ${entity.aliases.join(', ')}`);
            }
            const description = entity.description?.trim();
            if (description) {
                lines.push(`  description: ${description.slice(0, EXTRACTION_DESCRIPTION_CHARS).replace(/\s+/g, ' ')}`);
            }
            for (const field of Object.keys(STATE_FIELDS)) {
                if (state[field]) {
                    lines.push(`  ${field}: ${state[field]}`);
                }
            }
            return lines.join('\n');
        }).join('\n');

    const fieldGuide = Object.entries(STATE_FIELDS).map(([field, { hint }]) => `  - ${field}: ${hint}`).join('\n');
    const instructions = [
        'Report the changes this scene makes:',
        '',
        '<codex> holds the state as currently recorded. It may already include some changes from this scene; report only what still differs.',
        '',
        '1. "updates": one item for each KNOWN entry whose state changes in this scene. Use its id as entityId.',
        '   For every state field, give the complete new value (the previous value combined with the change, as it stands at the end of the scene), or "" if this scene does not change it.',
        '   State fields:',
        fieldGuide,
        '   "evidence": a short quote from the scene that shows the change.',
        '   Leave out entries that do not change.',
        '',
        '2. "newEntities": characters, locations, items, factions or lore that matter to the story and are NOT in the codex yet. Skip unnamed or one-off walk-ons.',
        '   Give type, name, the other names the text uses for it (aliases), a description of only what the text establishes, its state fields as of the end of the scene ("" if unknown), and evidence.',
        '',
        '3. "threads": plot threads, meaning mysteries, promises, secrets, goals, conflicts or setups that need a payoff later.',
        '   - "open": a new thread this scene introduces (threadId "", a short title, and a one-sentence description).',
        '   - "advance": the scene develops a thread in <open_threads> (use its threadId; note what changed).',
        '   - "resolve": the scene pays off or closes a thread in <open_threads> (use its threadId; note how).',
        '   Only real story threads; not every detail. Leave out threads the scene does not touch.',
    ];
    if (jsonInstructions) {
        instructions.push(
            '',
            'Respond with a single JSON object and nothing else, in this shape:',
            '{"updates":[{"entityId":"","location":"","condition":"","goals":"","relationships":"","possessions":"","knowledge":"","evidence":""}],'
            + '"newEntities":[{"type":"character","name":"","aliases":[],"description":"","location":"","condition":"","goals":"","relationships":"","possessions":"","knowledge":"","evidence":""}],'
            + '"threads":[{"action":"open","threadId":"","title":"","description":"","note":"","evidence":""}]}',
        );
    }

    const meta = [
        `Novel: ${project.title}`,
        `Chapter ${chapterNumber}${chapter.title ? `: ${chapter.title}` : ''}`,
        `Scene: ${scene.title || 'Untitled'}`,
        scene.pov ? `Point of view: ${scene.pov}` : '',
        scene.location ? `Location: ${scene.location}` : '',
        scene.storyTime ? `Story time: ${scene.storyTime}` : '',
    ].filter(Boolean).join('\n');

    const user = [
        `<codex>\n${knownText}\n</codex>`,
        `<open_threads>\n${threads.length ? threads.map(thread => `- id: ${thread.id}\n  title: ${thread.title}${thread.description ? `\n  description: ${thread.description}` : ''}`).join('\n') : '(No open plot threads.)'}\n</open_threads>`,
        `<scene>\n${meta}\n\n${sceneText.trim()}\n</scene>`,
        `<instructions>\n${instructions.join('\n')}\n</instructions>`,
    ].join('\n\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

/**
 * Parses a model response into an object, tolerating code fences and surrounding text.
 * @param {unknown} response Parsed JSON or raw text
 * @returns {any}
 */
export function parseJsonResponse(response) {
    if (response && typeof response === 'object') {
        return response;
    }
    const text = String(response ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
        throw new Error('The background model did not return valid JSON.');
    }
}

/**
 * Picks the state fields that differ from the current state.
 * @param {any} source Object with state fields
 * @param {Record<string, string>} current Current state
 * @returns {Record<string, string>}
 */
function changedFields(source, current) {
    /** @type {Record<string, string>} */
    const changes = {};
    for (const field of Object.keys(STATE_FIELDS)) {
        const value = typeof source?.[field] === 'string' ? source[field].trim() : '';
        if (value && value !== (current[field] ?? '')) {
            changes[field] = value;
        }
    }
    return changes;
}

/**
 * Turns an extraction result into suggestions for the review queue. Drops unchanged
 * fields and unknown IDs, and turns "new" entities that already exist into updates.
 * @param {any} result Parsed extraction result
 * @param {{ entity: any, state: Record<string, string> }[]} known Entities with their recorded state
 * @param {any[]} [threads] Known plot threads
 * @returns {any[]} Suggestions for the server
 */
export function extractionToSuggestions(result, known, threads = []) {
    const byId = new Map(known.map(item => [item.entity.id, item]));
    const byName = new Map();
    for (const item of known) {
        for (const name of [item.entity.name, ...(item.entity.aliases ?? [])]) {
            byName.set(name.trim().toLowerCase(), item);
        }
    }

    /** @type {Map<string, { kind: 'update', entityId: string, changes: Record<string, string>, evidence: string }>} */
    const updates = new Map();
    const addUpdate = (/** @type {any} */ item, /** @type {any} */ source) => {
        const changes = changedFields(source, item.state);
        if (Object.keys(changes).length === 0) {
            return;
        }
        const existing = updates.get(item.entity.id);
        if (existing) {
            Object.assign(existing.changes, changes);
        } else {
            updates.set(item.entity.id, { kind: 'update', entityId: item.entity.id, changes, evidence: String(source?.evidence ?? '').trim() });
        }
    };

    for (const update of Array.isArray(result?.updates) ? result.updates : []) {
        const item = byId.get(update?.entityId) ?? byName.get(String(update?.entityId ?? '').trim().toLowerCase());
        if (item) {
            addUpdate(item, update);
        }
    }

    const creates = [];
    const createdNames = new Set();
    for (const candidate of Array.isArray(result?.newEntities) ? result.newEntities : []) {
        const name = String(candidate?.name ?? '').trim();
        if (!name) {
            continue;
        }
        const existing = byName.get(name.toLowerCase());
        if (existing) {
            addUpdate(existing, candidate);
            continue;
        }
        if (createdNames.has(name.toLowerCase())) {
            continue;
        }
        createdNames.add(name.toLowerCase());
        creates.push({
            kind: /** @type {const} */ ('create'),
            entity: {
                type: Object.hasOwn(ENTITY_TYPES, candidate.type) ? candidate.type : 'character',
                name,
                aliases: (Array.isArray(candidate.aliases) ? candidate.aliases : [])
                    .map((/** @type {unknown} */ alias) => String(alias).trim())
                    .filter((/** @type {string} */ alias) => alias && alias.toLowerCase() !== name.toLowerCase()),
                description: String(candidate.description ?? '').trim(),
            },
            changes: changedFields(candidate, {}),
            evidence: String(candidate.evidence ?? '').trim(),
        });
    }

    return [...updates.values(), ...creates, ...threadSuggestions(result?.threads, threads)];
}

/**
 * Turns extracted plot thread changes into suggestions. New threads whose title already
 * exists become updates of that thread.
 * @param {unknown} extracted Extracted thread changes
 * @param {any[]} threads Known plot threads
 * @returns {any[]}
 */
function threadSuggestions(extracted, threads) {
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    const byTitle = new Map(threads.map(thread => [thread.title.trim().toLowerCase(), thread]));
    const suggestions = [];
    const seen = new Set();

    for (const item of Array.isArray(extracted) ? extracted : []) {
        const title = String(item?.title ?? '').trim();
        const evidence = String(item?.evidence ?? '').trim();
        const note = String(item?.note ?? '').trim();
        const known = byId.get(item?.threadId) ?? byTitle.get(title.toLowerCase());

        if (known) {
            if (seen.has(known.id)) {
                continue;
            }
            const status = item.action === 'resolve' ? 'resolved' : 'open';
            if (!note && status === known.status) {
                continue;
            }
            seen.add(known.id);
            suggestions.push({ kind: 'thread-update', threadId: known.id, status, note, evidence });
        } else if (item?.action === 'open' && title && !seen.has(title.toLowerCase())) {
            seen.add(title.toLowerCase());
            suggestions.push({ kind: 'thread-open', thread: { title, description: String(item.description ?? '').trim() }, evidence });
        }
    }
    return suggestions;
}

/**
 * Lists the plot threads open when a scene begins: opened earlier and not yet resolved.
 * Threads without a known opening scene count as open from the start.
 * @param {any[]} threads All plot threads
 * @param {Map<string, number>} order Scene order from sceneOrder()
 * @param {string} sceneId Current scene
 * @returns {any[]}
 */
export function openThreadsAt(threads, order, sceneId) {
    const position = order.get(sceneId) ?? Infinity;
    return threads.filter((thread) => {
        const opened = thread.openedIn && order.has(thread.openedIn) ? order.get(thread.openedIn) : -1;
        const resolved = thread.status === 'resolved' && thread.resolvedIn && order.has(thread.resolvedIn) ? order.get(thread.resolvedIn) : Infinity;
        const resolvedWithoutScene = thread.status === 'resolved' && !(thread.resolvedIn && order.has(thread.resolvedIn));
        return opened < position && resolved >= position && !resolvedWithoutScene;
    });
}

/**
 * Formats a plot thread for a writing prompt, with its latest development before the scene.
 * @param {any} thread Plot thread
 * @param {Map<string, number>} order Scene order
 * @param {string} sceneId Current scene
 * @returns {{ title: string, text: string }}
 */
export function formatThreadForPrompt(thread, order, sceneId) {
    const position = order.get(sceneId) ?? Infinity;
    const latest = [...(thread.notes ?? [])].reverse().find(note => note.sceneId && (order.get(note.sceneId) ?? Infinity) < position);
    const parts = [thread.title];
    if (thread.description) {
        parts.push(`: ${thread.description}`);
    }
    if (latest) {
        parts.push(` (latest: ${latest.text})`);
    }
    return { title: thread.title, text: parts.join('') };
}
