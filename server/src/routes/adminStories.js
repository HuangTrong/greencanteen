import { Router } from 'express';
import { adminAction, adminRead } from '../middleware/admin.js';
import { adminActor } from '../services/audit.js';
import {
  createStory,
  listStories,
  loadStory,
  publishStory,
  serializeAdminStory,
  unpublishStory,
  updateStory,
} from '../services/adminStories.js';

const router = Router();

const storyTarget = (story) => ({ type: 'story', id: story._id, label: story.slug });

router.param('id', (req, res, next, id) => {
  if (/^[a-f0-9]{24}$/i.test(id)) return next();
  res.status(404).json({ error: 'Không tìm thấy câu chuyện.', code: 'not_found' });
});

router.get('/', adminRead((req) => listStories(req.query)));

router.post(
  '/',
  adminAction('story.create', async (req, ctx) => {
    ctx.target = { type: 'story', label: typeof req.body.slug === 'string' ? req.body.slug.slice(0, 80) : '' };
    const story = await createStory(adminActor(req.admin), req.body);
    ctx.target = storyTarget(story);
    ctx.status = 201;
    return serializeAdminStory(story);
  })
);

router.get('/:id', adminRead(async (req) => serializeAdminStory(await loadStory(req.params.id))));

router.put(
  '/:id',
  adminAction('story.update', async (req, ctx) => {
    ctx.target = { type: 'story', id: req.params.id };
    const story = await updateStory(adminActor(req.admin), req.params.id, req.body);
    ctx.target = storyTarget(story);
    ctx.meta = { status: story.status };
    return serializeAdminStory(story);
  })
);

router.post(
  '/:id/publish',
  adminAction('story.publish', async (req, ctx) => {
    ctx.target = { type: 'story', id: req.params.id };
    const story = await publishStory(adminActor(req.admin), req.params.id, req.body.revision);
    ctx.target = storyTarget(story);
    return serializeAdminStory(story);
  })
);

router.post(
  '/:id/unpublish',
  adminAction('story.unpublish', async (req, ctx) => {
    ctx.target = { type: 'story', id: req.params.id };
    const story = await unpublishStory(adminActor(req.admin), req.params.id, req.body.revision);
    ctx.target = storyTarget(story);
    return serializeAdminStory(story);
  })
);

export default router;
