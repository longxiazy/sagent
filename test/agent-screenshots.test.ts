import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configStore } from '../agent/core/config-store.ts';
import { createAgentScreenshotsRouter } from '../routes/agent-screenshots.ts';
import type { ScreenshotPage } from '../helpers/screenshot-store.ts';

let dir: string;
let screenshotDir: string;
let app: express.Express;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-screenshot-api-'));
  screenshotDir = path.join(dir, 'screenshots');
  await configStore.init(dir);
  await configStore.updateTools({ screenshots: { retention: { enabled: false, maxAgeDays: 0, maxTotalMB: 0 } } });
  app = express();
  app.use(createAgentScreenshotsRouter({ screenshotDir }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedScreenshots(count = 23) {
  const urls: string[] = [];
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const runId = index < 12 ? 'run-new' : 'run-old';
    const name = `screen-${index}.png`;
    const runDir = path.join(screenshotDir, runId);
    await mkdir(runDir, { recursive: true });
    const file = path.join(runDir, name);
    await writeFile(file, Buffer.alloc(100));
    const mtime = new Date(now - index * 1000);
    await utimes(file, mtime, mtime);
    urls.push(`/screenshots/${runId}/${name}`);
  }
  return urls;
}

function pageUrls(page: ScreenshotPage): string[] {
  return page.groups.flatMap(group => group.files.map(file => file.url));
}

describe('screenshot pagination API', () => {
  it('defaults to ten images and keeps complete group and global totals', async () => {
    const urls = await seedScreenshots();
    const res = await request(app).get('/api/agent/screenshots');

    expect(res.status).toBe(200);
    expect(pageUrls(res.body)).toEqual(urls.slice(0, 10));
    expect(res.body.total).toEqual({ count: 23, bytes: 2300 });
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ runId: 'run-new', count: 12, bytes: 1200 });
    expect(res.body.nextOffset).toBe(10);
    expect(res.body.screenshots.retention.enabled).toBe(false);
  });

  it('continues within and across runs without repeating or skipping images', async () => {
    const urls = await seedScreenshots();
    const first = await request(app).get('/api/agent/screenshots?offset=0&limit=10');
    const second = await request(app).get(`/api/agent/screenshots?offset=${first.body.nextOffset}&limit=10`);
    const last = await request(app).get(`/api/agent/screenshots?offset=${second.body.nextOffset}&limit=10`);

    expect(second.body.groups.map(group => group.files.length)).toEqual([2, 8]);
    expect(second.body.nextOffset).toBe(20);
    expect(pageUrls(last.body)).toHaveLength(3);
    expect(last.body.nextOffset).toBeNull();
    expect([...pageUrls(first.body), ...pageUrls(second.body), ...pageUrls(last.body)]).toEqual(urls);
  });

  it.each([
    'limit=10000',
    'offset=-1&limit=0',
    'offset=oops&limit=oops',
    'offset=0.5&limit=1.5',
    'offset=Infinity&limit=Infinity',
    'offset[toString]=bad&limit[valueOf]=bad',
    'offset=0&offset=10&limit=10000',
  ])('never returns the full collection for invalid or oversized paging: %s', async query => {
    await seedScreenshots();
    const res = await request(app).get(`/api/agent/screenshots?${query}`);
    expect(res.status).toBe(200);
    expect(pageUrls(res.body)).toHaveLength(10);
    expect(res.body.nextOffset).toBe(10);
  });

  it('stops at an exact page boundary and beyond the end', async () => {
    await seedScreenshots(20);
    const last = await request(app).get('/api/agent/screenshots?offset=10');
    expect(pageUrls(last.body)).toHaveLength(10);
    expect(last.body.nextOffset).toBeNull();

    const beyond = await request(app).get('/api/agent/screenshots?offset=100');
    expect(pageUrls(beyond.body)).toEqual([]);
    expect(beyond.body.nextOffset).toBeNull();
  });

  it('returns an empty terminal page when there are no screenshots', async () => {
    const res = await request(app).get('/api/agent/screenshots');
    expect(res.body).toMatchObject({ total: { count: 0, bytes: 0 }, groups: [], nextOffset: null });
  });

  it('refreshes pagination after deleting an image', async () => {
    const urls = await seedScreenshots();
    await request(app).delete('/api/agent/screenshots/run-new/screen-0.png').expect(200);
    const first = await request(app).get('/api/agent/screenshots');
    const second = await request(app).get(`/api/agent/screenshots?offset=${first.body.nextOffset}`);

    expect(first.body.total.count).toBe(22);
    expect([...pageUrls(first.body), ...pageUrls(second.body)]).toEqual(urls.slice(1, 21));
  });

  it('returns only the first page after manual cleanup', async () => {
    await seedScreenshots();
    const res = await request(app).post('/api/agent/screenshots/cleanup');

    expect(res.status).toBe(200);
    expect(res.body.removedFiles).toBe(0);
    expect(res.body.total.count).toBe(23);
    expect(pageUrls(res.body)).toHaveLength(10);
    expect(res.body.nextOffset).toBe(10);
  });
});
