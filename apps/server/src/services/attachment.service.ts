import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { TaskAttachment } from "@local-pair-review/shared";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const DEFAULT_DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type AttachmentMediaType = TaskAttachment["mediaType"];

export interface AttachmentPersistencePort {
  createAttachmentDraft(attachment: TaskAttachment): Promise<TaskAttachment>;
  claimAttachments(
    projectId: string,
    taskId: string,
    attachmentIds: string[],
    messageId: string | null,
  ): Promise<TaskAttachment[]>;
}

export interface AttachmentServiceOptions {
  /** A Flint-owned data directory. Drafts are stored in its attachment-drafts child only. */
  dataRoot: string;
  persistence: AttachmentPersistencePort;
  now?: () => Date;
  id?: () => string;
  draftLifetimeMs?: number;
}

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

interface DetectedImage {
  mediaType: AttachmentMediaType;
  extension: "png" | "jpg" | "webp" | "gif";
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function skipGifSubBlocks(bytes: Uint8Array, position: number): number | null {
  let cursor = position;
  while (cursor < bytes.length) {
    const size = bytes[cursor++];
    if (size === undefined) return null;
    if (size === 0) return cursor;
    cursor += size;
    if (cursor > bytes.length) return null;
  }
  return null;
}

function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 14) throw new AttachmentValidationError("GIF data is truncated.");
  let cursor = 13;
  const packed = bytes[10]!;
  if ((packed & 0x80) !== 0) {
    cursor += 3 * (1 << ((packed & 0x07) + 1));
  }
  let imageFrames = 0;
  while (cursor < bytes.length) {
    const marker = bytes[cursor++];
    if (marker === 0x3b) {
      if (imageFrames === 0) throw new AttachmentValidationError("GIF data has no image frame.");
      return imageFrames > 1;
    }
    if (marker === 0x2c) {
      imageFrames += 1;
      if (imageFrames > 1) return true;
      if (cursor + 9 > bytes.length) throw new AttachmentValidationError("GIF image frame is truncated.");
      const imagePacked = bytes[cursor + 8]!;
      cursor += 9;
      if ((imagePacked & 0x80) !== 0) cursor += 3 * (1 << ((imagePacked & 0x07) + 1));
      if (cursor >= bytes.length) throw new AttachmentValidationError("GIF image data is truncated.");
      cursor += 1; // LZW minimum code size
      const next = skipGifSubBlocks(bytes, cursor);
      if (next === null) throw new AttachmentValidationError("GIF image data is truncated.");
      cursor = next;
      continue;
    }
    if (marker === 0x21) {
      if (cursor >= bytes.length) throw new AttachmentValidationError("GIF extension is truncated.");
      cursor += 1; // extension label
      const next = skipGifSubBlocks(bytes, cursor);
      if (next === null) throw new AttachmentValidationError("GIF extension is truncated.");
      cursor = next;
      continue;
    }
    throw new AttachmentValidationError("GIF data contains an invalid block.");
  }
  throw new AttachmentValidationError("GIF data is missing its trailer.");
}

export function detectImage(bytes: Uint8Array): DetectedImage {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mediaType: "image/png", extension: "png" };
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg", extension: "jpg" };
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])) {
    return { mediaType: "image/webp", extension: "webp" };
  }
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    if (isAnimatedGif(bytes)) throw new AttachmentValidationError("Animated GIF images are not supported.");
    return { mediaType: "image/gif", extension: "gif" };
  }
  throw new AttachmentValidationError("Only PNG, JPEG, WebP, and non-animated GIF images are supported.");
}

function controlledPath(dataRoot: string, filename: string): string {
  const draftDirectory = resolve(dataRoot, "attachment-drafts");
  const path = resolve(draftDirectory, basename(filename));
  const pathFromDraftDirectory = relative(draftDirectory, path);
  if (pathFromDraftDirectory.startsWith("..") || isAbsolute(pathFromDraftDirectory)) {
    throw new AttachmentValidationError("Attachment storage path escapes the Flint data directory.");
  }
  return path;
}

export class AttachmentService {
  private readonly dataRoot: string;
  private readonly persistence: AttachmentPersistencePort;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly draftLifetimeMs: number;

  constructor(options: AttachmentServiceOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => randomUUID());
    this.draftLifetimeMs = options.draftLifetimeMs ?? DEFAULT_DRAFT_LIFETIME_MS;
    if (!Number.isSafeInteger(this.draftLifetimeMs) || this.draftLifetimeMs <= 0) {
      throw new Error("Attachment draft lifetime must be a positive integer.");
    }
  }

  async createDraft(projectId: string, bytes: Uint8Array, _declaredMediaType?: string): Promise<TaskAttachment> {
    if (!projectId) throw new AttachmentValidationError("A Project is required for attachment drafts.");
    if (bytes.byteLength === 0) throw new AttachmentValidationError("Image data is empty.");
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AttachmentValidationError("Each image must be 10 MiB or smaller.");
    const detected = detectImage(bytes);
    const now = this.now();
    const id = this.id();
    if (!id || /[^a-zA-Z0-9_-]/u.test(id)) throw new AttachmentValidationError("Attachment identifiers must be generated safely.");
    const filename = `attachment-${id}.${detected.extension}`;
    const storagePath = controlledPath(this.dataRoot, filename);
    const directory = resolve(this.dataRoot, "attachment-drafts");
    const attachment: TaskAttachment = {
      id,
      projectId,
      taskId: null,
      messageId: null,
      state: "draft",
      storagePath,
      mediaType: detected.mediaType,
      sizeBytes: bytes.byteLength,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.draftLifetimeMs).toISOString(),
      claimedAt: null,
    };

    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, bytes, { flag: "wx" });
    try {
      return await this.persistence.createAttachmentDraft(attachment);
    } catch (error) {
      await rm(storagePath, { force: true });
      throw error;
    }
  }

  /** Use this boundary for a single paste/input containing multiple images. */
  async createDrafts(projectId: string, images: Array<{ bytes: Uint8Array; declaredMediaType?: string }>): Promise<TaskAttachment[]> {
    if (images.length > MAX_ATTACHMENTS) throw new AttachmentValidationError("A message can include at most four images.");
    return Promise.all(images.map((image) => this.createDraft(projectId, image.bytes, image.declaredMediaType)));
  }

  async claim(projectId: string, taskId: string, attachmentIds: string[], messageId: string | null = null): Promise<TaskAttachment[]> {
    if (attachmentIds.length > MAX_ATTACHMENTS) throw new AttachmentValidationError("A message can include at most four images.");
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new AttachmentValidationError("Attachment IDs must be unique.");
    return this.persistence.claimAttachments(projectId, taskId, attachmentIds, messageId);
  }
}
