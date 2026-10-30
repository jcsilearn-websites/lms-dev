import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './app';
import type { TestClient } from './client';
import {
  doc,
  errorCode,
  type Json,
  loginAs,
  newCourse,
  newOffering,
  ok,
  PDF,
  type Person,
  person,
  structure,
  uploadFile,
} from './courses-helpers';
import { type AuthFixture, createAuthFixture, testOwnerPool } from './support';

// Course content: modules and items, ordering, visibility per actor, rich text, links, copy.

let owner: pg.Pool;
let t: TestApp;
let A: AuthFixture;
let admin: TestClient;
let termId: string;

beforeAll(async () => {
  owner = testOwnerPool();
  t = makeApp();
  A = await createAuthFixture(owner, 'ct-a');
  await t.app.ready();
  admin = await loginAs(t, A.host, A.adminEmail);
  termId = (await structure(admin)).termId;
});
afterAll(async () => {
  await t.close();
  await owner.end();
});

interface Course {
  offering: Json;
  instructor: Person;
  learner: Person;
  outsider: Person;
  assistant: Person;
}

/** An offering (draft) with an instructor, an assistant and a learner; the outsider takes no part. */
async function course(publish = true): Promise<Course> {
  const c = await newCourse(admin);
  const offering = await newOffering(admin, c.id, termId);
  const instructor = await person(owner, t, A, 'Instructor');
  const assistant = await person(owner, t, A, 'Assistant');
  const learner = await person(owner, t, A, 'Learner');
  const outsider = await person(owner, t, A, 'Outsider');
  for (const [p, kind] of [
    [instructor, 'instructor'],
    [assistant, 'assistant'],
    [learner, 'learner'],
  ] as const) {
    ok(
      await admin.post(`/offerings/${offering.id}/participants`, {
        userId: p.userId,
        participation: kind,
      }),
    );
  }
  if (publish) ok(await instructor.client.post(`/offerings/${offering.id}/publish`));
  return { offering, instructor, assistant, learner, outsider };
}

