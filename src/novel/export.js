import fs from 'node:fs';
import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import sanitize from 'sanitize-filename';

import { NovelError, projectPaths, readProjectFiles } from './store.js';

/** @type {Readonly<Record<string, { extension: string, contentType: string, render: (manuscript: Manuscript, options: ExportOptions) => string | Promise<Buffer> }>>} */
export const EXPORT_FORMATS = Object.freeze({
    md: { extension: 'md', contentType: 'text/markdown; charset=utf-8', render: toMarkdown },
    txt: { extension: 'txt', contentType: 'text/plain; charset=utf-8', render: toPlainText },
    docx: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', render: toDocx },
    epub: { extension: 'epub', contentType: 'application/epub+zip', render: toEpub },
});

const SCENE_BREAK = '* * *';

/**
 * @typedef {object} Inline
 * @property {string} text
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [strike]
 */

/**
 * @typedef {{ type: 'paragraph' | 'quote', inlines: Inline[] } | { type: 'heading', level: number, inlines: Inline[] } | { type: 'break' }} Block
 */

/**
 * Parses inline Markdown as the editor writes it: **bold**, *italic* or _italic_,
 * ~~strike~~ and backslash escapes. Unmatched markers stay as text.
 * @param {string} text Inline Markdown
 * @returns {Inline[]}
 */
export function parseInline(text) {
    /** @type {Inline[]} */
    const result = [];
    const state = { bold: false, italic: false, strike: false };
    let buffer = '';
    const flush = () => {
        if (buffer) {
            result.push({ text: buffer, ...Object.fromEntries(Object.entries(state).filter(([, on]) => on)) });
            buffer = '';
        }
    };
    // Only toggle a marker on if it is closed later in the text
    const closes = (/** @type {string} */ marker, /** @type {number} */ from) => text.indexOf(marker, from) !== -1;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\\' && i + 1 < text.length && /[\\*_~`#>\-[\]()!.]/.test(text[i + 1])) {
            buffer += text[++i];
            continue;
        }
        if (text.startsWith('**', i) && (state.bold || closes('**', i + 2))) {
            flush();
            state.bold = !state.bold;
            i++;
            continue;
        }
        if (text.startsWith('~~', i) && (state.strike || closes('~~', i + 2))) {
            flush();
            state.strike = !state.strike;
            i++;
            continue;
        }
        if ((char === '*' || char === '_') && (state.italic || closes(char, i + 1))) {
            // Underscores inside words (snake_case) are not emphasis
            if (char === '_' && /\w/.test(text[i - 1] ?? '') && /\w/.test(text[i + 1] ?? '')) {
                buffer += char;
                continue;
            }
            flush();
            state.italic = !state.italic;
            continue;
        }
        buffer += char;
    }
    flush();
    return result;
}

/**
 * Splits Markdown into blocks: paragraphs, headings, quotes and scene breaks.
 * @param {string} markdown Scene Markdown
 * @returns {Block[]}
 */
export function parseBlocks(markdown) {
    /** @type {Block[]} */
    const blocks = [];
    for (const raw of markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
        const text = raw.trim();
        if (!text) {
            continue;
        }
        if (/^(\*\s*){3,}$|^-{3,}$|^(_\s*){3,}$/.test(text)) {
            blocks.push({ type: 'break' });
            continue;
        }
        const heading = text.match(/^(#{1,6})\s+(.*)$/s);
        if (heading) {
            blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2].replace(/\s*\n\s*/g, ' ')) });
            continue;
        }
        if (text.startsWith('>')) {
            const inner = text.split('\n').map(line => line.replace(/^>\s?/, '')).join(' ');
            blocks.push({ type: 'quote', inlines: parseInline(inner) });
            continue;
        }
        // A single line break inside a paragraph is a soft wrap
        blocks.push({ type: 'paragraph', inlines: parseInline(text.replace(/\s*\n\s*/g, ' ')) });
    }
    return blocks;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {Inline[]} inlines
 * @returns {string}
 */
function inlinesToText(inlines) {
    return inlines.map(inline => inline.text).join('');
}

/**
 * Names a chapter for export, leaving out titles that only repeat the number.
 * @param {number} number 1-based chapter number
 * @param {string} title Chapter title
 * @returns {string}
 */
export function exportChapterTitle(number, title) {
    const trimmed = title?.trim() ?? '';
    return trimmed && !/^chapter\s+\d+$/i.test(trimmed) ? `Chapter ${number}: ${trimmed}` : `Chapter ${number}`;
}

/**
 * @typedef {object} Manuscript
 * @property {any} project Project metadata
 * @property {{ number: number, title: string, scenes: { title: string, content: string }[] }[]} chapters Chapters with written scenes
 */

