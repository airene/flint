import { describe, expect, test } from "bun:test";

const composer = await Bun.file(new URL("../../apps/web/src/components/TaskComposer.vue", import.meta.url)).text();
const strip = await Bun.file(new URL("../../apps/web/src/components/AttachmentStrip.vue", import.meta.url)).text();

describe("TaskComposer", () => {
  test("keeps text paste native while extracting clipboard image files for the injected uploader", () => {
    expect(composer).toContain('function onPaste(event: ClipboardEvent): void');
    expect(composer).toContain('item.kind === "file" && item.type.startsWith("image/")');
    expect(composer).toContain("// Do not prevent the native paste: pasted text must continue into the editor.");
    expect(composer).not.toContain("event.preventDefault()");
    expect(composer).toContain("uploadImage: UploadImage");
    expect(composer).toContain("onProgress: (percent)");
  });

  test("reports upload state, supports removal and retry, and emits only ready attachment ids", () => {
    expect(composer).toContain('status === "ready" && attachment.attachmentId');
    expect(composer).toContain("function remove(localId: string): void");
    expect(composer).toContain("function retry(localId: string): void");
    expect(composer).toContain("void upload(attachment, attachment.file)");
    expect(composer).toContain('emit("submit", { text: props.modelValue, attachmentIds: readyAttachmentIds.value })');
    expect(strip).toContain("Uploading {{ attachment.progress }}%");
    expect(strip).toContain("Upload failed.");
  });

  test("blocks submission until every attachment is ready and fences repeated submits synchronously", () => {
    expect(composer).toContain('attachment.status !== "ready"');
    expect(composer).toContain("submissionLocked.value = true");
    expect(composer).toContain("props.submitting || submissionLocked.value || hasBlockedAttachment.value");
    expect(composer).toContain("submitting?: boolean");
    expect(composer).toContain("Sending…");
  });

  test("shows a capability reason and limits a composed message to four images", () => {
    expect(composer).toContain('v-if="!imagesEnabled"');
    expect(composer).toContain("{{ imageDisabledReason }}");
    expect(composer).toContain("4 - attachments.value.length");
    expect(composer).toContain("{{ attachments.length }}/4 images");
  });
});
