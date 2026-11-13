import { PrismaClient } from '@prisma/user-client';
import * as bcrypt from 'bcrypt';
import {
  BOT_USER_EMAIL,
  BOT_USER_ID,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_ID,
  DEFAULT_ADMIN_PASSWORD,
} from '../../../libs/common/src/constants/seed.constants';

const prisma = new PrismaClient();
const DEFAULT_ADMIN_AVATAR_URL =
  'https://ui-avatars.com/api/?name=Admin+User&background=2563eb&color=ffffff&bold=true';
// R2 object key of apps/user-service/prisma/assets/velora-ai-avatar.png, uploaded through
// POST /media/upload-url (purpose: avatar) as the bot user.
const BOT_AVATAR_KEY =
  'avatars/b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7/a4f60a49-8674-4883-b640-23524b6984ae.png';
const BOT_FULL_NAME = 'Velora AI';
const BOT_USERNAME = 'velora_ai';

async function main() {
  console.log('Seeding User Service...');

  const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: DEFAULT_ADMIN_EMAIL },
    update: {
      fullName: 'Admin User',
      username: 'admin',
      password: hashedPassword,
      isVerified: true,
      avatarKey: DEFAULT_ADMIN_AVATAR_URL,
    },
    create: {
      id: DEFAULT_ADMIN_ID,
      email: DEFAULT_ADMIN_EMAIL,
      fullName: 'Admin User',
      username: 'admin',
      password: hashedPassword,
      isVerified: true,
      avatarKey: DEFAULT_ADMIN_AVATAR_URL,
      createdAt: new Date(),
    },
  });

  console.log(`Admin User created: ${admin.email} (${admin.id})`);

  const bot = await prisma.user.upsert({
    where: { email: BOT_USER_EMAIL },
    update: {
      fullName: BOT_FULL_NAME,
      username: BOT_USERNAME,
      password: hashedPassword,
      isVerified: true,
      avatarKey: BOT_AVATAR_KEY,
    },
    create: {
      id: BOT_USER_ID,
      email: BOT_USER_EMAIL,
      fullName: BOT_FULL_NAME,
      username: BOT_USERNAME,
      password: hashedPassword,
      isVerified: true,
      avatarKey: BOT_AVATAR_KEY,
      createdAt: new Date(),
    },
  });

  console.log(`Bot User created: ${bot.email} (${bot.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
