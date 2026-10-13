const { PrismaClient } = require('@prisma/conversation-client');

const CONFIRM_TOKEN = 'BACKFILL_CONVERSATION_LAST_MESSAGE_AT';
const prisma = new PrismaClient();

// Conversations created before lastMessageAt defaulted to createdAt have a
// null value, and the descending conversation list sorts nulls last, so a new
// empty chat or group sat at the bottom (often on page two). Conversations
// that already received a message are never touched: only null/missing values
// are filled. Safe to run repeatedly.
const FILTER = { lastMessageAt: null };

async function main() {
  const counted = await prisma.$runCommandRaw({
    count: 'conversations',
    query: FILTER,
  });
  const pending = counted.n ?? 0;
  console.log(`Conversations with a null lastMessageAt: ${pending}`);

  if (process.env.CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(
      `Refusing to modify conversations. Re-run with CONFIRM=${CONFIRM_TOKEN}`,
    );
  }

  const result = await prisma.$runCommandRaw({
    update: 'conversations',
    updates: [
      {
        q: FILTER,
        u: [{ $set: { lastMessageAt: '$createdAt' } }],
        multi: true,
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
