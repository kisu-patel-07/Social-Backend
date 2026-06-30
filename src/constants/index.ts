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

export enum KeywordMatchType {
  EXACT = 'exact',
  CONTAINS = 'contains',
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
}

export enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

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
