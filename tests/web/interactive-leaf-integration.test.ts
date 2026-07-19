import { describe, expect, test } from "bun:test";

const projectView = await Bun.file(new URL("../../apps/web/src/views/ProjectView.vue", import.meta.url)).text();
const settingsView = await Bun.file(new URL("../../apps/web/src/views/SettingsView.vue", import.meta.url)).text();
const app = await Bun.file(new URL("../../apps/web/src/App.vue", import.meta.url)).text();
const workspace = await Bun.file(new URL("../../apps/web/src/stores/task-workspace.ts", import.meta.url)).text();
const taskView = await Bun.file(new URL("../../apps/web/src/views/TaskView.vue", import.meta.url)).text();
const activityPanel = await Bun.file(new URL("../../apps/web/src/components/ActivityPanel.vue", import.meta.url)).text();

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
    expect(workspace).toContain('apiEndpoints.listApprovals');
    expect(activityPanel).toContain('import ApprovalCard');
    expect(activityPanel).toContain('approvalErrors[approval.id]');
  });
});
