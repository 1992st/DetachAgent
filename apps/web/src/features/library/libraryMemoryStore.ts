import type { ChatMessage, LibraryEntry, LibraryPathResolution } from "@detaches/shared";

export type LibraryActiveTab = "root" | "recommended" | "recent";
export type LibrarySocketState = "idle" | "connecting" | "connected" | "closed" | "error";

export interface LibraryFileLocation {
  pageNumber?: number;
  heading?: string;
  lineStart?: number;
  lineEnd?: number;
  textQuote?: string;
}

export interface RecommendedFile {
  id: string;
  title: string;
  absolutePath: string;
  reason?: string;
  snippet?: string;
  location?: LibraryFileLocation;
  resolution: LibraryPathResolution;
}

export interface SelectedFile {
  source: "directory" | "recommendation" | "recent";
  title: string;
  absolutePath?: string;
  relativePath: string;
  displayPath: string;
  url: string;
  location?: LibraryFileLocation;
}

export interface DirectoryNodeState {
  entries?: LibraryEntry[];
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

export interface FloatPosition {
  x: number;
  y: number;
}

export interface LibraryWorkspaceState {
  scopeKey: string;
  sessionKey: string;
  activeServerId?: string;
  ui: {
    activeTab: LibraryActiveTab;
    filter: string;
    floatOpen: boolean;
    floatPosition: FloatPosition;
    configOpen: boolean;
  };
  reader: {
    selectedFile: SelectedFile | null;
    readerNotice: string | null;
    readerRevision: number;
  };
  directory: {
    tree: Record<string, DirectoryNodeState>;
    loadedServerId?: string;
  };
  recommendations: {
    files: RecommendedFile[];
    updatedAt?: string;
  };
  recent: {
    files: SelectedFile[];
  };
  librarianChat: {
    messages: ChatMessage[];
    draft: string;
    socketState: LibrarySocketState;
    lastRunId: string | null;
    hydratedFromHistory: boolean;
  };
}

interface LibraryMemoryStore {
  scopes: Record<string, LibraryWorkspaceState>;
}

const store: LibraryMemoryStore = {
  scopes: {}
};

export function normalizeLibraryAgentId(agentId: string | null | undefined): string {
  return (agentId || "custom").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "custom";
}

export function libraryScopeKey(agentId: string | null | undefined, deviceIdShort: string | null | undefined): string {
  return `${normalizeLibraryAgentId(agentId)}:library:${deviceIdShort || "local"}`;
}

export function createLibrarySessionKey(scopeKey: string): string {
  return `agent:${scopeKey}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getLibraryWorkspaceState(scopeKey: string, defaultFloatPosition: FloatPosition): LibraryWorkspaceState {
  const existing = store.scopes[scopeKey];
  if (existing) return existing;
  const created: LibraryWorkspaceState = {
    scopeKey,
    sessionKey: createLibrarySessionKey(scopeKey),
    ui: {
      activeTab: "root",
      filter: "",
      floatOpen: false,
      floatPosition: defaultFloatPosition,
      configOpen: false
    },
    reader: {
      selectedFile: null,
      readerNotice: null,
      readerRevision: 0
    },
    directory: {
      tree: {}
    },
    recommendations: {
      files: []
    },
    recent: {
      files: []
    },
    librarianChat: {
      messages: [],
      draft: "",
      socketState: "idle",
      lastRunId: null,
      hydratedFromHistory: false
    }
  };
  store.scopes[scopeKey] = created;
  return created;
}

export function updateLibraryWorkspaceState(
  scopeKey: string,
  updater: (current: LibraryWorkspaceState) => LibraryWorkspaceState,
  defaultFloatPosition: FloatPosition
): LibraryWorkspaceState {
  const current = getLibraryWorkspaceState(scopeKey, defaultFloatPosition);
  const next = updater(current);
  store.scopes[scopeKey] = next;
  return next;
}
