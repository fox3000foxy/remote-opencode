import { describe, it, expect, vi, beforeEach } from "vitest";

const sessionManagerMock = vi.hoisted(() => ({
  getSessionForThread: vi.fn(),
  listQuestions: vi.fn(),
  replyQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  abortSession: vi.fn(),
  ensureSessionForThread: vi.fn(),
  sendPrompt: vi.fn(),
}));

vi.mock("../services/sessionManager.js", () => sessionManagerMock);
vi.mock("../services/serveManager.js", () => ({
  getPort: vi.fn(),
  spawnServe: vi.fn(),
  waitForReady: vi.fn(),
}));
vi.mock("../services/dataStore.js", () => ({
  getChannelModel: vi.fn(),
  getWorktreeMapping: vi.fn(),
  removeWorktreeMapping: vi.fn(),
}));
vi.mock("../services/worktreeManager.js", () => ({
  worktreeExists: vi.fn(),
  removeWorktree: vi.fn(),
}));

import { handleButton, handleSelectMenu } from "../handlers/buttonHandler.js";

function mockInteraction(customId: string) {
  return {
    customId,
    reply: vi.fn(),
    deferReply: vi.fn(),
    editReply: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { id: "msg_1" },
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

function mockSelectInteraction(customId: string, values: string[]) {
  return {
    customId,
    values,
    reply: vi.fn(),
    deferReply: vi.fn(),
    editReply: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { id: "msg_1" },
    channel: { id: "channel-1", isThread: () => false },
  } as any;
}

describe("handleButton question responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers a single-select question with one question (auto-submit)", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_abc",
        sessionID: "ses_123",
        questions: [
          {
            question: "Approve this plan?",
            options: [{ label: "Approve plan" }, { label: "Revise plan" }],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockInteraction("qanswer:thread123:que_abc:0:0");
    await handleButton(interaction);

    expect(interaction.update).toHaveBeenCalled();
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_abc", [
      ["Approve plan"],
    ]);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("rejects OpenCode questions", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.rejectQuestion.mockResolvedValue(true);

    const interaction = mockInteraction("qreject:thread123:que_abc");
    await handleButton(interaction);

    expect(sessionManagerMock.rejectQuestion).toHaveBeenCalledWith(14098, "que_abc");
    expect(interaction.update).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "🚫 Question rejected.",
      flags: 64,
    });
  });

  it("handles multi-question single-select: answers progressively, submits when done", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_xyz",
        sessionID: "ses_123",
        questions: [
          {
            question: "Choose framework?",
            options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
          },
          {
            header: "Styling",
            question: "Choose styling approach?",
            options: [{ label: "CSS" }, { label: "Tailwind" }],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const q1Interaction = mockInteraction("qanswer:thread123:que_xyz:0:1");
    await handleButton(q1Interaction);

    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
    expect(q1Interaction.update).toHaveBeenCalled();
    expect(q1Interaction.followUp).toHaveBeenCalledWith({
      content: "✅ Q1 answered: Vue",
      flags: 64,
    });

    const q2Interaction = mockInteraction("qanswer:thread123:que_xyz:1:0");
    await handleButton(q2Interaction);

    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_xyz", [
      ["Vue"],
      ["CSS"],
    ]);
    expect(q2Interaction.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("handles multi-select toggle: toggle in, then submit", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_multi",
        sessionID: "ses_123",
        questions: [
          {
            question: "Select toppings?",
            multiple: true,
            options: [
              { label: "Cheese" },
              { label: "Pepperoni" },
              { label: "Mushrooms" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const toggle1 = mockInteraction("qtoggle:thread123:que_multi:0:0");
    await handleButton(toggle1);
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();
    expect(toggle1.update).toHaveBeenCalled();

    const toggle2 = mockInteraction("qtoggle:thread123:que_multi:0:2");
    await handleButton(toggle2);
    expect(sessionManagerMock.replyQuestion).not.toHaveBeenCalled();

    const submit = mockInteraction("qsubmit:thread123:que_multi");
    await handleButton(submit);
    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_multi", [
      ["Cheese", "Mushrooms"],
    ]);
    expect(submit.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("handles select menu interaction for single-select", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_select",
        sessionID: "ses_123",
        questions: [
          {
            question: "Pick one?",
            options: [
              { label: "Option A" },
              { label: "Option B" },
              { label: "Option C" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockSelectInteraction("qselect:thread123:que_select:0", ["1"]);
    await handleSelectMenu(interaction);

    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(14098, "que_select", [
      ["Option B"],
    ]);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("handles select menu interaction for multi-select", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue({
      sessionId: "ses_123",
      projectPath: "/repo",
      port: 14098,
    });
    sessionManagerMock.listQuestions.mockResolvedValue([
      {
        id: "que_multi_select",
        sessionID: "ses_123",
        questions: [
          {
            question: "Pick multiple?",
            multiple: true,
            options: [
              { label: "Alpha" },
              { label: "Beta" },
              { label: "Gamma" },
            ],
          },
        ],
      },
    ]);
    sessionManagerMock.replyQuestion.mockResolvedValue(true);

    const interaction = mockSelectInteraction("qselect:thread123:que_multi_select:0", [
      "0",
      "2",
    ]);
    await handleSelectMenu(interaction);

    expect(sessionManagerMock.replyQuestion).toHaveBeenCalledWith(
      14098,
      "que_multi_select",
      [["Alpha", "Gamma"]],
    );
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "✅ All questions answered.",
      flags: 64,
    });
  });

  it("returns error for invalid button customId", async () => {
    const interaction = mockInteraction("qanswer:thread123:que_abc:notanumber:0");
    await handleButton(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "❌ Invalid question response.",
      flags: 64,
    });
  });

  it("returns error when session not found", async () => {
    sessionManagerMock.getSessionForThread.mockReturnValue(undefined);
    const interaction = mockInteraction("qanswer:thread123:que_abc:0:0");
    await handleButton(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "⚠️ Session not found.",
      flags: 64,
    });
  });
});
