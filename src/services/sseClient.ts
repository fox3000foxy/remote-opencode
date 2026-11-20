import { EventSource } from "eventsource";
import type { TextPart, SSEEvent, SessionErrorInfo, QuestionRequest } from "../types/index.js";
import { getAuthHeaders } from "./serverAuth.js";

type PartUpdatedCallback = (part: TextPart) => void;
type SessionIdleCallback = (sessionId: string) => void;
type SessionErrorCallback = (
  sessionId: string,
  error: SessionErrorInfo,
) => void;
type QuestionAskedCallback = (request: QuestionRequest) => void;
type ErrorCallback = (error: Error) => void;

/** Pending permission/question requests seen on the SSE stream (v2 has no list endpoint). */
interface PendingRequest {
  request: QuestionRequest;
  seenAt: number;
}

const pendingRequests = new Map<string, PendingRequest>();

export function getPendingQuestions(): QuestionRequest[] {
  return Array.from(pendingRequests.values()).map((p) => p.request);
}

export function clearPendingQuestion(requestId: string): void {
  pendingRequests.delete(requestId);
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private partUpdatedCallbacks: PartUpdatedCallback[] = [];
  private sessionIdleCallbacks: SessionIdleCallback[] = [];
  private sessionErrorCallbacks: SessionErrorCallback[] = [];
  private questionAskedCallbacks: QuestionAskedCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private accumulatedByMessage = new Map<string, string>();

  connect(baseUrl: string, directory?: string): void {
    // OpenCode v2: SSE lives at /api/event (optionally scoped with ?directory=).
    const params = directory ? `?directory=${encodeURIComponent(directory)}` : "";
    const url = `${baseUrl}/api/event${params}`;
    // When OPENCODE_SERVER_PASSWORD is set, forward the same Basic auth
    // header we use for regular HTTP requests. The `eventsource` package
    // allows overriding the underlying fetch so we can inject headers —
    // EventSource itself does not accept headers directly.
    const authHeaders = getAuthHeaders();
    const init: ConstructorParameters<typeof EventSource>[1] =
      Object.keys(authHeaders).length > 0
        ? {
            fetch: (input, fetchInit) =>
              fetch(input, {
                ...fetchInit,
                headers: { ...fetchInit?.headers, ...authHeaders },
              }),
          }
        : undefined;
    this.eventSource = new EventSource(url, init);

    this.eventSource.addEventListener("message", (event: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        this.handleError(new Error(`Failed to parse SSE event: ${error}`));
      }
    });

    this.eventSource.addEventListener("error", (error: Event) => {
      this.handleError(
        error instanceof Error ? error : new Error("SSE connection error"),
      );
    });
  }

  onPartUpdated(callback: PartUpdatedCallback): void {
    this.partUpdatedCallbacks.push(callback);
  }

  onSessionIdle(callback: SessionIdleCallback): void {
    this.sessionIdleCallbacks.push(callback);
  }

  onSessionError(callback: SessionErrorCallback): void {
    this.sessionErrorCallbacks.push(callback);
  }

  onQuestionAsked(callback: QuestionAskedCallback): void {
    this.questionAskedCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  isConnected(): boolean {
    return (
      this.eventSource !== null &&
      this.eventSource.readyState === EventSource.OPEN
    );
  }

  private emitPart(sessionID: string, messageID: string, text: string): void {
    const textPart: TextPart = {
      id: `${messageID}:part`,
      sessionID,
      messageID,
      text,
    };
    this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
  }

  private handleMessage(event: SSEEvent): void {
    const props = (event.properties ?? event) as any;
    switch (event.type) {
      case "message.part.delta": {
        // v2 streaming delta: accumulate per message and re-emit full text.
        const sessionID = props.sessionID as string;
        const messageID = props.messageID as string;
        const delta = (props.delta ?? "") as string;
        if (!sessionID || !messageID) return;
        const prev = this.accumulatedByMessage.get(messageID) ?? "";
        const next = prev + delta;
        this.accumulatedByMessage.set(messageID, next);
        this.emitPart(sessionID, messageID, next);
        return;
      }
      case "message.part.updated": {
        const part = props.part ?? props;
        if (part && part.type === "text") {
          const textPart: TextPart = {
            id: part.id,
            sessionID: part.sessionID,
            messageID: part.messageID,
            text: part.text,
          };
          if (textPart.sessionID && textPart.messageID) {
            this.accumulatedByMessage.set(textPart.messageID, textPart.text ?? "");
          }
          this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
        }
        return;
      }
      case "session.idle": {
        const sessionID = props.sessionID as string;
        if (sessionID) {
          this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
        }
        return;
      }
      case "session.status": {
        // v2 reports lifecycle via session.status { status }; "idle" == done.
        const sessionID = props.sessionID as string;
        const status = props.status as string;
        if (sessionID && status === "idle") {
          this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
        }
        return;
      }
      case "session.error": {
        const sessionID = props.sessionID as string;
        const error = props.error as SessionErrorInfo | undefined;
        if (sessionID && error) {
          this.sessionErrorCallbacks.forEach((cb) => cb(sessionID, error));
        } else if (sessionID) {
          this.sessionErrorCallbacks.forEach((cb) =>
            cb(sessionID, { name: "UnknownError", data: { message: props.message } }),
          );
        }
        return;
      }
      case "permission.asked":
      case "question.asked": {
        // v2 permission request ~= v1 question request. Normalize to the
        // QuestionRequest shape consumed by the Discord button handlers.
        const req = props.request ?? props;
        const request = {
          id: req.id,
          sessionID: req.sessionID ?? req.sessionId,
          questions: req.questions ?? [
            {
              question: req.title ?? req.question ?? "Permission requested",
              header: req.kind ?? undefined,
              options: [],
              multiple: false,
              custom: true,
            },
          ],
          tool: req.tool,
        } as QuestionRequest;
        if (request?.sessionID && request?.id) {
          pendingRequests.set(request.id, { request, seenAt: Date.now() });
          this.questionAskedCallbacks.forEach((cb) => cb(request));
        }
        return;
      }
      case "permission.replied":
      case "question.replied":
      case "question.rejected": {
        const id = props.requestID ?? props.id;
        if (typeof id === "string") pendingRequests.delete(id);
        return;
      }
      default:
        return;
    }
  }

  private handleError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }
}
