import { Platform } from '../../constants';

/** Long-lived token exchange response. */
export interface MetaTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/** A Facebook Page returned from /me/accounts. */
export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string };
}

/** Result of resolving the entities a user can connect. */
export interface ConnectableAccount {
  platform: Platform;
  pageId: string;
  name: string;
  username?: string;
  instagramBusinessId?: string;
  pageAccessToken: string;
}

/** Instagram media classification. `mediaProductType` distinguishes feed posts from reels/stories. */
export type MediaProductType = 'FEED' | 'REELS' | 'STORY' | 'AD';
export type MediaType = 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';

/** A single Instagram media object (post or reel) from the `/media` edge. */
export interface InstagramMedia {
  id: string;
  caption?: string;
  mediaType: MediaType;
  mediaProductType: MediaProductType;
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink?: string;
  timestamp?: string;
  likeCount?: number;
  commentsCount?: number;
  /** Populated only when insights are explicitly requested (best-effort). */
  insights?: Record<string, number>;
}

/** One page of Instagram media plus the cursor for the next page, if any. */
export interface InstagramMediaPage {
  media: InstagramMedia[];
  nextCursor?: string;
}

/** Normalized representation of an inbound comment webhook event. */
export interface IncomingComment {
  platform: Platform;
  /** The connected account's external id (page id or IG business id). */
  accountExternalId: string;
  commentId: string;
  postId?: string;
  text: string;
  fromId: string;
  fromUsername?: string;
  fromName?: string;
  createdTime?: Date;
}

/** Normalized representation of an inbound direct message webhook event. */
export interface IncomingMessage {
  platform: Platform;
  accountExternalId: string;
  messageId: string;
  text: string;
  fromId: string;
  toId: string;
  createdTime?: Date;
}
