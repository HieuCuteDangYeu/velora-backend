import type {
  IReelSubtitleTrackRepository,
  StoredSubtitleTrack,
} from '@content/domain/interfaces/reel-subtitle-track.repository.interface';
import type { SubtitleCue } from '@content/domain/subtitle-cues';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';

@Injectable()
export class ReelSubtitleTrackRepository implements IReelSubtitleTrackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    reelId: string,
    language: string,
  ): Promise<StoredSubtitleTrack | null> {
    const record = await this.prisma.reelSubtitleTrack.findUnique({
      where: { reelId_language: { reelId, language } },
    });
    if (!record) return null;
    return {
      sourceHash: record.sourceHash,
      cues: record.cues as unknown as SubtitleCue[],
      model: record.model,
    };
  }

  async save(
    reelId: string,
    language: string,
    track: StoredSubtitleTrack,
  ): Promise<void> {
    const data = {
      sourceHash: track.sourceHash,
      cues: track.cues as unknown as Prisma.InputJsonValue,
      model: track.model,
    };
    await this.prisma.reelSubtitleTrack.upsert({
      where: { reelId_language: { reelId, language } },
      create: { reelId, language, ...data },
      update: data,
    });
  }
}
