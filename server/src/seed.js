import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { syncStories } from './services/stories.js';

dotenv.config();

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/greencanteen';
  await mongoose.connect(uri);
  const { upserted, keptAdminManaged, removedUnsourced } = await syncStories();
  console.log(
    `Seeded ${upserted} sourced stories; kept ${keptAdminManaged} admin-managed; removed ${removedUnsourced} story/stories without a source.`
  );
  await mongoose.disconnect();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
