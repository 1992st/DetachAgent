import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const apiRoutesSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/routes/apiRoutes.ts"), "utf8");
const libraryServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/library/libraryService.ts"), "utf8");
const webLibrarySource = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/library/LibraryPage.tsx"), "utf8");
const webApiSource = fs.readFileSync(path.join(repoRoot, "apps/web/src/lib/api.ts"), "utf8");
const serverIndexSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/index.ts"), "utf8");

assert.doesNotMatch(apiRoutesSource, /\/library\/edit-auth\//, "library should not expose edit auth endpoints when editing is disabled");
assert.match(apiRoutesSource, /apiRoutes\.get\("\/library\/servers\/:id\/files"/, "library file read endpoint should exist");
assert.doesNotMatch(apiRoutesSource, /apiRoutes\.put\("\/library\/servers\/:id\/files"/, "library should not expose file write endpoints");
assert.match(apiRoutesSource, /Content-Range/, "PDF range responses should set Content-Range");

assert.doesNotMatch(libraryServiceSource, /writeDrawioFile/, "library service should not write draw.io files through http-server");
assert.match(libraryServiceSource, /application\/pdf/, "PDF reads should return application/pdf");
assert.match(libraryServiceSource, /text\/markdown; charset=utf-8/, "Markdown reads should force UTF-8 text rendering");
assert.match(libraryServiceSource, /parseRangeHeader/, "PDF reads should support range headers");
assert.match(libraryServiceSource, /Library path is outside the configured local root/, "local file paths should be root confined");
assert.match(libraryServiceSource, /process\.platform === "win32" \? path\.win32 : path/, "local file path resolution should use Windows path semantics on Windows");

assert.doesNotMatch(webApiSource, /saveLibraryDrawioFile|unlockLibraryEdit|lockLibraryEdit/, "web API should not expose draw.io edit helpers");
assert.match(webLibrarySource, /pdfViewerUrl\(serverId, file\.relativePath\)/, "library UI should route PDFs through PDF.js");
assert.match(webLibrarySource, /DrawioPreview/, "library UI should include draw.io preview");
assert.doesNotMatch(webLibrarySource, /DrawioEditorHost|EditUnlockDialog|编辑 draw\.io/, "library UI should not expose draw.io editing");
assert.match(webLibrarySource, /TextReader/, "library UI should route Markdown and text files through a UTF-8 text reader");
assert.match(webLibrarySource, /fetchLibraryTextFile\(serverId, file\.relativePath\)/, "Markdown, text, and draw.io XML should be read through the Detaches UTF-8 file endpoint");
assert.match(webLibrarySource, /ReactMarkdown/, "Markdown files should render in preview mode by default");
assert.match(webLibrarySource, /remarkGfm/, "Markdown preview should support GitHub-flavored Markdown tables");
assert.match(webLibrarySource, /stripLibraryManagerPrompt\(text\)/, "library chat visible text should strip embedded manager prompts at render time");
assert.match(webLibrarySource, /你是 Detaches 图书馆管理员/, "library prompt stripping should anchor on the stable manager prompt marker");
assert.match(webLibrarySource, /visibleText \? \(/, "library chat should not render empty message bubbles after display filtering");
assert.match(webLibrarySource, /event\.source !== frameRef\.current\?\.contentWindow/, "draw.io postMessage handling should be scoped to its iframe");
assert.match(webLibrarySource, /setFrameSrc\(drawioEmbedUrl\(drawioBaseUrl\)\)/, "draw.io iframe src should be set after message handlers are mounted to avoid missing init");
assert.match(webLibrarySource, /embed=1&proto=json/, "draw.io preview should use diagrams.net JSON embed mode");
assert.match(webLibrarySource, /未收到 diagrams\.net 的 export 响应/, "draw.io preview should show a clear timeout when export never arrives");
assert.match(webLibrarySource, /ONLINE_DRAWIO_URL = "https:\/\/embed\.diagrams\.net\/"/, "draw.io should have an online embed fallback when local vendor is missing");
assert.match(serverIndexSource, /app\.use\("\/vendor"/, "server should expose bundled viewer vendor assets");