/**
 * Reads the manuscript in order, leaving out empty scenes and chapters.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @returns {Promise<Manuscript>}
 */
export async function readManuscript(directories, projectId) {
    const paths = projectPaths(directories, projectId);
    const { project, structure } = readProjectFiles(paths);
    const readScene = (/** @type {any} */ scene) => fs.promises.readFile(paths.scene(scene.id), 'utf8')
        .catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
        .then(content => ({ title: scene.title, content: content.trim() }));
    const chapters = [];
    for (const [index, chapter] of structure.chapters.entries()) {
        const scenes = (await Promise.all(chapter.scenes.map(readScene))).filter(scene => scene.content);
        if (scenes.length > 0) {
            chapters.push({ number: index + 1, title: chapter.title, scenes });
        }
    }
    return { project, chapters };
}

/**
 * @typedef {{ kind: 'sceneTitle' | 'break' | 'heading' | 'quote', inlines: Inline[] } | { kind: 'paragraph', inlines: Inline[], first: boolean }} SceneItem
 */

/**
 * Lays out one scene for the book formats: its title or the break before it, then its blocks.
 * Book convention: the first paragraph after a heading or break is marked so it gets no indent.
 * @param {{ title: string, content: string }} scene
 * @param {number} index Position of the scene in its chapter
 * @param {ExportOptions} options
 * @returns {SceneItem[]}
 */
function layoutScene(scene, index, options) {
    /** @type {SceneItem[]} */
    const items = [];
    if (options.sceneTitles) {
        items.push({ kind: 'sceneTitle', inlines: [{ text: scene.title || 'Untitled scene' }] });
    } else if (index > 0) {
        items.push({ kind: 'break', inlines: [{ text: SCENE_BREAK }] });
    }
    let first = true;
    for (const block of parseBlocks(scene.content)) {
        if (block.type === 'break') {
            items.push({ kind: 'break', inlines: [{ text: SCENE_BREAK }] });
            first = true;
        } else if (block.type === 'heading') {
            items.push({ kind: 'heading', inlines: block.inlines });
            first = true;
        } else if (block.type === 'quote') {
            items.push({ kind: 'quote', inlines: block.inlines });
        } else {
            items.push({ kind: 'paragraph', inlines: block.inlines, first });
            first = false;
        }
    }
    return items;
}

/** @returns {string} The current time as an ISO timestamp without milliseconds */
function isoSeconds() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * @typedef {object} ExportOptions
 * @property {boolean} [sceneTitles] Show scene titles instead of plain scene breaks
 */

/**
 * @param {Manuscript} manuscript
 * @param {ExportOptions} options
 * @returns {string}
 */
export function toMarkdown(manuscript, options = {}) {
    const { project } = manuscript;
    const parts = [`# ${project.title}`];
    if (project.author?.trim()) {
        parts.push(`*by ${project.author.trim()}*`);
    }
    for (const chapter of manuscript.chapters) {
        parts.push(`## ${exportChapterTitle(chapter.number, chapter.title)}`);
        chapter.scenes.forEach((scene, index) => {
            if (options.sceneTitles) {
                parts.push(`### ${scene.title || 'Untitled scene'}`);
            } else if (index > 0) {
                parts.push(SCENE_BREAK);
            }
            parts.push(scene.content);
        });
    }
    return parts.join('\n\n') + '\n';
}

/**
 * @param {Manuscript} manuscript
 * @param {ExportOptions} options
 * @returns {string}
 */
export function toPlainText(manuscript, options = {}) {
    const lines = [];
    const push = (/** @type {Block[]} */ blocks) => {
        for (const block of blocks) {
            lines.push(block.type === 'break' ? SCENE_BREAK : inlinesToText(block.inlines));
        }
    };
    lines.push(manuscript.project.title.toUpperCase());
    if (manuscript.project.author?.trim()) {
        lines.push(`by ${manuscript.project.author.trim()}`);
    }
    for (const chapter of manuscript.chapters) {
        lines.push('', exportChapterTitle(chapter.number, chapter.title).toUpperCase());
        chapter.scenes.forEach((scene, index) => {
            if (options.sceneTitles) {
                lines.push(scene.title || 'Untitled scene');
            } else if (index > 0) {
                lines.push(SCENE_BREAK);
            }
            push(parseBlocks(scene.content));
        });
    }
    return lines.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * Collects a zip archive into a buffer.
 * @param {(archive: import('archiver').Archiver) => void} fill Adds the entries
 * @returns {Promise<Buffer>}
 */
function zip(fill) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = new PassThrough();
        const chunks = [];
        output.on('data', chunk => chunks.push(chunk));
        output.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);
        archive.pipe(output);
        fill(archive);
        archive.finalize();
    });
}

