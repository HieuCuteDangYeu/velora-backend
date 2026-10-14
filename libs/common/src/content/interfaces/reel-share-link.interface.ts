import type { ReelMediaStatus } from './reel-state.interface';

export interface ReelShareLinkResponse {
  id: string;
  reelId: string;
  ownerId: string;
  token: string;
  createdBy: string;
  publicUrl?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  clickCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentResolvedReelShareLinkResponse {
  link: ReelShareLinkResponse;
  reel: {
    id: string;
    userId: string;
    mediaKey: string;
    hlsMasterKey?: string;
    title?: string;
    description?: string;
    tags: string[];
    status: string;
    mediaStatus?: ReelMediaStatus;
    visibility: string;
    thumbnailKey?: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface PublicResolvedReelShareLinkResponse {
  token: string;
  publicUrl: string;
  appDeepLink: string;
  reel: {
    title?: string;
    description?: string;
    tags: string[];
    thumbnailUrl?: string;
    streamUrl: string;
    createdAt: string;
  };
}
