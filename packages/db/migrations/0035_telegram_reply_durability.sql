-- Reply durability: an outbound reply that was generated but failed to send
-- now persists as a row with no Telegram message_id, flagged undelivered — so
-- the (paid-for) reply is never silently lost and stays recoverable.
ALTER TABLE "telegram_messages" ALTER COLUMN "telegram_message_id" DROP NOT NULL;
ALTER TABLE "telegram_messages" ADD COLUMN "delivered" boolean DEFAULT true NOT NULL;
