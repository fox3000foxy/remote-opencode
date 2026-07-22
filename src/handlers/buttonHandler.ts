import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ThreadChannel,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { QuestionItem, QuestionRequest } from '../types/index.js';
import * as sessionManager from '../services/sessionManager.js';
import * as serveManager from '../services/serveManager.js';
import * as dataStore from '../services/dataStore.js';
import * as worktreeManager from '../services/worktreeManager.js';

const pendingAnswers = new Map<string, Map<number, string[]>>();

export function setPendingAnswers(key: string, selections: Map<number, string[]>): void {
  pendingAnswers.set(key, selections);
}

function clearPendingAnswers(key: string): void {
  pendingAnswers.delete(key);
}

export function buildQuestionText(
  questions: QuestionItem[],
  selections: Map<number, string[]>,
): string {
  const parts = questions.map((q, i) => {
    const labels = selections.get(i) ?? [];
    const isAnswered = labels.length > 0;
    const status = isAnswered ? `✅ ${labels.join(', ')}` : '⬜ Pending';
    const header = q.header ? `**${q.header}**` : '';
    const body = q.question.slice(0, 200);
    return `**Q${i + 1}:** ${header} (${status})\n${body}`;
  });
  return `⏸️ **Waiting for OpenCode input**\n\n${parts.join('\n\n')}`;
}

function buildQuestionTextAnswered(
  questions: QuestionItem[],
  selections: Map<number, string[]>,
): string {
  const parts = questions.map((q, i) => {
    const labels = selections.get(i) ?? [];
    return `**Q${i + 1}:** ${q.header || q.question.slice(0, 100)}\n✅ ${labels.join(', ')}`;
  });
  return `**⏸️ Questions answered**\n\n${parts.join('\n\n')}`;
}

export function buildQuestionComponents(
  threadId: string,
  request: QuestionRequest,
  selections: Map<number, string[]>,
  showSubmit: boolean,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const maxRows = 5;

  for (let qIdx = 0; qIdx < request.questions.length && rows.length < maxRows; qIdx++) {
    const question = request.questions[qIdx];
    const selectedLabels = selections.get(qIdx) ?? [];
    const options = question.options ?? [];
    const isMulti = question.multiple === true;

    if (isMulti || options.length > 5) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`qselect:${threadId}:${request.id}:${qIdx}`)
        .setPlaceholder(
          selectedLabels.length > 0
            ? `Selected: ${selectedLabels.join(', ').slice(0, 100)}`
            : `Choose option(s) for Q${qIdx + 1}`,
        )
        .setMinValues(0)
        .setMaxValues(isMulti ? options.length : 1)
        .addOptions(
          options.map((opt, oIdx) => {
            const optBuilder = new StringSelectMenuOptionBuilder()
              .setLabel(opt.label.slice(0, 100))
              .setValue(String(oIdx))
              .setDefault(selectedLabels.includes(opt.label));
            if (opt.description) {
              optBuilder.setDescription(opt.description.slice(0, 100));
            }
            return optBuilder;
          }),
        );

      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    } else {
      const buttons = options.map((opt, oIdx) => {
        const isSelected = selectedLabels.includes(opt.label);
        const customId = isMulti
          ? `qtoggle:${threadId}:${request.id}:${qIdx}:${oIdx}`
          : `qanswer:${threadId}:${request.id}:${qIdx}:${oIdx}`;

        return new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(opt.label.slice(0, 80))
          .setStyle(
            isSelected
              ? isMulti
                ? ButtonStyle.Success
                : ButtonStyle.Primary
              : ButtonStyle.Secondary,
          );
      });

      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
    }
  }

  if (rows.length >= maxRows) return rows;

  const hasMulti = request.questions.some((q) => q.multiple);
  if (hasMulti && showSubmit) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`qsubmit:${threadId}:${request.id}`)
          .setLabel('Submit Answers')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`qreject:${threadId}:${request.id}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`qreject:${threadId}:${request.id}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  return rows;
}

