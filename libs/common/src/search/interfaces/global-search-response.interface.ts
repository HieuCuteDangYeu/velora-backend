import { ReelFeedListItem } from '@common/content/interfaces/reel-response.interface';
import { SearchTagItem } from '@common/search/interfaces/search-tag.interface';
import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';

export type GlobalSearchType = 'all' | 'users' | 'reels' | 'tags';

export interface GlobalSearchResponse {
  query: string;
  type: GlobalSearchType;
  users: PublicUserProfile[];
  reels: ReelFeedListItem[];
  tags: SearchTagItem[];
  counts: {
    users: number;
    reels: number;
    tags: number;
  };
}
