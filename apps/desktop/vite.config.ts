import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import {
  archiveThread,
  archiveThreads,
  copyText,
  deleteCleanupRule,
  deleteSavedView,
  exportBackup,
  importBackupArtifact,
  loadTrashInventory,
  loadBackupInventory,
  loadThreadLibrarySnapshot,
  previewBackupArtifact,
  previewSecureHandoff,
  purgeTrashItems,
  revealPath,
  restoreTrashItems,
  createSecureHandoff,
  saveCleanupRule,
  saveAppPreferences,
  saveSavedView,
  importSecureHandoff,
  trashThreads,
  unarchiveThread,
  unarchiveThreads,
} from "./dev/thread-library";
import { defineConfig, type Plugin } from "vite";

function threadDockDevApi(): Plugin {
  return {
    name: "threaddock-dev-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleThreadDockRequest(request, response, next);
      });
    },
  };
}

async function handleThreadDockRequest(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  if (request.method === "GET" && request.url === "/__threaddock__/thread-library") {
    try {
      const snapshot = await loadThreadLibrarySnapshot();
      writeJson(response, 200, snapshot);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/thread/archive") {
    try {
      const body = await readRequestBody<{ threadId?: string }>(request);
      if (!body.threadId) {
        writeJson(response, 400, { message: "threadId is required." });
        return;
      }

      await archiveThread(body.threadId);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/thread/unarchive") {
    try {
      const body = await readRequestBody<{ threadId?: string }>(request);
      if (!body.threadId) {
        writeJson(response, 400, { message: "threadId is required." });
        return;
      }

      await unarchiveThread(body.threadId);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/thread/archive-many") {
    try {
      const body = await readRequestBody<{ threadIds?: string[] }>(request);
      if (!Array.isArray(body.threadIds) || body.threadIds.length === 0) {
        writeJson(response, 400, { message: "threadIds is required." });
        return;
      }

      await archiveThreads(body.threadIds);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/thread/unarchive-many") {
    try {
      const body = await readRequestBody<{ threadIds?: string[] }>(request);
      if (!Array.isArray(body.threadIds) || body.threadIds.length === 0) {
        writeJson(response, 400, { message: "threadIds is required." });
        return;
      }

      await unarchiveThreads(body.threadIds);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/backups") {
    try {
      const body = await readRequestBody<{ destinationDir?: string | null }>(request);
      const snapshot = await loadBackupInventory(body.destinationDir);
      writeJson(response, 200, snapshot);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/backups/export") {
    try {
      const body = await readRequestBody<Parameters<typeof exportBackup>[0]>(request);
      const record = await exportBackup(body);
      writeJson(response, 200, record);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/backups/import") {
    try {
      const body = await readRequestBody<Parameters<typeof importBackupArtifact>[0]>(request);
      const result = await importBackupArtifact(body);
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/backups/preview") {
    try {
      const body = await readRequestBody<Parameters<typeof previewBackupArtifact>[0]>(request);
      const record = await previewBackupArtifact(body);
      writeJson(response, 200, record);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/handoffs/create") {
    try {
      const body = await readRequestBody<{ request: Parameters<typeof createSecureHandoff>[0] }>(request);
      writeJson(response, 200, await createSecureHandoff(body.request));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/handoffs/preview") {
    try {
      const body = await readRequestBody<{ request: Parameters<typeof previewSecureHandoff>[0] }>(request);
      writeJson(response, 200, await previewSecureHandoff(body.request));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/handoffs/import") {
    try {
      const body = await readRequestBody<{ request: Parameters<typeof importSecureHandoff>[0] }>(request);
      writeJson(response, 200, await importSecureHandoff(body.request));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/preferences") {
    try {
      const body = await readRequestBody<Parameters<typeof saveAppPreferences>[0]>(request);
      const preferences = await saveAppPreferences(body);
      writeJson(response, 200, preferences);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/saved-views") {
    try {
      const body = await readRequestBody<{ view: Parameters<typeof saveSavedView>[0] }>(request);
      const result = await saveSavedView(body.view);
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/saved-views/delete") {
    try {
      const body = await readRequestBody<{ viewId?: string }>(request);
      if (!body.viewId) {
        writeJson(response, 400, { message: "viewId is required." });
        return;
      }
      const result = await deleteSavedView(body.viewId);
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/cleanup-rules") {
    try {
      const body = await readRequestBody<{ rule: Parameters<typeof saveCleanupRule>[0] }>(request);
      const result = await saveCleanupRule(body.rule);
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/cleanup-rules/delete") {
    try {
      const body = await readRequestBody<{ ruleId?: string }>(request);
      if (!body.ruleId) {
        writeJson(response, 400, { message: "ruleId is required." });
        return;
      }
      const result = await deleteCleanupRule(body.ruleId);
      writeJson(response, 200, result);
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "GET" && request.url === "/__threaddock__/trash") {
    try {
      writeJson(response, 200, await loadTrashInventory());
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/trash") {
    try {
      const body = await readRequestBody<{ threadIds?: string[] }>(request);
      if (!Array.isArray(body.threadIds) || body.threadIds.length === 0) {
        writeJson(response, 400, { message: "threadIds is required." });
        return;
      }
      writeJson(response, 200, await trashThreads(body.threadIds));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/trash/restore") {
    try {
      const body = await readRequestBody<{ trashIds?: string[] }>(request);
      if (!Array.isArray(body.trashIds) || body.trashIds.length === 0) {
        writeJson(response, 400, { message: "trashIds is required." });
        return;
      }
      writeJson(response, 200, await restoreTrashItems(body.trashIds));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/trash/purge") {
    try {
      const body = await readRequestBody<{ trashIds?: string[] }>(request);
      if (!Array.isArray(body.trashIds) || body.trashIds.length === 0) {
        writeJson(response, 400, { message: "trashIds is required." });
        return;
      }
      writeJson(response, 200, await purgeTrashItems(body.trashIds));
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/system/reveal") {
    try {
      const body = await readRequestBody<{ path?: string }>(request);
      if (!body.path) {
        writeJson(response, 400, { message: "path is required." });
        return;
      }

      await revealPath(body.path);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  if (request.method === "POST" && request.url === "/__threaddock__/system/copy") {
    try {
      const body = await readRequestBody<{ value?: string }>(request);
      if (body.value === undefined) {
        writeJson(response, 400, { message: "value is required." });
        return;
      }

      await copyText(body.value);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      writeError(response, error);
    }
    return;
  }

  next();
}

function readRequestBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    request.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve((body ? JSON.parse(body) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function writeError(response: ServerResponse, error: unknown) {
  const message = error instanceof Error ? error.message : "ThreadDock request failed.";
  writeJson(response, 500, { message });
}

export default defineConfig({
  plugins: [react(), threadDockDevApi()],
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
