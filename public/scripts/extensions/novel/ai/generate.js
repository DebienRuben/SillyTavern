import { ConnectionManagerRequestService } from '../../shared.js';
import { parseJsonResponse } from './codex-logic.js';
import { cleanOutput } from './prompt.js';

/**
 * Lists the connection profiles that can be used for writing requests.
 * @returns {{ id: string, name: string }[]} Profiles, or an empty list if Connection Manager is off
 */
export function getProfiles() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles()
            .map(profile => ({ id: profile.id, name: profile.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

/**
 * Finds a usable profile by ID.
 * @param {string|null|undefined} profileId Profile ID
 * @param {string} role Role of the profile, for error messages
 * @returns {string} The profile ID
 */
function requireProfile(profileId, role) {
    if (!profileId) {
        throw new Error(`No ${role} model is set. Choose a connection profile in AI settings.`);
    }
    if (!getProfiles().some(profile => profile.id === profileId)) {
        throw new Error(`The ${role} connection profile no longer exists. Choose another one in AI settings.`);
    }
    return profileId;
}

/**
 * Finds the most useful message in an error chain; the request service wraps
 * provider errors in a generic "API request failed".
 * @param {any} error Error to describe
 * @returns {string}
 */
export function describeError(error) {
    const messages = [];
    for (let current = error; current; current = current.cause) {
        if (current.message) {
            messages.push(current.message);
        }
    }
    return messages.at(-1) || 'Unknown error';
}

/**
 * Streams a completion through a connection profile.
 * @param {object} options Request options
 * @param {string|null|undefined} options.profileId Connection profile ID
 * @param {string} options.role Role of the model, for error messages (e.g. "writer")
 * @param {{ role: string, content: string }[]} options.messages Prompt messages
 * @param {number} options.maxTokens Maximum response tokens
 * @param {AbortSignal} options.signal Signal to stop the request
 * @param {(text: string) => void} options.onText Called with the full text generated so far
 * @returns {Promise<string>} The generated text
 */
export async function streamCompletion({ profileId, role, messages, maxTokens, signal, onText }) {
    const id = requireProfile(profileId, role);
    const createStream = /** @type {() => AsyncGenerator<{ text: string }>} */ (
        await ConnectionManagerRequestService.sendRequest(id, messages, maxTokens, {
            stream: true,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        })
    );

    let text = '';
    for await (const chunk of createStream()) {
        text = chunk.text ?? text;
        onText(text);
    }
    return text;
}

/**
 * Requests JSON through a connection profile. Asks for structured output first;
 * if the provider rejects the schema or returns invalid JSON, retries once with
 * the format described in the prompt instead.
 * @param {object} options Request options
 * @param {string|null|undefined} options.profileId Connection profile ID
 * @param {string} options.role Role of the model, for error messages (e.g. "background")
 * @param {{ role: string, content: string }[]} options.messages Prompt for structured output
 * @param {{ role: string, content: string }[]} options.fallbackMessages Prompt that describes the JSON format itself
 * @param {object} options.schema JSON schema ({ name, description, strict, value })
 * @param {number} options.maxTokens Maximum response tokens
 * @param {AbortSignal} [options.signal] Signal to stop the request
 * @returns {Promise<any>} The parsed JSON
 */
export async function requestJson({ profileId, role, messages, fallbackMessages, schema, maxTokens, signal }) {
    const id = requireProfile(profileId, role);
    const options = { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true };
    try {
        const result = /** @type {{ content: any }} */ (
            await ConnectionManagerRequestService.sendRequest(id, messages, maxTokens, options, { json_schema: schema })
        );
        return parseJsonResponse(result.content);
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        console.warn('Novel Studio: structured output failed, retrying with JSON instructions in the prompt', error);
        const result = /** @type {{ content: any }} */ (
            await ConnectionManagerRequestService.sendRequest(id, fallbackMessages, maxTokens, options)
        );
        return parseJsonResponse(result.content);
    }
}

/**
 * Requests plain text through a connection profile, without streaming.
 * @param {object} options Request options
 * @param {string|null|undefined} options.profileId Connection profile ID
 * @param {string} options.role Role of the model, for error messages (e.g. "background")
 * @param {{ role: string, content: string }[]} options.messages Prompt messages
 * @param {number} options.maxTokens Maximum response tokens
 * @param {AbortSignal} [options.signal] Signal to stop the request
 * @returns {Promise<string>} The cleaned response text
 */
export async function requestText({ profileId, role, messages, maxTokens, signal }) {
    const id = requireProfile(profileId, role);
    const result = /** @type {{ content: any }} */ (
        await ConnectionManagerRequestService.sendRequest(id, messages, maxTokens, {
            stream: false, signal, extractData: true, includePreset: true, includeInstruct: true,
        })
    );
    return cleanOutput(String(result?.content ?? '')).trim();
}
