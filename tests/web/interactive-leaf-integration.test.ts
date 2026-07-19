import { describe, expect, test } from "bun:test";

const projectView = await Bun.file(new URL("../../apps/web/src/views/ProjectView.vue", import.meta.url)).text();
const settingsView = await Bun.file(new URL("../../apps/web/src/views/SettingsView.vue", import.meta.url)).text();
const app = await Bun.file(new URL("../../apps/web/src/App.vue", import.meta.url)).text();
const workspace = await Bun.file(new URL("../../apps/web/src/stores/task-workspace.ts", import.meta.url)).text();
const taskView = await Bun.file(new URL("../../apps/web/src/views/TaskView.vue", import.meta.url)).text();
const activityPanel = await Bun.file(new URL("../../apps/web/src/components/ActivityPanel.vue", import.meta.url)).text();
const taskHeader = await Bun.file(new URL("../../apps/web/src/components/TaskHeader.vue", import.meta.url)).text();
const agentPanel = await Bun.file(new URL("../../apps/web/src/components/AgentPanel.vue", import.meta.url)).text();
const finalResponse = await Bun.file(new URL("../../apps/web/src/components/FinalResponse.vue", import.meta.url)).text();

describe("completed interactive leaf integration", () => {
  test("uses the attachment composer for initial Task creation and gates images by provider capability", () => {
    expect(projectView).toContain('import TaskComposer');
    expect(projectView).toContain(':upload-image="uploadAttachmentDraft"');
    expect(projectView).toContain('developerInitialImage');
    expect(projectView).toContain('attachmentIds: submission.attachmentIds');
    expect(projectView).not.toContain('import FileMentionInput');
  });

  test("mounts the summary unfinished list under repositories and replaces reconnect snapshots", () => {
    expect(app).toContain('import UnfinishedTaskList');
    expect(app).toContain('useUnfinishedTasksStore');
    expect(app).toContain('subscribe_unfinished');
    expect(app).toContain('replaceUnfinishedTaskSnapshot');
    expect(app).not.toContain('projects.loadUnfinishedTasks');
  });

  test("renders explicit notification opt-in and feeds role-resolved current Task persisted events", () => {
    expect(settingsView).toContain('import NotificationSettings');
    expect(settingsView).toContain('<NotificationSettings');
    expect(workspace).toContain('consumePersistedEvent');
    expect(workspace).toContain('run.runType.startsWith("reviewer") ? "reviewer" : "developer"');
  });

  test("wires persisted exact-session conversations and approval cards into the Task workspace", () => {
    expect(taskView).toContain('import TaskComposer');
    expect(taskView).toContain('selectedFormalReview');
    expect(taskView).toContain('reviewerResumeImage');
    expect(taskView).toContain('developerResumeImage');
    expect(taskView).toContain('workspace.sendMessage');
    expect(taskView).toContain('workspace.decideApproval');
    expect(workspace).toContain('apiEndpoints.listMessages');
    expect(workspace).toContain('apiEndpoints.listAttachments');
    expect(workspace).toContain('apiEndpoints.listApprovals');
    expect(taskView).toContain('initialAttachments');
    expect(taskView).toContain('attachmentSummary(message.id)');
    expect(activityPanel).toContain('import ApprovalCard');
    expect(activityPanel).toContain('approvalErrors[approval.id]');
    expect(taskHeader).not.toContain('continuationPrompt');
    expect(taskHeader).not.toContain('import FileMentionInput');
  });

  test("reflects the guarded message action in the Task composer", () => {
    expect(taskView).toContain(':submitting="workspace.sendingMessage"');
    expect(workspace).toContain("sendingMessage");
  });

  test("hides the conversation without an exact session and after Task completion", () => {
    expect(taskView).toContain('const conversationAvailable = computed(() => Boolean(workspace.task?.developerSessionId)');
    expect(taskView).toContain('&& workspace.task?.status !== "completed"');
    expect(taskView).toContain('<section v-if="conversationAvailable" class="panel conversation-panel">');
    expect(taskView).toContain(':rows="2"');
    expect(taskView).toContain('.conversation-panel{margin-top:14px;padding:10px}');
    expect(taskView).toContain('class="panel-header conversation-header"');
    expect(taskView).toContain('.conversation-header{min-height:37px;align-items:center;margin-bottom:8px;padding:0;border-bottom:0}');
  });

  test("moves compact Task context beside the title without repeating the repository", () => {
    expect(taskView).toContain(':event-count="workspace.events.length"');
    expect(taskView).toContain(':connected="workspace.connected"');
    expect(taskView).not.toContain('class="context-strip panel"');
    expect(taskHeader).toContain('<dl class="task-context">');
    expect(taskHeader).toContain('<dt>Base commit</dt>');
    expect(taskHeader).toContain('<dt>{{ developerLabel }} session</dt>');
    expect(taskHeader).toContain('<dt>Events</dt>');
    expect(taskHeader).not.toContain('<dt>Repository</dt>');
    expect(taskHeader).toContain('.task-context{display:grid;');
  });

  test("renders detected Markdown final responses through a sanitizer", () => {
    expect(agentPanel).toContain('import FinalResponse from "./FinalResponse.vue"');
    expect(agentPanel).toContain('<FinalResponse :content="run.finalMessage" />');
    expect(finalResponse).toContain('import DOMPurify from "dompurify"');
    expect(finalResponse).toContain('import { marked } from "marked"');
    expect(finalResponse).toContain('v-html="renderedHtml"');
  });
});
