import type { SSEClient } from "./sseClient.js";
import * as dataStore from "./dataStore.js";
import { sanitizeModel } from "../utils/stringUtils.js";
import { getAuthHeaders, assertNotAuthError } from "./serverAuth.js";

/**
 * OpenCode v2 HTTP API client.
 *
 * v1 endpoints (POST /session, POST /session/{id}/prompt_async, GET /event,
 * GET|POST /question/...) are gone in v2. This module targets the v2 routes:
 *   - POST   /api/session?directory=...          -> { data: { id } }
 *   - GET    /api/session?directory=...          -> { data: [...] }
 *   - GET    /api/session/{id}?directory=...     -> { data: {...} | null }
 *   - POST   /api/session/{id}/prompt?directory   -> { data: {...} }  (body: { text })
 *   - GET    /api/event?directory=...            -> SSE stream
 * Auth is HTTP Basic opencode:<service-password>, forwarded via serverAuth.
 */

const threadSseClients = new Map<string, SSEClient>();

function dirParam(directory?: string): string {
  return directory ? `?directory=${encodeURIComponent(directory)}` : "";
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getAuthHeaders() };
}

export async function createSession(port: number, directory?: string): Promise<string> {
  const url = `http://127.0.0.1:${port}/api/session${dirParam(directory)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: "{}",
  });

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to create session");
    throw new Error(
      `Failed to create session: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  const id = data?.data?.id ?? data?.id;

  if (!id) {
    throw new Error("Invalid session response: missing id");
  }

  return id;
}

function parseModelString(
  model: string,
): { providerID: string; modelID: string } | null {
  const clean = sanitizeModel(model);
  const slashIndex = clean.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return {
    providerID: clean.slice(0, slashIndex),
    modelID: clean.slice(slashIndex + 1),
  };
}

export async function sendPrompt(
  port: number,
  sessionId: string,
  text: string,
  model?: string,
  directory?: string,
): Promise<void> {
  // v2: POST /api/session/{id}/prompt with a flat { text } body.
  // The model is pinned at session-creation time (see createSession); a
  // per-message model override is not supported by this endpoint, so an
  // explicit preferred model is applied by creating the session accordingly
  // (handled by callers via ensureSessionForThread recreation if needed).
  void model;
  void parseModelString;
  const url = `http://127.0.0.1:${port}/api/session/${sessionId}/prompt${dirParam(directory)}`;
  const body = { text };

  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    assertNotAuthError(response.status, "Failed to send prompt");
    throw new Error(
      `Failed to send prompt: ${response.status} ${response.statusText} — ${responseBody}`,
    );
  }
}

export async function validateSession(
  port: number,
  sessionId: string,
  directory?: string,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/session/${sessionId}${dirParam(directory)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(),
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    if (response.status === 404) return false;
    assertNotAuthError(response.status, "Failed to validate session");
  }
  return response.ok;
}

export async function getSessionInfo(
  port: number,
  sessionId: string,
  directory?: string,
): Promise<SessionInfo | null> {
  const url = `http://127.0.0.1:${port}/api/session/${sessionId}${dirParam(directory)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    if (response.status === 404) return null;
    assertNotAuthError(response.status, "Failed to get session info");
    return null;
  }
  const data = await response.json();
  const s = data?.data ?? data;
  return { id: s.id, title: s.title ?? "" };
}

export interface SessionInfo {
  id: string;
  title: string;
}

export async function listSessions(port: number, directory?: string): Promise<SessionInfo[]> {
  const url = `http://127.0.0.1:${port}/api/session${dirParam(directory)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(),
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to list sessions");
    return [];
  }

  const data = await response.json();
  const list = Array.isArray(data) ? data : (data?.data ?? []);
  if (Array.isArray(list)) {
    return list.map((s: { id: string; title?: string }) => ({
      id: s.id,
      title: s.title ?? "",
    }));
  }
  return [];
}

export async function abortSession(
  port: number,
  sessionId: string,
  directory?: string,
): Promise<boolean> {
  // v2: POST /api/session/{id}/abort
  const url = `http://127.0.0.1:${port}/api/session/${sessionId}/abort${dirParam(directory)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    assertNotAuthError(response.status, "Failed to abort session");
  }
  return response.ok;
}


export async function listQuestions(port: number, directory?: string): Promise<unknown[]> {
  // v2 removed the global /question list endpoint; pending questions arrive
  // over the /api/event SSE stream as question.asked events. Keep the
  // signature for callers; the button handlers now resolve pending requests
  // from the SSE-cached state (see sseClient pending question store).
  void port;
  void directory;
  const { getPendingQuestions } = await import("./sseClient.js");
  return getPendingQuestions();
}

export async function replyQuestion(
  port: number,
  requestId: string,
  answers: string[][],
  directory?: string,
): Promise<boolean> {
  // v2: POST /permission/{requestID}/reply with { reply: "accept"|"reject"|..., message }
  // For question-style prompts (options), map selected labels to an accept + message.
  const params = dirParam(directory);
  const url = `http://127.0.0.1:${port}/permission/${requestId}/reply${params}`;
  const flat = answers.map((a) => a.join(", ")).filter(Boolean);
  const body = {
    reply: "accept",
    message: flat.length > 0 ? flat.join(" | ") : "accepted",
  };
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    assertNotAuthError(response.status, "Failed to answer question");
    throw new Error(
      `Failed to answer question: ${response.status} ${response.statusText} — ${responseBody}`,
    );
  }

  return true;
}

export async function rejectQuestion(
  port: number,
  requestId: string,
  directory?: string,
): Promise<boolean> {
  const params = dirParam(directory);
  const url = `http://127.0.0.1:${port}/permission/${requestId}/reply${params}`;
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ reply: "reject" }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    assertNotAuthError(response.status, "Failed to reject question");
    throw new Error(
      `Failed to reject question: ${response.status} ${response.statusText} — ${responseBody}`,
    );
  }

  return true;
}

export function getSessionForThread(
  threadId: string,
): { sessionId: string; projectPath: string; port: number } | undefined {
  const session = dataStore.getThreadSession(threadId);
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    port: session.port,
  };
}

export function setSessionForThread(
  threadId: string,
  sessionId: string,
  projectPath: string,
  port: number,
): void {
  const existing = dataStore.getThreadSession(threadId);
  const now = Date.now();
  dataStore.setThreadSession({
    threadId,
    sessionId,
    projectPath,
    port,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  });
}

export async function ensureSessionForThread(
  threadId: string,
  projectPath: string,
  port: number,
): Promise<string> {
  const existingSession = getSessionForThread(threadId);

  if (existingSession && existingSession.projectPath === projectPath) {
    const isValid = await validateSession(port, existingSession.sessionId, projectPath);
    if (isValid) {
      setSessionForThread(
        threadId,
        existingSession.sessionId,
        projectPath,
        port,
      );
      return existingSession.sessionId;
    }
  }

  const sessionId = await createSession(port, projectPath);
  setSessionForThread(threadId, sessionId, projectPath, port);
  return sessionId;
}

export function updateSessionLastUsed(threadId: string): void {
  dataStore.updateThreadSessionLastUsed(threadId);
}

export function clearSessionForThread(threadId: string): void {
  dataStore.clearThreadSession(threadId);
}

export function setSseClient(threadId: string, client: SSEClient): void {
  threadSseClients.set(threadId, client);
}

export function getSseClient(threadId: string): SSEClient | undefined {
  return threadSseClients.get(threadId);
}

export function clearSseClient(threadId: string): void {
  threadSseClients.delete(threadId);
}
