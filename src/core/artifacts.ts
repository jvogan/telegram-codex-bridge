import { chmod, copyFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { StoredArtifact } from "./types.js";
import { BridgeState } from "./state.js";
import { ensureDir } from "./util/files.js";

export class ArtifactStore {
  private readonly artifactsRoot: string;

  constructor(
    private readonly storageRoot: string,
    private readonly state: BridgeState,
  ) {
    this.artifactsRoot = ensureDir(join(storageRoot, "artifacts"));
  }

  async writeArtifact(input: {
    modality: StoredArtifact["modality"];
    providerId: StoredArtifact["providerId"];
    source: StoredArtifact["source"];
    buffer: Buffer;
    fileExtension: string;
    mimeType: string;
    metadata?: Record<string, unknown>;
  }): Promise<StoredArtifact> {
    const artifactId = randomUUID();
    const fileName = `${artifactId}.${input.fileExtension}`;
    const path = join(this.artifactsRoot, fileName);
    await writeFile(path, input.buffer, { mode: 0o600 });
    const artifact: StoredArtifact = {
      id: artifactId,
      modality: input.modality,
      providerId: input.providerId,
      source: input.source,
      path,
      mimeType: input.mimeType,
      fileName,
      createdAt: Date.now(),
      metadata: input.metadata ?? {},
      deliveredAt: null,
    };
    this.state.saveArtifact(artifact);
    return artifact;
  }

  async stageExistingFile(input: {
    modality: StoredArtifact["modality"];
    providerId: StoredArtifact["providerId"];
    source: StoredArtifact["source"];
    sourcePath: string;
    mimeType: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
    dedupeUndelivered?: boolean;
  }): Promise<StoredArtifact> {
    if (input.dedupeUndelivered !== false) {
      const existing = this.state.findUndeliveredArtifactByOriginalPath({
        modality: input.modality,
        sourcePath: input.sourcePath,
        source: input.source,
      });
      if (existing) {
        return existing;
      }
    }
    const artifactId = randomUUID();
    const extension = extname(input.fileName ?? input.sourcePath) || ".bin";
    const fileName = `${artifactId}${extension}`;
    const path = join(this.artifactsRoot, fileName);
    await copyFile(input.sourcePath, path);
    await chmod(path, 0o600).catch(() => undefined);
    const artifact: StoredArtifact = {
      id: artifactId,
      modality: input.modality,
      providerId: input.providerId,
      source: input.source,
      path,
      mimeType: input.mimeType,
      fileName: input.fileName ?? basename(input.sourcePath),
      createdAt: Date.now(),
      metadata: {
        ...(input.metadata ?? {}),
        originalPath: input.sourcePath,
      },
      deliveredAt: null,
    };
    this.state.saveArtifact(artifact);
    return artifact;
  }

  listRecentUndeliveredImages(createdAfter: number): StoredArtifact[] {
    return this.state.listRecentUndeliveredArtifacts("image", createdAfter);
  }

  listUndeliveredImages(): StoredArtifact[] {
    return this.state.listRecentUndeliveredArtifacts("image", 0);
  }
}