function buildAnsweredComponents(
  threadId: string,
  requestId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`qreject:${threadId}:${requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    ),
  ];
}

export async function handleButton(interaction: ButtonInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qanswer:')) {
    const [, threadId, requestId, questionIndexRaw, optionIndexRaw] = customId.split(':');
    await handleQuestionAnswer(interaction, threadId, requestId, questionIndexRaw, optionIndexRaw);
    return;
  }

  if (customId.startsWith('qtoggle:')) {
    const [, threadId, requestId, questionIndexRaw, optionIndexRaw] = customId.split(':');
    await handleQuestionToggle(interaction, threadId, requestId, questionIndexRaw, optionIndexRaw);
    return;
  }

  if (customId.startsWith('qsubmit:')) {
    const [, threadId, requestId] = customId.split(':');
    await handleQuestionSubmit(interaction, threadId, requestId);
    return;
  }

  if (customId.startsWith('qreject:')) {
    const [, threadId, requestId] = customId.split(':');
    await handleQuestionReject(interaction, threadId, requestId);
    return;
  }

  const [action, threadId] = customId.split('_');

  if (!threadId) {
    await interaction.reply({
      content: '❌ Invalid button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'interrupt') {
    await handleInterrupt(interaction, threadId);
  } else if (action === 'delete') {
    await handleWorktreeDelete(interaction, threadId);
  } else if (action === 'pr') {
    await handleWorktreePR(interaction, threadId);
  } else {
    await interaction.reply({
      content: '❌ Unknown action.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  const customId = interaction.customId;

  if (customId.startsWith('qselect:')) {
    const [, threadId, requestId, questionIndexRaw] = customId.split(':');
    const questionIndex = Number(questionIndexRaw);

    if (!threadId || !requestId || !Number.isInteger(questionIndex)) {
      await interaction.reply({
        content: '❌ Invalid question selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session = sessionManager.getSessionForThread(threadId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ Session not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
      const request = questions.find((q) => q.id === requestId);

      if (!request) {
        await interaction.reply({
          content: '⚠️ Pending question not found. It may have already been answered.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const question = request.questions[questionIndex];
      if (!question) {
        await interaction.reply({
          content: '⚠️ Question not found.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const isMulti = question.multiple === true;

      const selectedLabels = interaction.values
        .map((v) => Number(v))
        .filter((idx) => Number.isInteger(idx) && question.options?.[idx])
        .map((idx) => question.options![idx].label);

      const answerKey = `${requestId}:${threadId}`;
      let selections = pendingAnswers.get(answerKey);
      if (!selections) {
        selections = new Map();
        pendingAnswers.set(answerKey, selections);
      }
      selections.set(questionIndex, selectedLabels);

      const allAnswered = request.questions.every(
        (_, i) => (selections!.get(i) ?? []).length > 0,
      );

      if (allAnswered) {
        await submitAllAnswers(interaction, session.port, request, selections, answerKey, threadId);
      } else {
        const maxRows = 5;
        const hasMulti = request.questions.some((q) => q.multiple);
        const showSubmit = hasMulti || request.questions.length > 1;
        const text = buildQuestionText(request.questions, selections);
        const components = buildQuestionComponents(threadId, request, selections, showSubmit);

        const safeComponents = components.slice(0, maxRows);

        await interaction.update({ content: text, components: safeComponents });
        await interaction.followUp({
          content: `✅ Selected: ${selectedLabels.join(', ') || '(none)'}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      await interaction.followUp({
        content: `❌ Failed to process selection: ${(error as Error).message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

async function submitAllAnswers(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  port: number,
  request: QuestionRequest,
  selections: Map<number, string[]>,
  answerKey: string,
  threadId: string,
) {
  const answers = request.questions.map((_, i) => selections.get(i) ?? []);
  await sessionManager.replyQuestion(port, request.id, answers);
  clearPendingAnswers(answerKey);

  const answeredText = buildQuestionTextAnswered(request.questions, selections);
  const answeredComponents = buildAnsweredComponents(threadId, request.id);
  await interaction.update({ content: answeredText, components: answeredComponents });
  await interaction.followUp({
    content: '✅ All questions answered.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleQuestionAnswer(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  questionIndexRaw: string | undefined,
  optionIndexRaw: string | undefined,
) {
  const questionIndex = Number(questionIndexRaw);
  const optionIndex = Number(optionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    await interaction.reply({
      content: '❌ Invalid question response.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = questions.find((q) => q.id === requestId);

    if (!request) {
      await interaction.reply({
        content: '⚠️ Pending question not found. It may have already been answered.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const question = request.questions[questionIndex];
    const option = question?.options?.[optionIndex];

    if (!option?.label) {
      await interaction.reply({
        content: '⚠️ Pending question/option not found. It may have already been answered.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const answerKey = `${requestId}:${threadId}`;
    let selections = pendingAnswers.get(answerKey);
    if (!selections) {
      selections = new Map();
      pendingAnswers.set(answerKey, selections);
    }

    selections.set(questionIndex, [option.label]);

    const allAnswered = request.questions.every((_, i) => (selections!.get(i) ?? []).length > 0);

    if (allAnswered) {
      await submitAllAnswers(interaction, session.port, request, selections, answerKey, threadId);
    } else {
      const text = buildQuestionText(request.questions, selections);
      const components = buildQuestionComponents(threadId, request, selections, false);
      await interaction.update({ content: text, components: components.slice(0, 5) });
      await interaction.followUp({
        content: `✅ Q${questionIndex + 1} answered: ${option.label}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to answer question: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionToggle(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
  questionIndexRaw: string | undefined,
  optionIndexRaw: string | undefined,
) {
  const questionIndex = Number(questionIndexRaw);
  const optionIndex = Number(optionIndexRaw);

  if (!threadId || !requestId || !Number.isInteger(questionIndex) || !Number.isInteger(optionIndex)) {
    await interaction.reply({
      content: '❌ Invalid toggle.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = questions.find((q) => q.id === requestId);

    if (!request) {
      await interaction.reply({
        content: '⚠️ Pending question not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const option = request.questions[questionIndex]?.options?.[optionIndex];
    if (!option?.label) {
      await interaction.reply({
        content: '⚠️ Option not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const answerKey = `${requestId}:${threadId}`;
    let selections = pendingAnswers.get(answerKey);
    if (!selections) {
      selections = new Map();
      pendingAnswers.set(answerKey, selections);
    }

    const current = selections.get(questionIndex) ?? [];
    if (current.includes(option.label)) {
      selections.set(questionIndex, current.filter((l) => l !== option.label));
    } else {
      selections.set(questionIndex, [...current, option.label]);
    }

    const text = buildQuestionText(request.questions, selections);
    const components = buildQuestionComponents(threadId, request, selections, true);
    await interaction.update({ content: text, components: components.slice(0, 5) });
    await interaction.followUp({
      content: `Toggled: ${option.label}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to toggle: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionSubmit(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
) {
  if (!threadId || !requestId) {
    await interaction.reply({
      content: '❌ Invalid submit.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const questions = (await sessionManager.listQuestions(session.port)) as QuestionRequest[];
    const request = questions.find((q) => q.id === requestId);

    if (!request) {
      await interaction.reply({
        content: '⚠️ Pending question not found.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const answerKey = `${requestId}:${threadId}`;
    const selections = pendingAnswers.get(answerKey) ?? new Map();

    await submitAllAnswers(interaction, session.port, request, selections, answerKey, threadId);
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to submit: ${(error as Error).message}`,
    });
  }
}

async function handleQuestionReject(
  interaction: ButtonInteraction,
  threadId: string | undefined,
  requestId: string | undefined,
) {
  if (!threadId || !requestId) {
    await interaction.reply({
      content: '❌ Invalid question rejection.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSessionForThread(threadId);
  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await sessionManager.rejectQuestion(session.port, requestId);
    const answerKey = `${requestId}:${threadId}`;
    clearPendingAnswers(answerKey);

    await interaction.update({
      content: '🚫 Question rejected.',
      components: buildAnsweredComponents(threadId, requestId),
    });
    await interaction.followUp({
      content: '🚫 Question rejected.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Failed to reject question: ${(error as Error).message}`,
    });
  }
}

async function handleInterrupt(interaction: ButtonInteraction, threadId: string) {
  const session = sessionManager.getSessionForThread(threadId);

  if (!session) {
    await interaction.reply({
      content: '⚠️ Session not found.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  const port = serveManager.getPort(session.projectPath, preferredModel);

  if (!port) {
    await interaction.reply({
      content: '⚠️ Server is not running.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const success = await sessionManager.abortSession(port, session.sessionId);

  if (success) {
    await interaction.editReply({ content: '⏸️ Interrupt request sent.' });
  } else {
    await interaction.editReply({
      content: '⚠️ Failed to interrupt. Server may not be running or no active task.',
    });
  }
}

async function handleWorktreeDelete(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (worktreeManager.worktreeExists(mapping.worktreePath)) {
      await worktreeManager.removeWorktree(mapping.worktreePath, false);
    }

    dataStore.removeWorktreeMapping(threadId);

    const channel = interaction.channel;
    if (channel?.isThread()) {
      await (channel as ThreadChannel).setArchived(true);
    }

    await interaction.editReply({ content: '✅ Worktree deleted and thread archived.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to delete worktree: ${(error as Error).message}` });
  }
}

async function handleWorktreePR(interaction: ButtonInteraction, threadId: string) {
  const mapping = dataStore.getWorktreeMapping(threadId);
  if (!mapping) {
    await interaction.reply({ content: '⚠️ Worktree mapping not found.', flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = interaction.channel;
  const parentChannelId = channel?.isThread() ? (channel as ThreadChannel).parentId! : channel?.id;
  const preferredModel = parentChannelId ? dataStore.getChannelModel(parentChannelId) : undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const port = await serveManager.spawnServe(mapping.worktreePath, preferredModel);
    await serveManager.waitForReady(port, 30000, mapping.worktreePath, preferredModel);

    const sessionId = await sessionManager.ensureSessionForThread(
      threadId,
      mapping.worktreePath,
      port,
    );

    const prPrompt = `Create a pull request for the current branch. Include a clear title and description summarizing all changes.`;
    await sessionManager.sendPrompt(port, sessionId, prPrompt, preferredModel);

    await interaction.editReply({ content: '🚀 PR creation started! Check the thread for progress.' });
  } catch (error) {
    await interaction.editReply({ content: `❌ Failed to start PR creation: ${(error as Error).message}` });
  }
}
