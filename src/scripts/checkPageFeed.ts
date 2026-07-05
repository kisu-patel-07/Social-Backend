import axios from 'axios';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { Platform } from '../constants';
import { SocialAccountModel } from '../models';

/**
 * Inspect the connected Facebook Page: publish state and recent feed posts
 * with their comments. Confirms whether test comments actually landed on
 * Page-owned posts (the only posts that trigger `feed` webhooks).
 *
 * Run with: npx ts-node src/scripts/checkPageFeed.ts
 */

const base = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_VERSION}`;

/* eslint-disable no-console */

async function run(): Promise<void> {
  await connectDatabase();
  const account = await SocialAccountModel.findOne({
    platform: Platform.FACEBOOK,
    isActive: true,
  }).select('+accessToken');
  if (!account?.pageId) {
    console.log('No active Facebook account found.');
    await disconnectDatabase();
    return;
  }

  const { data: page } = await axios.get(`${base}/${account.pageId}`, {
    params: {
      access_token: account.accessToken,
      fields: 'name,is_published,link,verification_status',
    },
  });
  console.log('\n=== Page ===');
  console.log(JSON.stringify(page, null, 2));
  if (page.is_published === false) {
    console.log('❌ PAGE IS UNPUBLISHED — Meta does not deliver feed webhooks reliably.');
  }

  const { data: feed } = await axios.get(`${base}/${account.pageId}/posts`, {
    params: {
      access_token: account.accessToken,
      fields:
        'message,created_time,permalink_url,comments.summary(true){message,from{id,name},created_time}',
      limit: 5,
    },
  });

  console.log('\n=== Last 5 Page posts and their comments ===');
  const posts = (feed?.data ?? []) as Array<Record<string, any>>;
  if (!posts.length) {
    console.log('❌ The Page has NO posts. A comment test needs a post owned by the Page.');
  }
  for (const post of posts) {
    console.log(`\n- Post: "${(post.message ?? '(no text)').slice(0, 60)}" @ ${post.created_time}`);
    console.log(`  ${post.permalink_url}`);
    const comments = post.comments?.data ?? [];
    const total = post.comments?.summary?.total_count ?? 0;
    console.log(`  comments (${total}):`);
    for (const c of comments) {
      console.log(
        `    • "${(c.message ?? '').slice(0, 60)}" — from ${c.from?.name ?? 'HIDDEN (no permission for this user)'} (${c.from?.id ?? '?'}) @ ${c.created_time}`
      );
    }
  }
  await disconnectDatabase();
}

run().catch((error) => {
  if (axios.isAxiosError(error)) {
    console.error('Graph error:', JSON.stringify(error.response?.data, null, 2));
  } else {
    console.error(error);
  }
  process.exit(1);
});