// ---- DOCX ----

/**
 * @param {Inline[]} inlines
 * @returns {string} WordprocessingML runs
 */
function docxRuns(inlines) {
    return inlines.map((inline) => {
        const props = [inline.bold ? '<w:b/>' : '', inline.italic ? '<w:i/>' : '', inline.strike ? '<w:strike/>' : ''].join('');
        return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(inline.text)}</w:t></w:r>`;
    }).join('');
}

/**
 * @param {string} style Paragraph style ID
 * @param {string} runs Runs XML
 * @returns {string}
 */
function docxParagraph(style, runs) {
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`;
}

/** DOCX paragraph styles for the scene items other than paragraphs. */
const DOCX_STYLES = Object.freeze({ sceneTitle: 'Heading2', break: 'SceneBreak', heading: 'Heading3', quote: 'Quote' });

/**
 * Builds a DOCX file: a title page, then one chapter per page, first-line indents and
 * centred scene breaks, in a book-like Georgia layout.
 * @param {Manuscript} manuscript
 * @param {ExportOptions} options
 * @returns {Promise<Buffer>}
 */
export function toDocx(manuscript, options = {}) {
    const { project } = manuscript;
    const body = [docxParagraph('Title', docxRuns([{ text: project.title }]))];
    if (project.author?.trim()) {
        body.push(docxParagraph('Subtitle', docxRuns([{ text: project.author.trim() }])));
    }
    for (const chapter of manuscript.chapters) {
        // Heading1 starts on a new page (pageBreakBefore in its style)
        body.push(docxParagraph('Heading1', docxRuns([{ text: exportChapterTitle(chapter.number, chapter.title) }])));
        chapter.scenes.forEach((scene, index) => {
            for (const item of layoutScene(scene, index, options)) {
                const style = item.kind === 'paragraph' ? (item.first ? 'FirstParagraph' : 'BodyText') : DOCX_STYLES[item.kind];
                body.push(docxParagraph(style, docxRuns(item.inlines)));
            }
        });
    }

    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${w}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

    const style = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ pPr, /** @type {string} */ rPr, basedOn = 'Normal') =>
        `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${w}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
${style('Normal', 'Normal', '', '', '')}
${style('BodyText', 'Body Text', '<w:ind w:firstLine="425"/><w:jc w:val="both"/>', '')}
${style('FirstParagraph', 'First Paragraph', '<w:jc w:val="both"/>', '')}
${style('Title', 'Title', '<w:spacing w:before="4000" w:after="400"/><w:jc w:val="center"/>', '<w:sz w:val="56"/>')}
${style('Subtitle', 'Subtitle', '<w:jc w:val="center"/>', '<w:i/><w:sz w:val="32"/>')}
${style('Heading1', 'heading 1', '<w:keepNext/><w:pageBreakBefore/><w:spacing w:before="1200" w:after="600"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/>', '<w:sz w:val="36"/>')}
${style('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="26"/>')}
${style('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="2"/>', '<w:b/>')}
${style('SceneBreak', 'Scene Break', '<w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/>', '')}
${style('Quote', 'Quote', '<w:ind w:left="720" w:right="720"/><w:spacing w:before="120" w:after="120"/>', '<w:i/>')}
</w:styles>`;

    const now = isoSeconds();
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(project.title)}</dc:title><dc:creator>${escapeXml(project.author ?? '')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

    return zip((archive) => {
        archive.append(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`, { name: '[Content_Types].xml' });
        archive.append(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`, { name: '_rels/.rels' });
        archive.append(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, { name: 'word/_rels/document.xml.rels' });
        archive.append(document, { name: 'word/document.xml' });
        archive.append(styles, { name: 'word/styles.xml' });
        archive.append(core, { name: 'docProps/core.xml' });
    });
}

// ---- EPUB ----

/**
 * @param {Inline[]} inlines
 * @returns {string} XHTML
 */
function xhtmlInlines(inlines) {
    return inlines.map((inline) => {
        let html = escapeXml(inline.text);
        if (inline.strike) {
            html = `<del>${html}</del>`;
        }
        if (inline.italic) {
            html = `<em>${html}</em>`;
        }
        if (inline.bold) {
            html = `<strong>${html}</strong>`;
        }
        return html;
    }).join('');
}

/**
 * @param {string} title Page title
 * @param {string} body Body XHTML
 * @param {string} language Language code
 * @returns {string}
 */
