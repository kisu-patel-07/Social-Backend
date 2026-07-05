import axios from 'axios';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { Platform } from '../constants';
import { SocialAccountModel } from '../models';

/**
 * Diagnose why comment (feed) webhooks are not delivered.
 * Queries the Graph API for the three things comment delivery depends on:
 *   1. App-level webhook subscription (object=page must include `feed`).
 *   2. Page-level subscribed_apps fields (must include `feed`).
 *   3. Page token scopes (must include `pages_read_user_content`).
 *
 * Run with: npx ts-node src/scripts/diagnoseWebhooks.ts
 */

const base = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_VERSION}`;
const appToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;

/* eslint-disable no-console */

function fail(msg: string): void {
  console.log(`  ❌ ${msg}`);
}
function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

async function checkAppSubscriptions(): Promise<void> {
  console.log('\n=== 1) App-level webhook subscriptions (App Dashboard → Webhooks) ===');
  try {
    const { data } = await axios.get(`${base}/${env.META_APP_ID}/subscriptions`, {
      params: { access_token: appToken },
    });
    const subs = (data?.data ?? []) as Array<{
      object: string;
      callback_url?: string;
      active?: boolean;
      fields?: Array<{ name: string; version?: string }>;
    }>;
    if (!subs.length) {
      fail('No app-level webhook subscriptions AT ALL. Configure Webhooks in the App Dashboard.');
      return;
    }
    for (const sub of subs) {
      const fields = (sub.fields ?? []).map((f) => f.name);
      console.log(
        `  object=${sub.object} active=${sub.active} callback=${sub.callback_url}\n` +
          `    fields: ${fields.join(', ') || '(none)'}`
      );
      if (sub.object === 'page') {
        if (fields.includes('feed')) ok('`feed` is subscribed at app level.');
        else
          fail(
            '`feed` is NOT subscribed at app level → comment webhooks will never be sent. ' +
              'App Dashboard → Webhooks → Page → subscribe to `feed`.'
          );
        if (fields.includes('messages')) ok('`messages` is subscribed at app level (why DMs work).');
      }
    }
    if (!subs.some((s) => s.object === 'page')) {
      fail('No subscription for object=page. Comment webhooks require it.');
    }
  } catch (error) {
    fail(`Could not read app subscriptions: ${extractError(error)}`);
  }
}

async function checkTokenScopes(name: string, token: string): Promise<void> {
  try {
    const { data } = await axios.get(`${base}/debug_token`, {
      params: { input_token: token, access_token: appToken },
    });
    const info = data?.data as {
      is_valid?: boolean;
      scopes?: string[];
      expires_at?: number;
      granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    };
    if (!info?.is_valid) {
      fail(`Token for "${name}" is INVALID — reconnect the account.`);
      return;
    }
    const scopes = info.scopes ?? [];
    console.log(`    token scopes: ${scopes.join(', ')}`);
    if (scopes.includes('pages_read_user_content')) {
      ok('`pages_read_user_content` granted.');
    } else {
      fail(
        '`pages_read_user_content` NOT granted → Meta will not deliver feed (comment) events. ' +
          'Reconnect the account via OAuth and accept the new permission.'
      );
    }
    if (scopes.includes('pages_manage_metadata')) ok('`pages_manage_metadata` granted.');
    else fail('`pages_manage_metadata` NOT granted (needed to subscribe webhooks).');
  } catch (error) {
    fail(`debug_token failed for "${name}": ${extractError(error)}`);
  }
}

async function checkPageSubscribedApps(name: string, pageId: string, token: string): Promise<void> {
  try {
    const { data } = await axios.get(`${base}/${pageId}/subscribed_apps`, {
      params: { access_token: token },
    });
    const apps = (data?.data ?? []) as Array<{
      id: string;
      name?: string;
      subscribed_fields?: string[];
    }>;
    if (!apps.length) {
      fail(`Page "${name}" has NO subscribed apps — run the subscribe-webhook retry.`);
      return;
    }
    for (const app of apps) {
      const fields = app.subscribed_fields ?? [];
      console.log(`    app ${app.name ?? app.id}: subscribed_fields = ${fields.join(', ')}`);
      if (app.id === env.META_APP_ID) {
        if (fields.includes('feed')) ok('`feed` subscribed at page level.');
        else fail('`feed` NOT in page-level subscribed_fields — re-run subscribe-webhook.');
      }
    }
  } catch (error) {
    fail(`subscribed_apps failed for "${name}": ${extractError(error)}`);
  }
}

function extractError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const metaError = error.response?.data?.error as
      | { message?: string; code?: number; error_subcode?: number }
      | undefined;
    if (metaError) return `${metaError.message} (code ${metaError.code}/${metaError.error_subcode})`;
    return error.message;
  }
  return (error as Error).message;
}

async function run(): Promise<void> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    console.error('META_APP_ID / META_APP_SECRET missing in .env');
    process.exit(1);
  }

  await checkAppSubscriptions();

  await connectDatabase();
  const accounts = await SocialAccountModel.find({ isActive: true }).select('+accessToken');
  console.log(`\n=== 2) Connected accounts (${accounts.length}) ===`);
  for (const account of accounts) {
    console.log(
      `\n- ${account.name} [${account.platform}] pageId=${account.pageId} ` +
        `webhookSubscribed=${account.isWebhookSubscribed} lastError=${account.lastError ?? 'none'}`
    );
    await checkTokenScopes(account.name, account.accessToken);
    if (account.platform === Platform.FACEBOOK && account.pageId) {
      await checkPageSubscribedApps(account.name, account.pageId, account.accessToken);
    }
  }
  await disconnectDatabase();

  console.log(
    '\n=== 3) Reminders that cannot be checked via API ===\n' +
      '  - App in Development Mode → feed events fire ONLY for comments made by users\n' +
      '    with a role on the app (admin/developer/tester). Comment from the app admin\n' +
      '    personal profile, NOT as the Page, and not from a random account.\n' +
      '  - Public users require Advanced Access to pages_read_user_content (App Review).\n' +
      '  - The callback URL must be publicly reachable (https). If you are on localhost\n' +
      '    without a tunnel (ngrok etc.), nothing can arrive.'
  );
}

run().catch((error) => {
  console.error('Diagnosis failed', error);
  process.exit(1);
});
