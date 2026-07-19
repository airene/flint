import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { TaskAttachment } from "@local-pair-review/shared";
import {
  AttachmentService,
  AttachmentValidationError,
  type AttachmentPersistencePort,
} from "../../apps/server/src/services/attachment.service";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = new Uint8Array([255, 216, 255, 0]);
const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
const singleFrameGif = new Uint8Array([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 76, 1, 0, 59,
]);

class MemoryAttachments implements AttachmentPersistencePort {
  drafts: TaskAttachment[] = [];
  claimed: TaskAttachment[] = [];

  async createAttachmentDraft(attachment: TaskAttachment): Promise<TaskAttachment> {
    this.drafts.push(attachment);
    return attachment;
  }

  async claimAttachments(projectId: string, taskId: string, attachmentIds: string[], messageId: string | null): Promise<TaskAttachment[]> {
    const now = "2026-07-19T00:00:00.000Z";
    const claimed = attachmentIds.map((id) => {
      const attachment = this.drafts.find((candidate) => candidate.id === id);
      if (!attachment || attachment.projectId !== projectId || attachment.expiresAt <= now) {
        throw new Error("Attachment is expired or does not belong to this Project.");
      }
      const sameClaim = attachment.state === "claimed" && attachment.taskId === taskId && attachment.messageId === messageId;
      if (attachment.state === "claimed" && !sameClaim) throw new Error("Attachment is already claimed.");
      Object.assign(attachment, { state: "claimed" as const, taskId, messageId, claimedAt: now });
      return attachment;
    });
    this.claimed.push(...claimed);
    return claimed;
  }
}

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), "flint-attachments-"));
  const persistence = new MemoryAttachments();
  let nextId = 0;
  const service = new AttachmentService({
    dataRoot,
    persistence,
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    id: () => `draft-${++nextId}`,
  });
  return { dataRoot, persistence, service };
}

describe("AttachmentService", () => {
  test("stores signature-validated images beneath the configured data root with controlled names", async () => {
    const { dataRoot, persistence, service } = await setup();
    try {
      const attachment = await service.createDraft("project/../../outside", png, "image/jpeg");

      expect(attachment).toMatchObject({
        id: "draft-1",
        projectId: "project/../../outside",
        mediaType: "image/png",
        storagePath: join(resolve(dataRoot), "attachment-drafts", "attachment-draft-1.png"),
        sizeBytes: png.byteLength,
        state: "draft",
        taskId: null,
        messageId: null,
        claimedAt: null,
      });
      expect(relative(resolve(dataRoot), attachment.storagePath).startsWith("..")).toBeFalse();
      expect(await readFile(attachment.storagePath)).toEqual(Buffer.from(png));
      expect(persistence.drafts).toEqual([attachment]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("detects supported formats from bytes and rejects malformed or animated image data", async () => {
    const { dataRoot, service } = await setup();
    try {
      await expect(service.createDraft("project", jpeg)).resolves.toMatchObject({ mediaType: "image/jpeg" });
      await expect(service.createDraft("project", webp)).resolves.toMatchObject({ mediaType: "image/webp" });
      await expect(service.createDraft("project", singleFrameGif)).resolves.toMatchObject({ mediaType: "image/gif" });
      await expect(service.createDraft("project", new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(AttachmentValidationError);
      await expect(service.createDraft("project", new Uint8Array([...singleFrameGif.slice(0, -1), 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 76, 1, 0, 59]))).rejects.toThrow("Animated GIF");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("enforces the per-image and per-message limits before writing", async () => {
    const { dataRoot, service } = await setup();
    try {
      await expect(service.createDraft("project", new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MiB");
      await expect(service.createDrafts("project", Array.from({ length: 5 }, () => ({ bytes: png })))).rejects.toThrow("four");
      await expect(service.claim("project", "task", ["1", "2", "3", "4", "5"])).rejects.toThrow("four");
      await expect(service.claim("project", "task", ["1", "1"])).rejects.toThrow("unique");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("delegates atomic claims so retries are idempotent and invalid ownership or expiry is rejected", async () => {
    const { dataRoot, service } = await setup();
    try {
      const attachment = await service.createDraft("project-a", png);
      await expect(service.claim("project-b", "task-1", [attachment.id])).rejects.toThrow("does not belong");
      await expect(service.claim("project-a", "task-1", [attachment.id], "message-1")).resolves.toMatchObject([
        { id: attachment.id, state: "claimed", taskId: "task-1", messageId: "message-1" },
      ]);
      await expect(service.claim("project-a", "task-1", [attachment.id], "message-1")).resolves.toHaveLength(1);
      await expect(service.claim("project-a", "task-2", [attachment.id])).rejects.toThrow("already claimed");
      const expired = await service.createDraft("project-a", png);
      expired.expiresAt = "2026-07-18T23:59:59.000Z";
      await expect(service.claim("project-a", "task-1", [expired.id])).rejects.toThrow("expired");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