const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe('modules and items: editing and ordering', () => {
  it('modules and items keep their order; a move rewrites ordering and survives reload', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const m1 = ok(await i.post(`/offerings/${o}/modules`, { title: 'One' }));
    const m2 = ok(await i.post(`/offerings/${o}/modules`, { title: 'Two' }));
    const m3 = ok(await i.post(`/offerings/${o}/modules`, { title: 'Three', after: null })); // first
    const m4 = ok(await i.post(`/offerings/${o}/modules`, { title: 'Four', after: m1.id })); // after One
    const order = async () => ids(ok(await i.get(`/offerings/${o}/outline`)).modules);
    expect(await order()).toEqual([m3.id, m1.id, m4.id, m2.id]);

    ok(await i.post(`/offerings/${o}/modules/${m2.id}/move`, { after: null }));
    expect(await order()).toEqual([m2.id, m3.id, m1.id, m4.id]);
    ok(await i.post(`/offerings/${o}/modules/${m2.id}/move`, { after: m4.id }));
    expect(await order()).toEqual([m3.id, m1.id, m4.id, m2.id]);

    const gone = await i.post(`/offerings/${o}/modules/${m2.id}/move`, {
      after: '01a183c6-b2f4-7bd0-a6ae-58be9db51f10',
    });
    expect(gone.statusCode).toBe(404);
    expect(errorCode(gone)).toBe('sibling_not_found');
    ok(await i.delete(`/offerings/${o}/modules/${m3.id}`));
    expect(await order()).toEqual([m1.id, m4.id, m2.id]);
  });

  it('items move inside a module and between modules; many moves keep the order right', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const a = ok(await i.post(`/offerings/${o}/modules`, { title: 'A' }));
    const b = ok(await i.post(`/offerings/${o}/modules`, { title: 'B' }));
    const mk = async (m: string, title: string, after?: string | null) =>
      ok(
        await i.post(`/offerings/${o}/modules/${m}/items`, {
          kind: 'link',
          title,
          url: `https://example.org/${title}`,
          ...(after === undefined ? {} : { after }),
        }),
      );
    const x = await mk(a.id, 'x');
    const y = await mk(a.id, 'y');
    const z = await mk(a.id, 'z');
    const titles = async (m: string) =>
      ok(await i.get(`/offerings/${o}/outline`))
        .modules.find((q: Json) => q.id === m)
        .items.map((q: Json) => q.title);
    expect(await titles(a.id)).toEqual(['x', 'y', 'z']);
    ok(await i.post(`/offerings/${o}/items/${z.id}/move`, { after: null }));
    expect(await titles(a.id)).toEqual(['z', 'x', 'y']);
    ok(await i.post(`/offerings/${o}/items/${x.id}/move`, { moduleId: b.id, after: null }));
    expect(await titles(a.id)).toEqual(['z', 'y']);
    expect(await titles(b.id)).toEqual(['x']);
    // keep inserting at the front and moving to the end: the order never breaks
    let last = y.id;
    for (let n = 0; n < 25; n++) {
      const it = await mk(a.id, `n${n}`, null);
      ok(await i.post(`/offerings/${o}/items/${it.id}/move`, { after: last }));
      last = it.id;
    }
    const t2 = await titles(a.id);
    expect(t2.slice(0, 2)).toEqual(['z', 'y']);
    expect(t2.slice(2)).toEqual(Array.from({ length: 25 }, (_, n) => `n${n}`));
  });

  it('concurrent inserts at the same spot all succeed with distinct positions', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, n) => i.post(`/offerings/${o}/modules`, { title: `P${n}` })),
    );
    for (const r of rs) expect(r.statusCode, r.body).toBe(201);
    const mods = ok(await i.get(`/offerings/${o}/outline`)).modules;
    expect(mods).toHaveLength(8);
    expect(new Set(ids(mods)).size).toBe(8);
  });

  it('an item has what its kind needs; video is refused until a later step', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const m = ok(await i.post(`/offerings/${o}/modules`, { title: 'M' }));
    const add = (body: Json) => i.post(`/offerings/${o}/modules/${m.id}/items`, body);
    expect(errorCode(await add({ kind: 'video', title: 'v' }))).toBe('video_not_supported');
    expect(errorCode(await add({ kind: 'text', title: 'no body' }))).toBe('invalid_item');
    expect(errorCode(await add({ kind: 'link', title: 'no url' }))).toBe('invalid_item');
    expect(errorCode(await add({ kind: 'file', title: 'no file' }))).toBe('invalid_item');
    expect(errorCode(await add({ kind: 'link', title: 'x', url: 'javascript:alert(1)' }))).toBe(
      'invalid_link',
    );
    expect(errorCode(await add({ kind: 'link', title: 'x', url: 'data:text/html,hi' }))).toBe(
      'invalid_link',
    );
    expect(errorCode(await add({ kind: 'link', title: 'x', url: '/relative' }))).toBe(
      'invalid_link',
    );
    expect(
      (await add({ kind: 'link', title: 'ok', url: 'https://example.org/a?b=1' })).statusCode,
    ).toBe(201);
    // a file that was never uploaded
    expect(
      errorCode(
        await add({ kind: 'file', title: 'f', fileId: '01a183c6-b2f4-7bd0-a6ae-58be9db51f10' }),
      ),
    ).toBe('invalid_file');
  });
});

