import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const store = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/library/libraryMemoryStore.ts"), "utf8");
const libraryPage = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/library/LibraryPage.tsx"), "utf8");

assert.match(store, /interface LibraryMemoryStore[\s\S]*scopes: Record<string, LibraryWorkspaceState>/, "library memory store should hold scope-keyed workspace state");
assert.match(store, /export interface LibraryWorkspaceState[\s\S]*sessionKey: string/, "workspace state should keep a stable librarian session key");
assert.match(store, /ui:[\s\S]*activeTab: LibraryActiveTab[\s\S]*filter: string[\s\S]*floatOpen: boolean[\s\S]*floatPosition: FloatPosition[\s\S]*configOpen: boolean/, "workspace state should keep key UI state in memory");
assert.match(store, /reader:[\s\S]*selectedFile: SelectedFile \| null[\s\S]*readerNotice: string \| null[\s\S]*readerRevision: number/, "workspace state should keep reader state in memory");
assert.match(store, /directory:[\s\S]*tree: Record<string, DirectoryNodeState>[\s\S]*loadedServerId\?: string/, "workspace state should keep directory state in memory");
assert.match(store, /recommendations:[\s\S]*files: RecommendedFile\[\]/, "workspace state should keep recommendations in memory");
assert.match(store, /recent:[\s\S]*files: SelectedFile\[\]/, "workspace state should keep recent files in memory");
assert.match(store, /librarianChat:[\s\S]*messages: ChatMessage\[\][\s\S]*draft: string[\s\S]*socketState: LibrarySocketState[\s\S]*lastRunId: string \| null[\s\S]*hydratedFromHistory: boolean/, "workspace state should keep librarian chat state in memory");
assert.match(store, /libraryScopeKey\(agentId[\s\S]*`\$\{normalizeLibraryAgentId\(agentId\)\}:library:\$\{deviceIdShort \|\| "local"\}`/, "scope key should isolate by agent and device");
assert.match(store, /const existing = store\.scopes\[scopeKey\];\s*if \(existing\) return existing;/, "get should reuse existing state instead of recreating sessions on remount");

assert.match(libraryPage, /getLibraryWorkspaceState\(scopeKey, defaultFloatPosition\)/, "LibraryPage should hydrate from memory store");
assert.match(libraryPage, /setWorkspaceState\(getLibraryWorkspaceState\(scopeKey, defaultFloatPosition\)\)/, "LibraryPage should switch to the active scope when agent/device changes");
assert.match(libraryPage, /directory: \{ tree: \{\}, loadedServerId: activeServer\.id \}/, "server changes should clear only server-bound directory state");
assert.match(libraryPage, /reader: \{ \.\.\.current\.reader, selectedFile: null, readerNotice: null/, "server changes should clear reader selection and notice");
assert.doesNotMatch(libraryPage, /recommendations: \{ files: \[\] \}/, "server changes should not wipe recommendations");
assert.doesNotMatch(libraryPage, /recent: \{ files: \[\] \}/, "server changes should not wipe recent files");
assert.match(libraryPage, /recent: \{ files: \[file, \.\.\.current\.recent\.files\.filter\(\(item\) => item\.url !== file\.url\)\]\.slice\(0, 12\) \}/, "recent files should be URL-deduped and capped");
assert.match(libraryPage, /mergeRecommended\(current, resolved\)/, "recommendations should use the merge helper");
assert.match(libraryPage, /return Array\.from\(byPath\.values\(\)\)\.slice\(0, 80\)/, "recommendations should be capped");
assert.match(libraryPage, /messages: data\.payload\.messages,[\s\S]*hydratedFromHistory: true/, "librarian chat history should hydrate memory messages");
assert.match(libraryPage, /extractLibraryFilesFromMessages\(data\.payload\.messages\)/, "history hydration should reparse library-files recommendations");
assert.match(libraryPage, /createLibrarySessionKey\(scopeKey\)/, "new librarian sessions should explicitly create a new session key");
assert.match(libraryPage, /librarianChat:[\s\S]*messages: \[\],[\s\S]*draft: "",[\s\S]*lastRunId: null,[\s\S]*hydratedFromHistory: false/, "new librarian session should reset chat state only");
assert.doesNotMatch(libraryPage, /localStorage\.setItem\([^)]*library/i, "library workspace state should not be persisted to localStorage");

console.log("libraryMemoryStore: ok");
