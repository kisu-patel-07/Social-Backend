/**
 * Application-wide enums and constant values.
 * Keeping these centralized avoids magic strings scattered across the codebase.
 */

export enum Platform {
  INSTAGRAM = 'instagram',
  FACEBOOK = 'facebook',
}

export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
}

export enum AuthProvider {
  LOCAL = 'local',
  GOOGLE = 'google',
  FACEBOOK = 'facebook',
}

export enum AutomationStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
}

/** What starts a classic automation: a post comment or an incoming DM. */
export enum AutomationTrigger {
  COMMENT = 'comment',
  DM = 'dm',
  /** Reply sent when someone responds to a story (targetPostId = story id). */
  STORY = 'story',
  /** Thank-you DM sent when someone mentions the account in THEIR story. */
  STORY_MENTION = 'story_mention',
}

export enum KeywordMatchType {
  EXACT = 'exact',
  CONTAINS = 'contains',
}

/**
 * Automation Studio (v2 trial) — parallel to the classic Automation feature.
 * Kept as separate enums so the classic feature is untouched.
 */
export enum StudioAutomationStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
}

/** How Studio automations decide whether a comment triggers. */
export enum StudioKeywordMode {
  /** Every comment triggers (no keyword needed). */
  ANY = 'any',
  /** Comment contains any keyword as a substring (classic behavior). */
  CONTAINS = 'contains',
  /** Comment contains a keyword as a whole word. */
  EXACT = 'exact',
}

/** Which posts a Studio automation listens on. */
export enum StudioPostScope {
  ALL = 'all',
  SPECIFIC = 'specific',
}

/**
 * The step a per-user Studio DM flow is currently waiting on. A flow chains
 * optional gates before the link is delivered: follow-gate → email → link,
 * with an optional follow-up if the link goes unclicked.
 */
export enum FlowStep {
  /** Follow-gate sent; waiting for the "I'm following" tap. */
  AWAIT_FOLLOW = 'await_follow',
  /** Email asked; waiting for the user to reply with it. */
  AWAIT_EMAIL = 'await_email',
  /** Opening DM sent; waiting for the "Send me the link" tap. */
  AWAIT_CLICK = 'await_click',
  /** Link delivered; a follow-up may still fire if it goes unclicked. */
  LINK_SENT = 'link_sent',
  /** Flow finished (link clicked, or nothing left to do). */
  DONE = 'done',
}

export enum MessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export enum MessageType {
  COMMENT = 'comment',
  DIRECT_MESSAGE = 'dm',
  PUBLIC_REPLY = 'public_reply',
}

export enum MessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  RECEIVED = 'received',
}

export enum ConversationStatus {
  UNREAD = 'unread',
  READ = 'read',
  RESOLVED = 'resolved',
}

export enum LeadStatus {
  NEW = 'new',
  CONTACTED = 'contacted',
  QUALIFIED = 'qualified',
  CONVERTED = 'converted',
  LOST = 'lost',
}

/** How a contact/lead first entered the workspace ("opted in through"). */
export enum LeadSource {
  COMMENT = 'comment',
  DM = 'dm',
}

export enum NotificationType {
  NEW_LEAD = 'new_lead',
  ACCOUNT_CONNECTED = 'account_connected',
  ACCOUNT_DISCONNECTED = 'account_disconnected',
  AUTOMATION_TRIGGERED = 'automation_triggered',
  TOKEN_EXPIRING = 'token_expiring',
  WEEKLY_REPORT = 'weekly_report',
  SYSTEM = 'system',
}

export enum SubscriptionStatus {
  TRIALING = 'trialing',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELED = 'canceled',
  EXPIRED = 'expired',
}

export enum BillingInterval {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  /** Fixed validity pack — plan.durationDays sets the length (e.g. 7-day pack). */
  DAYS = 'days',
}

export enum InvoiceStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  PAID = 'paid',
  VOID = 'void',
  UNCOLLECTIBLE = 'uncollectible',
}

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export enum ActivityAction {
  USER_REGISTERED = 'user.registered',
  USER_LOGGED_IN = 'user.logged_in',
  ACCOUNT_CONNECTED = 'account.connected',
  ACCOUNT_DISCONNECTED = 'account.disconnected',
  AUTOMATION_CREATED = 'automation.created',
  AUTOMATION_UPDATED = 'automation.updated',
  AUTOMATION_DELETED = 'automation.deleted',
  AUTOMATION_TRIGGERED = 'automation.triggered',
  LEAD_CREATED = 'lead.created',
  LEAD_UPDATED = 'lead.updated',
  MESSAGE_SENT = 'message.sent',
  // Platform-admin actions (performed from the /admin panel).
  ADMIN_USER_SUSPENDED = 'admin.user_suspended',
  ADMIN_USER_UNSUSPENDED = 'admin.user_unsuspended',
  ADMIN_USER_VERIFIED = 'admin.user_verified',
  ADMIN_USER_DELETED = 'admin.user_deleted',
  ADMIN_SUBSCRIPTION_UPDATED = 'admin.subscription_updated',
  ADMIN_PLAN_CREATED = 'admin.plan_created',
  ADMIN_PLAN_UPDATED = 'admin.plan_updated',
  ADMIN_AUTOMATION_PAUSED = 'admin.automation_paused',
  ADMIN_AUTOMATION_RESUMED = 'admin.automation_resumed',
  ADMIN_WEBHOOK_RETRIED = 'admin.webhook_retried',
  ADMIN_BROADCAST_SENT = 'admin.broadcast_sent',
  ADMIN_IMPERSONATION_STARTED = 'admin.impersonation_started',
  ADMIN_PAYMENT_REFUNDED = 'admin.payment_refunded',
  ADMIN_FEATURE_UPDATED = 'admin.feature_updated',
  ADMIN_DATA_EXPORTED = 'admin.data_exported',
  ADMIN_2FA_ENABLED = 'admin.2fa_enabled',
  ADMIN_2FA_DISABLED = 'admin.2fa_disabled',
  ADMIN_NOTES_UPDATED = 'admin.notes_updated',
  ADMIN_BANNER_UPDATED = 'admin.banner_updated',
  ADMIN_BONUS_GRANTED = 'admin.bonus_granted',
  ADMIN_BONUS_REMOVED = 'admin.bonus_removed',
}

export enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

/** What a demo-call enquiry is about. */
export enum DemoRequestTopic {
  DEMO = 'demo',
  SETUP = 'setup',
  BOTH = 'both',
}

export enum DemoRequestStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/**
 * Meta's standard messaging window: free-form DMs are only allowed within
 * 24 hours of the contact's last inbound message (both IG and Messenger).
 */
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default pagination settings used across list endpoints. */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

/** Cookie name used to store the refresh token. */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/** Meta long-lived token lifetime is ~60 days; refresh when within this window. */
export const TOKEN_REFRESH_THRESHOLD_DAYS = 7;