describe('who can see and change content', () => {
  it('learners see published entries only; locked entries show title and date, not content', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const m = ok(await i.post(`/offerings/${o}/modules`, { title: 'Week 1', published: true }));
    ok(await i.patch(`/offerings/${o}/modules/${m.id}`, { published: true }));
    const post = async (body: Json) =>
      ok(
        await i.post(`/offerings/${o}/modules/${m.id}/items`, {
          kind: 'text',
          body: doc('secret text'),
          ...body,
        }),
      );
    const open = await post({ title: 'Open', published: true });
    const draft = await post({ title: 'Draft' });
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const locked = await post({ title: 'Later', published: true, availableFrom: future });
    const link = ok(
      await i.post(`/offerings/${o}/modules/${m.id}/items`, {
        kind: 'link',
        title: 'Soon',
        url: 'https://example.org/soon',
        published: true,
        availableFrom: future,
      }),
    );

    const learnerOutline = ok(await c.learner.client.get(`/offerings/${o}/outline`));
    expect(learnerOutline.canEdit).toBe(false);
    const items = learnerOutline.modules[0].items;
    expect(items.map((x: Json) => x.title)).toEqual(['Open', 'Later', 'Soon']); // the draft is not sent
    expect(items.find((x: Json) => x.title === 'Later')).toMatchObject({
      locked: true,
      hasBody: false,
      url: null,
      file: null,
    });
    expect(items.find((x: Json) => x.title === 'Later').availableFrom).not.toBeNull();
    expect(items.find((x: Json) => x.title === 'Soon')).toMatchObject({ locked: true, url: null });
    expect(JSON.stringify(learnerOutline)).not.toContain('example.org/soon');

    // a single item: open one has its body; locked has none; the draft does not exist for a learner
    const got = ok(await c.learner.client.get(`/offerings/${o}/items/${open.id}`));
    expect(got.body.content[0].content[0].text).toBe('secret text');
    const lockedGot = ok(await c.learner.client.get(`/offerings/${o}/items/${locked.id}`));
    expect(lockedGot).toMatchObject({ locked: true, body: null });
    expect(JSON.stringify(lockedGot)).not.toContain('secret text');
    expect((await c.learner.client.get(`/offerings/${o}/items/${draft.id}`)).statusCode).toBe(404);
    expect((await c.learner.client.get(`/offerings/${o}/items/${link.id}`)).statusCode).toBe(200);

    // the instructor and the assistant see everything, with the flags; the administrator too
    for (const who of [c.instructor.client, c.assistant.client, admin]) {
      const out = ok(await who.get(`/offerings/${o}/outline`));
      expect(out.modules[0].items.map((x: Json) => x.title)).toEqual([
        'Open',
        'Draft',
        'Later',
        'Soon',
      ]);
      expect(out.modules[0].items.every((x: Json) => x.locked === false)).toBe(true);
    }
    expect(ok(await c.instructor.client.get(`/offerings/${o}/outline`)).canEdit).toBe(true);
    expect(ok(await c.assistant.client.get(`/offerings/${o}/outline`)).canEdit).toBe(false);
    expect(ok(await admin.get(`/offerings/${o}/outline`)).canEdit).toBe(false);
  });

  it('an unpublished module hides its items from learners; a module date locks them', async () => {
    const c = await course();
    const i = c.instructor.client;
    const o = c.offering.id;
    const m = ok(await i.post(`/offerings/${o}/modules`, { title: 'Hidden' }));
    ok(
      await i.post(`/offerings/${o}/modules/${m.id}/items`, {
        kind: 'text',
        title: 'T',
        body: doc('x'),
        published: true,
      }),
    );
    expect(ok(await c.learner.client.get(`/offerings/${o}/outline`)).modules).toEqual([]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    ok(
      await i.patch(`/offerings/${o}/modules/${m.id}`, { published: true, availableFrom: future }),
    );
    const mod = ok(await c.learner.client.get(`/offerings/${o}/outline`)).modules[0];
    expect(mod.title).toBe('Hidden');
    expect(mod.items[0]).toMatchObject({ title: 'T', locked: true, hasBody: false });
  });

  it('only editors change content: learner, assistant, administrator get 403; an outsider 404', async () => {
    const c = await course();
    const o = c.offering.id;
    const m = ok(await c.instructor.client.post(`/offerings/${o}/modules`, { title: 'M' }));
    for (const who of [c.learner, c.assistant]) {
      expect((await who.client.post(`/offerings/${o}/modules`, { title: 'x' })).statusCode).toBe(
        403,
      );
      expect((await who.client.delete(`/offerings/${o}/modules/${m.id}`)).statusCode).toBe(403);
    }
    expect((await admin.post(`/offerings/${o}/modules`, { title: 'x' })).statusCode).toBe(403);
    expect(
      (await c.outsider.client.post(`/offerings/${o}/modules`, { title: 'x' })).statusCode,
    ).toBe(404);
    expect((await c.outsider.client.get(`/offerings/${o}/outline`)).statusCode).toBe(404);
    // a learner of a DRAFT offering does not see it either
    const d = await course(false);
    expect((await d.learner.client.get(`/offerings/${d.offering.id}/outline`)).statusCode).toBe(
      404,
    );
    expect((await d.instructor.client.get(`/offerings/${d.offering.id}/outline`)).statusCode).toBe(
      200,
    );
  });

  it('an archived offering cannot be edited any more', async () => {
    const c = await course();
    const o = c.offering.id;
    ok(await admin.post(`/offerings/${o}/archive`));
    const r = await c.instructor.client.post(`/offerings/${o}/modules`, { title: 'late' });
    expect(r.statusCode).toBe(409);
    expect(errorCode(r)).toBe('offering_archived');
    expect((await c.instructor.client.get(`/offerings/${o}/outline`)).statusCode).toBe(200);
  });

  it("an item of another offering cannot be reached through this one's URL", async () => {
    const c1 = await course();
    const c2 = await course();
    const m = ok(
      await c2.instructor.client.post(`/offerings/${c2.offering.id}/modules`, { title: 'M' }),
    );
    const it = ok(
      await c2.instructor.client.post(`/offerings/${c2.offering.id}/modules/${m.id}/items`, {
        kind: 'text',
        title: 'T',
        body: doc('x'),
      }),
    );
    expect(
      (await c1.instructor.client.get(`/offerings/${c1.offering.id}/items/${it.id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await c1.instructor.client.patch(`/offerings/${c1.offering.id}/items/${it.id}`, {
          title: 'hijack',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await c1.instructor.client.delete(`/offerings/${c1.offering.id}/items/${it.id}`)).statusCode,
    ).toBe(404);
  });
});

describe('rich text is validated JSON, never HTML', () => {
  async function addText(c: Course, body: unknown) {
    const i = c.instructor.client;
    const m = ok(await i.post(`/offerings/${c.offering.id}/modules`, { title: 'M' }));
    return i.post(`/offerings/${c.offering.id}/modules/${m.id}/items`, {
      kind: 'text',
      title: 'T',
      body,
    });
  }

  it('accepts the editor nodes and returns the document it understood', async () => {
    const c = await course();
    const body = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, evil: 'x' },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'italic' }] },
            {
              type: 'text',
              text: 'link',
              marks: [
                {
                  type: 'link',
                  attrs: { href: 'https://example.org/x', target: '_blank', onclick: 'x()' },
                },
              ],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
      ],
    };
    const r = ok(await addText(c, body));
    expect(r.body.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Title' }],
    });
    expect(r.body.content[1].content[1].marks[0]).toEqual({
      type: 'link',
      attrs: { href: 'https://example.org/x' },
    });
  });

  it.each([
    ['a script node', { type: 'doc', content: [{ type: 'script', content: [] }] }],
    [
      'raw html as a node',
      { type: 'doc', content: [{ type: 'html', text: '<img src=x onerror=alert(1)>' }] },
    ],
    ['an image', { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://x/y.png' } }] }],
    [
      'a heading level 1',
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [] }] },
    ],
    [
      'an unknown mark',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' }] }],
          },
        ],
      },
    ],
    [
      'a javascript: link',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    ],
    [
      'a data: link',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'data:text/html;base64,AAAA' } }],
              },
            ],
          },
        ],
      },
    ],
    [
      'a link with a space trick',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: ' javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    ],
    ['text outside a block', { type: 'doc', content: [{ type: 'text', text: 'x' }] }],
    [
      'a list with a paragraph directly inside',
      { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'paragraph' }] }] },
    ],
  ])('refuses %s', async (_name, body) => {
    const c = await course();
    const r = await addText(c, body);
    expect(r.statusCode).toBe(400);
    expect(errorCode(r)).toBe('invalid_rich_text');
  });

  it('refuses a document nested too deeply and one that is far too large', async () => {
    const c = await course();
    let node: Json = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] };
    for (let n = 0; n < 12; n++) node = { type: 'blockquote', content: [node] };
    expect(errorCode(await addText(c, { type: 'doc', content: [node] }))).toBe('invalid_rich_text');
    const big = {
      type: 'doc',
      content: Array.from({ length: 6000 }, () => ({ type: 'paragraph' })),
    };
    const r = await addText(c, big);
    expect([400, 413]).toContain(r.statusCode);
  });

  it('what a learner reads back is the stored tree: the API never produces HTML', async () => {
    const c = await course();
    const i = c.instructor.client;
    const m = ok(
      await i.post(`/offerings/${c.offering.id}/modules`, { title: 'M', published: true }),
    );
    ok(await i.patch(`/offerings/${c.offering.id}/modules/${m.id}`, { published: true }));
    const text = '<script>alert(1)</script> & <b>not bold</b>';
    const it = ok(
      await i.post(`/offerings/${c.offering.id}/modules/${m.id}/items`, {
        kind: 'text',
        title: '<img src=x onerror=alert(1)>',
        body: doc(text),
        published: true,
      }),
    );
    const got = await c.learner.client.get(`/offerings/${c.offering.id}/items/${it.id}`);
    expect(got.headers['content-type']).toContain('application/json');
    // markup typed by an author is plain TEXT in the tree: the renderer shows it as text
    expect(got.json().body.content[0].content[0].text).toBe(text);
    expect(got.json().title).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('copying content from another offering', () => {
  it('copies modules and items as unpublished drafts, shares the file rows, and appends after existing content', async () => {
    const src = await course();
    const dst = await course();
    // the instructor of the destination must also teach the source to copy from it
    ok(
      await admin.post(`/offerings/${src.offering.id}/participants`, {
        userId: dst.instructor.userId,
        participation: 'instructor',
      }),
    );
    const si = src.instructor.client;
    const m = ok(
      await si.post(`/offerings/${src.offering.id}/modules`, { title: 'Intro', published: true }),
    );
    const file = await uploadFile(si, src.offering.id, 'notes.pdf', PDF);
    ok(
      await si.post(`/offerings/${src.offering.id}/modules/${m.id}/items`, {
        kind: 'file',
        title: 'Notes',
        fileId: file.id,
        published: true,
      }),
    );
    ok(
      await si.post(`/offerings/${src.offering.id}/modules/${m.id}/items`, {
        kind: 'text',
        title: 'Read',
        body: doc('hello'),
        published: true,
      }),
    );
    ok(await si.post(`/offerings/${src.offering.id}/modules`, { title: 'Second' }));

    const di = dst.instructor.client;
    ok(await di.post(`/offerings/${dst.offering.id}/modules`, { title: 'Existing' }));
    const r = ok(
      await di.post(`/offerings/${dst.offering.id}/copy`, { sourceOfferingId: src.offering.id }),
    );
    expect(r).toEqual({ status: 'done', modules: 2, items: 2 });

    const out = ok(await di.get(`/offerings/${dst.offering.id}/outline`));
    expect(out.modules.map((x: Json) => x.title)).toEqual(['Existing', 'Intro', 'Second']);
    const intro = out.modules[1];
    expect(intro.published).toBe(false);
    expect(intro.items.map((x: Json) => [x.title, x.published])).toEqual([
      ['Notes', false],
      ['Read', false],
    ]);
    // one file row, referenced by both offerings
    expect(intro.items[0].file.id).toBe(file.id);
    const { rows } = await owner.query(
      'SELECT count(*)::int AS n FROM lms.content_items WHERE file_id = $1',
      [file.id],
    );
    expect(rows[0].n).toBe(2);
    // the source is untouched
    expect(ok(await si.get(`/offerings/${src.offering.id}/outline`)).modules).toHaveLength(2);
  });

  it('refuses a copy into itself, from an offering the caller cannot edit, and by someone who may not publish', async () => {
    const a = await course();
    const b = await course();
    expect(
      errorCode(
        await a.instructor.client.post(`/offerings/${a.offering.id}/copy`, {
          sourceOfferingId: a.offering.id,
        }),
      ),
    ).toBe('copy_not_possible');
    // the instructor of A does not take part in B
    const probe = await a.instructor.client.post(`/offerings/${a.offering.id}/copy`, {
      sourceOfferingId: b.offering.id,
    });
    expect(probe.statusCode).toBe(404);
    // a learner of A cannot copy anything (no course.publish)
    expect(
      (
        await a.learner.client.post(`/offerings/${a.offering.id}/copy`, {
          sourceOfferingId: b.offering.id,
        })
      ).statusCode,
    ).toBe(403);
    // an assistant of the source cannot be used to copy its drafts: assistants may not edit the source
    ok(
      await admin.post(`/offerings/${b.offering.id}/participants`, {
        userId: a.instructor.userId,
        participation: 'assistant',
      }),
    );
    expect(
      (
        await a.instructor.client.post(`/offerings/${a.offering.id}/copy`, {
          sourceOfferingId: b.offering.id,
        })
      ).statusCode,
    ).toBe(403);
  });
});