function xhtmlPage(title, body, language) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body>
</html>`;
}

/**
 * Builds an EPUB 3 book (with an EPUB 2 table of contents for older readers).
 * @param {Manuscript} manuscript
 * @param {ExportOptions & { bookId?: string, language?: string }} options
 * @returns {Promise<Buffer>}
 */
export function toEpub(manuscript, options = {}) {
    const { project } = manuscript;
    const language = options.language ?? 'en';
    const bookId = `urn:uuid:${options.bookId ?? project.id}`;
    const modified = isoSeconds();

    const chapters = manuscript.chapters.map((chapter, index) => {
        const title = exportChapterTitle(chapter.number, chapter.title);
        const body = [`<section epub:type="chapter"><h1>${escapeXml(title)}</h1>`];
        chapter.scenes.forEach((scene, sceneIndex) => {
            for (const item of layoutScene(scene, sceneIndex, options)) {
                const inlines = xhtmlInlines(item.inlines);
                body.push(item.kind === 'sceneTitle' ? `<h2>${inlines}</h2>`
                    : item.kind === 'break' ? `<p class="scene-break">${inlines}</p>`
                        : item.kind === 'heading' ? `<h3>${inlines}</h3>`
                            : item.kind === 'quote' ? `<blockquote><p>${inlines}</p></blockquote>`
                                : `<p${item.first ? ' class="first"' : ''}>${inlines}</p>`);
            }
        });
        body.push('</section>');
        return { id: `chapter-${index + 1}`, file: `chapter-${index + 1}.xhtml`, title, xhtml: xhtmlPage(title, body.join('\n'), language) };
    });

    const author = project.author?.trim() ?? '';
    const titlePage = xhtmlPage(project.title, `<section epub:type="titlepage" class="titlepage"><h1>${escapeXml(project.title)}</h1>${author ? `<p class="author">${escapeXml(author)}</p>` : ''}</section>`, language);
    const nav = xhtmlPage('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map(c => `<li><a href="${c.file}">${escapeXml(c.title)}</a></li>`).join('')}</ol></nav>`, language);
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${language}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>
<dc:title>${escapeXml(project.title)}</dc:title>
${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ''}
<dc:language>${language}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${chapters.map(c => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="title"/>
${chapters.map(c => `<itemref idref="${c.id}"/>`).join('\n')}
</spine>
</package>`;
    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(bookId)}"/></head>
<docTitle><text>${escapeXml(project.title)}</text></docTitle>
<navMap>${chapters.map((c, i) => `<navPoint id="nav-${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('')}</navMap>
</ncx>`;
    const css = `body { font-family: Georgia, serif; line-height: 1.5; margin: 0 5%; }
h1 { text-align: center; margin: 3em 0 2em; font-weight: normal; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
p.first, p.scene-break { text-indent: 0; }
p.scene-break { text-align: center; margin: 1em 0; }
blockquote { margin: 1em 2em; font-style: italic; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage .author { text-indent: 0; text-align: center; font-style: italic; margin-top: 1em; }`;

    return zip((archive) => {
        // The mimetype must be the first entry and stored uncompressed
        archive.append('application/epub+zip', { name: 'mimetype', store: true });
        archive.append(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, { name: 'META-INF/container.xml' });
        archive.append(opf, { name: 'OEBPS/content.opf' });
        archive.append(nav, { name: 'OEBPS/nav.xhtml' });
        archive.append(ncx, { name: 'OEBPS/toc.ncx' });
        archive.append(css, { name: 'OEBPS/style.css' });
        archive.append(titlePage, { name: 'OEBPS/title.xhtml' });
        for (const chapter of chapters) {
            archive.append(chapter.xhtml, { name: `OEBPS/${chapter.file}` });
        }
    });
}

/**
 * Exports a project's manuscript.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} projectId Project ID
 * @param {unknown} format Export format
 * @param {ExportOptions} [options] Export options
 * @returns {Promise<{ filename: string, contentType: string, data: Buffer }>}
 */
export async function exportProject(directories, projectId, format, options = {}) {
    if (typeof format !== 'string' || !Object.hasOwn(EXPORT_FORMATS, format)) {
        throw new NovelError(400, 'Unsupported export format');
    }
    const manuscript = await readManuscript(directories, projectId);
    if (manuscript.chapters.length === 0) {
        throw new NovelError(400, 'There is no text to export yet');
    }
    const settings = { sceneTitles: Boolean(options?.sceneTitles) };
    const { extension, contentType, render } = EXPORT_FORMATS[format];
    const data = Buffer.from(await render(manuscript, settings));
    const safeTitle = sanitize(manuscript.project.title).replace(/\s+/g, ' ').trim() || 'novel';
    return { filename: `${safeTitle}.${extension}`, contentType, data };
}
